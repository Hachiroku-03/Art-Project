"""
Auth / profile / wallet / VIP service.

Port:
    http://localhost:8000

This service owns:
- signup
- login
- password login
- face registration/login
- profile/settings
- house accreditation
- wallet ledger
- VIP subscription
- /me endpoint used by Navbar

IMPORTANT LEDGER PARITY:
This service shares the same ledger_entries table as backend port 8001.
The currency filtering and advisory-lock key formula must stay identical to
backend/ledger.py, otherwise the two processes can double-spend.

IMPORTANT CORS:
Do not use allow_origins=["*"] together with allow_credentials=True.
Use explicit origins.
"""

import hashlib
import json
import math
import os
import re
import secrets

import psycopg2
from psycopg2 import errors as pg_errors
from psycopg2.extras import RealDictCursor

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse


load_dotenv()

app = FastAPI()


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL missing — check your .env file")

# Admins who may approve/reject house applications.
# Comma-separated usernames in .env.
ADMIN_USERNAMES = {
    u.strip()
    for u in os.getenv("ADMIN_USERNAMES", "").split(",")
    if u.strip()
}

# Monthly VIP price, debited on signup/renewal.
# Keep this env-overridable. If your wallet is NGN-denominated, this should
# probably be an NGN amount, not USD 20.
VIP_PRICE = float(os.getenv("VIP_PRICE", "20"))

# Mock/dev wallet top-up cap.
WALLET_TOPUP_CAP = float(os.getenv("WALLET_TOPUP_CAP", "10000"))

# Multi-currency + ledger holders.
# MUST match backend/ledger.py on port 8001 EXACTLY.
DEFAULT_CURRENCY = "NGN"
PLATFORM_REVENUE = "__platform_revenue__"
ESCROW = "__escrow__"
HOLDERS = {PLATFORM_REVENUE, ESCROW}

EMAIL_REGEX = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
FACE_THRESHOLD = float(os.getenv("FACE_THRESHOLD", "0.363"))

# CORS:
# Explicit origins only. Do not use ["*"] with credentials.
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]

if not ALLOWED_ORIGINS:
    ALLOWED_ORIGINS = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

ALLOW_CREDENTIALS = os.getenv("ALLOW_CREDENTIALS", "true").lower() == "true"

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=ALLOW_CREDENTIALS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------

def get_db():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)


def _is_admin(viewer: str) -> bool:
    return bool(viewer) and viewer in ADMIN_USERNAMES


def init_db():
    conn = get_db()
    cursor = conn.cursor()

    # Users
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            role TEXT DEFAULT 'artist',
            tier TEXT DEFAULT 'standard',
            face_embedding TEXT
        )
        """
    )

    # Profiles
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS profiles (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            display_name TEXT,
            bio TEXT,
            extra JSONB,
            language TEXT DEFAULT 'en',
            avatar_url TEXT,
            banner_url TEXT
        )
        """
    )

    # House applications
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS house_applications (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            house_name TEXT NOT NULL,
            statement TEXT,
            license TEXT,
            contact_email TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            admin_note TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            decided_at TIMESTAMP
        )
        """
    )

    # Ledger
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS ledger_entries (
            id SERIAL PRIMARY KEY,
            user_name TEXT NOT NULL,
            amount NUMERIC(18,2) NOT NULL,
            kind TEXT NOT NULL,
            reference TEXT,
            ref_table TEXT,
            ref_id INTEGER,
            currency TEXT NOT NULL DEFAULT 'NGN',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    # VIP subscriptions
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS vip_subscriptions (
            user_name TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'active',
            price NUMERIC(18,2) NOT NULL DEFAULT 0,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            renews_at TIMESTAMP NOT NULL,
            cancelled_at TIMESTAMP,
            last_charged_at TIMESTAMP,
            periods_paid INTEGER NOT NULL DEFAULT 0,
            failure_reason TEXT
        )
        """
    )

    # -----------------------------------------------------------------------
    # Idempotent migrations for older databases
    # -----------------------------------------------------------------------

    for column, definition in [
        ("email", "TEXT UNIQUE"),
        ("role", "TEXT DEFAULT 'artist'"),
        ("tier", "TEXT DEFAULT 'standard'"),
        ("face_embedding", "TEXT"),
    ]:
        cursor.execute(
            f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {column} {definition}"
        )

    cursor.execute(
        "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en'"
    )
    cursor.execute(
        "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT"
    )
    cursor.execute(
        "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS banner_url TEXT"
    )

    cursor.execute(
        """
        ALTER TABLE ledger_entries
        ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'
        """
    )

    # Expand money precision safely if an older table used NUMERIC(12,2).
    cursor.execute(
        """
        ALTER TABLE ledger_entries
        ALTER COLUMN amount TYPE NUMERIC(18,2)
        """
    )

    cursor.execute(
        """
        ALTER TABLE vip_subscriptions
        ALTER COLUMN price TYPE NUMERIC(18,2)
        """
    )

    # Indexes
    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ledger_user
        ON ledger_entries (user_name, created_at DESC)
        """
    )

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ledger_acct_cur
        ON ledger_entries (user_name, currency, created_at DESC)
        """
    )

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_house_app_user_status
        ON house_applications (user_id, status, created_at DESC)
        """
    )

    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_users_username_lower
        ON users (lower(username))
        """
    )

    # One-time retirement of collector role: everyone is an artist.
    cursor.execute("UPDATE users SET role = 'artist' WHERE role = 'collector'")

    conn.commit()
    conn.close()


init_db()


# ---------------------------------------------------------------------------
# Password / face helpers
# ---------------------------------------------------------------------------

def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode(),
        salt.encode(),
        100_000,
    ).hex()


def _valid_embedding(embedding) -> list[float] | None:
    """
    Validate a face embedding before storing/comparing.

    Must be a non-empty list of finite floats.
    """
    if not isinstance(embedding, list) or not embedding:
        return None

    try:
        vec = [float(x) for x in embedding]
    except (TypeError, ValueError):
        return None

    if not all(math.isfinite(x) for x in vec):
        return None

    return vec


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """
    Cosine similarity.

    If dimensions differ, return 0.0 instead of silently truncating with zip().
    """
    if not a or not b or len(a) != len(b):
        return 0.0

    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))

    if norm_a == 0 or norm_b == 0:
        return 0.0

    return dot / (norm_a * norm_b)


# ---------------------------------------------------------------------------
# Ledger helpers — KEEP IN SYNC WITH backend/ledger.py on port 8001
#
# Per-currency + advisory-locked.
# The lock key f"{account}|{currency}" must be byte-identical to 8001's.
# Do not "optimize" this back to a users-row FOR UPDATE; that breaks
# cross-process serialization between port 8000 and port 8001.
# ---------------------------------------------------------------------------

def _is_holder(account: str) -> bool:
    return account in HOLDERS


def balance_of(cursor, user_name: str, currency: str = DEFAULT_CURRENCY) -> float:
    cursor.execute(
        """
        SELECT COALESCE(SUM(amount), 0)::text AS bal
        FROM ledger_entries
        WHERE user_name = %s
          AND currency = %s
        """,
        (user_name, currency),
    )
    row = cursor.fetchone()
    return float(row["bal"]) if row else 0.0


def _valid_amount(amount) -> float | None:
    try:
        a = round(float(amount), 2)
    except (TypeError, ValueError):
        return None

    if not math.isfinite(a) or a <= 0:
        return None

    return a


def _lock_account(cursor, account: str, currency: str) -> bool:
    """
    Serialize balance mutations across both processes.

    Returns False if a real user account does not exist.
    Holder accounts like __escrow__ and __platform_revenue__ have no users row.
    """
    cursor.execute(
        "SELECT pg_advisory_xact_lock(hashtext(%s))",
        (f"{account}|{currency}",),
    )

    if not _is_holder(account):
        cursor.execute(
            "SELECT id FROM users WHERE username = %s",
            (account,),
        )
        if not cursor.fetchone():
            return False

    return True


def spend(
    cursor,
    user_name: str,
    amount,
    kind: str,
    reference: str = "",
    ref_table: str | None = None,
    ref_id: int | None = None,
    currency: str = DEFAULT_CURRENCY,
):
    a = _valid_amount(amount)
    if a is None:
        return False, "invalid amount", None

    if not _lock_account(cursor, user_name, currency):
        return False, "unknown user", None

    bal = balance_of(cursor, user_name, currency)

    if bal + 1e-9 < a:
        return (
            False,
            f"insufficient {currency} balance — {bal:,.2f} available",
            bal,
        )

    cursor.execute(
        """
        INSERT INTO ledger_entries (
            user_name,
            amount,
            currency,
            kind,
            reference,
            ref_table,
            ref_id
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (user_name, -a, currency, kind, reference, ref_table, ref_id),
    )

    return True, None, round(bal - a, 2)


def credit(
    cursor,
    user_name: str,
    amount,
    kind: str,
    reference: str = "",
    ref_table: str | None = None,
    ref_id: int | None = None,
    currency: str = DEFAULT_CURRENCY,
):
    a = _valid_amount(amount)
    if a is None:
        return False, "invalid amount", None

    if not _lock_account(cursor, user_name, currency):
        return False, "unknown user", None

    cursor.execute(
        """
        INSERT INTO ledger_entries (
            user_name,
            amount,
            currency,
            kind,
            reference,
            ref_table,
            ref_id
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (user_name, a, currency, kind, reference, ref_table, ref_id),
    )

    return True, None, round(balance_of(cursor, user_name, currency), 2)


# ---------------------------------------------------------------------------
# VIP sweep — lazy monthly renewal, no scheduler.
#
# Runs at the single-call sites where VIP is actually needed:
#   login, /wallet, /vip/*, /wallet/topup
#
# It is intentionally NOT run inside the public /sales loop. The auction floor
# gate reads the subscription table directly through backend helpers.
#
# Concurrency:
# The claim UPDATE is serialized by the subscription row lock. Under READ
# COMMITTED, a second concurrent sweep re-evaluates renews_at <= now() after the
# lock releases and matches 0 rows, so a period is never charged twice.
#
# A SAVEPOINT isolates the claim so a FAILED charge rolls back only the claim,
# not the caller's whole transaction.
# ---------------------------------------------------------------------------

def _sweep_vip(cursor, viewer: str) -> str:
    """
    Normalize the subscription, charge/lapse as due, re-sync users.tier.

    Caller owns the transaction.
    Returns the effective tier after sweeping.
    """
    if not viewer:
        return "standard"

    cursor.execute(
        "SELECT tier FROM users WHERE username = %s",
        (viewer,),
    )
    u = cursor.fetchone()

    if not u:
        return "standard"

    # Grandfather: legacy tier='vip' with no sub row gets the current month free,
    # then renews like everyone else. Non-VIPs never get a row.
    cursor.execute(
        "SELECT 1 FROM vip_subscriptions WHERE user_name = %s",
        (viewer,),
    )

    if not cursor.fetchone():
        if u["tier"] == "vip":
            cursor.execute(
                """
                INSERT INTO vip_subscriptions (
                    user_name,
                    status,
                    price,
                    renews_at,
                    started_at,
                    periods_paid
                )
                VALUES (%s, 'active', %s, CURRENT_TIMESTAMP + INTERVAL '1 month', CURRENT_TIMESTAMP, 0)
                """,
                (viewer, VIP_PRICE),
            )
        else:
            return "standard"

    # Cancelled-and-expired -> stop, no charge. Access already ran to renews_at.
    cursor.execute(
        """
        UPDATE vip_subscriptions
        SET status = 'cancelled'
        WHERE user_name = %s
          AND status = 'active'
          AND cancelled_at IS NOT NULL
          AND renews_at <= CURRENT_TIMESTAMP
        """,
        (viewer,),
    )

    # Active-or-past_due, not cancelled, and due -> optimistic claim, then charge.
    cursor.execute("SAVEPOINT vip_sweep")

    cursor.execute(
        """
        UPDATE vip_subscriptions
        SET
            renews_at = GREATEST(renews_at, CURRENT_TIMESTAMP) + INTERVAL '1 month',
            last_charged_at = CURRENT_TIMESTAMP,
            periods_paid = periods_paid + 1,
            status = 'active',
            failure_reason = NULL
        WHERE user_name = %s
          AND cancelled_at IS NULL
          AND status IN ('active', 'past_due')
          AND renews_at <= CURRENT_TIMESTAMP
        RETURNING price
        """,
        (viewer,),
    )

    claimed = cursor.fetchone()

    if claimed:
        ok, err, _ = spend(
            cursor,
            viewer,
            float(claimed["price"]),
            "vip_renewal",
            "VIP membership · monthly renewal",
            "vip_subscriptions",
            None,
        )

        if not ok:
            # Undo the claim only. Do not consume renews_at/periods_paid for
            # money we did not take.
            cursor.execute("ROLLBACK TO SAVEPOINT vip_sweep")
            cursor.execute(
                """
                UPDATE vip_subscriptions
                SET
                    status = 'past_due',
                    failure_reason = %s
                WHERE user_name = %s
                """,
                (err, viewer),
            )

    # Authoritative cache sync:
    # tier == 'vip' iff an active sub is in-date.
    # cancelled_at does NOT reduce access, so it is not part of this predicate.
    cursor.execute(
        """
        SELECT
            CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM vip_subscriptions
                    WHERE user_name = %s
                      AND status = 'active'
                      AND renews_at > CURRENT_TIMESTAMP
                )
                THEN 'vip'
                ELSE 'standard'
            END AS t
        """,
        (viewer,),
    )

    eff = cursor.fetchone()["t"]

    cursor.execute(
        "UPDATE users SET tier = %s WHERE username = %s",
        (eff, viewer),
    )

    return eff


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True, "service": "auth", "port": 8000}


# ---------------------------------------------------------------------------
# Signup
# ---------------------------------------------------------------------------

@app.post("/signup")
def signup(data: dict):
    username = str(data.get("username") or "").strip()
    password = str(data.get("password") or "")
    email = str(data.get("email") or "").strip().lower()
    full_name = str(data.get("fullName") or "").strip()
    extra = data.get("extra") or {}
    language = str(data.get("language") or "en").strip() or "en"

    if not username or not password or not email or not full_name:
        return {"error": "All fields are required."}

    if not EMAIL_REGEX.match(email):
        return {"error": "Invalid email address."}

    if len(password) < 8:
        return {"error": "Password must be at least 8 characters."}

    if len(username) < 3:
        return {"error": "Username must be at least 3 characters."}

    salt = secrets.token_hex(16)
    pw_hash = hash_password(password, salt)

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            """
            INSERT INTO users (
                username,
                email,
                password_hash,
                salt,
                role
            )
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (username, email, pw_hash, salt, "artist"),
        )

        user_id = cursor.fetchone()["id"]

        cursor.execute(
            """
            INSERT INTO profiles (
                user_id,
                display_name,
                bio,
                extra,
                language
            )
            VALUES (%s, %s, %s, %s, %s)
            """,
            (user_id, full_name, "", json.dumps(extra), language),
        )

        conn.commit()

        return {
            "message": f"Welcome to The Space, {full_name}!",
            "username": username,
            "role": "artist",
            "tier": "standard",
        }

    except pg_errors.UniqueViolation:
        conn.rollback()
        return {"error": "Username or email already taken."}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

@app.post("/login")
def login(data: dict):
    identifier = str(data.get("username") or "").strip()
    password = str(data.get("password") or "")

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT *
            FROM users
            WHERE username = %s
               OR lower(email) = lower(%s)
            """,
            (identifier, identifier),
        )

        row = cursor.fetchone()

        if row is None:
            return {"error": "Account not found."}

        if hash_password(password, row["salt"]) != row["password_hash"]:
            return {"error": "Incorrect password."}

        # Sweep VIP first so the tier the client caches is never stale at
        # session start.
        tier = _sweep_vip(cursor, row["username"])

        conn.commit()

        return {
            "message": f"Welcome back, {row['username']}",
            "username": row["username"],
            "role": row["role"],
            "tier": tier,
            "token": secrets.token_hex(32),
        }

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


# ---------------------------------------------------------------------------
# /me and /profile
#
# This is the missing endpoint that caused:
#   GET http://localhost:8000/me?viewer=ken 404
#
# It returns both:
#   { "user": { ... } }
# and flat fields:
#   { "username": ..., "role": ..., ... }
#
# That maximizes compatibility with older/newer Navbar code.
# ---------------------------------------------------------------------------

def _me_response(ident: str):
    ident = str(ident or "").strip()

    if not ident:
        return JSONResponse(
            {"error": "viewer required"},
            status_code=400,
        )

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                u.username,
                u.email,
                u.role,
                u.tier,
                p.display_name,
                p.avatar_url,
                p.banner_url,
                p.language
            FROM users u
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE u.username = %s
               OR lower(u.email) = lower(%s)
            """,
            (ident, ident),
        )

        row = cursor.fetchone()

        if not row:
            return JSONResponse(
                {"error": "user not found"},
                status_code=404,
            )

        username = row["username"]

        # Per-currency balances.
        cursor.execute(
            """
            SELECT
                currency,
                COALESCE(SUM(amount), 0)::text AS bal
            FROM ledger_entries
            WHERE user_name = %s
            GROUP BY currency
            ORDER BY currency
            """,
            (username,),
        )

        balances = {
            r["currency"]: r["bal"]
            for r in cursor.fetchall()
        }

        ngn_balance = balances.get(DEFAULT_CURRENCY, "0.00")

        # Determine effective VIP tier without mutating/charging in a GET.
        #
        # If a subscription row exists, trust the subscription table.
        # If no subscription row exists, fall back to the cached users.tier so
        # legacy grandfathered VIPs do not instantly disappear from the navbar.
        cursor.execute(
            "SELECT 1 FROM vip_subscriptions WHERE user_name = %s",
            (username,),
        )

        has_sub = cursor.fetchone() is not None

        if has_sub:
            cursor.execute(
                """
                SELECT
                    CASE
                        WHEN EXISTS (
                            SELECT 1
                            FROM vip_subscriptions
                            WHERE user_name = %s
                              AND status = 'active'
                              AND renews_at > CURRENT_TIMESTAMP
                        )
                        THEN 'vip'
                        ELSE 'standard'
                    END AS t
                """,
                (username,),
            )

            effective_tier = cursor.fetchone()["t"]
        else:
            effective_tier = row["tier"] or "standard"

        cursor.execute(
            """
            SELECT
                status,
                price::text AS price,
                renews_at::text AS renews_at,
                cancelled_at::text AS cancelled_at,
                periods_paid,
                failure_reason
            FROM vip_subscriptions
            WHERE user_name = %s
            """,
            (username,),
        )

        sub_row = cursor.fetchone()
        subscription = dict(sub_row) if sub_row else None

        payload = {
            "username": username,
            "email": row["email"],
            "role": row["role"],
            "tier": effective_tier,
            "cached_tier": row["tier"] or "standard",
            "is_vip": effective_tier == "vip",
            "display_name": row["display_name"] or username,
            "avatar_url": row["avatar_url"],
            "banner_url": row["banner_url"],
            "language": row["language"] or "en",
            "balance": ngn_balance,
            "balances": balances,
            "vip_price": VIP_PRICE,
            "vip_subscription": subscription,
        }

        # Return both shapes:
        # { user: {...}, username: ..., role: ..., ... }
        return {
            "user": payload,
            **payload,
        }

    except Exception as e:
        return JSONResponse(
            {"error": str(e)},
            status_code=500,
        )

    finally:
        conn.close()


@app.get("/me")
def me(viewer: str = "", username: str = ""):
    return _me_response(viewer or username)


@app.get("/profile")
def profile(viewer: str = "", username: str = ""):
    return _me_response(viewer or username)


# ---------------------------------------------------------------------------
# Settings / language
# ---------------------------------------------------------------------------

@app.get("/settings")
def get_settings(viewer: str = ""):
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT p.language
            FROM profiles p
            JOIN users u ON u.id = p.user_id
            WHERE u.username = %s
            """,
            (viewer,),
        )

        row = cursor.fetchone()
        return {"language": (row["language"] if row else None) or "en"}

    except Exception as e:
        return {"error": str(e)}

    finally:
        conn.close()


def _update_settings(data: dict):
    viewer = str(data.get("viewer") or "").strip()
    language = str(data.get("language") or "").strip()

    if not viewer or not language:
        return {"error": "viewer and language required"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            """
            UPDATE profiles
            SET language = %s
            WHERE user_id = (
                SELECT id FROM users WHERE username = %s
            )
            """,
            (language, viewer),
        )

        conn.commit()
        return {"message": "settings updated", "language": language}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


@app.put("/settings")
def update_settings_put(data: dict):
    return _update_settings(data)


@app.patch("/settings")
def update_settings_patch(data: dict):
    return _update_settings(data)


# ---------------------------------------------------------------------------
# Biometric auth
# ---------------------------------------------------------------------------

@app.post("/register_face")
def register_face(data: dict):
    username = str(data.get("username") or "").strip()
    embedding = _valid_embedding(data.get("embedding"))

    if not username:
        return {"error": "username required"}

    if embedding is None:
        return {"error": "valid embedding required"}

    embedding_json = json.dumps(embedding)

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            "UPDATE users SET face_embedding = %s WHERE username = %s",
            (embedding_json, username),
        )

        if cursor.rowcount == 0:
            conn.rollback()
            return {"error": "unknown user"}

        conn.commit()
        return {"message": f"face successfully registered for {username}"}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


@app.post("/login_face")
def login_face(data: dict):
    embedding = _valid_embedding(data.get("embedding"))

    if embedding is None:
        return {"error": "valid embedding required"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT username, role, tier, face_embedding
            FROM users
            WHERE face_embedding IS NOT NULL
            """
        )

        rows = cursor.fetchall()

        best_score = -1.0
        best_user = None
        best_role = None
        best_tier = "standard"

        for row in rows:
            try:
                stored_raw = json.loads(row["face_embedding"])
            except Exception:
                continue

            stored = _valid_embedding(stored_raw)

            if stored is None:
                continue

            score = cosine_similarity(embedding, stored)

            if score > best_score:
                best_score = score
                best_user = row["username"]
                best_role = row["role"]
                best_tier = row["tier"]

        if best_user is not None and best_score >= FACE_THRESHOLD:
            # Same sweep as password login.
            tier = _sweep_vip(cursor, best_user)
            conn.commit()

            return {
                "message": f"welcome back, {best_user}",
                "username": best_user,
                "role": best_role,
                "tier": tier,
                "score": round(best_score, 3),
                "token": secrets.token_hex(32),
            }

        return {
            "error": "face not recognized",
            "score": round(best_score, 3),
        }

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


# ---------------------------------------------------------------------------
# VIP membership — monthly subscription.
#
# upgrade = charge for current period + set renews_at (+1 month).
# cancel  = stop auto-renew at period end; access continues to renews_at; no refund.
# resume  = clear pending cancel while paid time remains; free, that month is bought.
# ---------------------------------------------------------------------------

@app.post("/vip/upgrade")
def vip_upgrade(data: dict):
    viewer = str(data.get("viewer") or "").strip()

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        # Normalize first. A lapsed-active must not read as "already vip".
        _sweep_vip(cursor, viewer)

        cursor.execute(
            """
            SELECT
                status,
                cancelled_at,
                renews_at
            FROM vip_subscriptions
            WHERE user_name = %s
            FOR UPDATE
            """,
            (viewer,),
        )

        # Already active and paid through -> no charge.
        cursor.execute(
            """
            SELECT 1
            FROM vip_subscriptions
            WHERE user_name = %s
              AND status = 'active'
              AND cancelled_at IS NULL
              AND renews_at > CURRENT_TIMESTAMP
            """,
            (viewer,),
        )

        if cursor.fetchone():
            conn.rollback()
            return {"error": "you are already a VIP member"}

        # Paid-through-but-cancelled -> resume auto-renew, no charge.
        cursor.execute(
            """
            SELECT 1
            FROM vip_subscriptions
            WHERE user_name = %s
              AND status = 'active'
              AND cancelled_at IS NOT NULL
              AND renews_at > CURRENT_TIMESTAMP
            """,
            (viewer,),
        )

        if cursor.fetchone():
            cursor.execute(
                """
                UPDATE vip_subscriptions
                SET cancelled_at = NULL
                WHERE user_name = %s
                """,
                (viewer,),
            )

            cursor.execute(
                "UPDATE users SET tier = 'vip' WHERE username = %s",
                (viewer,),
            )

            conn.commit()

            cursor.execute(
                """
                SELECT renews_at::text AS renews_at
                FROM vip_subscriptions
                WHERE user_name = %s
                """,
                (viewer,),
            )

            return {
                "message": "membership resumed",
                "tier": "vip",
                "charged": 0,
                "renews_at": cursor.fetchone()["renews_at"],
            }

        # Create / resume-from-past_due / reactivate / renew-lapsed -> charge.
        ok, err, bal = spend(
            cursor,
            viewer,
            VIP_PRICE,
            "vip_upgrade",
            "VIP membership · monthly",
            "vip_subscriptions",
            None,
        )

        if not ok:
            conn.rollback()
            return {"error": err}

        cursor.execute(
            """
            INSERT INTO vip_subscriptions (
                user_name,
                status,
                price,
                started_at,
                renews_at,
                cancelled_at,
                last_charged_at,
                periods_paid,
                failure_reason
            )
            VALUES (
                %s,
                'active',
                %s,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP + INTERVAL '1 month',
                NULL,
                CURRENT_TIMESTAMP,
                1,
                NULL
            )
            ON CONFLICT (user_name) DO UPDATE SET
                status = 'active',
                price = EXCLUDED.price,
                renews_at = CURRENT_TIMESTAMP + INTERVAL '1 month',
                cancelled_at = NULL,
                last_charged_at = CURRENT_TIMESTAMP,
                periods_paid = vip_subscriptions.periods_paid + 1,
                failure_reason = NULL
            """,
            (viewer, VIP_PRICE),
        )

        cursor.execute(
            "UPDATE users SET tier = 'vip' WHERE username = %s",
            (viewer,),
        )

        conn.commit()

        cursor.execute(
            """
            SELECT renews_at::text AS renews_at
            FROM vip_subscriptions
            WHERE user_name = %s
            """,
            (viewer,),
        )

        return {
            "message": "welcome to the inner circle",
            "tier": "vip",
            "charged": VIP_PRICE,
            "balance": f"{bal:,.2f}",
            "renews_at": cursor.fetchone()["renews_at"],
        }

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


@app.post("/vip/cancel")
def vip_cancel(data: dict):
    viewer = str(data.get("viewer") or "").strip()

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                status,
                cancelled_at,
                renews_at::text AS renews_at
            FROM vip_subscriptions
            WHERE user_name = %s
            FOR UPDATE
            """,
            (viewer,),
        )

        sub = cursor.fetchone()

        if not sub or sub["status"] != "active":
            conn.rollback()
            return {"error": "no active membership to cancel"}

        if sub["cancelled_at"]:
            conn.rollback()
            return {
                "message": "cancellation already scheduled",
                "access_until": sub["renews_at"],
            }

        cursor.execute(
            """
            UPDATE vip_subscriptions
            SET cancelled_at = CURRENT_TIMESTAMP
            WHERE user_name = %s
            """,
            (viewer,),
        )

        # Tier stays 'vip' until renews_at. The sweep lapses it then.
        conn.commit()

        return {
            "message": "membership will end at the close of the current period",
            "access_until": sub["renews_at"],
        }

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


@app.get("/vip/status")
def vip_status(viewer: str = ""):
    """
    Light, canonical VIP truth.

    Sweeps, then returns subscription + balance so the pricing page can warn:
    "your balance won't cover the next renewal".
    """
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        tier = _sweep_vip(cursor, viewer)

        # VIP is NGN-denominated, so "can you afford the next renewal" must look
        # at the NGN balance ONLY. Summing USD into it would falsely tell a
        # lapsed member they're funded when their dollars cannot pay a naira bill.
        cursor.execute(
            """
            SELECT COALESCE(SUM(amount), 0)::text AS bal
            FROM ledger_entries
            WHERE user_name = %s
              AND currency = %s
            """,
            (viewer, DEFAULT_CURRENCY),
        )

        bal = cursor.fetchone()["bal"]

        cursor.execute(
            """
            SELECT
                status,
                price::text AS price,
                renews_at::text AS renews_at,
                cancelled_at::text AS cancelled_at,
                periods_paid,
                failure_reason
            FROM vip_subscriptions
            WHERE user_name = %s
            """,
            (viewer,),
        )

        sub_row = cursor.fetchone()
        subscription = dict(sub_row) if sub_row else None

        conn.commit()

        return {
            "vip": tier == "vip",
            "tier": tier,
            "balance": bal,
            "price": VIP_PRICE,
            "subscription": subscription,
        }

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Wallet — balance, history, mock top-up, paddle recovery.
#
# Top-up sweeps after crediting, so adding funds revives a past_due membership
# without the user touching the pricing page.
# ---------------------------------------------------------------------------

@app.get("/wallet")
def wallet(viewer: str = ""):
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        tier = _sweep_vip(cursor, viewer)

        # Per-currency: a user can hold NGN and USD independently.
        # `balance` stays the NGN figure for back-compat with any UI reading one
        # number. `balances` is the full per-currency map the wallet page should
        # render. History carries currency so each row can be labeled.
        cursor.execute(
            """
            SELECT
                currency,
                COALESCE(SUM(amount), 0)::text AS bal
            FROM ledger_entries
            WHERE user_name = %s
            GROUP BY currency
            ORDER BY currency
            """,
            (viewer,),
        )

        bal_rows = cursor.fetchall()
        balances = {r["currency"]: r["bal"] for r in bal_rows}
        bal = balances.get(DEFAULT_CURRENCY, "0.00")

        cursor.execute(
            """
            SELECT
                id,
                amount::text AS amount,
                currency,
                kind,
                reference,
                created_at::text AS created_at
            FROM ledger_entries
            WHERE user_name = %s
            ORDER BY created_at DESC, id DESC
            LIMIT 50
            """,
            (viewer,),
        )

        rows = cursor.fetchall()

        cursor.execute(
            """
            SELECT
                status,
                price::text AS price,
                renews_at::text AS renews_at,
                cancelled_at::text AS cancelled_at,
                periods_paid,
                failure_reason
            FROM vip_subscriptions
            WHERE user_name = %s
            """,
            (viewer,),
        )

        sub_row = cursor.fetchone()
        subscription = dict(sub_row) if sub_row else None

        conn.commit()

        return {
            "balance": bal,
            "balances": balances,
            "tier": tier,
            "vip_price": VIP_PRICE,
            "entries": rows,
            "subscription": subscription,
        }

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


@app.post("/wallet/topup")
def wallet_topup(data: dict):
    """
    DEV/MOCK top-up.

    The Paystack rail on backend port 8001 supersedes this for real money:
        webhooks.py charge.success -> credit()

    This endpoint is kept so a wallet can be funded in local test without a
    provider. Currency-aware, default NGN, matching the webhook path.
    """
    viewer = str(data.get("viewer") or "").strip()

    if not viewer:
        return {"error": "viewer required"}

    amount = _valid_amount(data.get("amount"))

    if amount is None:
        return {"error": "enter a positive amount"}

    if amount > WALLET_TOPUP_CAP:
        return {
            "error": (
                f"single top-up capped at {WALLET_TOPUP_CAP:,.2f} major units"
            )
        }

    currency = str(data.get("currency") or DEFAULT_CURRENCY).strip().upper()

    if len(currency) != 3 or not currency.isalpha():
        return {"error": "currency must be a 3-letter ISO code"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        ok, err, bal = credit(
            cursor,
            viewer,
            amount,
            "top_up",
            "Add funds",
            currency=currency,
        )

        if not ok:
            conn.rollback()
            return {"error": err}

        # Revive a past_due NGN membership with fresh NGN funds.
        _sweep_vip(cursor, viewer)

        conn.commit()

        # credit() already returns the new balance for THIS currency, so no
        # cross-currency re-sum here. The old SUM would have mixed USD in.
        return {
            "message": "funds added",
            "balance": f"{bal:,.2f}",
            "currency": currency,
            "added": amount,
        }

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


@app.get("/wallet/paddles")
def wallet_paddles(viewer: str = ""):
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                t.auction_id,
                t.code,
                a.title,
                a.status,
                a.host_username,
                a.ends_at::text AS ends_at,
                t.purchased_at::text AS obtained_at
            FROM tickets t
            JOIN auctions a ON a.id = t.auction_id
            WHERE t.user_name = %s
            ORDER BY
                (a.status = 'live') DESC,
                (a.status = 'upcoming') DESC,
                t.purchased_at DESC
            """,
            (viewer,),
        )

        rows = cursor.fetchall()

        return {"paddles": rows}

    except Exception as e:
        return {"error": str(e)}

    finally:
        conn.close()


# ---------------------------------------------------------------------------
# House accreditation — apply / status / admin review
# ---------------------------------------------------------------------------

@app.post("/house/apply")
def house_apply(data: dict):
    viewer = str(data.get("viewer") or "").strip()
    house_name = str(data.get("houseName") or "").strip()
    statement = str(data.get("statement") or "").strip()
    license_no = str(data.get("license") or "").strip()
    contact_email = str(data.get("contactEmail") or "").strip().lower()

    if not viewer or not house_name:
        return {"error": "viewer and house name required"}

    if contact_email and not EMAIL_REGEX.match(contact_email):
        return {"error": "Invalid contact email."}

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            "SELECT id, role FROM users WHERE username = %s",
            (viewer,),
        )

        u = cursor.fetchone()

        if not u:
            return {"error": "unknown user"}

        if u["role"] == "house":
            return {"error": "you are already an accredited house"}

        cursor.execute(
            """
            SELECT status
            FROM house_applications
            WHERE user_id = %s
              AND status IN ('pending', 'approved')
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (u["id"],),
        )

        if cursor.fetchone():
            return {"error": "an application is already in review"}

        cursor.execute(
            """
            INSERT INTO house_applications (
                user_id,
                house_name,
                statement,
                license,
                contact_email,
                status
            )
            VALUES (%s, %s, %s, %s, %s, 'pending')
            RETURNING id
            """,
            (u["id"], house_name, statement, license_no, contact_email),
        )

        app_id = cursor.fetchone()["id"]
        conn.commit()

        return {
            "message": "application submitted for review",
            "id": app_id,
            "status": "pending",
        }

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


@app.get("/house/application")
def house_application(viewer: str = ""):
    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT
                h.status,
                h.house_name,
                h.created_at::text AS created_at,
                h.decided_at::text AS decided_at,
                h.admin_note
            FROM house_applications h
            JOIN users u ON u.id = h.user_id
            WHERE u.username = %s
            ORDER BY h.created_at DESC
            LIMIT 1
            """,
            (viewer,),
        )

        row = cursor.fetchone()

        if not row:
            return {"status": "none"}

        return row

    except Exception as e:
        return {"error": str(e)}

    finally:
        conn.close()


@app.get("/house/applications")
def house_applications_list(status: str = "", viewer: str = ""):
    if not _is_admin(viewer):
        return {"error": "admin only"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        if status:
            cursor.execute(
                """
                SELECT
                    h.id,
                    h.house_name,
                    h.statement,
                    h.license,
                    h.contact_email,
                    h.status,
                    h.admin_note,
                    h.created_at::text AS created_at,
                    h.decided_at::text AS decided_at,
                    u.username
                FROM house_applications h
                JOIN users u ON u.id = h.user_id
                WHERE h.status = %s
                ORDER BY h.created_at DESC
                """,
                (status,),
            )
        else:
            cursor.execute(
                """
                SELECT
                    h.id,
                    h.house_name,
                    h.statement,
                    h.license,
                    h.contact_email,
                    h.status,
                    h.admin_note,
                    h.created_at::text AS created_at,
                    h.decided_at::text AS decided_at,
                    u.username
                FROM house_applications h
                JOIN users u ON u.id = h.user_id
                ORDER BY h.created_at DESC
                """
            )

        rows = cursor.fetchall()
        return {"applications": rows}

    except Exception as e:
        return {"error": str(e)}

    finally:
        conn.close()


@app.post("/house/applications/{app_id}/approve")
def house_approve(app_id: int, data: dict):
    viewer = str(data.get("viewer") or "").strip()

    if not _is_admin(viewer):
        return {"error": "admin only"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            "SELECT user_id, status FROM house_applications WHERE id = %s",
            (app_id,),
        )

        row = cursor.fetchone()

        if not row:
            return {"error": "application not found"}

        if row["status"] == "approved":
            return {"error": "already approved"}

        cursor.execute(
            """
            UPDATE house_applications
            SET
                status = 'approved',
                decided_at = CURRENT_TIMESTAMP,
                admin_note = %s
            WHERE id = %s
            """,
            (data.get("note", ""), app_id),
        )

        cursor.execute(
            "UPDATE users SET role = 'house' WHERE id = %s",
            (row["user_id"],),
        )

        conn.commit()

        return {
            "message": "house accredited",
            "id": app_id,
        }

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


@app.post("/house/applications/{app_id}/reject")
def house_reject(app_id: int, data: dict):
    viewer = str(data.get("viewer") or "").strip()

    if not _is_admin(viewer):
        return {"error": "admin only"}

    conn = get_db()

    try:
        cursor = conn.cursor()

        cursor.execute(
            "SELECT status FROM house_applications WHERE id = %s",
            (app_id,),
        )

        row = cursor.fetchone()

        if not row:
            return {"error": "application not found"}

        if row["status"] == "approved":
            return {"error": "cannot reject an approved house (revoke instead)"}

        cursor.execute(
            """
            UPDATE house_applications
            SET
                status = 'rejected',
                decided_at = CURRENT_TIMESTAMP,
                admin_note = %s
            WHERE id = %s
            """,
            (data.get("note", ""), app_id),
        )

        conn.commit()

        return {
            "message": "application declined",
            "id": app_id,
        }

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}

    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
    )