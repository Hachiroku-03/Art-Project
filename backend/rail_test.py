# backend/rail_test.py  — run with:  python rail_test.py
# Proves the rail is correct WITHOUT a Paystack account: minor-unit math, the
# HMAC signature check (with a known secret), and the webhook idempotency gate.
import hashlib
import hmac
import json
import os

import db
import paystack
from db import get_db

db.init_db()

# 1) minor units: the 100x bug guard
assert paystack.to_minor(50000.00, "NGN") == 5000000, "to_minor NGN wrong"
assert paystack.to_minor(200.50, "USD") == 20050, "to_minor USD wrong"
print("to_minor ok (50000.00 NGN ->", paystack.to_minor(50000, "NGN"), "kobo)")

# 2) signature verify, with a FAKE secret so we test the crypto, not the network
sec = "sk_test_fakelocal"
body = json.dumps({"event": "charge.success", "data": {"amount": 5000000}}).encode()
good = hmac.new(sec.encode(), body, hashlib.sha512).hexdigest()
assert paystack.verify_webhook_signature(body, good, sec) is True, "valid sig rejected"
assert paystack.verify_webhook_signature(body, "deadbeef", sec) is False, "bad sig accepted"
assert paystack.verify_webhook_signature(body, good, "") is False, "empty secret accepted (must fail closed)"
print("webhook signature verify ok (and fails closed on empty secret)")

# 3) idempotency: same event_id twice -> second call returns False (replay skipped)
conn = get_db(); cur = conn.cursor()
eid = "test_evt_" + str(os.urandom(4).hex())
first = paystack.record_event(cur, eid, "charge.success", account="__escrow__",
                              currency="NGN", amount=5000000, reference="r1", payload={})
second = paystack.record_event(cur, eid, "charge.success", account="__escrow__",
                               currency="NGN", amount=5000000, reference="r1", payload={})
conn.rollback(); conn.close()   # leave no rows
assert first is True and second is False, "idempotency gate failed"
print("payment_events idempotency ok (replay rejected)")

print("RAIL OK — no keys, no account, no network required")