"""
Shared money primitive for the FEED server (port 8001).

KEEP IN SYNC with the inline copy in auth_server.py (port 8000) — both processes
write to the SAME ledger_entries table in ONE Postgres DB. In production you'd
centralise this behind a single payments service; here, two localhost processes
sharing a DB, the duplication buys independent restarts and keeps a cross-service
HTTP hop OFF the money path. The table itself is created idempotently in BOTH
init_db() calls so either server can boot first.

Balance is NEVER a stored column: it is SUM(amount) over append-only rows.
A refund/reversal is a positive entry referencing the original — never a DELETE.
"""
import math


def balance_of(cursor, user_name):
    cursor.execute(
        "SELECT COALESCE(SUM(amount), 0)::text AS bal FROM ledger_entries WHERE user_name = %s",
        (user_name,),
    )
    row = cursor.fetchone()
    return float(row["bal"]) if row else 0.0


def _valid(amount):
    try:
        a = round(float(amount), 2)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(a) or a <= 0:
        return None
    return a


def spend(cursor, user_name, amount, kind, reference="", ref_table=None, ref_id=None):
    """Atomically debit. The CALLER owns the transaction (commit/rollback) so the
    debit and its dependent write land together. Returns (ok, err, balance_after)."""
    a = _valid(amount)
    if a is None:
        return False, "invalid amount", None
    # Lock the account row so two concurrent spends can't both clear the check.
    cursor.execute("SELECT id FROM users WHERE username = %s FOR UPDATE", (user_name,))
    if not cursor.fetchone():
        return False, "unknown user", None
    bal = balance_of(cursor, user_name)
    if bal + 1e-9 < a:
        return False, f"insufficient balance — ${bal:,.2f} available", bal
    cursor.execute(
        "INSERT INTO ledger_entries (user_name, amount, kind, reference, ref_table, ref_id) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        (user_name, -a, kind, reference, ref_table, ref_id),
    )
    return True, None, round(bal - a, 2)


def credit(cursor, user_name, amount, kind, reference="", ref_table=None, ref_id=None):
    """Atomically credit. Caller owns the transaction. Returns (ok, err, balance_after)."""
    a = _valid(amount)
    if a is None:
        return False, "invalid amount", None
    cursor.execute("SELECT id FROM users WHERE username = %s FOR UPDATE", (user_name,))
    if not cursor.fetchone():
        return False, "unknown user", None
    cursor.execute(
        "INSERT INTO ledger_entries (user_name, amount, kind, reference, ref_table, ref_id) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        (user_name, a, kind, reference, ref_table, ref_id),
    )
    return True, None, round(balance_of(cursor, user_name), 2)