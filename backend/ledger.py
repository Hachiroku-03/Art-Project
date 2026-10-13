"""
Shared money primitive for the FEED server (port 8001).

KEEP IN SYNC with the inline copy in auth_server.py (port 8000) — both processes
write to the SAME ledger_entries table in ONE Postgres DB. In production you'd
centralise this behind a single payments service; here, two localhost processes
sharing a DB, the duplication buys independent restarts and keeps a cross-service
HTTP hop OFF the money path. The table itself is created idempotently in BOTH
init_db() calls so either server can boot first.

MULTI-CURRENCY (Phase 1.1): balance is per (account, currency), never one global
number. A user can only spend a currency they actually hold; conversion happens
at the processor (Paystack) on top-up, never here. No in-app FX.

HOLDERS: __platform_revenue__ and __escrow__ are ledger accounts with NO users
row. They let the platform record its cut and (later, E1) hold buyer funds
without a bank account. spend()/credit() detect them and serialize via an
advisory lock on (account, currency) instead of the users-row lock.

Balance is NEVER a stored column: it is SUM(amount) over append-only rows, per
currency. A refund/reversal is a positive entry referencing the original —
never a DELETE.
"""
import math

DEFAULT_CURRENCY = "NGN"

# Ledger holder accounts: not real users, no login, no users row.
PLATFORM_REVENUE = "__platform_revenue__"
ESCROW = "__escrow__"
HOLDERS = {PLATFORM_REVENUE, ESCROW}


def _is_holder(account):
    return account in HOLDERS


def balance_of(cursor, user_name, currency=DEFAULT_CURRENCY):
    cursor.execute(
        "SELECT COALESCE(SUM(amount), 0)::text AS bal FROM ledger_entries "
        "WHERE user_name = %s AND currency = %s",
        (user_name, currency),
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


def _lock_account(cursor, account, currency):
    """Serialize concurrent ops on the same (account, currency) within this txn.
    Advisory lock works for users AND holders and is finer than locking the users
    row (one user's NGN and USD spends no longer contend). For real users we also
    validate existence with a plain SELECT (no row lock needed — the advisory
    lock already serializes every balance op for this account+currency)."""
    cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"{account}|{currency}",))
    if not _is_holder(account):
        cursor.execute("SELECT id FROM users WHERE username = %s", (account,))
        if not cursor.fetchone():
            return False
    return True


def spend(cursor, user_name, amount, kind="spend", reference="", ref_table=None, ref_id=None, currency=DEFAULT_CURRENCY):
    """Atomically debit `currency` from `user_name`. The CALLER owns the
    transaction (commit/rollback) so the debit and its dependent write land
    together. Returns (ok, err, balance_after)."""
    a = _valid(amount)
    if a is None:
        return False, "invalid amount", None
    if not _lock_account(cursor, user_name, currency):
        return False, "unknown user", None
    bal = balance_of(cursor, user_name, currency)
    if bal + 1e-9 < a:
        # No currency symbol: the wallet is single-currency today in practice
        # (no per-wallet currency selection yet) and the product is
        # currency-agnostic by design; the code names the unit instead.
        return False, f"insufficient {currency} balance — {bal:,.2f} available", bal
    cursor.execute(
        "INSERT INTO ledger_entries (user_name, amount, currency, kind, reference, ref_table, ref_id) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (user_name, -a, currency, kind, reference, ref_table, ref_id),
    )
    return True, None, round(bal - a, 2)


def credit(cursor, user_name, amount, kind="credit", reference="", ref_table=None, ref_id=None, currency=DEFAULT_CURRENCY):
    """Atomically credit `currency` to `user_name`. Caller owns the txn.
    Returns (ok, err, balance_after)."""
    a = _valid(amount)
    if a is None:
        return False, "invalid amount", None
    if not _lock_account(cursor, user_name, currency):
        return False, "unknown user", None
    cursor.execute(
        "INSERT INTO ledger_entries (user_name, amount, currency, kind, reference, ref_table, ref_id) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (user_name, a, currency, kind, reference, ref_table, ref_id),
    )
    return True, None, round(balance_of(cursor, user_name, currency), 2)