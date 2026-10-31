"""
Canonical Paystack webhook receiver.

One endpoint:
    POST /webhooks/paystack

Rules:
- signature-verified
- idempotent through payment_events
- routed by metadata.kind / metadata.purpose
- never trusts the client
- never double-applies money
- buyer collection complete sets payout_status = pending
- house payout paid only happens through payout transfer or manual mark-paid
- UNEXPECTED processing errors return HTTP 500 (so Paystack RETRIES) and are logged.
  A 200 must only ever mean "fully handled or deliberately ignored", never "crashed".

This is the ONLY place external money events enter the ledger via push.
The pull path (verify-on-return) shares apply_charge_success() below.
"""

import asyncio
import json
import traceback
from decimal import Decimal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from db import get_db
from ledger import credit, ESCROW
from notification_service import create_notification
import paystack


router = APIRouter()


def _log(msg: str):
    # Visible in the uvicorn console; replace with a real logger in prod.
    print(f"[paystack-webhook] {msg}", flush=True)


def _major(minor_amount) -> Decimal:
    return paystack.to_major(minor_amount)


# ---------------------------------------------------------------------------
# Payout status refresh (buyer-collection state only).
# Never sets 'paid' just because buyers paid.
# ---------------------------------------------------------------------------

def _refresh_collection_payout_status(cursor, sale_id: int) -> str:
    cursor.execute(
        """
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE COALESCE(payment_status,'unpaid') = 'paid')::int AS paid,
            COUNT(*) FILTER (WHERE COALESCE(payment_status,'unpaid') IN ('pending','processing'))::int AS pending,
            COUNT(*) FILTER (WHERE COALESCE(payment_status,'unpaid') = 'unpaid')::int AS unpaid,
            COUNT(*) FILTER (WHERE COALESCE(payment_status,'unpaid') = 'failed')::int AS failed
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

    cursor.execute("SELECT payout_status FROM auctions WHERE id = %s", (sale_id,))
    sale_row = cursor.fetchone()
    current = (sale_row or {}).get("payout_status") or "none"

    if current == "paid":
        return "paid"

    if total == 0:
        new_status = "none"
    elif paid == total:
        new_status = "pending"      # collection complete, house payout still owed
    elif pending > 0:
        new_status = "pending"
    else:
        new_status = "none"

    cursor.execute("UPDATE auctions SET payout_status = %s WHERE id = %s", (new_status, sale_id))
    return new_status


# ---------------------------------------------------------------------------
# Lot lookup. ONLY the int() conversion is guarded.
# Genuine DB errors MUST propagate so the outer handler returns 500 + retries.
# ---------------------------------------------------------------------------

def _find_lot_by_id_or_reference(cursor, lot_id, reference):
    lot = None

    if lot_id is not None:
        try:
            lid = int(lot_id)
        except (TypeError, ValueError):
            lid = None

        if lid is not None:
            cursor.execute(
                """
                SELECT
                    l.id, l.position, l.status, l.winner_username,
                    COALESCE(l.payment_status,'unpaid') AS payment_status,
                    l.payment_reference,
                    a.id AS sale_id, a.title AS sale_title, a.host_username
                FROM lots l
                JOIN auctions a ON a.id = l.sale_id
                WHERE l.id = %s
                FOR UPDATE OF l
                """,
                (lid,),
            )
            lot = cursor.fetchone()
            if lot:
                return lot

    if reference:
        cursor.execute(
            """
            SELECT
                l.id, l.position, l.status, l.winner_username,
                COALESCE(l.payment_status,'unpaid') AS payment_status,
                l.payment_reference,
                a.id AS sale_id, a.title AS sale_title, a.host_username
            FROM lots l
            JOIN auctions a ON a.id = l.sale_id
            WHERE l.payment_reference = %s
            FOR UPDATE OF l
            """,
            (reference,),
        )
        return cursor.fetchone()

    return None


# ---------------------------------------------------------------------------
# SHARED idempotent applier for a successful buyer charge.
# Used by BOTH the webhook (push) and /my/won-lots/{id}/verify (pull).
# Locks the lot, guards double-credit, credits ESCROW, marks paid,
# notifies buyer+host, refreshes payout status.
# Returns {"status":"paid"} | {"status":"paid","already":True} | {"error":...}
# ---------------------------------------------------------------------------

def apply_charge_success(cursor, *, lot_id, reference, amount_minor, currency="NGN") -> dict:
    lot = _find_lot_by_id_or_reference(cursor, lot_id, reference)

    if not lot:
        return {"error": "lot not found"}

    if str(lot.get("payment_status") or "unpaid").lower() == "paid":
        sale_id = lot.get("sale_id")
        if sale_id:
            _refresh_collection_payout_status(cursor, int(sale_id))
        return {"status": "paid", "already": True}

    collected = _major(amount_minor)
    sale_id = lot.get("sale_id")
    winner = lot.get("winner_username")
    host = lot.get("host_username")
    position = lot.get("position")
    sale_title = lot.get("sale_title")

    if collected > 0:
        ok, err, _ = credit(
            cursor,
            ESCROW,
            float(collected),
            kind="settle_in",
            reference=reference or "",
            ref_table="lots",
            ref_id=lot["id"],
            currency=currency or "NGN",
        )

        if not ok:
            raise RuntimeError(err or "escrow credit failed")

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

    if winner:
        create_notification(
            user_name=winner,
            category="wallet",
            type="payment_confirmed",
            title=f"Payment confirmed · Lot {position} · {sale_title}",
            body="Your payment was confirmed. The house can now proceed with release/payout according to its terms.",
            actor=host,
            source_type="sale",
            source_id=sale_id,
            secondary_id=lot["id"],
            data={"sale_id": sale_id, "lot_id": lot["id"], "reference": reference,
                  "amount": str(collected), "currency": currency},
            cursor=cursor,
        )

    if host:
        create_notification(
            user_name=host,
            category="wallet",
            type="lot_payment_received",
            title=f"Payment received · Lot {position} · {sale_title}",
            body=f"{winner or 'A buyer'} paid for Lot {position}.",
            actor=winner,
            source_type="sale",
            source_id=sale_id,
            secondary_id=lot["id"],
            data={"sale_id": sale_id, "lot_id": lot["id"], "winner_username": winner,
                  "reference": reference, "amount": str(collected), "currency": currency},
            cursor=cursor,
        )

    if sale_id:
        _refresh_collection_payout_status(cursor, int(sale_id))

    return {"status": "paid"}


def _apply_charge_failed(cursor, *, lot_id, reference) -> dict:
    lot = _find_lot_by_id_or_reference(cursor, lot_id, reference)
    if not lot:
        return {"error": "lot not found"}

    sale_id = lot.get("sale_id")
    winner = lot.get("winner_username")
    host = lot.get("host_username")
    position = lot.get("position")
    sale_title = lot.get("sale_title")

    if str(lot.get("payment_status") or "unpaid").lower() == "paid":
        if sale_id:
            _refresh_collection_payout_status(cursor, int(sale_id))
        return {"status": "ignored", "reason": "already paid"}

    cursor.execute(
        """
        UPDATE lots
        SET payment_status = 'failed', payment_updated_at = CURRENT_TIMESTAMP
        WHERE id = %s
        """,
        (lot["id"],),
    )

    if winner:
        create_notification(
            user_name=winner,
            category="wallet",
            type="payment_failed",
            title=f"Payment failed · Lot {position} · {sale_title}",
            body="Your payment attempt failed. Try again from your Won lots page.",
            actor=host,
            source_type="sale",
            source_id=sale_id,
            secondary_id=lot["id"],
            data={"sale_id": sale_id, "lot_id": lot["id"], "reference": reference},
            cursor=cursor,
        )

    if sale_id:
        _refresh_collection_payout_status(cursor, int(sale_id))

    return {"status": "failed"}


# ---------------------------------------------------------------------------
# Endpoint: thin async shell -> heavy sync work in a thread (Bug E).
# ---------------------------------------------------------------------------

@router.post("/webhooks/paystack")
async def paystack_webhook(request: Request):
    raw = await request.body()
    sig = request.headers.get("x-paystack-signature", "")
    return await asyncio.to_thread(_process_paystack_webhook, raw, sig)


def _process_paystack_webhook(raw: bytes, sig: str):
    # Fail closed on signature. 200 is fine here: nothing moved, no retry wanted.
    if not paystack.verify_webhook_signature(raw, sig):
        return {"received": False, "reason": "invalid signature"}

    try:
        body = json.loads(raw)
    except Exception:
        return JSONResponse({"received": False, "reason": "bad json"}, status_code=400)

    event = body.get("event") or ""
    data = body.get("data") or {}
    meta = data.get("metadata") or {}

    event_id = (
        body.get("id")
        or data.get("reference")
        or f"{event}:{data.get('reference','')}:{meta.get('lot_id','')}"
    )
    if not event_id:
        return JSONResponse({"received": False, "reason": "missing event id"}, status_code=400)

    kind = (meta.get("kind") or meta.get("purpose") or "").strip()

    conn = get_db()
    cursor = conn.cursor()

    try:
        first = paystack.record_event(
            cursor,
            event_id,
            event,
            account=meta.get("account") or meta.get("winner_username"),
            currency=data.get("currency"),
            amount=_major(data.get("amount")),          # Bug D: store major units
            reference=data.get("reference"),
            payload=body,
        )

        if not first:
            conn.commit()
            return {"received": True, "duplicate": True}

        # ---------------- wallet top-up ----------------
        if event == "charge.success" and kind == "wallet_topup":
            user = meta.get("account")
            cur = data.get("currency") or "NGN"
            amt = _major(data.get("amount"))
            if user and amt > 0:
                credit(cursor, user, float(amt), kind="wallet_topup",
                       reference=data.get("reference") or "",
                       ref_table="payment_events", ref_id=None, currency=cur)
                create_notification(
                    user_name=user, category="wallet", type="wallet_top_up_success",
                    title="Wallet top-up successful",
                    body=f"{amt} {cur} has been credited to your wallet.",
                    actor=None, source_type="wallet", source_id=None, secondary_id=None,
                    data={"reference": data.get("reference"), "amount": str(amt), "currency": cur},
                    cursor=cursor,
                )

        # ---------------- won-lot collection ----------------
        elif event in ("charge.success", "charge.failed") and kind in ("settle_charge", "won_lot_payment"):
            reference = data.get("reference") or meta.get("reference")
            cur = data.get("currency") or "NGN"

            if event == "charge.success":
                res = apply_charge_success(
                    cursor,
                    lot_id=meta.get("lot_id"),
                    reference=reference,
                    amount_minor=data.get("amount"),
                    currency=cur,
                )
                if res.get("error"):
                    # True unknown lot -> record + ignore (don't retry garbage forever).
                    conn.commit()
                    return {"received": True, "ignored": res["error"]}
            else:
                res = _apply_charge_failed(cursor, lot_id=meta.get("lot_id"), reference=reference)
                if res.get("error"):
                    conn.commit()
                    return {"received": True, "ignored": res["error"]}

        # ---------------- house payout transfer (future/live) ----------------
        elif event == "transfer.success" and kind == "payout_transfer":
            sale_id = meta.get("sale_id")
            reference = data.get("reference") or meta.get("reference")
            if sale_id:
                cursor.execute(
                    """
                    UPDATE auctions
                    SET payout_status = 'paid',
                        payout_reference = COALESCE(NULLIF(payout_reference,''), NULLIF(%s,''), payout_reference)
                    WHERE id = %s AND settled_at IS NOT NULL
                    """,
                    (reference or "", int(sale_id)),
                )
                cursor.execute("SELECT host_username, title FROM auctions WHERE id = %s", (int(sale_id),))
                sale = cursor.fetchone()
                if sale and sale.get("host_username"):
                    create_notification(
                        user_name=sale["host_username"], category="wallet", type="payout_paid",
                        title=f"House payout sent · {sale['title']}",
                        body="The platform transfer for this sale was successful.",
                        actor=None, source_type="sale", source_id=sale_id,
                        data={"sale_id": sale_id, "reference": reference},
                        cursor=cursor,
                    )

        # transfer.failed / refunds / unknown kinds: recorded above, no-op.
        conn.commit()
        return {"received": True}

    except Exception as e:
        # Bug A fix: rollback AND return 500 so Paystack retries, AND log the cause.
        conn.rollback()
        _log(f"processing failed event={event} kind={kind} ref={data.get('reference')}: {e}")
        traceback.print_exc()
        return JSONResponse({"received": False, "error": "webhook processing failed"}, status_code=500)

    finally:
        conn.close()