"""
Paystack rail (port 8001). Thin, decision-independent money pipe.
Browser must NEVER call https://api.paystack.co directly (Cloudflare-protected,
server-to-server). The KB confirms: a browser request to api.paystack.co returns
"Why have I been blocked?" — that host is server-to-server only.

CURRENCY HANDLING (this revision):
- to_minor / to_major RESPECT the currency parameter via a per-currency
  minor-unit exponent map WHEN ONE IS PASSED, but the currency is now OPTIONAL
  (default "NGN") and an unknown/omitted code falls back to the 2-decimal scale
  instead of raising. Rationale: these two are PURE SCALE helpers, and several
  callers (webhooks.py _major, the ledger/auth_server inline copies) pass only
  the amount. A required-currency signature crashed them with
  "to_major() missing 1 required positional argument", and because the webhook
  returns 500 on exception, Paystack retried the money event forever. Optional-
  with-fallback is total (never throws) and backward-compatible, while still
  honoring a passed currency (so a live USD webhook scales in cents, not a blind
  NGN). The original version hardcoded x100 and ignored currency entirely; this
  one respects currency when given and degrades safely when not.
- initialize_charge / create_subaccount / initiate_transfer keep currency
  REQUIRED and validate it against MERCHANT_SUPPORTED_CURRENCIES (from .env)
  BEFORE posting, because there the currency genuinely affects acceptance and
  routing. A currency not enabled on the merchant returns a clear actionable
  error instead of letting Paystack bounce with the opaque
  "Currency not supported by merchant."
- create_subaccount no longer defaults currency to NGN at the call boundary;
  the caller must pass the explicit currency (a subaccount/transfer in the wrong
  currency is rejected outright).
"""

import hashlib
import hmac
import json
import os
from decimal import Decimal, ROUND_HALF_UP

import requests

BASE = "https://api.paystack.co"
PROVIDER = "paystack"

# Per-currency minor-unit exponents. Paystack amount is ALWAYS an integer in
# the smallest unit: NGN -> kobo (x100), USD/EUR/GBP -> cents (x100),
# JPY/KRW -> yen/won (x1, zero decimal places). Add any currency your merchant
# dashboard actually has enabled.
MINOR_UNIT_EXPONENT: dict[str, int] = {
    "NGN": 2, "USD": 2, "EUR": 2, "GBP": 2, "ZAR": 2, "GHS": 2, "KES": 2,
    "XOF": 0, "XAF": 0, "CDF": 0, "RWF": 0,  # zero-decimal African francs
    "JPY": 0, "KRW": 0, "VND": 0, "IDR": 2,  # common international
}

# Currencies this merchant account is approved for. Keep in sync with the
# Paystack dashboard (Settings -> Business -> Currencies / international
# payments). If a lot uses a currency not in this set, initialize_charge
# returns a clear error instead of letting Paystack bounce with
# "Currency not supported by merchant."
#
# IMPORTANT for TEST mode: a Paystack TEST account is NGN-only by default and
# the dashboard's Default Currency dropdown offers only NGN (you cannot add USD
# in test). So set PAYSTACK_SUPPORTED_CURRENCIES=NGN in .env while testing;
# otherwise this default ("NGN,USD") lets a USD lot pass our guard and hit
# Paystack, which then returns the opaque "Currency not supported by merchant."
MERCHANT_SUPPORTED_CURRENCIES: set[str] = {
    c.strip().upper()
    for c in os.getenv("PAYSTACK_SUPPORTED_CURRENCIES", "NGN,USD").split(",")
    if c.strip()
}


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


def _validate_currency(currency: str) -> str | None:
    """Return a human-readable error if the currency is unusable, else None.
    Used ONLY by the charge/transfer/subaccount boundaries, where the currency
    affects acceptance. to_minor/to_major do NOT call this (they are scale-only
    and must stay total for unseen single-arg callers)."""
    c = (currency or "").strip().upper()

    if not c:
        return "currency is required — a lot with no currency must not be charged"

    if c not in MINOR_UNIT_EXPONENT:
        return (
            f"currency {c} has no known minor-unit exponent; add it to "
            f"MINOR_UNIT_EXPONENT in paystack.py before charging"
        )

    if c not in MERCHANT_SUPPORTED_CURRENCIES:
        return (
            f"this charge is in {c}, which is not enabled on the Paystack "
            f"merchant account. Enable {c} in the Paystack dashboard "
            f"(Settings -> Currencies) or reprice the lot in a supported "
            f"currency ({', '.join(sorted(MERCHANT_SUPPORTED_CURRENCIES))})."
        )

    return None


def to_minor(amount, currency: str = "NGN") -> int:
    """Convert a decimal money string/number to the integer minor unit Paystack
    requires. currency is OPTIONAL (default NGN) so single-arg callers
    (webhooks._major, ledger copies) never crash; when a currency IS passed the
    per-currency exponent is honored. An unknown/omitted code falls back to the
    2-decimal scale (NGN/USD) rather than raising — this is a scale helper, not
    an acceptance gate, and the charge path validates currency separately.
    4,785,495.00 -> 478549500. NEVER a float, NEVER the major-unit number."""
    c = (currency or "NGN").strip().upper()
    exp = MINOR_UNIT_EXPONENT.get(c, 2)  # unknown -> 2-decimal default

    try:
        d = Decimal(str(amount if amount is not None else 0))
    except Exception:
        d = Decimal("0")

    multiplier = Decimal(10) ** exp
    return int((d * multiplier).to_integral_value(rounding=ROUND_HALF_UP))


def to_major(minor_amount, currency: str = "NGN") -> Decimal:
    """Inverse of to_minor. currency OPTIONAL (default NGN), exponent honored
    when passed, 2-decimal fallback on unknown/omitted. Total — never raises —
    so a webhook amount can never 500 the endpoint into infinite Paystack
    retries."""
    c = (currency or "NGN").strip().upper()
    exp = MINOR_UNIT_EXPONENT.get(c, 2)

    try:
        d = Decimal(str(minor_amount if minor_amount is not None else 0))
    except Exception:
        d = Decimal("0")

    divisor = Decimal(10) ** exp
    quant = Decimal("0." + "0" * exp) if exp > 0 else Decimal("1")
    return (d / divisor).quantize(quant, rounding=ROUND_HALF_UP)


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
    """Initialize a Paystack charge. currency is REQUIRED and validated against
    the merchant's supported set BEFORE posting. This converts Paystack's opaque
    'Currency not supported by merchant' into a clear, actionable error that
    names the currency and tells the operator exactly what to enable."""
    verr = _validate_currency(currency)
    if verr:
        return {"error": verr}

    c = currency.strip().upper()

    payload = {
        "email": email,
        "amount": to_minor(amount, c),
        "currency": c,
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


def create_subaccount(business_name, bank_code, account_number, currency, metadata=None):
    """Create a Paystack subaccount. currency is REQUIRED — no silent NGN
    default. A subaccount in the wrong currency will reject transfers."""
    verr = _validate_currency(currency)
    if verr:
        return {"error": verr}

    return _post("/subaccount", {
        "business_name": business_name,
        "bank_code": bank_code,
        "account_number": account_number,
        "currency": currency.strip().upper(),
        "metadata": metadata or {},
    })


def list_subaccounts():
    return _get("/subaccount")


def initiate_transfer(destination, amount, currency, reference, metadata=None):
    verr = _validate_currency(currency)
    if verr:
        return {"error": verr}

    c = currency.strip().upper()

    return _post("/transfer", {
        "source": "bank",
        "destination": destination,
        "amount": to_minor(amount, c),
        "currency": c,
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