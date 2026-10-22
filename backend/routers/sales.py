import secrets

from fastapi import APIRouter
from db import get_db
from helpers import auction_access
from ledger import spend
from notification_service import create_notification
import paystack

import os
import json
import hmac
import hashlib
import secrets
from decimal import Decimal, ROUND_HALF_UP
from urllib import request as urlreq, error as urlerr

from fastapi import Request
from fastapi.responses import JSONResponse

router = APIRouter()

# Platform-controlled v1 rates. Become per-sale columns when houses set their own
# premium; until then the platform owns the money math (safer than letting a house
# discount itself into unpaid commission).
#
# FLOW A (charge at settlement), HOUSE-NET split:
#   buyer pays platform  = hammer + premium        (one Paystack charge per won lot)
#   platform commission  = collected * COMMISSION_RATE   (withheld from house payout)
#   net to house         = collected - commission        (paid to house via transfer)
#
# The platform's revenue is the commission — it is NOT debited from the house
# wallet; it is kept out of what would have been the house's payout. So the house
# never needs a funded wallet to settle. Money MOVES only via the rail (webhook ->
# escrow credit now; payout transfer later). With NO Paystack keys, settle still
# runs end-to-end: it computes the split, records it, sends notices, and leaves
# lots 'unpaid' (collection pending) — developable and testable today.
BUYER_PREMIUM_RATE = 0.15        # added to the buyer's hammer; part of the settle charge
PLATFORM_COMMISSION_RATE = 0.10  # platform's cut of the collected total (withheld at payout)

ACCESS_MODES = {"open", "vip", "invite"}            # canonical storage values
ACCESS_ALIASES = {                                   # accept the drifted spellings on write
    "open": "open",
    "vip": "vip",
    "vip_only": "vip",
    "invite": "invite",
    "invite_only": "invite",
}

DEFAULT_CCY = "NGN"
DEFAULT_CURRENCY = DEFAULT_CCY    # compatibility alias, safe if anything references it

# How long an ended sale remains visible on the public auction floor.
# The house/control room still sees all their sales forever via /my_sales.
ENDED_FLOOR_RETENTION_HOURS = 72  # 3 days

# ---------------------------------------------------------------------------
# Paystack collection + settlement controls
#
# Browser never calls api.paystack.co directly.
# Backend initializes Paystack, stores checkout_url, buyer opens checkout_url,
# Paystack sends webhook to backend, backend marks lot paid.
# ---------------------------------------------------------------------------

PAYSTACK_SECRET_KEY = os.getenv("PAYSTACK_SECRET_KEY", "")
BUYER_PREMIUM_RATE = Decimal(os.getenv("BUYER_PREMIUM_RATE", "0.15"))
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")
PAYSTACK_CALLBACK_URL = os.getenv(
    "PAYSTACK_CALLBACK_URL",
    f"{FRONTEND_URL}/wins?payment=completed",
)


def _money(value) -> Decimal:
    try:
        return Decimal(str(value if value is not None else 0)).quantize(
            Decimal("0.01"),
            rounding=ROUND_HALF_UP,
        )
    except Exception:
        return Decimal("0.00")


def _minor_amount(amount: Decimal) -> int:
    return int((amount * 100).to_integral_value(rounding=ROUND_HALF_UP))


def _paystack_initialize(
    email: str,
    amount_minor: int,
    currency: str,
    reference: str,
    metadata: dict,
):
    if not PAYSTACK_SECRET_KEY:
        raise RuntimeError("PAYSTACK_SECRET_KEY is not configured")

    payload = {
        "email": email,
        "amount": amount_minor,
        "currency": currency,
        "reference": reference,
        "callback_url": PAYSTACK_CALLBACK_URL,
        "metadata": metadata,
    }

    data = json.dumps(payload).encode("utf-8")

    req = urlreq.Request(
        "https://api.paystack.co/transaction/initialize",
        data=data,
        headers={
            "Authorization": f"Bearer {PAYSTACK_SECRET_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urlreq.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urlerr.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body)
        except Exception:
            return {
                "status": False,
                "message": f"Paystack HTTP {e.code}: {body[:300]}",
            }


def _refresh_payout_status(cursor, sale_id: int) -> str:
    """
    Recompute collection completion and update auctions.payout_status.

    payout_status meanings used here:
      none    = no confirmed collection yet / not ready
      pending = all won lots collected, house payout not marked paid yet
      paid    = house payout confirmed paid
    """
    cursor.execute(
        """
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (
                WHERE COALESCE(payment_status, 'unpaid') = 'paid'
            )::int AS paid,
            COUNT(*) FILTER (
                WHERE COALESCE(payment_status, 'unpaid') IN ('pending', 'processing')
            )::int AS pending,
            COUNT(*) FILTER (
                WHERE COALESCE(payment_status, 'unpaid') = 'unpaid'
            )::int AS unpaid,
            COUNT(*) FILTER (
                WHERE COALESCE(payment_status, 'unpaid') = 'failed'
            )::int AS failed
        FROM lots
        WHERE sale_id = %s
          AND status = 'sold'
          AND winner_username IS NOT NULL
        """,
        (sale_id,),
    )

    row = cursor.fetchone() or {}

    total = int(row.get("total") or 0)
    paid = int(row.get("paid") or 0)

    cursor.execute(
        "SELECT payout_status FROM auctions WHERE id = %s",
        (sale_id,),
    )
    sale_row = cursor.fetchone()
    current = (sale_row or {}).get("payout_status") or "none"

    if current == "paid":
        return "paid"

    new_status = "pending" if total > 0 and paid == total else "none"

    cursor.execute(
        """
        UPDATE auctions
        SET payout_status = %s
        WHERE id = %s
        """,
        (new_status, sale_id),
    )

    return new_status


def _buyer_email_for(cursor, username: str) -> str:
    email = None

    try:
        cursor.execute(
            "SELECT email FROM users WHERE username = %s",
            (username,),
        )
        row = cursor.fetchone()
        email = (row or {}).get("email")
    except Exception:
        email = None

    return email or f"{username}@thespace.local"


def _initialize_lot_checkout(cursor, lot_id: int) -> dict:
    """
    Internal helper.

    Creates or returns a Paystack checkout URL for one won lot.
    Does not move money. Does not mark paid. Marks pending and stores reference.
    """
    cursor.execute(
        """
        SELECT
            l.id,
            l.position,
            l.status,
            l.winner_username,
            l.sold_price::text AS sold_price,
            COALESCE(l.payment_status, 'unpaid') AS payment_status,
            l.payment_reference,
            l.checkout_url,
            l.currency,
            a.id AS sale_id,
            a.title AS sale_title,
            a.host_username,
            a.currency AS sale_currency,
            a.settled_at
        FROM lots l
        JOIN auctions a ON a.id = l.sale_id
        WHERE l.id = %s
        FOR UPDATE OF l
        """,
        (lot_id,),
    )

    row = cursor.fetchone()

    if not row:
        return {"error": "lot not found"}

    if row["status"] != "sold" or not row["winner_username"]:
        return {"error": "lot is not won"}

    if row["payment_status"] == "paid":
        return {
            "status": "paid",
            "message": "this lot is already paid",
        }

    if not row["settled_at"]:
        return {"error": "sale is not settled yet"}

    if row["payment_status"] == "pending" and row["checkout_url"]:
        return {
            "status": "pending",
            "message": "payment link already available",
            "checkout_url": row["checkout_url"],
            "reference": row["payment_reference"],
        }

    sold_price = _money(row["sold_price"])
    premium = (sold_price * BUYER_PREMIUM_RATE).quantize(
        Decimal("0.01"),
        rounding=ROUND_HALF_UP,
    )
    collected = sold_price + premium
    currency = (row["currency"] or row["sale_currency"] or "NGN").upper()
    reference = f"lot_{lot_id}_{secrets.token_hex(6)}"
    email = _buyer_email_for(cursor, row["winner_username"])

    metadata = {
        "purpose": "won_lot_payment",
        "lot_id": int(row["id"]),
        "sale_id": int(row["sale_id"]),
        "winner_username": row["winner_username"],
        "reference": reference,
        "custom_fields": [
            {
                "variable_name": "lot_id",
                "value": str(row["id"]),
                "display_value": f"Lot {row['position']}",
                "show_on_checkout": True,
            },
            {
                "variable_name": "sale_id",
                "value": str(row["sale_id"]),
                "display_value": row["sale_title"],
                "show_on_checkout": True,
            },
        ],
    }

    try:
        resp = _paystack_initialize(
            email=email,
            amount_minor=_minor_amount(collected),
            currency=currency,
            reference=reference,
            metadata=metadata,
        )
    except Exception as e:
        return {"error": f"Paystack initialize failed: {e}"}

    if not resp.get("status"):
        return {
            "error": resp.get("message") or "Paystack initialize failed",
        }

    checkout_url = (resp.get("data") or {}).get("authorization_url")

    if not checkout_url:
        return {"error": "Paystack did not return an authorization URL"}

    cursor.execute(
        """
        UPDATE lots
        SET
            payment_status = 'pending',
            payment_reference = %s,
            checkout_url = %s,
            payment_updated_at = CURRENT_TIMESTAMP
        WHERE id = %s
        """,
        (reference, checkout_url, lot_id),
    )

    create_notification(
        user_name=row["winner_username"],
        category="wallet",
        type="lot_payment_required",
        title=f"Payment required · Lot {row['position']} · {row['sale_title']}",
        body="Open your Won lots page to pay for this lot securely.",
        actor=row["host_username"],
        source_type="sale",
        source_id=row["sale_id"],
        secondary_id=row["id"],
        data={
            "sale_id": row["sale_id"],
            "lot_id": row["id"],
            "reference": reference,
            "amount": str(collected),
            "currency": currency,
        },
        cursor=cursor,
    )

    return {
        "status": "pending",
        "message": "payment link ready",
        "checkout_url": checkout_url,
        "reference": reference,
        "amount": str(collected),
        "currency": currency,
    }


@router.post("/my/won-lots/{lot_id}/pay")
def pay_won_lot(lot_id: int, data: dict):
    """
    Buyer-facing payment link request.

    The frontend calls this endpoint, then opens the returned checkout_url.
    The frontend must never call api.paystack.co directly.
    """
    conn = None

    try:
        viewer = str(data.get("viewer") or "").strip()

        if not viewer:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT winner_username FROM lots WHERE id = %s",
            (lot_id,),
        )
        owner = cursor.fetchone()

        if not owner:
            return {"error": "lot not found"}

        if owner["winner_username"] != viewer:
            return {"error": "this lot was not won by you"}

        result = _initialize_lot_checkout(cursor, lot_id)

        if result.get("error"):
            conn.rollback()
        else:
            conn.commit()

        return result

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/collect")
def collect_sale(sale_id: int, data: dict):
    """
    Host retry collection.

    Initializes Paystack checkout links for unpaid/failed won lots.
    If Paystack is not configured, this fails clearly and the host can use
    offline collection marking for tests/manual bank transfers.
    """
    conn = None

    try:
        host = str(data.get("viewer") or "").strip()

        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT id, host_username, title, status, settled_at
            FROM auctions
            WHERE id = %s
            FOR UPDATE
            """,
            (sale_id,),
        )

        sale = cursor.fetchone()

        if not sale:
            return {"error": "sale not found"}

        if sale["host_username"] != host:
            return {"error": "not your sale"}

        if sale["status"] != "ended":
            return {"error": "sale is not ended"}

        if not sale["settled_at"]:
            return {"error": "sale is not settled yet"}

        cursor.execute(
            """
            SELECT id, position, winner_username
            FROM lots
            WHERE sale_id = %s
              AND status = 'sold'
              AND winner_username IS NOT NULL
              AND COALESCE(payment_status, 'unpaid') IN ('unpaid', 'failed')
            ORDER BY position
            """,
            (sale_id,),
        )

        due = [dict(r) for r in cursor.fetchall()]

        initiated = 0
        existing = 0
        failed = 0
        errors = []

        for lot in due:
            result = _initialize_lot_checkout(cursor, lot["id"])

            if result.get("error"):
                failed += 1
                errors.append(
                    {
                        "lot_id": lot["id"],
                        "position": lot["position"],
                        "error": result["error"],
                    }
                )
            elif result.get("status") == "paid":
                continue
            elif result.get("message") == "payment link already available":
                existing += 1
            else:
                initiated += 1

        if initiated or existing or failed:
            create_notification(
                user_name=host,
                category="wallet",
                type="collection_retry_result",
                title=f"Collection retry · {sale['title']}",
                body=(
                    f"{initiated} payment link(s) initiated, "
                    f"{existing} already available, "
                    f"{failed} failed."
                ),
                actor=None,
                source_type="sale",
                source_id=sale_id,
                data={
                    "sale_id": sale_id,
                    "initiated": initiated,
                    "existing": existing,
                    "failed": failed,
                },
                cursor=cursor,
            )

        payout_status = _refresh_payout_status(cursor, sale_id)
        conn.commit()

        return {
            "message": "collection retried",
            "charges_initiated": initiated,
            "links_available": existing,
            "failed": failed,
            "errors": errors[:10],
            "payout_status": payout_status,
        }

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/collection/mark_paid")
def mark_collection_paid(sale_id: int, data: dict):
    """
    Host-only offline collection marker.

    Use only when buyer payment has been verified outside Paystack,
    for example bank transfer, cash, or local testing without a live rail.

    This does not move money. It records that collection is complete.
    """
    conn = None

    try:
        host = str(data.get("viewer") or "").strip()
        reference = str(data.get("reference") or "").strip()

        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT id, host_username, title, status, settled_at
            FROM auctions
            WHERE id = %s
            FOR UPDATE
            """,
            (sale_id,),
        )

        sale = cursor.fetchone()

        if not sale:
            return {"error": "sale not found"}

        if sale["host_username"] != host:
            return {"error": "not your sale"}

        if sale["status"] != "ended":
            return {"error": "sale is not ended"}

        if not sale["settled_at"]:
            return {"error": "sale is not settled"}

        cursor.execute(
            """
            SELECT id, position, winner_username
            FROM lots
            WHERE sale_id = %s
              AND status = 'sold'
              AND winner_username IS NOT NULL
              AND COALESCE(payment_status, 'unpaid') <> 'paid'
            ORDER BY position
            """,
            (sale_id,),
        )

        due = [dict(r) for r in cursor.fetchall()]

        if not due:
            payout_status = _refresh_payout_status(cursor, sale_id)
            conn.commit()
            return {
                "message": "collection already complete",
                "marked_paid": 0,
                "payout_status": payout_status,
            }

        if not reference:
            reference = f"offline_collection_{sale_id}_{secrets.token_hex(4)}"

        cursor.execute(
            """
            UPDATE lots
            SET
                payment_status = 'paid',
                payment_reference = COALESCE(
                    NULLIF(payment_reference, ''),
                    %s
                ),
                payment_updated_at = CURRENT_TIMESTAMP
            WHERE sale_id = %s
              AND status = 'sold'
              AND winner_username IS NOT NULL
              AND COALESCE(payment_status, 'unpaid') <> 'paid'
            """,
            (reference, sale_id),
        )

        marked = len(due)

        for lot in due:
            create_notification(
                user_name=lot["winner_username"],
                category="wallet",
                type="payment_confirmed",
                title=f"Payment confirmed · Lot {lot['position']} · {sale['title']}",
                body=(
                    "Your payment for this won lot has been confirmed. "
                    "The house can now proceed with payout/release."
                ),
                actor=host,
                source_type="sale",
                source_id=sale_id,
                secondary_id=lot["id"],
                data={
                    "sale_id": sale_id,
                    "lot_id": lot["id"],
                    "reference": reference,
                    "collection_method": "offline",
                },
                cursor=cursor,
            )

        create_notification(
            user_name=host,
            category="wallet",
            type="collection_marked_paid",
            title=f"Collection marked paid · {sale['title']}",
            body=(
                f"{marked} won lot(s) were manually marked as collected. "
                "You can now mark the house payout as paid if the transfer to the house is complete."
            ),
            actor=None,
            source_type="sale",
            source_id=sale_id,
            data={
                "sale_id": sale_id,
                "marked_paid": marked,
                "reference": reference,
                "collection_method": "offline",
            },
            cursor=cursor,
        )

        payout_status = _refresh_payout_status(cursor, sale_id)
        conn.commit()

        return {
            "message": "collection marked paid",
            "marked_paid": marked,
            "reference": reference,
            "payout_status": payout_status,
        }

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/paystack/webhook")
async def paystack_webhook(request: Request):
    """
    Paystack webhook receiver.

    This is the only sanctioned way a won lot becomes paid automatically.
    The browser never calls Paystack directly; Paystack calls this backend route.
    """
    if not PAYSTACK_SECRET_KEY:
        return JSONResponse(
            {"error": "webhook not configured"},
            status_code=400,
        )

    body = await request.body()
    signature = request.headers.get("x-paystack-signature") or ""

    hashed = hmac.new(
        PAYSTACK_SECRET_KEY.encode("utf-8"),
        body,
        hashlib.sha512,
    ).hexdigest()

    if not hmac.compare_digest(hashed, signature):
        return JSONResponse(
            {"error": "invalid signature"},
            status_code=400,
        )

    try:
        event = json.loads(body.decode("utf-8"))
    except Exception:
        return JSONResponse(
            {"error": "invalid json"},
            status_code=400,
        )

    event_name = event.get("event")
    data = event.get("data") or {}
    metadata = data.get("metadata") or {}

    reference = data.get("reference") or metadata.get("reference")
    lot_id = metadata.get("lot_id")

    if event_name not in ("charge.success", "charge.failed"):
        return {"status": True}

    conn = None

    try:
        conn = get_db()
        cursor = conn.cursor()

        conditions = []
        params = []

        try:
            if lot_id is not None:
                conditions.append("l.id = %s")
                params.append(int(lot_id))
        except Exception:
            pass

        if reference:
            conditions.append("l.payment_reference = %s")
            params.append(reference)

        if not conditions:
            return {"status": True}

        where = " OR ".join(conditions)

        cursor.execute(
            f"""
            SELECT
                l.id,
                l.position,
                l.status,
                l.winner_username,
                COALESCE(l.payment_status, 'unpaid') AS payment_status,
                l.payment_reference,
                a.id AS sale_id,
                a.title AS sale_title,
                a.host_username
            FROM lots l
            JOIN auctions a ON a.id = l.sale_id
            WHERE ({where})
            FOR UPDATE OF l
            """,
            tuple(params),
        )

        lot = cursor.fetchone()

        if not lot:
            return {"status": True}

        if event_name == "charge.success":
            if lot["payment_status"] == "paid":
                conn.commit()
                return {"status": True}

            cursor.execute(
                """
                UPDATE lots
                SET
                    payment_status = 'paid',
                    payment_reference = COALESCE(
                        NULLIF(payment_reference, ''),
                        NULLIF(%s, ''),
                        payment_reference
                    ),
                    payment_updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
                """,
                (reference or "", lot["id"]),
            )

            create_notification(
                user_name=lot["winner_username"],
                category="wallet",
                type="payment_confirmed",
                title=f"Payment confirmed · Lot {lot['position']} · {lot['sale_title']}",
                body="Your payment was confirmed. The house can now release/payout according to its terms.",
                actor=lot["host_username"],
                source_type="sale",
                source_id=lot["sale_id"],
                secondary_id=lot["id"],
                data={
                    "sale_id": lot["sale_id"],
                    "lot_id": lot["id"],
                    "reference": reference,
                },
                cursor=cursor,
            )

            create_notification(
                user_name=lot["host_username"],
                category="wallet",
                type="lot_payment_received",
                title=f"Payment received · Lot {lot['position']} · {lot['sale_title']}",
                body=f"{lot['winner_username']} paid for Lot {lot['position']}.",
                actor=lot["winner_username"],
                source_type="sale",
                source_id=lot["sale_id"],
                secondary_id=lot["id"],
                data={
                    "sale_id": lot["sale_id"],
                    "lot_id": lot["id"],
                    "winner_username": lot["winner_username"],
                    "reference": reference,
                },
                cursor=cursor,
            )

            _refresh_payout_status(cursor, lot["sale_id"])
            conn.commit()
            return {"status": True}

        if event_name == "charge.failed":
            if lot["payment_status"] == "paid":
                conn.commit()
                return {"status": True}

            cursor.execute(
                """
                UPDATE lots
                SET
                    payment_status = 'failed',
                    payment_updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
                """,
                (lot["id"],),
            )

            create_notification(
                user_name=lot["winner_username"],
                category="wallet",
                type="payment_failed",
                title=f"Payment failed · Lot {lot['position']} · {lot['sale_title']}",
                body="Your payment attempt failed. Try again from your Won lots page.",
                actor=lot["host_username"],
                source_type="sale",
                source_id=lot["sale_id"],
                secondary_id=lot["id"],
                data={
                    "sale_id": lot["sale_id"],
                    "lot_id": lot["id"],
                    "reference": reference,
                },
                cursor=cursor,
            )

            _refresh_payout_status(cursor, lot["sale_id"])
            conn.commit()
            return {"status": True}

    except Exception:
        if conn:
            conn.rollback()
        return JSONResponse(
            {"error": "webhook processing failed"},
            status_code=500,
        )
    finally:
        if conn:
            conn.close()


def _ccy(value, default=DEFAULT_CCY):
    c = (str(value or default)).strip().upper()
    return c if (len(c) == 3 and c.isalpha()) else default


def _money_or_none(value):
    """Return (amount, error). None means unset/null."""
    if value in (None, ""):
        return None, None
    try:
        f = round(float(value), 2)
    except (TypeError, ValueError):
        return None, "invalid amount"
    if f < 0:
        return None, "amount cannot be negative"
    return f, None


def _capacity_or_none(value):
    if value in (None, ""):
        return None, None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None, "invalid capacity"
    if n <= 0:
        return None, "capacity must be positive"
    return n, None


def _refresh_payout_status(cursor, sale_id: int) -> str:
    """
    payout_status reflects collection/payout state:
      pending = one or more charges initiated and awaiting webhook
      none    = settled but collection not initiated yet (e.g. no Paystack keys)
      paid    = all won lots paid
    """
    cursor.execute(
        """
        SELECT
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END), 0)::int AS paid,
            COALESCE(SUM(CASE WHEN payment_status = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending,
            COALESCE(SUM(CASE WHEN payment_status IN ('unpaid', 'failed') THEN 1 ELSE 0 END), 0)::int AS unpaid
        FROM lots
        WHERE sale_id = %s
          AND status = 'sold'
          AND winner_username IS NOT NULL
        """,
        (sale_id,),
    )
    row = cursor.fetchone() or {}
    paid = int(row.get("paid") or 0)
    pending = int(row.get("pending") or 0)
    unpaid = int(row.get("unpaid") or 0)

    if pending > 0:
        status = "pending"
    elif unpaid > 0:
        status = "none"
    elif paid > 0:
        status = "paid"
    else:
        status = "none"

    cursor.execute(
        "UPDATE auctions SET payout_status = %s WHERE id = %s",
        (status, sale_id),
    )
    return status


@router.get("/sales")
def list_sales(viewer: str = ""):
    """
    Public auction floor.

    Ended sales remain visible for ENDED_FLOOR_RETENTION_HOURS after they end,
    then disappear from the public floor. The house still sees all their own
    sales through /my_sales.

    IMPORTANT: every matching row is returned with its access flags. We do NOT
    hide invite/VIP rooms from the floor when the viewer lacks a paddle — the
    card renders them locked, and the real gating happens in get_sale + the room.
    (Hiding them here is what made a manually-openable room vanish from the list.)
    """
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                a.id,
                a.host_username,
                a.title,
                a.description,
                a.image_url,
                a.tier,
                a.status,
                a.starts_at::text AS starts_at,
                a.ends_at::text AS ends_at,
                a.ended_at::text AS ended_at,
                a.created_at::text AS created_at,
                a.ticket_price::text AS ticket_price,
                a.ticket_currency,
                a.currency,
                a.ticket_capacity,
                (
                    SELECT COUNT(*)
                    FROM tickets t
                    WHERE t.auction_id = a.id
                ) AS tickets_sold,
                (
                    SELECT COUNT(*)
                    FROM lots l
                    WHERE l.sale_id = a.id
                ) AS lot_count,
                CASE
                    WHEN a.ticket_capacity IS NULL THEN NULL
                    ELSE GREATEST(a.ticket_capacity - (
                        SELECT COUNT(*)
                        FROM tickets t2
                        WHERE t2.auction_id = a.id
                    ), 0)
                END AS tickets_remaining
            FROM auctions a
            WHERE
                a.status IN ('upcoming', 'live')
                OR (
                    a.status = 'ended'
                    AND COALESCE(a.ended_at, a.ends_at, a.created_at) >
                        CURRENT_TIMESTAMP - make_interval(hours => %s)
                )
            ORDER BY
                CASE
                    WHEN a.status = 'live' THEN 0
                    WHEN a.status = 'upcoming' THEN 1
                    ELSE 2
                END,
                COALESCE(a.ended_at, a.ends_at, a.created_at) DESC
            """,
            (ENDED_FLOOR_RETENTION_HOURS,),
        )

        rows = cursor.fetchall()
        out = []

        for s in rows:
            acc = auction_access(cursor, s, viewer) or {}

            # Always include the room on the floor; the card shows it locked.
            out.append(
                {
                    **s,
                    "access_mode": s.get("tier"),
                    **acc,
                    "visible": acc.get("visible", True),
                }
            )

        return {"sales": out}

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/my_sales")
def my_sales(viewer: str = ""):
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                a.id,
                a.title,
                a.status,
                a.tier,
                a.currency,
                a.ticket_currency,
                a.ticket_price::text AS ticket_price,
                a.ticket_capacity,
                a.starts_at::text AS starts_at,
                a.ends_at::text AS ends_at,
                a.ended_at::text AS ended_at,
                a.settled_at::text AS settled_at,
                a.payout_status,
                (SELECT COUNT(*) FROM lots l WHERE l.sale_id = a.id) AS lot_count,
                (SELECT COUNT(*) FROM tickets t WHERE t.auction_id = a.id) AS tickets_sold,
                CASE
                    WHEN a.ticket_capacity IS NULL THEN NULL
                    ELSE GREATEST(a.ticket_capacity - (
                        SELECT COUNT(*)
                        FROM tickets t2
                        WHERE t2.auction_id = a.id
                    ), 0)
                END AS tickets_remaining
            FROM auctions a
            WHERE a.host_username = %s
            ORDER BY a.created_at DESC
            """,
            (viewer,),
        )

        rows = cursor.fetchall()
        return {"sales": rows}

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/sales")
def list_sales(viewer: str = ""):
    """
    Public auction floor.

    Ended sales remain visible for ENDED_FLOOR_RETENTION_HOURS after they end,
    then disappear from the public floor. The house still sees all their own
    sales through /my_sales.
    """
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                a.id,
                a.host_username,
                a.title,
                a.description,
                a.image_url,
                a.tier,
                a.status,
                a.starts_at::text AS starts_at,
                a.ends_at::text AS ends_at,
                a.ended_at::text AS ended_at,
                a.created_at::text AS created_at,
                a.ticket_price::text AS ticket_price,
                a.ticket_currency,
                a.currency,
                a.ticket_capacity,
                (
                    SELECT COUNT(*)
                    FROM tickets t
                    WHERE t.auction_id = a.id
                ) AS tickets_sold,
                (
                    SELECT COUNT(*)
                    FROM lots l
                    WHERE l.sale_id = a.id
                ) AS lot_count,
                CASE
                    WHEN a.ticket_capacity IS NULL THEN NULL
                    ELSE GREATEST(a.ticket_capacity - (
                        SELECT COUNT(*)
                        FROM tickets t2
                        WHERE t2.auction_id = a.id
                    ), 0)
                END AS tickets_remaining
            FROM auctions a
            WHERE
                a.status IN ('upcoming', 'live')
                OR (
                    a.status = 'ended'
                    AND COALESCE(a.ended_at, a.ends_at, a.created_at) >
                        CURRENT_TIMESTAMP - make_interval(hours => %s)
                )
            ORDER BY
                CASE
                    WHEN a.status = 'live' THEN 0
                    WHEN a.status = 'upcoming' THEN 1
                    ELSE 2
                END,
                COALESCE(a.ended_at, a.ends_at, a.created_at) DESC
            """,
            (ENDED_FLOOR_RETENTION_HOURS,),
        )

        rows = cursor.fetchall()
        out = []

        for s in rows:
            acc = auction_access(cursor, s, viewer) or {}

            # List the room regardless of entitlement; the card renders it locked.
            # Bidding/entry is still enforced by get_sale + the room page.
            out.append(
                {
                    **s,
                    "access_mode": s.get("tier"),
                    **acc,
                    "visible": acc.get("visible", True),
                }
            )

        return {"sales": out}
    
    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/stream")
def set_stream(sale_id: int, data: dict):
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status FROM auctions WHERE id = %s", (sale_id,))
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] == "ended":
            return {"error": "sale has ended"}

        cursor.execute(
            "UPDATE auctions SET stream_type=%s, stream_url=%s, stream_peer_id=%s WHERE id=%s",
            (
                data.get("stream_type", "external"),
                data.get("stream_url", ""),
                data.get("stream_peer_id", ""),
                sale_id,
            ),
        )
        conn.commit()
        return {"message": "stream updated"}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()

@router.post("/lots/{lot_id}/revert_to_passed")
def revert_lot_to_passed(lot_id: int, data: dict):
    """
    Host-only correction for a lot that was hammered SOLD by mistake and should
    have been PASSED (no real buyer / below reserve / wrong click).

    SAFE LIMITS:
      - only the owning house
      - only while the sale is NOT yet settled (settled totals already include
        this lot as revenue; reverting post-settle would desync the money math.
        After settle, use /collection/mark_paid or redo the sale in test.)
      - clears winner, sold_price, payment state and re-stamps hammer_at

    This does not move money. It corrects the catalogue record before settlement.
    """
    conn = None
    try:
        host = str(data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT l.id, l.position, l.status AS lot_status, l.winner_username,
                   a.host_username, a.status AS sale_status, a.settled_at, a.title
            FROM lots l
            JOIN auctions a ON a.id = l.sale_id
            WHERE l.id = %s
            FOR UPDATE OF l, a
            """,
            (lot_id,),
        )
        row = cursor.fetchone()

        if not row:
            return {"error": "lot not found"}
        if row["host_username"] != host:
            return {"error": "not your sale"}
        if row["lot_status"] != "sold":
            return {"error": "only a sold lot can be reverted to passed"}
        if row["settled_at"] is not None:
            return {
                "error": (
                    "sale is already settled; reverting would desync the settlement totals. "
                    "Use /sales/{id}/collection/mark_paid for offline collection, or redo the sale in test."
                )
            }

        cursor.execute(
            """
            UPDATE lots
            SET status = 'passed',
                sold_price = NULL,
                winner_username = NULL,
                payment_status = NULL,
                checkout_url = NULL,
                payment_reference = NULL,
                payment_updated_at = NULL,
                hammer_at = CURRENT_TIMESTAMP
            WHERE id = %s
            """,
            (lot_id,),
        )

        # Tell the (now former) winner their lot did not sell, if there was one.
        if row["winner_username"]:
            create_notification(
                user_name=row["winner_username"],
                category="auctions",
                type="lot_lost",
                title=f"Lot {row['position']} · {row['title']} — correction",
                body="The house corrected this lot to passed. No payment is due.",
                actor=host,
                source_type="sale",
                source_id=None,
                secondary_id=lot_id,
                data={"lot_id": lot_id, "corrected_to": "passed"},
                cursor=cursor,
            )

        # Keep the sale's payout_status honest even though it's pre-settle.
        _refresh_payout_status(cursor, _sale_id_of(cursor, lot_id))

        conn.commit()
        return {"message": "lot reverted to passed", "lot_id": lot_id, "position": row["position"]}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()

@router.post("/lots/{lot_id}/reopen")
def reopen_lot(lot_id: int, data: dict):
    """
    Rostrum correction: put a PASSED lot back ON THE BLOCK so bidding resumes.

    Covers both "I passed it by mistake" and "I hammered it with no qualifying
    bid (which your hammer logic records as passed)". The previous bids are
    PRESERVED — reopening resumes the lot where it left off, it does not wipe
    the ledger. If you want a clean restart instead, that's a different action
    (clear lot_bids) and is not what "reverse the pass" should mean.

    Limits (deliberate, to protect settlement integrity):
      - only the owning house
      - only while the sale is LIVE (a rostrum action; ended/settled is immutable)
      - only a lot currently in status 'passed'
      - refuses if ANOTHER lot is already on the block (one lot at a time),
        so the room's activeLot + ledger stay unambiguous
    It does not move money and does not touch sold/winner fields (a passed lot
    already has them null; we re-null defensively in case any path left stale data).
    """
    conn = None
    try:
        host = str(data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        # Lock the lot + its sale so a concurrent reveal/hammer can't race us.
        cursor.execute(
            """
            SELECT
                l.id,
                l.position,
                l.status AS lot_status,
                l.sale_id,
                a.host_username,
                a.status AS sale_status
            FROM lots l
            JOIN auctions a ON a.id = l.sale_id
            WHERE l.id = %s
            FOR UPDATE OF l, a
            """,
            (lot_id,),
        )
        row = cursor.fetchone()

        if not row:
            return {"error": "lot not found"}
        if row["host_username"] != host:
            return {"error": "not your sale"}
        if row["sale_status"] != "live":
            return {"error": "lots can only be reopened while the sale is live"}
        if row["lot_status"] != "passed":
            return {
                "error": (
                    "only a passed lot can be reopened. "
                    "A sold lot cannot be un-sold from the room — use the pre-settle "
                    "correction (revert_to_passed) before settling, or leave it sold."
                )
            }

        # One lot on the block at a time. If another lot is currently open,
        # refuse so the room never has two active lots.
        cursor.execute(
            "SELECT 1 FROM lots WHERE sale_id = %s AND status = 'on_block' AND id <> %s",
            (row["sale_id"], lot_id),
        )
        if cursor.fetchone():
            return {"error": "another lot is on the block. Hammer or pass it before reopening this one."}

        cursor.execute(
            """
            UPDATE lots
            SET
                status = 'on_block',
                hammer_at = NULL,
                sold_price = NULL,
                winner_username = NULL,
                payment_status = NULL,
                checkout_url = NULL,
                payment_reference = NULL,
                payment_updated_at = NULL
            WHERE id = %s
            """,
            (lot_id,),
        )
        # NOTE: lot_bids rows are intentionally NOT deleted — reopening resumes
        # the existing bidding history. The room's ledger refetches them on the
        # next poll because activeLot changes to this lot.

        conn.commit()
        return {
            "message": "reopened",
            "lot_id": lot_id,
            "position": row["position"],
        }

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()

def _sale_id_of(cursor, lot_id: int) -> int:
    cursor.execute("SELECT sale_id FROM lots WHERE id = %s", (lot_id,))
    r = cursor.fetchone()
    return int(r["sale_id"]) if r else 0

@router.get("/sales/{sale_id}/paddles")
def list_paddles(sale_id: int, viewer: str = ""):
    """
    Host-only paddle holder list.

    Returns tickets for this sale with:
      - username
      - display name / avatar if available
      - source: purchased | invited | complimentary | void
      - masked code
      - won lots count
      - won total

    The full paddle code is intentionally not returned here.
    The house receives the full code only at invite time.
    """
    conn = None
    try:
        host = str(viewer or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT host_username, status, ticket_capacity
            FROM auctions
            WHERE id = %s
            """,
            (sale_id,),
        )
        sale = cursor.fetchone()

        if not sale:
            return {"error": "sale not found"}

        if sale["host_username"] != host:
            return {"error": "not your sale"}

        cursor.execute(
            """
            SELECT
                t.id,
                t.user_name,
                t.source,
                t.code,
                t.purchased_at::text AS purchased_at,
                u.role,
                u.tier,
                p.display_name,
                p.avatar_url,
                (
                    SELECT COUNT(*)
                    FROM lots l
                    WHERE l.sale_id = %s
                      AND l.status = 'sold'
                      AND l.winner_username = t.user_name
                ) AS won_lots,
                (
                    SELECT COALESCE(SUM(l.sold_price), 0)::text
                    FROM lots l
                    WHERE l.sale_id = %s
                      AND l.status = 'sold'
                      AND l.winner_username = t.user_name
                ) AS won_total
            FROM tickets t
            LEFT JOIN users u ON u.username = t.user_name
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE t.auction_id = %s
            ORDER BY t.purchased_at DESC
            """,
            (sale_id, sale_id, sale_id),
        )

        rows = cursor.fetchall()
        out = []

        for r in rows:
            d = dict(r)

            # Never expose the full paddle code in the host list.
            code = d.pop("code", None)
            d["code_masked"] = f"••••{str(code)[-4:]}" if code else None

            out.append(d)

        return {
            "paddles": out,
            "capacity": sale["ticket_capacity"],
            "sold": len(out),
            "status": sale["status"],
        }

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.patch("/sales/{sale_id}")
def update_sale(sale_id: int, data: dict):
    """
    Control-room schedule / access / content editor. House-gated.
    tier is validated STRICTLY so a typo can't silently flip a VIP room to open.
    """
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status FROM auctions WHERE id = %s", (sale_id,))
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] == "ended":
            return {"error": "sale has ended"}

        sets, params = [], []

        if "title" in data:
            t = (data.get("title") or "").strip()
            if not t:
                return {"error": "title cannot be empty"}
            sets.append("title = %s")
            params.append(t)

        if "description" in data:
            sets.append("description = %s")
            params.append(data.get("description") or "")

        if "image_url" in data:
            sets.append("image_url = %s")
            params.append(data.get("image_url") or None)

        if "tier" in data:
            canon = ACCESS_ALIASES.get(str(data.get("tier") or "").strip().lower())
            if canon not in ACCESS_MODES:
                return {"error": "invalid access mode"}
            sets.append("tier = %s")
            params.append(canon)

        if "starts_at" in data:
            sets.append("starts_at = %s")
            params.append(data.get("starts_at") or None)

        if "ends_at" in data:
            sets.append("ends_at = %s")
            params.append(data.get("ends_at") or None)

        if "ticket_price" in data:
            try:
                tp = round(float(data.get("ticket_price") or 0), 2)
            except (TypeError, ValueError):
                return {"error": "invalid ticket_price"}
            if tp < 0:
                return {"error": "ticket_price cannot be negative"}
            sets.append("ticket_price = %s")
            params.append(tp)

        if "ticket_currency" in data:
            sets.append("ticket_currency = %s")
            params.append(_ccy(data.get("ticket_currency")))

        if "currency" in data:
            sets.append("currency = %s")
            params.append(_ccy(data.get("currency")))

        if "ticket_capacity" in data:
            cap, cap_err = _capacity_or_none(data.get("ticket_capacity"))
            if cap_err:
                return {"error": cap_err}
            sets.append("ticket_capacity = %s")
            params.append(cap)

        if not sets:
            return {"error": "nothing to update"}

        params.append(sale_id)
        cursor.execute(
            f"UPDATE auctions SET {', '.join(sets)} WHERE id = %s",
            tuple(params),
        )

        conn.commit()
        return {"message": "sale updated"}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/lots")
def add_lot(sale_id: int, data: dict):
    conn = None
    try:
        host = str(data.get("viewer") or "").strip()
        title = str(data.get("title") or "").strip()

        if not host:
            return {"error": "viewer required", "debug_marker": "safe_add_lot_v1"}
        if not title:
            return {"error": "title required", "debug_marker": "safe_add_lot_v1"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT host_username, status, currency FROM auctions WHERE id = %s",
            (sale_id,),
        )
        sale = cursor.fetchone()

        if not sale:
            return {"error": "sale not found", "debug_marker": "safe_add_lot_v1"}
        if sale["host_username"] != host:
            return {"error": "not your sale", "debug_marker": "safe_add_lot_v1"}
        if sale["status"] == "ended":
            return {"error": "sale has ended", "debug_marker": "safe_add_lot_v1"}

        cursor.execute(
            "SELECT COALESCE(MAX(position), 0) + 1 AS p FROM lots WHERE sale_id = %s",
            (sale_id,),
        )
        position = int(cursor.fetchone()["p"])

        def parse_money(key: str, required: bool = False, default_zero: bool = False):
            raw = data.get(key)

            if raw is None or raw == "":
                if required:
                    return None, f"{key} is required"
                if default_zero:
                    return 0.0, None
                return None, None

            try:
                value = round(float(raw), 2)
            except (TypeError, ValueError):
                return None, f"invalid {key}"

            if value < 0:
                return None, f"{key} cannot be negative"

            return value, None

        starting_price, err = parse_money("starting_price", default_zero=True)
        if err:
            return {"error": err, "debug_marker": "safe_add_lot_v1"}

        reserve, err = parse_money("reserve")
        if err:
            return {"error": err, "debug_marker": "safe_add_lot_v1"}

        estimate_low, err = parse_money("estimate_low")
        if err:
            return {"error": err, "debug_marker": "safe_add_lot_v1"}

        estimate_high, err = parse_money("estimate_high")
        if err:
            return {"error": err, "debug_marker": "safe_add_lot_v1"}

        if estimate_low is not None and estimate_high is not None and estimate_high < estimate_low:
            return {
                "error": "estimate_high cannot be lower than estimate_low",
                "debug_marker": "safe_add_lot_v1",
            }

        sale_currency = str(sale.get("currency") or "NGN").strip().upper() or "NGN"
        lot_currency = str(data.get("currency") or sale_currency).strip().upper() or sale_currency

        if len(lot_currency) != 3 or not lot_currency.isalpha():
            lot_currency = sale_currency

        cursor.execute(
            """
            INSERT INTO lots (
                sale_id,
                position,
                title,
                description,
                image_url,
                starting_price,
                reserve,
                estimate_low,
                estimate_high,
                currency,
                status
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'sealed')
            RETURNING id, position, title, status, currency
            """,
            (
                sale_id,
                position,
                title,
                str(data.get("description") or ""),
                data.get("image_url") or None,
                starting_price or 0.0,
                reserve,
                estimate_low,
                estimate_high,
                lot_currency,
            ),
        )

        lot = cursor.fetchone()
        conn.commit()

        return {
            "lot": dict(lot) if lot else {"position": position},
            "debug_marker": "safe_add_lot_v1",
        }

    except Exception as e:
        if conn:
            conn.rollback()

        import traceback
        traceback.print_exc()

        return {
            "error": f"add_lot failed: {e}",
            "debug_marker": "safe_add_lot_v1",
        }

    finally:
        if conn:
            conn.close()


@router.patch("/lots/{lot_id}")
def update_lot(lot_id: int, data: dict):
    """
    Host-only lot editor.

    Rules:
      - sealed lot: all fields editable
      - on_block lot: only presentation fields editable
      - sold/passed lot: immutable
      - ended sale: immutable
    """
    conn = None
    try:
        host = str(data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                l.id,
                l.sale_id,
                l.status AS lot_status,
                l.starting_price,
                l.reserve,
                l.estimate_low,
                l.estimate_high,
                l.currency,
                a.host_username,
                a.status AS sale_status,
                a.currency AS sale_currency
            FROM lots l
            JOIN auctions a ON a.id = l.sale_id
            WHERE l.id = %s
            """,
            (lot_id,),
        )
        lot = cursor.fetchone()

        if not lot:
            return {"error": "lot not found"}
        if lot["host_username"] != host:
            return {"error": "not your sale"}
        if lot["sale_status"] == "ended":
            return {"error": "sale has ended"}
        if lot["lot_status"] in ("sold", "passed"):
            return {"error": "this lot is finalized and cannot be edited"}

        sets, params = [], []

        def parse_money(key: str):
            raw = data.get(key)

            if raw is None or raw == "":
                return None, None

            try:
                value = round(float(raw), 2)
            except (TypeError, ValueError):
                return None, f"invalid {key}"

            if value < 0:
                return None, f"{key} cannot be negative"

            return value, None

        if "title" in data:
            title = str(data.get("title") or "").strip()
            if not title:
                return {"error": "title cannot be empty"}
            sets.append("title = %s")
            params.append(title)

        if "description" in data:
            sets.append("description = %s")
            params.append(str(data.get("description") or ""))

        if "image_url" in data:
            sets.append("image_url = %s")
            params.append(data.get("image_url") or None)

        if lot["lot_status"] == "on_block":
            forbidden = {"starting_price", "reserve", "currency", "position"}
            for key in forbidden:
                if key in data:
                    return {"error": f"{key} cannot be changed once the lot is on the block"}

        if "starting_price" in data:
            value, err = parse_money("starting_price")
            if err:
                return {"error": err}
            sets.append("starting_price = %s")
            params.append(value if value is not None else 0.0)

        if "reserve" in data:
            value, err = parse_money("reserve")
            if err:
                return {"error": err}
            sets.append("reserve = %s")
            params.append(value)

        if "estimate_low" in data:
            value, err = parse_money("estimate_low")
            if err:
                return {"error": err}
            sets.append("estimate_low = %s")
            params.append(value)

        if "estimate_high" in data:
            value, err = parse_money("estimate_high")
            if err:
                return {"error": err}
            sets.append("estimate_high = %s")
            params.append(value)

        if "currency" in data:
            sale_currency = str(lot.get("sale_currency") or "NGN").strip().upper() or "NGN"
            lot_currency = str(data.get("currency") or sale_currency).strip().upper() or sale_currency
            if len(lot_currency) != 3 or not lot_currency.isalpha():
                lot_currency = sale_currency
            sets.append("currency = %s")
            params.append(lot_currency)

        # Validate estimate range using incoming values if present, else existing.
        low_val, low_err = (
            parse_money("estimate_low")
            if "estimate_low" in data
            else (float(lot.get("estimate_low")) if lot.get("estimate_low") is not None else None, None)
        )
        high_val, high_err = (
            parse_money("estimate_high")
            if "estimate_high" in data
            else (float(lot.get("estimate_high")) if lot.get("estimate_high") is not None else None, None)
        )

        if low_err:
            return {"error": low_err}
        if high_err:
            return {"error": high_err}

        if low_val is not None and high_val is not None and high_val < low_val:
            return {"error": "estimate_high cannot be lower than estimate_low"}

        if not sets:
            return {"error": "nothing to update"}

        params.append(lot_id)
        cursor.execute(
            f"UPDATE lots SET {', '.join(sets)} WHERE id = %s RETURNING id, position, title, status, currency",
            tuple(params),
        )

        updated = cursor.fetchone()
        conn.commit()

        return {"lot": dict(updated) if updated else None, "message": "lot updated"}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/lots/{lot_id}/delete")
def delete_lot(lot_id: int, data: dict):
    """
    Host-only lot deletion.

    Allowed only while:
      - sale is upcoming
      - lot is sealed
      - lot has no bids

    Remaining lot positions are renumbered after deletion.
    """
    conn = None
    try:
        host = str(data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                l.id,
                l.sale_id,
                l.status AS lot_status,
                a.host_username,
                a.status AS sale_status
            FROM lots l
            JOIN auctions a ON a.id = l.sale_id
            WHERE l.id = %s
            """,
            (lot_id,),
        )
        lot = cursor.fetchone()

        if not lot:
            return {"error": "lot not found"}
        if lot["host_username"] != host:
            return {"error": "not your sale"}
        if lot["sale_status"] != "upcoming":
            return {"error": "lots can only be deleted before the sale goes live"}
        if lot["lot_status"] != "sealed":
            return {"error": "only sealed lots can be deleted"}

        cursor.execute(
            "SELECT 1 FROM lot_bids WHERE lot_id = %s LIMIT 1",
            (lot_id,),
        )
        if cursor.fetchone():
            return {"error": "this lot already has bids and cannot be deleted"}

        cursor.execute("DELETE FROM lots WHERE id = %s", (lot_id,))

        # Renumber remaining lots so the catalogue stays sequential.
        cursor.execute(
            """
            WITH ranked AS (
                SELECT id, ROW_NUMBER() OVER (ORDER BY position) AS rn
                FROM lots
                WHERE sale_id = %s
            )
            UPDATE lots l
            SET position = r.rn
            FROM ranked r
            WHERE l.id = r.id
            """,
            (lot["sale_id"],),
        )

        conn.commit()
        return {"message": "lot deleted", "lot_id": lot_id}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/sales/{sale_id}")
def get_sale(sale_id: int, viewer: str = "", code: str = ""):
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                a.id,
                a.host_username,
                a.title,
                a.description,
                a.image_url,
                a.tier,
                a.status,
                a.starts_at::text AS starts_at,
                a.ends_at::text AS ends_at,
                a.ended_at::text AS ended_at,
                a.ticket_price::text AS ticket_price,
                a.ticket_currency,
                a.currency,
                a.ticket_capacity,
                a.payout_status,
                a.settled_at::text AS settled_at,
                a.stream_type,
                a.stream_url,
                a.stream_peer_id,
                (
                    SELECT COUNT(*)
                    FROM tickets t
                    WHERE t.auction_id = a.id
                ) AS tickets_sold,
                CASE
                    WHEN a.ticket_capacity IS NULL THEN NULL
                    ELSE GREATEST(a.ticket_capacity - (
                        SELECT COUNT(*)
                        FROM tickets t2
                        WHERE t2.auction_id = a.id
                    ), 0)
                END AS tickets_remaining
            FROM auctions a
            WHERE a.id = %s
            """,
            (sale_id,),
        )
        sale = cursor.fetchone()

        if not sale:
            return {"error": "sale not found"}

        acc = auction_access(cursor, sale, viewer)
        if not acc["visible"]:
            return {"error": "this sale is private"}

        is_host = bool(viewer) and viewer == sale["host_username"]

        cursor.execute(
            "SELECT 1 FROM tickets WHERE auction_id = %s AND user_name = %s",
            (sale_id, viewer),
        )
        has_ticket = cursor.fetchone() is not None

        proved = False
        if code:
            cursor.execute(
                "SELECT 1 FROM tickets WHERE auction_id = %s AND code = %s AND user_name = %s",
                (sale_id, code.strip(), viewer),
            )
            proved = cursor.fetchone() is not None

        # Holding a ticket already proves you. Code is only the device-switch
        # escape hatch.
        allowed = is_host or has_ticket or proved
        meta = {
            **sale,
            "access_mode": sale.get("tier"),
            **acc,
            "is_host": is_host,
            "has_ticket": has_ticket,
            "locked": not allowed,
        }

        if not allowed:
            return {"sale": meta, "lots": []}

        cursor.execute(
            """
            SELECT
                l.id,
                l.position,
                l.title,
                l.description,
                l.image_url,
                l.starting_price::text AS starting_price,
                l.reserve::text AS reserve,
                l.estimate_low::text AS estimate_low,
                l.estimate_high::text AS estimate_high,
                l.currency,
                l.status,
                l.sold_price::text AS sold_price,
                l.winner_username,
                l.payment_status,
                l.checkout_url,
                l.payment_reference,
                l.payment_updated_at::text AS payment_updated_at,
                l.hammer_at::text AS hammer_at,
                (SELECT MAX(amount)::text FROM lot_bids b WHERE b.lot_id = l.id) AS current_bid,
                (SELECT COUNT(*) FROM lot_bids b WHERE b.lot_id = l.id) AS bid_count
            FROM lots l
            WHERE l.sale_id = %s
            ORDER BY l.position
            """,
            (sale_id,),
        )

        lots = cursor.fetchall()
        out_lots = []

        for l in lots:
            d = dict(l)

            # Blind rule: sealed content is omitted for everyone but the host.
            if d["status"] == "sealed" and not is_host:
                out_lots.append(
                    {
                        "id": d["id"],
                        "position": d["position"],
                        "status": "sealed",
                    }
                )
                continue

            winner = d.get("winner_username")

            # Reserve is house-sensitive. Never expose it to buyers, even after reveal.
            if not is_host:
                d.pop("reserve", None)

                # Payment status is only meaningful to the host and the winner.
                if winner != viewer:
                    d.pop("payment_status", None)

            # Checkout links are private to the winning buyer.
            # The host can see payment status in settlement, but should not receive
            # the buyer's Paystack authorization URL through the public sale view.
            if winner != viewer:
                d.pop("checkout_url", None)
                d.pop("payment_reference", None)
                d.pop("payment_updated_at", None)

            out_lots.append(d)

        return {"sale": meta, "lots": out_lots}

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/go_live")
def go_live(sale_id: int, data: dict):
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status FROM auctions WHERE id = %s", (sale_id,))
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] == "ended":
            return {"error": "sale has ended"}
        if row["status"] == "live":
            return {"message": "sale is already live"}

        cursor.execute("UPDATE auctions SET status='live' WHERE id = %s", (sale_id,))
        conn.commit()
        return {"message": "sale is live"}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/end")
def end_sale(sale_id: int, data: dict):
    """
    Rostrum 'close sale': stamps ended + ended_at=now.
    Required before settle. Refuses while a lot is still on the block.
    """
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status FROM auctions WHERE id = %s", (sale_id,))
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] == "ended":
            return {"message": "sale already ended"}
        if row["status"] != "live":
            return {"error": "only a live sale can be ended"}

        cursor.execute(
            "SELECT 1 FROM lots WHERE sale_id = %s AND status = 'on_block'",
            (sale_id,),
        )
        if cursor.fetchone():
            return {"error": "hammer or pass the current lot before ending the sale"}

        cursor.execute(
            """
            UPDATE auctions
            SET status = 'ended',
                ended_at = CURRENT_TIMESTAMP,
                ends_at = COALESCE(ends_at, CURRENT_TIMESTAMP)
            WHERE id = %s
            """,
            (sale_id,),
        )
        conn.commit()
        return {"message": "sale ended"}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/reveal_next")
def reveal_next(sale_id: int, data: dict):
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status FROM auctions WHERE id = %s", (sale_id,))
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] != "live":
            return {"error": "sale is not live"}

        # One lot on the block at a time.
        cursor.execute(
            "SELECT 1 FROM lots WHERE sale_id = %s AND status = 'on_block'",
            (sale_id,),
        )
        if cursor.fetchone():
            return {"error": "hammer or pass the current lot before revealing the next"}

        cursor.execute(
            """
            SELECT id
            FROM lots
            WHERE sale_id = %s AND status = 'sealed'
            ORDER BY position
            LIMIT 1
            """,
            (sale_id,),
        )
        nxt = cursor.fetchone()
        if not nxt:
            return {"error": "no sealed lots left"}

        cursor.execute(
            "UPDATE lots SET status='on_block' WHERE id = %s RETURNING id, position",
            (nxt["id"],),
        )
        lot = cursor.fetchone()
        conn.commit()
        return {"lot": lot}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/lots/{lot_id}/hammer")
def hammer_lot(lot_id: int, data: dict):
    """
    Close the on-block lot: SOLD to the top bidder at/above reserve, else PASSED.
    """
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                l.status AS lot_status,
                l.reserve,
                a.host_username,
                a.status AS sale_status
            FROM lots l
            JOIN auctions a ON a.id = l.sale_id
            WHERE l.id = %s
            """,
            (lot_id,),
        )
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["sale_status"] != "live":
            return {"error": "sale is not live"}
        if row["lot_status"] != "on_block":
            return {"error": "lot is not on the block"}

        cursor.execute(
            """
            SELECT user_name, amount
            FROM lot_bids
            WHERE lot_id = %s
            ORDER BY amount DESC, id DESC
            LIMIT 1
            """,
            (lot_id,),
        )
        win = cursor.fetchone()
        reserve = row["reserve"]

        if not win:
            cursor.execute(
                """
                UPDATE lots
                SET status = 'passed',
                    hammer_at = CURRENT_TIMESTAMP
                WHERE id = %s
                """,
                (lot_id,),
            )
            conn.commit()
            return {"message": "passed", "reason": "no bids"}

        top_user, top_amt = win["user_name"], win["amount"]

        if reserve is not None and top_amt < reserve:
            cursor.execute(
                """
                UPDATE lots
                SET status = 'passed',
                    hammer_at = CURRENT_TIMESTAMP
                WHERE id = %s
                """,
                (lot_id,),
            )
            conn.commit()
            return {
                "message": "passed",
                "reason": "below reserve",
                "reserve": str(reserve),
            }

        cursor.execute(
            """
            UPDATE lots
            SET status = 'sold',
                sold_price = %s,
                winner_username = %s,
                hammer_at = CURRENT_TIMESTAMP
            WHERE id = %s
            """,
            (top_amt, top_user, lot_id),
        )
        conn.commit()
        return {"message": "sold", "sold_price": str(top_amt), "winner": top_user}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/lots/{lot_id}/pass")
def pass_lot(lot_id: int, data: dict):
    """
    Manually pass the current on-block lot.

    This is the auctioneer's "no sale" button.
    It marks the lot as passed and stamps hammer_at.
    """
    conn = None
    try:
        host = str(data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                l.status AS lot_status,
                a.host_username,
                a.status AS sale_status
            FROM lots l
            JOIN auctions a ON a.id = l.sale_id
            WHERE l.id = %s
            """,
            (lot_id,),
        )
        row = cursor.fetchone()

        if not row or row["host_username"] != host:
            return {"error": "not your sale"}

        if row["sale_status"] != "live":
            return {"error": "sale is not live"}

        if row["lot_status"] != "on_block":
            return {"error": "lot is not on the block"}

        cursor.execute(
            """
            UPDATE lots
            SET status = 'passed',
                hammer_at = CURRENT_TIMESTAMP
            WHERE id = %s
            """,
            (lot_id,),
        )

        conn.commit()
        return {"message": "passed", "lot_id": lot_id}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/lots/{lot_id}/bid")
def bid_on_lot(lot_id: int, data: dict):
    conn = None
    try:
        viewer = (data.get("viewer") or "").strip()
        if not viewer:
            return {"error": "viewer required"}

        try:
            amount = round(float(data.get("amount", 0)), 2)
        except (TypeError, ValueError):
            return {"error": "invalid amount"}

        if amount <= 0:
            return {"error": "bid must be positive"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                l.status AS lot_status,
                l.sale_id,
                l.starting_price,
                l.currency,
                a.status AS sale_status,
                a.tier,
                a.host_username
            FROM lots l
            JOIN auctions a ON a.id = l.sale_id
            WHERE l.id = %s
            """,
            (lot_id,),
        )
        row = cursor.fetchone()
        if not row:
            return {"error": "lot not found"}
        if row["lot_status"] != "on_block":
            return {"error": "this lot is not on the block"}
        if row["sale_status"] != "live":
            return {"error": "the sale is not live"}

        acc = auction_access(
            cursor,
            {
                "id": row["sale_id"],
                "tier": row["tier"],
                "host_username": row["host_username"],
            },
            viewer,
        )

        if not acc["can_bid"]:
            return {"error": "you do not have bidding rights here"}

        # Lock the lot row so two simultaneous bids cannot both think they are the new top bid.
        cursor.execute(
            "SELECT id FROM lots WHERE id = %s FOR UPDATE",
            (lot_id,),
        )

        cursor.execute(
            "SELECT COALESCE(MAX(amount), 0) AS top FROM lot_bids WHERE lot_id = %s",
            (lot_id,),
        )
        top = float(cursor.fetchone()["top"] or 0)
        floor = max(top, float(row["starting_price"] or 0))

        if amount <= floor:
            return {"error": f"bid must exceed {floor}"}

        cursor.execute(
            """
            INSERT INTO lot_bids (lot_id, user_name, amount, currency)
            VALUES (%s, %s, %s, %s)
            RETURNING
                id,
                user_name,
                amount::text AS amount,
                currency,
                created_at::text AS created_at
            """,
            (lot_id, viewer, amount, _ccy(row["currency"])),
        )

        bid = cursor.fetchone()
        conn.commit()

        return {
            "message": "bid placed",
            "bid": dict(bid),
            "current_bid": str(bid["amount"]),
        }

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/lots/{lot_id}/bids")
def lot_bids_feed(lot_id: int, since: int = 0):
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, user_name, amount::text AS amount, created_at::text AS created_at
            FROM lot_bids
            WHERE lot_id = %s AND id > %s
            ORDER BY id
            """,
            (lot_id, since),
        )
        rows = cursor.fetchall()
        return {"bids": rows}

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/enter")
def enter_sale(sale_id: int, data: dict):
    """
    Room entry by paddle code. This is the manual/device-switch path.
    Normal logged-in users can enter through get_sale because has_ticket is enough.
    """
    conn = None
    try:
        viewer = (data.get("viewer") or "").strip()
        code = (data.get("code") or "").strip()

        if not viewer:
            return {"error": "viewer required"}
        if not code:
            return {"error": "paddle code required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status FROM auctions WHERE id = %s", (sale_id,))
        sale = cursor.fetchone()
        if not sale:
            return {"error": "sale not found"}

        if viewer == sale["host_username"]:
            return {"ok": True}

        cursor.execute(
            "SELECT user_name FROM tickets WHERE auction_id = %s AND code = %s",
            (sale_id, code),
        )
        row = cursor.fetchone()
        if not row:
            return {"error": "That paddle number isn't valid for this room."}
        if row["user_name"] != viewer:
            return {"error": "Tickets are unique to one account."}

        return {"ok": True}

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/ticket")
def issue_paddle(sale_id: int, data: dict):
    conn = None
    try:
        viewer = (data.get("viewer") or "").strip()
        if not viewer:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                id,
                host_username,
                title,
                tier,
                status,
                ticket_price::text AS ticket_price,
                ticket_currency,
                ticket_capacity
            FROM auctions
            WHERE id = %s
            FOR UPDATE
            """,
            (sale_id,),
        )
        row = cursor.fetchone()
        if not row:
            return {"error": "sale not found"}
        if row["status"] == "ended":
            return {"error": "sale has ended"}

        # Host-shill block: a house may not buy a paddle for its own room and
        # bid its own lots.
        if viewer == row["host_username"]:
            return {"error": "houses cannot hold a paddle in their own room"}

        acc = auction_access(cursor, row, viewer)
        if not acc["can_buy_ticket"]:
            return {"error": "you are not permitted to claim a paddle for this sale"}

        cursor.execute(
            "SELECT 1 FROM tickets WHERE auction_id = %s AND user_name = %s",
            (sale_id, viewer),
        )
        if cursor.fetchone():
            return {"error": "you already hold a paddle for this room"}

        cap = row["ticket_capacity"]
        if cap is not None:
            cursor.execute(
                "SELECT COUNT(*)::int AS c FROM tickets WHERE auction_id = %s",
                (sale_id,),
            )
            if cursor.fetchone()["c"] >= int(cap):
                return {"error": "this room is sold out"}

        price = float(row["ticket_price"] or 0)
        ticket_ccy = _ccy(row["ticket_currency"])

        if price > 0:
            # Per-currency debit: a buyer's NGN cannot pay a USD paddle fee.
            ok, err, _ = spend(
                cursor,
                viewer,
                price,
                "ticket_purchase",
                f"Paddle · {row['title']}",
                "auctions",
                sale_id,
                currency=ticket_ccy,
            )
            if not ok:
                return {"error": err}

        code = ""
        for _ in range(6):
            c = f"{secrets.randbelow(900000) + 100000}"
            cursor.execute("SELECT 1 FROM tickets WHERE code = %s", (c,))
            if not cursor.fetchone():
                code = c
                break

        if not code:
            return {"error": "could not mint a paddle, try again"}

        cursor.execute(
            """
            INSERT INTO tickets (auction_id, user_name, code, source)
            VALUES (%s, %s, %s, 'purchased')
            """,
            (sale_id, viewer, code),
        )

        conn.commit()
        return {
            "message": "paddle issued",
            "code": code,
            "price": f"{price:.2f}",
            "currency": ticket_ccy,
            "charged": price > 0,
        }

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/invite")
def invite_paddle(sale_id: int, data: dict):
    """
    House ISSUES a paddle to a named user.

    Unified issuance: an invited paddle is a ticket row with source='invited',
    price 0 — same credential a purchase mints, so the door treats them identically.
    """
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        target_raw = (data.get("user_name") or "").strip()

        if not host:
            return {"error": "viewer required"}
        if not target_raw:
            return {"error": "user_name required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT host_username, title, status FROM auctions WHERE id = %s FOR UPDATE",
            (sale_id,),
        )
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] == "ended":
            return {"error": "sale has ended"}

        cursor.execute("SELECT username FROM users WHERE username = %s", (target_raw,))
        u = cursor.fetchone()
        if not u:
            cursor.execute(
                "SELECT username FROM users WHERE lower(username) = lower(%s)",
                (target_raw,),
            )
            u = cursor.fetchone()
        if not u:
            return {"error": "unknown user"}

        target = u["username"]
        if target == host:
            return {"error": "cannot invite yourself to your own room"}

        cursor.execute(
            "SELECT 1 FROM tickets WHERE auction_id = %s AND user_name = %s",
            (sale_id, target),
        )
        if cursor.fetchone():
            return {"error": "that user already holds a paddle here"}

        cursor.execute("SELECT ticket_capacity FROM auctions WHERE id = %s", (sale_id,))
        cr = cursor.fetchone()
        cap = cr["ticket_capacity"] if cr else None
        if cap is not None:
            cursor.execute(
                "SELECT COUNT(*)::int AS c FROM tickets WHERE auction_id = %s",
                (sale_id,),
            )
            if cursor.fetchone()["c"] >= int(cap):
                return {"error": "this room is sold out"}

        code = ""
        for _ in range(6):
            c = f"{secrets.randbelow(900000) + 100000}"
            cursor.execute("SELECT 1 FROM tickets WHERE code = %s", (c,))
            if not cursor.fetchone():
                code = c
                break

        if not code:
            return {"error": "could not mint a paddle, try again"}

        cursor.execute(
            """
            INSERT INTO tickets (auction_id, user_name, code, source)
            VALUES (%s, %s, %s, 'invited')
            """,
            (sale_id, target, code),
        )

        create_notification(
            user_name=target,
            category="auctions",
            type="paddle_invited",
            title=f"You're invited to {row['title']}",
            body="The house issued you a paddle for this room.",
            actor=host,
            source_type="sale",
            source_id=sale_id,
            # Safer for production: do not store the full code in notification payload.
            # The invited user can enter by account, and the house received the code once.
            data={"sale_id": sale_id},
            cursor=cursor,
        )

        conn.commit()
        return {"message": "paddle issued", "user_name": target, "code": code}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


# ---------------------------------------------------------------------------
# Settlement (Flow A, house-net).
#
# settle computes + queues collection; the rail (webhook) moves the money.
# With no Paystack keys, settle still runs fully and leaves lots 'unpaid'
# (collection pending) — developable today.
# ---------------------------------------------------------------------------
def _winner_emails(cursor, winners):
    if not winners:
        return {}
    ph = ",".join(["%s"] * len(winners))
    cursor.execute(f"SELECT username, email FROM users WHERE username IN ({ph})", tuple(winners))
    return {r["username"]: r["email"] for r in cursor.fetchall()}


def _attempt_settle_charges(cursor, sale, won):
    """
    Initiate one Paystack charge per won lot (hammer + premium) for lots not yet paid.

    Returns (initiated, awaiting, outcomes). Safe to call again from /collect once
    keys exist: it only touches unpaid/failed lots, so a paid lot is never re-charged.

    Important:
    paystack.initialize_charge must convert money to Paystack minor units server-side.
    The browser must never call https://api.paystack.co directly.
    """
    initiated = 0
    awaiting = 0
    outcomes = []

    emails = _winner_emails(cursor, list({w["winner_username"] for w in won}))
    sale_ccy = _ccy(sale["currency"])

    for w in won:
        hammer = float(w["sold_price"] or 0)
        premium = round(hammer * BUYER_PREMIUM_RATE, 2)
        collected = round(hammer + premium, 2)
        commission = round(collected * PLATFORM_COMMISSION_RATE, 2)
        net = round(collected - commission, 2)

        base = {
            "lot_id": w["id"],
            "position": w["position"],
            "winner": w["winner_username"],
            "hammer": f"{hammer:.2f}",
            "premium": f"{premium:.2f}",
            "collected": f"{collected:.2f}",
            "commission": f"{commission:.2f}",
            "net_to_house": f"{net:.2f}",
            "currency": sale_ccy,
        }

        if w.get("payment_status") == "paid":
            outcomes.append({**base, "status": "paid"})
            continue

        email = emails.get(w["winner_username"])
        if not email:
            awaiting += 1
            outcomes.append({**base, "status": "unpaid", "reason": "winner has no email on file"})
            continue

        ref = f"settle_{sale['id']}_{w['id']}_{secrets.token_hex(4)}"

        resp = paystack.initialize_charge(
            email=email,
            amount=collected,
            currency=sale_ccy,
            reference=ref,
            metadata={
                "kind": "settle_charge",
                "sale_id": sale["id"],
                "lot_id": w["id"],
                "winner": w["winner_username"],
                "hammer": base["hammer"],
                "premium": base["premium"],
                "commission": base["commission"],
                "net_to_house": base["net_to_house"],
            },
        )

        if resp.get("status") and (resp.get("data") or {}).get("authorization_url"):
            initiated += 1
            checkout_url = resp["data"]["authorization_url"]

            cursor.execute(
                """
                UPDATE lots
                SET payment_status = 'pending',
                    checkout_url = %s,
                    payment_reference = %s,
                    payment_updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
                """,
                (checkout_url, ref, w["id"]),
            )

            outcomes.append(
                {
                    **base,
                    "status": "pending",
                    "checkout": checkout_url,
                    "payment_reference": ref,
                }
            )
        else:
            awaiting += 1
            reason = resp.get("error") or resp.get("message") or "charge not initiated"

            # Do not mark failed when Paystack is simply not configured.
            # Keep the lot unpaid so /collect can retry later.
            outcomes.append({**base, "status": "unpaid", "reason": reason})

    return initiated, awaiting, outcomes


@router.post("/sales/{sale_id}/settle")
def settle_sale(sale_id: int, data: dict):
    """
    Compute the Flow A house-net split for an ENDED sale, send the notices, and
    queue collection (one charge per won lot).

    Idempotent on the math via settled_at; collection is retried via /collect
    once the rail is configured.

    No consignor, no house-wallet debit — commission is withheld from the payout.
    """
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT id, host_username, title, status, settled_at, currency, ticket_currency
            FROM auctions
            WHERE id = %s
            FOR UPDATE
            """,
            (sale_id,),
        )
        sale = cursor.fetchone()
        if not sale or sale["host_username"] != host:
            return {"error": "not your sale"}
        if sale["status"] != "ended":
            return {"error": "end the sale before settling"}
        if sale["settled_at"] is not None:
            return {"error": "already settled (use /collect to retry payment)"}

        cursor.execute(
            """
            SELECT id, position, sold_price, winner_username, payment_status
            FROM lots
            WHERE sale_id = %s
              AND status = 'sold'
              AND winner_username IS NOT NULL
            ORDER BY position
            """,
            (sale_id,),
        )
        won = [dict(r) for r in cursor.fetchall()]

        if not won:
            cursor.execute(
                "UPDATE auctions SET settled_at = CURRENT_TIMESTAMP, payout_status = 'none' WHERE id = %s",
                (sale_id,),
            )
            conn.commit()
            return {"message": "settled", "lots_sold": 0, "note": "no winning lots"}

        initiated, awaiting, outcomes = _attempt_settle_charges(cursor, sale, won)
        by_lot = {o["lot_id"]: o for o in outcomes}

        hammer_total = round(sum(float(w["sold_price"] or 0) for w in won), 2)
        premium_total = round(sum(float(by_lot[w["id"]]["premium"]) for w in won), 2)
        collected_total = round(sum(float(by_lot[w["id"]]["collected"]) for w in won), 2)
        commission_total = round(sum(float(by_lot[w["id"]]["commission"]) for w in won), 2)
        net_total = round(sum(float(by_lot[w["id"]]["net_to_house"]) for w in won), 2)

        # Notices sent ONCE (guarded by settled_at).
        for w in won:
            o = by_lot[w["id"]]

            if o["status"] == "pending":
                body = (
                    f"Hammer {o['hammer']}. Buyer's premium {o['premium']}. "
                    f"Total {o['collected']} {o['currency']}. "
                    "A secure payment link has been sent to your email."
                )
            elif o["status"] == "paid":
                body = (
                    f"Hammer {o['hammer']}. Buyer's premium {o['premium']}. "
                    f"Total {o['collected']} {o['currency']} — paid."
                )
            else:
                body = (
                    f"Hammer {o['hammer']}. Buyer's premium {o['premium']}. "
                    f"Total {o['collected']} {o['currency']} — payment will be requested shortly."
                )

            create_notification(
                user_name=w["winner_username"],
                category="auctions",
                type="lot_won",
                title=f"You won Lot {w['position']} · {sale['title']}",
                body=body,
                actor=host,
                source_type="sale",
                source_id=sale_id,
                secondary_id=w["id"],
                data={
                    "sale_id": sale_id,
                    "lot_id": w["id"],
                    **{
                        k: o[k]
                        for k in (
                            "hammer",
                            "premium",
                            "collected",
                            "commission",
                            "net_to_house",
                            "currency",
                            "status",
                        )
                    },
                },
                cursor=cursor,
            )

        create_notification(
            user_name=host,
            category="wallet",
            type="settlement_complete",
            title=f"Settlement · {sale['title']}",
            body=(
                f"{len(won)} lots · hammer {hammer_total} · premium {premium_total} · "
                f"collected {collected_total} {_ccy(sale['currency'])} · "
                f"platform commission {commission_total} (withheld from payout) · "
                f"net to house {net_total}. "
                + (
                    f"{initiated} payment link(s) sent; {awaiting} awaiting collection."
                    if initiated
                    else "Collection pending — set Paystack keys, then run /collect."
                )
            ),
            actor=None,
            source_type="sale",
            source_id=sale_id,
            data={
                "sale_id": sale_id,
                "lots_sold": len(won),
                "hammer_total": f"{hammer_total:.2f}",
                "premium_total": f"{premium_total:.2f}",
                "collected_total": f"{collected_total:.2f}",
                "commission_total": f"{commission_total:.2f}",
                "net_to_house": f"{net_total:.2f}",
                "charges_initiated": initiated,
                "awaiting_collection": awaiting,
                "currency": _ccy(sale["currency"]),
            },
            cursor=cursor,
        )

        cursor.execute(
            "UPDATE auctions SET settled_at = CURRENT_TIMESTAMP WHERE id = %s",
            (sale_id,),
        )
        payout_status = _refresh_payout_status(cursor, sale_id)
        conn.commit()

        return {
            "message": "settled",
            "lots_sold": len(won),
            "hammer_total": f"{hammer_total:.2f}",
            "premium_total": f"{premium_total:.2f}",
            "collected_total": f"{collected_total:.2f}",
            "commission_total": f"{commission_total:.2f}",
            "net_to_house": f"{net_total:.2f}",
            "charges_initiated": initiated,
            "awaiting_collection": awaiting,
            "payout_status": payout_status,
            "collection_state": "pending" if initiated else "awaiting_rail",
            "outcomes": outcomes,
        }

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/collect")
def collect_sale(sale_id: int, data: dict):
    """
    Retry collection for a settled sale whose lots are still unpaid.

    Example: the first settle ran before Paystack keys existed. This re-attempts
    charges only — it does NOT recompute the split or resend notices.
    """
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT id, host_username, title, status, settled_at, currency, ticket_currency
            FROM auctions
            WHERE id = %s
            FOR UPDATE
            """,
            (sale_id,),
        )
        sale = cursor.fetchone()
        if not sale or sale["host_username"] != host:
            return {"error": "not your sale"}
        if sale["settled_at"] is None:
            return {"error": "settle the sale first"}

        cursor.execute(
            """
            SELECT id, position, sold_price, winner_username, payment_status
            FROM lots
            WHERE sale_id = %s
              AND status = 'sold'
              AND winner_username IS NOT NULL
              AND payment_status IN ('unpaid', 'failed')
            ORDER BY position
            """,
            (sale_id,),
        )
        due = [dict(r) for r in cursor.fetchall()]

        if not due:
            payout_status = _refresh_payout_status(cursor, sale_id)
            conn.commit()
            return {
                "message": "nothing to collect",
                "charges_initiated": 0,
                "awaiting_collection": 0,
                "payout_status": payout_status,
                "outcomes": [],
            }

        initiated, awaiting, outcomes = _attempt_settle_charges(cursor, sale, due)
        payout_status = _refresh_payout_status(cursor, sale_id)
        conn.commit()

        return {
            "message": "collection retried",
            "charges_initiated": initiated,
            "awaiting_collection": awaiting,
            "payout_status": payout_status,
            "outcomes": outcomes,
        }

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/sales/{sale_id}/settlement")
def settlement_view(sale_id: int, viewer: str = ""):
    """
    Host-only settlement preview.

    This does NOT mutate anything. It only computes the Flow A house-net split
    for won lots and returns payment status so the control room can display it.
    """
    conn = None
    try:
        host = str(viewer or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                id,
                host_username,
                title,
                status,
                currency,
                ticket_currency,
                settled_at::text AS settled_at,
                ended_at::text AS ended_at,
                payout_status,
                payout_reference
            FROM auctions
            WHERE id = %s
            """,
            (sale_id,),
        )

        sale = cursor.fetchone()

        if not sale:
            return {"error": "sale not found"}

        if sale["host_username"] != host:
            return {"error": "not your sale"}

        cursor.execute(
            """
            SELECT
                id,
                position,
                title,
                sold_price::text AS sold_price,
                winner_username,
                payment_status,
                hammer_at::text AS hammer_at,
                currency
            FROM lots
            WHERE sale_id = %s
              AND status = 'sold'
              AND winner_username IS NOT NULL
            ORDER BY position
            """,
            (sale_id,),
        )

        rows = cursor.fetchall()

        sale_currency = _ccy(sale.get("currency"))

        lots = []

        hammer_total = 0.0
        premium_total = 0.0
        collected_total = 0.0
        commission_total = 0.0
        net_total = 0.0

        counts = {
            "paid": 0,
            "pending": 0,
            "unpaid": 0,
            "failed": 0,
        }

        for r in rows:
            d = dict(r)

            hammer = float(d.get("sold_price") or 0)
            premium = round(hammer * BUYER_PREMIUM_RATE, 2)
            collected = round(hammer + premium, 2)
            commission = round(collected * PLATFORM_COMMISSION_RATE, 2)
            net = round(collected - commission, 2)

            payment_status = str(d.get("payment_status") or "unpaid").strip().lower()
            if payment_status not in counts:
                payment_status = "unpaid"

            counts[payment_status] += 1

            lot_currency = _ccy(d.get("currency") or sale_currency)

            d.update(
                {
                    "hammer": f"{hammer:.2f}",
                    "premium": f"{premium:.2f}",
                    "collected": f"{collected:.2f}",
                    "commission": f"{commission:.2f}",
                    "net_to_house": f"{net:.2f}",
                    "currency": lot_currency,
                    "payment_status": payment_status,
                }
            )

            lots.append(d)

            hammer_total = round(hammer_total + hammer, 2)
            premium_total = round(premium_total + premium, 2)
            collected_total = round(collected_total + collected, 2)
            commission_total = round(commission_total + commission, 2)
            net_total = round(net_total + net, 2)

        settled = sale.get("settled_at") is not None

        if not settled:
            collection_state = "not_settled"
        elif len(lots) == 0:
            collection_state = "collected"
        elif counts["paid"] == len(lots):
            collection_state = "collected"
        elif counts["pending"] > 0:
            collection_state = "pending"
        elif counts["unpaid"] + counts["failed"] > 0:
            collection_state = "awaiting_collection"
        else:
            collection_state = "none"

        return {
            "sale": dict(sale),
            "lots": lots,
            "totals": {
                "hammer_total": f"{hammer_total:.2f}",
                "premium_total": f"{premium_total:.2f}",
                "collected_total": f"{collected_total:.2f}",
                "commission_total": f"{commission_total:.2f}",
                "net_to_house": f"{net_total:.2f}",
                "currency": sale_currency,
            },
            "counts": counts,
            "settled": settled,
            "collection_state": collection_state,
            "rates": {
                "buyer_premium_rate": BUYER_PREMIUM_RATE,
                "platform_commission_rate": PLATFORM_COMMISSION_RATE,
            },
        }

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/my/won-lots")
def my_won_lots(viewer: str = ""):
    """
    Buyer-facing won lots.

    Returns sold lots where the signed-in user is the winner.
    Includes sale info, hammer/premium/total, payment status,
    and checkout URL if one was generated by settlement.

    Important:
    The browser must never call https://api.paystack.co directly.
    It may only open the checkout_url returned by this backend endpoint.
    """
    conn = None
    try:
        buyer = str(viewer or "").strip()
        if not buyer:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                l.id AS lot_id,
                l.position,
                l.title AS lot_title,
                l.description AS lot_description,
                l.image_url AS lot_image_url,
                l.sold_price::text AS hammer,
                l.currency AS lot_currency,
                l.payment_status,
                l.checkout_url,
                l.payment_reference,
                l.payment_updated_at::text AS payment_updated_at,
                l.hammer_at::text AS hammered_at,

                a.id AS sale_id,
                a.title AS sale_title,
                a.host_username,
                a.status AS sale_status,
                a.currency AS sale_currency,
                a.settled_at::text AS settled_at
            FROM lots l
            JOIN auctions a ON a.id = l.sale_id
            WHERE l.winner_username = %s
              AND l.status = 'sold'
            ORDER BY a.created_at DESC, l.position ASC
            """,
            (buyer,),
        )

        rows = cursor.fetchall()

        lots = []

        total_hammer = 0.0
        total_premium = 0.0
        total_collected = 0.0
        total_paid = 0.0
        total_outstanding = 0.0

        for r in rows:
            d = dict(r)

            sale_ccy = _ccy(d.get("sale_currency") or d.get("lot_currency"))
            hammer = float(d.get("hammer") or 0)
            premium = round(hammer * BUYER_PREMIUM_RATE, 2)
            collected = round(hammer + premium, 2)

            payment_status = str(d.get("payment_status") or "unpaid").strip().lower()
            if payment_status not in {"paid", "pending", "unpaid", "failed"}:
                payment_status = "unpaid"

            d.update(
                {
                    "currency": sale_ccy,
                    "hammer": f"{hammer:.2f}",
                    "premium": f"{premium:.2f}",
                    "collected": f"{collected:.2f}",
                    "payment_status": payment_status,
                }
            )

            lots.append(d)

            total_hammer = round(total_hammer + hammer, 2)
            total_premium = round(total_premium + premium, 2)
            total_collected = round(total_collected + collected, 2)

            if payment_status == "paid":
                total_paid = round(total_paid + collected, 2)
            else:
                total_outstanding = round(total_outstanding + collected, 2)

        first = dict(rows[0]) if rows else {}
        summary_currency = _ccy(first.get("sale_currency") or DEFAULT_CCY)

        return {
            "lots": lots,
            "summary": {
                "count": len(lots),
                "total_hammer": f"{total_hammer:.2f}",
                "total_premium": f"{total_premium:.2f}",
                "total_collected": f"{total_collected:.2f}",
                "total_paid": f"{total_paid:.2f}",
                "total_outstanding": f"{total_outstanding:.2f}",
                "currency": summary_currency,
            },
            "rates": {
                "buyer_premium_rate": BUYER_PREMIUM_RATE,
            },
        }

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/house/payout")
def get_house_payout(viewer: str = ""):
    """
    Host-only payout profile read.

    Returns the house's saved payout destination, if any.
    """
    conn = None
    try:
        host = str(viewer or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT role FROM users WHERE username = %s", (host,))
        u = cursor.fetchone()

        if not u or u["role"] != "house":
            return {"error": "only accredited houses may manage payout settings"}

        cursor.execute(
            "SELECT * FROM house_payout_profiles WHERE user_name = %s",
            (host,),
        )
        row = cursor.fetchone()

        return {"profile": dict(row) if row else None}

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/house/payout")
def upsert_house_payout(data: dict):
    """
    Host-only payout profile upsert.

    Stores bank details for later payout transfers. This does not move money.
    """
    conn = None
    try:
        host = str(data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        business_name = str(data.get("business_name") or "").strip()
        bank_code = str(data.get("bank_code") or "").strip().upper()
        account_number = str(data.get("account_number") or "").strip()
        account_name = str(data.get("account_name") or "").strip()
        currency = _ccy(data.get("currency"))

        subaccount = str(data.get("paystack_subaccount_code") or "").strip() or None
        recipient = str(data.get("paystack_recipient_code") or "").strip() or None

        if not business_name:
            return {"error": "business_name is required"}
        if len(business_name) > 160:
            return {"error": "business_name is too long"}

        if not bank_code:
            return {"error": "bank_code is required"}
        if not (3 <= len(bank_code) <= 12) or not all(ch.isalnum() for ch in bank_code):
            return {"error": "bank_code must be 3-12 letters/numbers"}

        if not account_number:
            return {"error": "account_number is required"}
        if not (7 <= len(account_number) <= 20) or not account_number.isdigit():
            return {"error": "account_number must be 7-20 digits"}

        if not account_name:
            return {"error": "account_name is required"}
        if len(account_name) > 160:
            return {"error": "account_name is too long"}

        if subaccount and not subaccount.upper().startswith("SUB_"):
            return {"error": "paystack_subaccount_code should start with SUB_"}

        if recipient and not recipient.upper().startswith("BT_"):
            return {"error": "paystack_recipient_code should start with BT_"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT role FROM users WHERE username = %s", (host,))
        u = cursor.fetchone()

        if not u or u["role"] != "house":
            return {"error": "only accredited houses may manage payout settings"}

        status = "ready"

        cursor.execute(
            """
            INSERT INTO house_payout_profiles (
                user_name,
                business_name,
                bank_code,
                account_number,
                account_name,
                currency,
                paystack_subaccount_code,
                paystack_recipient_code,
                status
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (user_name) DO UPDATE SET
                business_name = EXCLUDED.business_name,
                bank_code = EXCLUDED.bank_code,
                account_number = EXCLUDED.account_number,
                account_name = EXCLUDED.account_name,
                currency = EXCLUDED.currency,
                paystack_subaccount_code = EXCLUDED.paystack_subaccount_code,
                paystack_recipient_code = EXCLUDED.paystack_recipient_code,
                status = EXCLUDED.status,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
            """,
            (
                host,
                business_name,
                bank_code,
                account_number,
                account_name,
                currency,
                subaccount,
                recipient,
                status,
            ),
        )

        row = cursor.fetchone()
        conn.commit()

        return {
            "message": "payout profile saved",
            "profile": dict(row) if row else None,
        }

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/sales/{sale_id}/payout")
def sale_payout_view(sale_id: int, viewer: str = ""):
    """
    Host-only payout view for one sale.

    This reuses settlement_view and adds the house payout profile.
    """
    base = settlement_view(sale_id, viewer)

    if base.get("error"):
        return base

    sale = base.get("sale") or {}
    host = str(sale.get("host_username") or "").strip()

    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT * FROM house_payout_profiles WHERE user_name = %s",
            (host,),
        )
        row = cursor.fetchone()

        base["payout_profile"] = dict(row) if row else None
        return base

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/payout/mark_paid")
def mark_payout_paid(sale_id: int, data: dict):
    """
    Host-only manual payout marker.

    This is for offline/local settlement. It only marks the sale payout as paid
    after the sale is settled and every won lot has been collected/paid.
    It does not call Paystack and does not move money.
    """
    conn = None
    try:
        host = str(data.get("viewer") or "").strip()
        reference = str(data.get("reference") or "").strip()

        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT host_username, status, settled_at, payout_status
            FROM auctions
            WHERE id = %s
            FOR UPDATE
            """,
            (sale_id,),
        )

        sale = cursor.fetchone()

        if not sale:
            return {"error": "sale not found"}

        if sale["host_username"] != host:
            return {"error": "not your sale"}

        if sale["status"] != "ended":
            return {"error": "sale is not ended"}

        if sale["settled_at"] is None:
            return {"error": "sale is not settled"}

        if sale["payout_status"] == "paid":
            return {
                "message": "payout already marked paid",
                "payout_status": "paid",
                "payout_reference": sale.get("payout_reference"),
            }

        cursor.execute(
            """
            SELECT COUNT(*)::int AS c
            FROM lots
            WHERE sale_id = %s
              AND status = 'sold'
              AND winner_username IS NOT NULL
              AND payment_status <> 'paid'
            """,
            (sale_id,),
        )

        unpaid = int(cursor.fetchone()["c"] or 0)

        if unpaid > 0:
            return {
                "error": f"cannot mark payout paid: {unpaid} won lot(s) are not paid yet"
            }

        if not reference:
            reference = f"manual_payout_{sale_id}_{secrets.token_hex(4)}"

        cursor.execute(
            """
            UPDATE auctions
            SET payout_status = 'paid',
                payout_reference = %s
            WHERE id = %s
            """,
            (reference, sale_id),
        )

        conn.commit()

        return {
            "message": "payout marked paid",
            "payout_status": "paid",
            "payout_reference": reference,
        }

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()