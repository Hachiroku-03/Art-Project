"""
Paystack webhook receiver. One endpoint, signature-verified, idempotent, routed by
metadata.kind. This is the ONLY place external money events enter the ledger, so
it never trusts the client and never double-applies (record_event gate).
"""
import json

from fastapi import APIRouter, Request

from db import get_db
from ledger import credit, ESCROW
import paystack

router = APIRouter()


@router.post("/webhooks/paystack")
async def paystack_webhook(request: Request):
    raw = await request.body()
    sig = request.headers.get("x-paystack-signature", "")
    if not paystack.verify_webhook_signature(raw, sig):
        # fail closed: an unverified body must not move money
        return {"received": False, "reason": "invalid signature"}

    try:
        body = json.loads(raw)
    except Exception:
        return {"received": False, "reason": "bad json"}

    event = body.get("event") or ""
    data = body.get("data") or {}
    event_id = body.get("id") or data.get("reference") or ""   # prefer notification id
    meta = data.get("metadata") or {}
    kind = meta.get("kind")

    conn = get_db()
    cursor = conn.cursor()
    try:
        # Idempotency: a replayed event returns False here and we skip all effects.
        first = paystack.record_event(
            cursor, event_id, event,
            account=meta.get("account"), currency=data.get("currency"),
            amount=data.get("amount"), reference=data.get("reference"), payload=body,
        )
        if not first:
            conn.commit()
            return {"received": True, "duplicate": True}

        if event == "charge.success" and kind == "wallet_topup":
            user = meta.get("account")
            cur = data.get("currency") or "NGN"
            # amount from Paystack is MINOR; convert back to major for the ledger
            amt = float(data.get("amount") or 0) / 100.0
            if user and amt > 0:
                credit(cursor, user, amt, kind="wallet_topup",
                       reference=data.get("reference") or "", ref_table="payment_events",
                       ref_id=None, currency=cur)

        elif event == "charge.success" and kind == "settle_charge":
            lot_id = meta.get("lot_id")
            sale_id = meta.get("sale_id")
            cur = data.get("currency") or "NGN"
            collected = float(data.get("amount") or 0) / 100.0   # Paystack amount is minor units
            # The buyer's money is now HELD by the platform until payout. Record it
            # against the escrow holder so the ledger can answer "what do we owe the
            # house?" — this is the E1-ready bookkeeping, even though E2 releases
            # immediately once a payout transfer exists.
            if collected > 0:
                credit(cursor, ESCROW, collected, kind="settle_in",
                       reference=data.get("reference") or "", ref_table="lots",
                       ref_id=lot_id, currency=cur)
            if lot_id:
                cursor.execute("UPDATE lots SET payment_status='paid' WHERE id = %s", (lot_id,))
            if sale_id:
                # sale is fully collected only when every won lot is paid
                cursor.execute(
                    """UPDATE auctions SET payout_status = CASE
                         WHEN NOT EXISTS(SELECT 1 FROM lots
                                         WHERE sale_id = %s AND status='sold'
                                           AND payment_status <> 'paid')
                         THEN 'paid' ELSE 'pending' END
                       WHERE id = %s""",
                    (sale_id, sale_id),
                )

        # transfer.success / refund events: recorded above; act on them when the
        # payout/refund flows land (next chunks). Unknown kinds: recorded, no-op.
        conn.commit()
        return {"received": True}
    except Exception as e:
        conn.rollback()
        return {"received": False, "error": str(e)}
    finally:
        conn.close()