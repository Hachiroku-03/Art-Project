"""
Paystack rail (port 8001). Thin, decision-independent money pipe.
Browser must NEVER call https://api.paystack.co directly (Cloudflare-protected,
server-to-server). See the standing boundary ruling at the bottom of this answer.
"""

import hashlib
import hmac
import json
import os
from decimal import Decimal, ROUND_HALF_UP

import requests

BASE = "https://api.paystack.co"
PROVIDER = "paystack"


def _secret() -> str:
    return (os.getenv("PAYSTACK_SECRET_KEY") or "").strip()


def _frontend_url() -> str:
    return (os.getenv("FRONTEND_URL") or "http://localhost:5173").rstrip("/")


def _default_callback_url() -> str:
    return (os.getenv("PAYSTACK_CALLBACK_URL") or f"{_frontend_url()}/wins?payment=completed").strip()


def _headers():
    return {
        "Authorization": f"Bearer {_secret()}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def configured() -> bool:
    return bool(_secret())


def to_minor(amount, currency: str = "NGN") -> int:
    try:
        d = Decimal(str(amount if amount is not None else 0))
    except Exception:
        d = Decimal("0")
    return int((d * Decimal(100)).to_integral_value(rounding=ROUND_HALF_UP))


def to_major(minor_amount, currency: str = "NGN") -> Decimal:
    try:
        d = Decimal(str(minor_amount if minor_amount is not None else 0))
    except Exception:
        d = Decimal("0")
    return (d / Decimal(100)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _parse(r):
    try:
        return r.json()
    except Exception:
        return {"status": False, "message": f"non-JSON response (HTTP {r.status_code})"}


def _post(path: str, payload: dict):
    if not configured():
        return {"error": "paystack not configured"}
    try:
        r = requests.post(f"{BASE}{path}", headers=_headers(), json=payload, timeout=20)
        return _parse(r)
    except Exception as e:
        return {"error": f"paystack request failed: {e}"}


def _get(path: str):
    if not configured():
        return {"error": "paystack not configured"}
    try:
        r = requests.get(f"{BASE}{path}", headers=_headers(), timeout=20)
        return _parse(r)
    except Exception as e:
        return {"error": f"paystack request failed: {e}"}


def initialize_charge(email, amount, currency, reference, metadata=None, subaccounts=None, callback_url=None):
    payload = {
        "email": email,
        "amount": to_minor(amount, currency),
        "currency": currency,
        "reference": reference,
        "metadata": metadata or {},
    }
    cb = (callback_url or _default_callback_url()).strip()
    if cb:
        payload["callback_url"] = cb
    if subaccounts:
        payload["subaccounts"] = subaccounts
    return _post("/transaction/initialize", payload)


def verify_charge(reference: str):
    return _get(f"/transaction/verify/{reference}")


def create_subaccount(business_name, bank_code, account_number, currency="NGN", metadata=None):
    return _post("/subaccount", {
        "business_name": business_name,
        "bank_code": bank_code,
        "account_number": account_number,
        "currency": currency,
        "metadata": metadata or {},
    })


def list_subaccounts():
    return _get("/subaccount")


def initiate_transfer(destination, amount, currency, reference, metadata=None):
    return _post("/transfer", {
        "source": "bank",
        "destination": destination,
        "amount": to_minor(amount, currency),
        "currency": currency,
        "reference": reference,
        "metadata": metadata or {},
    })


def verify_transfer(reference: str):
    return _get(f"/transfer/verify/{reference}")


def verify_webhook_signature(raw_body: bytes, signature: str, secret: str | None = None) -> bool:
    sec = (secret or _secret()).strip()
    if not sec or not signature:
        return False
    mac = hmac.new(sec.encode("utf-8"), raw_body, hashlib.sha512).hexdigest()
    return hmac.compare_digest(mac, str(signature).strip())


def record_event(cursor, event_id, event_type, account=None, currency=None,
                 amount=None, reference=None, payload=None) -> bool:
    cursor.execute(
        """
        INSERT INTO payment_events (provider, event_id, type, account, currency, amount, reference, payload)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (provider, event_id) DO NOTHING
        RETURNING id
        """,
        (PROVIDER, str(event_id or ""), event_type, account, currency, amount,
         reference, json.dumps(payload or {}, default=str)),
    )
    return cursor.fetchone() is not None