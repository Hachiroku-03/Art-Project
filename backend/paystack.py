"""
Paystack rail (port 8001). Thin, decision-independent money pipe: charge, verify,
subaccount, transfer, webhook signature + idempotent event recording. It does NOT
know about sales, paddles, or settlement — routers/webhooks.py and routers/sales.py
call these. Built so it is SAFE TO IMPORT AND RUN WITH NO KEYS: every outbound
helper returns {"error": "paystack not configured"} instead of raising, so the app
boots and develops before you have a Paystack account. Live round-trips need test
keys (free, instant, no KYC); real money needs a verified live account (legal-gated).

Amounts: Paystack uses MINOR units. NGN/USD/GBP/EUR/ZAR are all 2-decimal, so
to_minor(x) = round(x * 100). If you ever add a 0- or 3-decimal currency (JPY, BHD),
this helper is the single place that must learn per-currency exponents — flagged,
not silently wrong.
"""
import hashlib
import hmac
import json
import os

import requests

BASE = "https://api.paystack.co"
PROVIDER = "paystack"


def _secret():
    return (os.getenv("PAYSTACK_SECRET_KEY") or "").strip()


def _headers():
    return {
        "Authorization": f"Bearer {_secret()}",
        "Content-Type": "application/json",
    }


def configured() -> bool:
    return bool(_secret())


def to_minor(amount, currency="NGN") -> int:
    # 2-decimal for all currencies Paystack supports today; the param exists so a
    # future 0/3-decimal currency is a one-line change here, not a 100x money bug.
    return int(round(float(amount) * 100))


def _post(path, payload):
    if not configured():
        return {"error": "paystack not configured"}
    try:
        r = requests.post(f"{BASE}{path}", headers=_headers(), json=payload, timeout=20)
        return r.json()
    except Exception as e:
        return {"error": f"paystack request failed: {e}"}


def _get(path):
    if not configured():
        return {"error": "paystack not configured"}
    try:
        r = requests.get(f"{BASE}{path}", headers=_headers(), timeout=20)
        return r.json()
    except Exception as e:
        return {"error": f"paystack request failed: {e}"}


# ---- charges (top-up + settle collection both go through these) ----
def initialize_charge(email, amount, currency, reference, metadata=None, subaccounts=None):
    """Create a charge. `subaccounts` = [{"subaccount": "SUB_xxx", "transaction_split": minor}]
    for the E2 split-at-charge model; omit for a plain charge (e.g. wallet top-up).
    amount is MAJOR units here; converted to minor inside."""
    payload = {
        "email": email,
        "amount": to_minor(amount, currency),
        "currency": currency,
        "reference": reference,
        "metadata": metadata or {},
    }
    if subaccounts:
        payload["subaccounts"] = subaccounts
    return _post("/transaction/initialize", payload)


def verify_charge(reference):
    return _get(f"/transaction/verify/{reference}")


# ---- subaccounts (the house's slice of a split charge) ----
def create_subaccount(business_name, bank_code, account_number, currency="NGN", metadata=None):
    payload = {
        "business_name": business_name,
        "bank_code": bank_code,
        "account_number": account_number,
        "currency": currency,
        "metadata": metadata or {},
    }
    return _post("/subaccount", payload)


def list_subaccounts():
    return _get("/subaccount")


# ---- transfers (house payout, refunds, manual adjustments) ----
def initiate_transfer(destination, amount, currency, reference, metadata=None):
    payload = {
        "source": "bank",
        "destination": destination,        # a Paystack bank recipient code (BT_xxx)
        "amount": to_minor(amount, currency),
        "currency": currency,
        "reference": reference,
        "metadata": metadata or {},
    }
    return _post("/transfer", payload)


def verify_transfer(reference):
    return _get(f"/transfer/verify/{reference}")


# ---- webhooks: signature + idempotency ----
def verify_webhook_signature(raw_body: bytes, signature: str, secret: str = None) -> bool:
    """Paystack signs the RAW request body with HMAC-SHA512(secret) and sends the
    hex digest in x-paystack-signature. Compare in constant time. Rejects when
    unconfigured (fail closed — an unsigned/unknown event must never credit money)."""
    sec = (secret or _secret()).strip()
    if not sec or not signature:
        return False
    mac = hmac.new(sec.encode("utf-8"), raw_body, hashlib.sha512).hexdigest()
    return hmac.compare_digest(mac, signature.strip())


def record_event(cursor, event_id, event_type, account=None, currency=None,
                 amount=None, reference=None, payload=None) -> bool:
    """Idempotency gate. Returns True if THIS call is the first to see the event
    (proceed), False if it's a replay (skip). UNIQUE(provider, event_id) is the
    key — same race-safe pattern as the call-reminder sweep. The caller commits
    only after its dependent write lands, so a crash mid-handling replays cleanly."""
    cursor.execute(
        """
        INSERT INTO payment_events (provider, event_id, type, account, currency,
                                    amount, reference, payload)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (provider, event_id) DO NOTHING
        RETURNING id
        """,
        (PROVIDER, str(event_id), event_type, account, currency, amount,
         reference, json.dumps(payload or {})),
    )
    return cursor.fetchone() is not None