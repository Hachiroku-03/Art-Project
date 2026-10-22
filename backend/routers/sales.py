import os
import json
import hmac
import hashlib
import secrets
from decimal import Decimal, ROUND_HALF_UP
from urllib import request as urlreq, error as urlerr

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from db import get_db
from helpers import auction_access
from ledger import spend
from notification_service import create_notification


router = APIRouter()


# ---------------------------------------------------------------------------
# Platform-controlled v1 rates.
#
# FLOW A (charge at settlement), HOUSE-NET split:
#   buyer pays platform  = hammer + premium
#   platform commission  = collected * PLATFORM_COMMISSION_RATE
#   net to house         = collected - commission
#
# The platform's revenue is the commission. It is withheld from the house payout.
# The house does not need a funded wallet to settle.
#
# Money moves only through the backend rail:
#   frontend -> backend
#   backend -> Paystack initialize
#   backend stores checkout_url + payment_reference
#   buyer opens backend-returned checkout_url
#   Paystack -> backend webhook
#   backend marks lot paid
#
# The browser must NEVER call https://api.paystack.co directly.
# ---------------------------------------------------------------------------

BUYER_PREMIUM_RATE = Decimal(os.getenv("BUYER_PREMIUM_RATE", "0.15"))
PLATFORM_COMMISSION_RATE = Decimal(os.getenv("PLATFORM_COMMISSION_RATE", "0.10"))

ACCESS_MODES = {"open", "vip", "invite"}
ACCESS_ALIASES = {
    "open": "open",
    "vip": "vip",
    "vip_only": "vip",
    "invite": "invite",
    "invite_only": "invite",
}

DEFAULT_CCY = "NGN"
DEFAULT_CURRENCY = DEFAULT_CCY

# How long an ended sale remains visible on the public auction floor.
ENDED_FLOOR_RETENTION_HOURS = int(os.getenv("ENDED_FLOOR_RETENTION_HOURS", "72"))

PAYSTACK_SECRET_KEY = os.getenv("PAYSTACK_SECRET_KEY", "")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")
PAYSTACK_CALLBACK_URL = os.getenv(
    "PAYSTACK_CALLBACK_URL",
    f"{FRONTEND_URL}/wins?payment=completed",
)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _ccy(value, default=DEFAULT_CCY):
    c = (str(value or default)).strip().upper()
    return c if (len(c) == 3 and c.isalpha()) else default


def _money(value) -> Decimal:
    try:
        return Decimal(str(value if value is not None else 0)).quantize(
            Decimal("0.01"),
            rounding=ROUND_HALF_UP,
        )
    except Exception:
        return Decimal("0.00")


def _money_str(value) -> str:
    return str(_money(value))


def _minor_amount(amount: Decimal) -> int:
    return int((amount * 100).to_integral_value(rounding=ROUND_HALF_UP))


def _resolve_username(cursor, raw: str):
    raw = str(raw or "").strip()
    if not raw:
        return None

    cursor.execute("SELECT username FROM users WHERE username = %s", (raw,))
    row = cursor.fetchone()
    if row:
        return row["username"]

    cursor.execute("SELECT username FROM users WHERE lower(username) = lower(%s)", (raw,))
    row = cursor.fetchone()
    return row["username"] if row else None


def _sale_id_of(cursor, lot_id: int) -> int:
    cursor.execute("SELECT sale_id FROM lots WHERE id = %s", (lot_id,))
    r = cursor.fetchone()
    return int(r["sale_id"]) if r else 0


def _buyer_email_for(cursor, username: str):
    try:
        cursor.execute(
            "SELECT email FROM users WHERE username = %s",
            (username,),
        )
        row = cursor.fetchone()
        email = (row or {}).get("email")
    except Exception:
        email = None

    email = str(email or "").strip()
    return email or None


# ---------------------------------------------------------------------------
# Paystack server-side initialize
#
# This is backend-to-backend. The browser must never call api.paystack.co.
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Payout status refresh
#
# payout_status:
#   none    = not ready / no confirmed collection
#   pending = collection in progress OR collection complete but house payout not marked paid
#   paid    = house payout manually/administratively confirmed paid
# ---------------------------------------------------------------------------

def _refresh_payout_status(cursor, sale_id: int) -> str:
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
    pending = int(row.get("pending") or 0)

    cursor.execute(
        "SELECT payout_status FROM auctions WHERE id = %s",
        (sale_id,),
    )
    sale_row = cursor.fetchone()
    current = (sale_row or {}).get("payout_status") or "none"

    # Once house payout is confirmed paid, do not downgrade it automatically.
    if current == "paid":
        return "paid"

    if total == 0:
        new_status = "none"
    elif paid == total:
        # All buyer collection is complete, but house payout still needs confirmation.
        new_status = "pending"
    elif pending > 0:
        # Some Paystack charges are awaiting webhook.
        new_status = "pending"
    else:
        new_status = "none"

    cursor.execute(
        """
        UPDATE auctions
        SET payout_status = %s
        WHERE id = %s
        """,
        (new_status, sale_id),
    )

    return new_status


# ---------------------------------------------------------------------------
# One won-lot checkout initializer.
#
# Used by:
#   - settle_sale
#   - collect_sale
#   - buyer pay endpoint
#
# It does not move money. It creates/returns a Paystack checkout URL and marks
# the lot pending. The webhook marks it paid.
# ---------------------------------------------------------------------------

def _initialize_lot_checkout(cursor, lot_id: int) -> dict:
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

    if str(row["payment_status"]).lower() == "paid":
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

    email = _buyer_email_for(cursor, row["winner_username"])
    if not email:
        return {
            "error": (
                "winner has no email on file. Configure a valid buyer email for Paystack, "
                "or use offline collection marking for local/testing settlement."
            )
        }

    sold_price = _money(row["sold_price"])
    premium = (sold_price * BUYER_PREMIUM_RATE).quantize(
        Decimal("0.01"),
        rounding=ROUND_HALF_UP,
    )
    collected = sold_price + premium
    currency = _ccy(row["currency"] or row["sale_currency"])
    reference = f"lot_{lot_id}_{secrets.token_hex(6)}"

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


# ---------------------------------------------------------------------------
# Public auction floor
# ---------------------------------------------------------------------------

@router.get("/sales")
def list_sales(viewer: str = ""):
    """
    Public auction floor.

    Ended sales remain visible for ENDED_FLOOR_RETENTION_HOURS after they end,
    then disappear from the public floor. The house still sees all their own
    sales through /my_sales.

    IMPORTANT: every matching row is returned with its access flags. We do NOT
    hide invite/VIP rooms from the floor when the viewer lacks a paddle. The
    card renders them locked, and the real gating happens in get_sale + room.
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


# ---------------------------------------------------------------------------
# House sales
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Stream settings
# ---------------------------------------------------------------------------

@router.post("/sales/{sale_id}/stream")
def set_stream(sale_id: int, data: dict):
    conn = None

    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT host_username, status FROM auctions WHERE id = %s",
            (sale_id,),
        )
        row = cursor.fetchone()

        if not row or row["host_username"] != host:
            return {"error": "not your sale"}

        if row["status"] == "ended":
            return {"error": "sale has ended"}

        cursor.execute(
            """
            UPDATE auctions
            SET
                stream_type = %s,
                stream_url = %s,
                stream_peer_id = %s
            WHERE id = %s
            """,
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


# ---------------------------------------------------------------------------
# Lot corrections
# ---------------------------------------------------------------------------

@router.post("/lots/{lot_id}/revert_to_passed")
def revert_lot_to_passed(lot_id: int, data: dict):
    """
    Host-only correction for a lot that was hammered SOLD by mistake and should
    have been PASSED.

    SAFE LIMITS:
      - only the owning house
      - only while the sale is NOT yet settled
      - only a lot currently in status 'sold'

    After settle, do not revert; use offline collection marking or redo the sale
    in test.
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
                l.position,
                l.title,
                l.status AS lot_status,
                l.winner_username,
                l.sale_id,
                a.host_username,
                a.status AS sale_status,
                a.settled_at,
                a.title AS sale_title
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
            SET
                status = 'passed',
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

        if row["winner_username"]:
            create_notification(
                user_name=row["winner_username"],
                category="auctions",
                type="lot_lost",
                title=f"Lot {row['position']} · {row['sale_title']} — correction",
                body="The house corrected this lot to passed. No payment is due.",
                actor=host,
                source_type="sale",
                source_id=row["sale_id"],
                secondary_id=lot_id,
                data={
                    "sale_id": row["sale_id"],
                    "lot_id": lot_id,
                    "corrected_to": "passed",
                },
                cursor=cursor,
            )

        _refresh_payout_status(cursor, row["sale_id"])
        conn.commit()

        return {
            "message": "lot reverted to passed",
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


@router.post("/lots/{lot_id}/reopen")
def reopen_lot(lot_id: int, data: dict):
    """
    Rostrum correction: put a PASSED lot back ON THE BLOCK so bidding resumes.

    Covers:
      - "I passed it by mistake"
      - "I hammered it with no qualifying bid"

    Previous bids are preserved.

    Limits:
      - only the owning house
      - only while the sale is LIVE
      - only a lot currently in status 'passed'
      - refuses if another lot is already on the block
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
                    "A sold lot cannot be un-sold from the room."
                )
            }

        cursor.execute(
            """
            SELECT 1
            FROM lots
            WHERE sale_id = %s
              AND status = 'on_block'
              AND id <> %s
            """,
            (row["sale_id"], lot_id),
        )

        if cursor.fetchone():
            return {
                "error": (
                    "another lot is on the block. "
                    "Hammer or pass it before reopening this one."
                )
            }

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


# ---------------------------------------------------------------------------
# Paddles / tickets
# ---------------------------------------------------------------------------

@router.get("/sales/{sale_id}/paddles")
def list_paddles(sale_id: int, viewer: str = ""):
    """
    Host-only paddle holder list.

    The full paddle code is intentionally not returned here.
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


@router.post("/sales/{sale_id}/enter")
def enter_sale(sale_id: int, data: dict):
    """
    Room entry by paddle code. This is the manual/device-switch path.
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

        cursor.execute(
            "SELECT host_username, status FROM auctions WHERE id = %s",
            (sale_id,),
        )

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

        target = _resolve_username(cursor, target_raw)

        if not target:
            return {"error": "unknown user"}

        if target == host:
            return {"error": "cannot invite yourself to your own room"}

        cursor.execute(
            "SELECT 1 FROM tickets WHERE auction_id = %s AND user_name = %s",
            (sale_id, target),
        )

        if cursor.fetchone():
            return {"error": "that user already holds a paddle here"}

        cursor.execute(
            "SELECT ticket_capacity FROM auctions WHERE id = %s",
            (sale_id,),
        )

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
            data={"sale_id": sale_id},
            cursor=cursor,
        )

        conn.commit()

        return {
            "message": "paddle issued",
            "user_name": target,
            "code": code,
        }

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}

    finally:
        if conn:
            conn.close()


# ---------------------------------------------------------------------------
# Sale CRUD
# ---------------------------------------------------------------------------

@router.patch("/sales/{sale_id}")
def update_sale(sale_id: int, data: dict):
    """
    Control-room schedule / access / content editor. House-gated.
    """
    conn = None

    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT host_username, status FROM auctions WHERE id = %s",
            (sale_id,),
        )

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
            raw = data.get("ticket_capacity")

            if raw in (None, ""):
                cap = None
            else:
                try:
                    cap = int(raw)
                except (TypeError, ValueError):
                    return {"error": "invalid capacity"}

                if cap <= 0:
                    return {"error": "capacity must be positive"}

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

        if (
            estimate_low is not None
            and estimate_high is not None
            and estimate_high < estimate_low
        ):
            return {
                "error": "estimate_high cannot be lower than estimate_low",
                "debug_marker": "safe_add_lot_v1",
            }

        sale_currency = _ccy(sale.get("currency"))
        lot_currency = _ccy(data.get("currency") or sale_currency)

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
            sale_currency = _ccy(lot.get("sale_currency"))
            lot_currency = _ccy(data.get("currency") or sale_currency)

            sets.append("currency = %s")
            params.append(lot_currency)

        low_val, low_err = (
            parse_money("estimate_low")
            if "estimate_low" in data
            else (
                float(lot.get("estimate_low"))
                if lot.get("estimate_low") is not None
                else None,
                None,
            )
        )

        high_val, high_err = (
            parse_money("estimate_high")
            if "estimate_high" in data
            else (
                float(lot.get("estimate_high"))
                if lot.get("estimate_high") is not None
                else None,
                None,
            )
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
            f"""
            UPDATE lots
            SET {', '.join(sets)}
            WHERE id = %s
            RETURNING id, position, title, status, currency
            """,
            tuple(params),
        )

        updated = cursor.fetchone()
        conn.commit()

        return {
            "lot": dict(updated) if updated else None,
            "message": "lot updated",
        }

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


# ---------------------------------------------------------------------------
# Sale detail / room access
# ---------------------------------------------------------------------------

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

            if not is_host:
                d.pop("reserve", None)

                if winner != viewer:
                    d.pop("payment_status", None)

            # Checkout links are private to the winning buyer.
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


# ---------------------------------------------------------------------------
# Rostrum actions
# ---------------------------------------------------------------------------

@router.post("/sales/{sale_id}/go_live")
def go_live(sale_id: int, data: dict):
    conn = None

    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT host_username, status FROM auctions WHERE id = %s",
            (sale_id,),
        )

        row = cursor.fetchone()

        if not row or row["host_username"] != host:
            return {"error": "not your sale"}

        if row["status"] == "ended":
            return {"error": "sale has ended"}

        if row["status"] == "live":
            return {"message": "sale is already live"}

        cursor.execute(
            "UPDATE auctions SET status='live' WHERE id = %s",
            (sale_id,),
        )

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

        cursor.execute(
            "SELECT host_username, status FROM auctions WHERE id = %s",
            (sale_id,),
        )

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
            SET
                status = 'ended',
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

        cursor.execute(
            "SELECT host_username, status FROM auctions WHERE id = %s",
            (sale_id,),
        )

        row = cursor.fetchone()

        if not row or row["host_username"] != host:
            return {"error": "not your sale"}

        if row["status"] != "live":
            return {"error": "sale is not live"}

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
                SET
                    status = 'passed',
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
                SET
                    status = 'passed',
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
            SET
                status = 'sold',
                sold_price = %s,
                winner_username = %s,
                hammer_at = CURRENT_TIMESTAMP
            WHERE id = %s
            """,
            (top_amt, top_user, lot_id),
        )

        conn.commit()

        return {
            "message": "sold",
            "sold_price": str(top_amt),
            "winner": top_user,
        }

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
            SET
                status = 'passed',
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
            SELECT
                id,
                user_name,
                amount::text AS amount,
                created_at::text AS created_at
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


# ---------------------------------------------------------------------------
# Settlement
# ---------------------------------------------------------------------------

@router.post("/sales/{sale_id}/settle")
def settle_sale(sale_id: int, data: dict):
    """
    Compute the Flow A house-net split for an ENDED sale, send notices, and
    queue buyer collection.

    Idempotent on the math via settled_at.
    Collection can be retried via /collect.

    With no Paystack keys, settle still runs end-to-end: it computes the split,
    records settlement, sends notices, and leaves lots unpaid.
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
                id,
                host_username,
                title,
                status,
                settled_at,
                currency,
                ticket_currency
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
            SELECT
                id,
                position,
                title,
                sold_price::text AS sold_price,
                winner_username,
                COALESCE(payment_status, 'unpaid') AS payment_status,
                currency
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
                """
                UPDATE auctions
                SET
                    settled_at = CURRENT_TIMESTAMP,
                    payout_status = 'none'
                WHERE id = %s
                """,
                (sale_id,),
            )

            conn.commit()

            return {
                "message": "settled",
                "lots_sold": 0,
                "note": "no winning lots",
            }

        # Stamp settlement before initializing checkout links so the helper can
        # see settled_at inside the same transaction.
        cursor.execute(
            "UPDATE auctions SET settled_at = CURRENT_TIMESTAMP WHERE id = %s",
            (sale_id,),
        )

        sale_currency = _ccy(sale.get("currency"))

        outcomes = []
        initiated = 0
        existing = 0
        awaiting = 0

        hammer_total = Decimal("0.00")
        premium_total = Decimal("0.00")
        collected_total = Decimal("0.00")
        commission_total = Decimal("0.00")
        net_total = Decimal("0.00")

        for w in won:
            hammer = _money(w.get("sold_price"))
            premium = (hammer * BUYER_PREMIUM_RATE).quantize(
                Decimal("0.01"),
                rounding=ROUND_HALF_UP,
            )
            collected = hammer + premium
            commission = (collected * PLATFORM_COMMISSION_RATE).quantize(
                Decimal("0.01"),
                rounding=ROUND_HALF_UP,
            )
            net = collected - commission
            lot_currency = _ccy(w.get("currency") or sale_currency)

            base = {
                "lot_id": int(w["id"]),
                "position": int(w["position"]),
                "title": w.get("title") or f"Lot {w['position']}",
                "winner": w["winner_username"],
                "hammer": str(hammer),
                "premium": str(premium),
                "collected": str(collected),
                "commission": str(commission),
                "net_to_house": str(net),
                "currency": lot_currency,
            }

            hammer_total += hammer
            premium_total += premium
            collected_total += collected
            commission_total += commission
            net_total += net

            if str(w.get("payment_status") or "unpaid").lower() == "paid":
                outcomes.append({**base, "status": "paid"})
                continue

            result = _initialize_lot_checkout(cursor, int(w["id"]))

            if result.get("error"):
                awaiting += 1
                outcomes.append(
                    {
                        **base,
                        "status": "unpaid",
                        "reason": result["error"],
                    }
                )
                continue

            if result.get("status") == "paid":
                outcomes.append({**base, "status": "paid"})
                continue

            if result.get("message") == "payment link already available":
                existing += 1
                outcomes.append(
                    {
                        **base,
                        "status": "pending",
                        "payment_reference": result.get("reference"),
                    }
                )
                continue

            initiated += 1
            outcomes.append(
                {
                    **base,
                    "status": "pending",
                    "payment_reference": result.get("reference"),
                }
            )

        # Buyer notices.
        for w, o in zip(won, outcomes):
            if o["status"] == "paid":
                body = (
                    f"Hammer {o['hammer']}. Buyer's premium {o['premium']}. "
                    f"Total {o['collected']} {o['currency']} — paid."
                )
            elif o["status"] == "pending":
                body = (
                    f"Hammer {o['hammer']}. Buyer's premium {o['premium']}. "
                    f"Total {o['collected']} {o['currency']}. "
                    "Open your Won lots page to pay securely."
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
                secondary_id=int(w["id"]),
                data={
                    "sale_id": sale_id,
                    "lot_id": int(w["id"]),
                    "hammer": o["hammer"],
                    "premium": o["premium"],
                    "collected": o["collected"],
                    "commission": o["commission"],
                    "net_to_house": o["net_to_house"],
                    "currency": o["currency"],
                    "status": o["status"],
                },
                cursor=cursor,
            )

        # Host notice.
        if initiated or existing:
            collection_note = (
                f"{initiated + existing} payment link(s) available; "
                f"{awaiting} awaiting collection."
            )
        else:
            collection_note = "Collection pending — set Paystack keys, then run /collect, or use offline collection marking."

        create_notification(
            user_name=host,
            category="wallet",
            type="settlement_complete",
            title=f"Settlement · {sale['title']}",
            body=(
                f"{len(won)} lots · hammer {hammer_total} · premium {premium_total} · "
                f"collected {collected_total} {sale_currency} · "
                f"platform commission {commission_total} (withheld from payout) · "
                f"net to house {net_total}. {collection_note}"
            ),
            actor=None,
            source_type="sale",
            source_id=sale_id,
            data={
                "sale_id": sale_id,
                "lots_sold": len(won),
                "hammer_total": str(hammer_total),
                "premium_total": str(premium_total),
                "collected_total": str(collected_total),
                "commission_total": str(commission_total),
                "net_to_house": str(net_total),
                "charges_initiated": initiated,
                "links_available": existing,
                "awaiting_collection": awaiting,
                "currency": sale_currency,
            },
            cursor=cursor,
        )

        payout_status = _refresh_payout_status(cursor, sale_id)
        conn.commit()

        return {
            "message": "settled",
            "lots_sold": len(won),
            "hammer_total": str(hammer_total),
            "premium_total": str(premium_total),
            "collected_total": str(collected_total),
            "commission_total": str(commission_total),
            "net_to_house": str(net_total),
            "charges_initiated": initiated,
            "links_available": existing,
            "awaiting_collection": awaiting,
            "payout_status": payout_status,
            "collection_state": "pending" if (initiated or existing) else "awaiting_rail",
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
    Retry collection for a settled sale whose lots are still unpaid/failed.

    This only attempts Paystack initialization again. It does NOT recompute the
    settlement split or resend lot_won notices.
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
                id,
                host_username,
                title,
                status,
                settled_at,
                currency
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
            return {"error": "sale is not ended"}

        if sale["settled_at"] is None:
            return {"error": "settle the sale first"}

        cursor.execute(
            """
            SELECT
                id,
                position,
                winner_username
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

        if not due:
            payout_status = _refresh_payout_status(cursor, sale_id)
            conn.commit()

            return {
                "message": "nothing to collect",
                "charges_initiated": 0,
                "links_available": 0,
                "failed": 0,
                "payout_status": payout_status,
                "outcomes": [],
            }

        initiated = 0
        existing = 0
        failed = 0
        errors = []

        for lot in due:
            result = _initialize_lot_checkout(cursor, int(lot["id"]))

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
            SELECT
                id,
                host_username,
                title,
                status,
                settled_at
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

        cursor.execute(
            """
            SELECT
                id,
                position,
                winner_username
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
                secondary_id=int(lot["id"]),
                data={
                    "sale_id": sale_id,
                    "lot_id": int(lot["id"]),
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


# ---------------------------------------------------------------------------
# Buyer payment
# ---------------------------------------------------------------------------

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

        canonical = _resolve_username(cursor, viewer)
        if not canonical:
            return {"error": "unknown user"}

        cursor.execute(
            "SELECT winner_username FROM lots WHERE id = %s",
            (lot_id,),
        )

        owner = cursor.fetchone()

        if not owner:
            return {"error": "lot not found"}

        if owner["winner_username"] != canonical:
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


# ---------------------------------------------------------------------------
# Paystack webhook
# ---------------------------------------------------------------------------

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
            if str(lot["payment_status"]).lower() == "paid":
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
            if str(lot["payment_status"]).lower() == "paid":
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


# ---------------------------------------------------------------------------
# Settlement view
# ---------------------------------------------------------------------------

@router.get("/sales/{sale_id}/settlement")
def settlement_view(sale_id: int, viewer: str = ""):
    """
    Host-only settlement preview.

    This does NOT mutate anything. It computes the Flow A house-net split for
    won lots and returns payment status so the control room can display it.

    Passed and sealed lots are excluded. Only sold lots with a winner are
    collectible.
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
                COALESCE(payment_status, 'unpaid') AS payment_status,
                payment_reference,
                payment_updated_at::text AS payment_updated_at,
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

        hammer_total = Decimal("0.00")
        premium_total = Decimal("0.00")
        collected_total = Decimal("0.00")
        commission_total = Decimal("0.00")
        net_total = Decimal("0.00")

        counts = {
            "paid": 0,
            "pending": 0,
            "unpaid": 0,
            "failed": 0,
        }

        for r in rows:
            d = dict(r)

            hammer = _money(d.get("sold_price"))
            premium = (hammer * BUYER_PREMIUM_RATE).quantize(
                Decimal("0.01"),
                rounding=ROUND_HALF_UP,
            )
            collected = hammer + premium
            commission = (collected * PLATFORM_COMMISSION_RATE).quantize(
                Decimal("0.01"),
                rounding=ROUND_HALF_UP,
            )
            net = collected - commission

            payment_status = str(d.get("payment_status") or "unpaid").strip().lower()
            if payment_status not in counts:
                payment_status = "unpaid"

            counts[payment_status] += 1

            lot_currency = _ccy(d.get("currency") or sale_currency)

            d.update(
                {
                    "hammer": str(hammer),
                    "premium": str(premium),
                    "collected": str(collected),
                    "commission": str(commission),
                    "net_to_house": str(net),
                    "currency": lot_currency,
                    "payment_status": payment_status,
                }
            )

            lots.append(d)

            hammer_total += hammer
            premium_total += premium
            collected_total += collected
            commission_total += commission
            net_total += net

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
                "hammer_total": str(hammer_total),
                "premium_total": str(premium_total),
                "collected_total": str(collected_total),
                "commission_total": str(commission_total),
                "net_to_house": str(net_total),
                "currency": sale_currency,
            },
            "counts": counts,
            "settled": settled,
            "collection_state": collection_state,
            "rates": {
                "buyer_premium_rate": float(BUYER_PREMIUM_RATE),
                "platform_commission_rate": float(PLATFORM_COMMISSION_RATE),
            },
        }

    except Exception as e:
        return {"error": str(e)}

    finally:
        if conn:
            conn.close()


# ---------------------------------------------------------------------------
# Buyer won lots
# ---------------------------------------------------------------------------

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
        raw_buyer = str(viewer or "").strip()
        if not raw_buyer:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        buyer = _resolve_username(cursor, raw_buyer)

        if not buyer:
            return {
                "lots": [],
                "summary": {
                    "count": 0,
                    "total_hammer": "0.00",
                    "total_premium": "0.00",
                    "total_collected": "0.00",
                    "total_paid": "0.00",
                    "total_outstanding": "0.00",
                    "currency": DEFAULT_CCY,
                },
                "rates": {
                    "buyer_premium_rate": float(BUYER_PREMIUM_RATE),
                },
            }

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
                COALESCE(l.payment_status, 'unpaid') AS payment_status,
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
            ORDER BY
                a.settled_at DESC NULLS LAST,
                l.hammer_at DESC NULLS LAST,
                l.id DESC
            """,
            (buyer,),
        )

        rows = cursor.fetchall()

        lots = []

        total_hammer = Decimal("0.00")
        total_premium = Decimal("0.00")
        total_collected = Decimal("0.00")
        total_paid = Decimal("0.00")
        total_outstanding = Decimal("0.00")

        for r in rows:
            d = dict(r)

            sale_ccy = _ccy(d.get("sale_currency") or d.get("lot_currency"))
            hammer = _money(d.get("hammer"))
            premium = (hammer * BUYER_PREMIUM_RATE).quantize(
                Decimal("0.01"),
                rounding=ROUND_HALF_UP,
            )
            collected = hammer + premium

            payment_status = str(d.get("payment_status") or "unpaid").strip().lower()
            if payment_status not in {"paid", "pending", "unpaid", "failed"}:
                payment_status = "unpaid"

            settled = d.get("settled_at") is not None
            collection_ready = d.get("sale_status") == "ended" and settled

            d.update(
                {
                    "currency": sale_ccy,
                    "hammer": str(hammer),
                    "premium": str(premium),
                    "collected": str(collected),
                    "payment_status": payment_status,
                    "collection_ready": collection_ready,
                }
            )

            lots.append(d)

            total_hammer += hammer
            total_premium += premium
            total_collected += collected

            if payment_status == "paid":
                total_paid += collected
            else:
                total_outstanding += collected

        first = dict(rows[0]) if rows else {}
        summary_currency = _ccy(first.get("sale_currency") or DEFAULT_CCY)

        return {
            "lots": lots,
            "summary": {
                "count": len(lots),
                "total_hammer": str(total_hammer),
                "total_premium": str(total_premium),
                "total_collected": str(total_collected),
                "total_paid": str(total_paid),
                "total_outstanding": str(total_outstanding),
                "currency": summary_currency,
            },
            "rates": {
                "buyer_premium_rate": float(BUYER_PREMIUM_RATE),
            },
        }

    except Exception as e:
        return {"error": str(e)}

    finally:
        if conn:
            conn.close()


# ---------------------------------------------------------------------------
# House payout profile
# ---------------------------------------------------------------------------

@router.get("/house/payout")
def get_house_payout(viewer: str = ""):
    """
    Host-only payout profile read.
    """
    conn = None

    try:
        host = str(viewer or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT role FROM users WHERE username = %s",
            (host,),
        )

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

        cursor.execute(
            "SELECT role FROM users WHERE username = %s",
            (host,),
        )

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
            SELECT
                host_username,
                status,
                settled_at,
                payout_status,
                payout_reference
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
              AND COALESCE(payment_status, 'unpaid') <> 'paid'
            """,
            (sale_id,),
        )

        unpaid = int(cursor.fetchone()["c"] or 0)

        if unpaid > 0:
            return {
                "error": (
                    f"{unpaid} won lot(s) are still unpaid/failed. "
                    "Payout cannot be marked paid until collection is complete."
                )
            }

        if not reference:
            reference = f"manual_payout_{sale_id}_{secrets.token_hex(4)}"

        cursor.execute(
            """
            UPDATE auctions
            SET
                payout_status = 'paid',
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