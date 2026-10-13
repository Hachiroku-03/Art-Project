# backend/ledger_test.py  — run with:  python ledger_test.py
# Proves the Phase 1.1 foundation: balances are PER-CURRENCY and you cannot
# cross-spend. Uses the __escrow__ holder so it needs no real account and no
# server restart (it calls init_db() itself). Rolls back at the end, so it
# leaves zero rows behind.
import os
import psycopg2
from psycopg2.extras import RealDictCursor

import db                      # triggers load_dotenv() from a proper file frame
from ledger import credit, spend, balance_of

db.init_db()                   # ensure currency columns + indexes exist before testing

url = os.environ["DATABASE_URL"]
conn = psycopg2.connect(url, cursor_factory=RealDictCursor)
cur = conn.cursor()

u = "__escrow__"               # holder account: no users row required, perfect for this test

credit(cur, u, 50000, kind="topup_test", currency="NGN")
credit(cur, u, 200,   kind="topup_test", currency="USD")
print("NGN balance:", balance_of(cur, u, "NGN"))   # expect 50000.0
print("USD balance:", balance_of(cur, u, "USD"))   # expect 200.0

ok, err, _ = spend(cur, u, 300, kind="spend_test", currency="USD")
print("USD overspend blocked:", not ok, "->", err)  # expect True, "insufficient USD balance — 200.00 available"

ok, err, bal = spend(cur, u, 1000, kind="spend_test", currency="NGN")
print("NGN spend ok:", ok, "new NGN:", bal)         # expect True, 49000.0

conn.rollback()                # discard the test rows; schema from init_db() stays
conn.close()
print("DONE — rolled back, no rows left")