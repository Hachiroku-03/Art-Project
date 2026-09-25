from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import psycopg2
from psycopg2.extras import RealDictCursor
import hashlib
import secrets
import json
import math
import re
import os
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL missing — check your .env file")

# Admins who may approve/reject house applications. Comma-separated usernames in .env.
# e.g. ADMIN_USERNAMES=coura,houseadmin   →   if unset, admin endpoints 403 (safe default).
ADMIN_USERNAMES = {u.strip() for u in os.getenv("ADMIN_USERNAMES", "").split(",") if u.strip()}

EMAIL_REGEX = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
FACE_THRESHOLD = 0.363

def get_db():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)

def _is_admin(viewer: str) -> bool:
    return bool(viewer) and viewer in ADMIN_USERNAMES

def init_db():
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
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
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS profiles (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            display_name TEXT,
            bio TEXT,
            extra JSONB
        )
    ''')

    # House accreditation applications — the reviewable paper trail.
    cursor.execute('''
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
    ''')

    # Migration safety net
    for column, definition in [
        ("email", "TEXT UNIQUE"),
        ("role", "TEXT DEFAULT 'artist'"),
        ("tier", "TEXT DEFAULT 'standard'"),
        ("face_embedding", "TEXT"),
    ]:
        cursor.execute(f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {column} {definition}")

    cursor.execute("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en'")
    # ← added: the two media fields the edit-wall uploads write to
    cursor.execute("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT")
    cursor.execute("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS banner_url TEXT")

    # One-time (idempotent) collapse: the collector role is retired — everyone is an artist.
    cursor.execute("UPDATE users SET role = 'artist' WHERE role = 'collector'")

    conn.commit()
    conn.close()

init_db()

def hash_password(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()

def cosine_similarity(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)

# ==========================================
# SIGNUP — single role: everyone is an artist.
# Client role is IGNORED on purpose (no self-declaring as a house).
# ==========================================
@app.post("/signup")
def signup(data: dict):
    username = data.get("username", "").strip()
    password = data.get("password", "")
    email = data.get("email", "").strip().lower()
    full_name = data.get("fullName", "").strip()
    extra = data.get("extra", {})
    language = data.get("language", "en")

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
            "INSERT INTO users (username, email, password_hash, salt, role) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (username, email, pw_hash, salt, "artist"),  # forced
        )
        user_id = cursor.fetchone()["id"]
        cursor.execute(
            "INSERT INTO profiles (user_id, display_name, bio, extra, language) VALUES (%s, %s, %s, %s, %s)",
            (user_id, full_name, "", json.dumps(extra), language),
        )
        conn.commit()
        return {"message": f"Welcome to The Space, {full_name}!"}
    except psycopg2.errors.UniqueViolation:
        conn.rollback()
        return {"error": "Username or email already taken."}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

# ==========================================
# HOUSE ACCREDITATION — apply / status / admin review
# The application FORM page and the ADMIN panel are built later;
# these endpoints are the contract they plug into.
# ==========================================
@app.post("/house/apply")
def house_apply(data: dict):
    viewer = data.get("viewer", "")
    house_name = (data.get("houseName") or "").strip()
    statement = (data.get("statement") or "").strip()
    license_no = (data.get("license") or "").strip()
    contact_email = (data.get("contactEmail") or "").strip().lower()

    if not viewer or not house_name:
        return {"error": "viewer and house name required"}
    if contact_email and not EMAIL_REGEX.match(contact_email):
        return {"error": "Invalid contact email."}

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id, role FROM users WHERE username = %s", (viewer,))
        u = cursor.fetchone()
        if not u:
            return {"error": "unknown user"}
        if u["role"] == "house":
            return {"error": "you are already an accredited house"}
        # Block re-applying while one is live (pending or approved). Rejected → may retry.
        cursor.execute(
            "SELECT status FROM house_applications WHERE user_id = %s AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1",
            (u["id"],),
        )
        if cursor.fetchone():
            return {"error": "an application is already in review"}
        cursor.execute(
            """INSERT INTO house_applications (user_id, house_name, statement, license, contact_email, status)
               VALUES (%s,%s,%s,%s,%s,'pending') RETURNING id""",
            (u["id"], house_name, statement, license_no, contact_email),
        )
        app_id = cursor.fetchone()["id"]
        conn.commit()
        return {"message": "application submitted for review", "id": app_id, "status": "pending"}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

@app.get("/house/application")
def house_application(viewer: str = ""):
    """Drives the 3-state floor button: none/rejected → apply, pending → review, approved → control room."""
    if not viewer:
        return {"error": "viewer required"}
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """SELECT h.status, h.house_name, h.created_at::text AS created_at, h.decided_at::text AS decided_at, h.admin_note
           FROM house_applications h JOIN users u ON u.id = h.user_id
           WHERE u.username = %s ORDER BY h.created_at DESC LIMIT 1""",
        (viewer,),
    )
    row = cursor.fetchone()
    conn.close()
    if not row:
        return {"status": "none"}
    return row

@app.get("/house/applications")
def house_applications_list(status: str = "", viewer: str = ""):
    """ADMIN. Lists applications (default: all). Pass ?status=pending for the review queue."""
    if not _is_admin(viewer):
        return {"error": "admin only"}
    conn = get_db()
    cursor = conn.cursor()
    if status:
        cursor.execute(
            """SELECT h.id, h.house_name, h.statement, h.license, h.contact_email, h.status, h.admin_note,
                      h.created_at::text AS created_at, h.decided_at::text AS decided_at, u.username
               FROM house_applications h JOIN users u ON u.id = h.user_id
               WHERE h.status = %s ORDER BY h.created_at DESC""",
            (status,),
        )
    else:
        cursor.execute(
            """SELECT h.id, h.house_name, h.statement, h.license, h.contact_email, h.status, h.admin_note,
                      h.created_at::text AS created_at, h.decided_at::text AS decided_at, u.username
               FROM house_applications h JOIN users u ON u.id = h.user_id
               ORDER BY h.created_at DESC"""
        )
    rows = cursor.fetchall()
    conn.close()
    return {"applications": rows}

@app.post("/house/applications/{app_id}/approve")
def house_approve(app_id: int, data: dict):
    """ADMIN. Flips status to approved AND grants the house role (the feed server gates on role)."""
    viewer = data.get("viewer", "")
    if not _is_admin(viewer):
        return {"error": "admin only"}
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT user_id, status FROM house_applications WHERE id = %s", (app_id,))
        row = cursor.fetchone()
        if not row:
            return {"error": "application not found"}
        if row["status"] == "approved":
            return {"error": "already approved"}
        cursor.execute(
            "UPDATE house_applications SET status='approved', decided_at=CURRENT_TIMESTAMP, admin_note=%s WHERE id=%s",
            (data.get("note", ""), app_id),
        )
        cursor.execute("UPDATE users SET role='house' WHERE id = %s", (row["user_id"],))
        conn.commit()
        return {"message": "house accredited", "id": app_id}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

@app.post("/house/applications/{app_id}/reject")
def house_reject(app_id: int, data: dict):
    """ADMIN. Declines the application; the member stays an artist and may re-apply."""
    viewer = data.get("viewer", "")
    if not _is_admin(viewer):
        return {"error": "admin only"}
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT status FROM house_applications WHERE id = %s", (app_id,))
        row = cursor.fetchone()
        if not row:
            return {"error": "application not found"}
        if row["status"] == "approved":
            return {"error": "cannot reject an approved house (revoke instead)"}
        cursor.execute(
            "UPDATE house_applications SET status='rejected', decided_at=CURRENT_TIMESTAMP, admin_note=%s WHERE id=%s",
            (data.get("note", ""), app_id),
        )
        conn.commit()
        return {"message": "application declined", "id": app_id}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

# ==========================================
# LOGIN
# ==========================================
@app.post("/login")
def login(data: dict):
    identifier = data.get("username", "").strip()
    password = data.get("password", "")

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM users WHERE username = %s OR email = %s",
        (identifier, identifier.lower()),
    )
    row = cursor.fetchone()
    conn.close()

    if row is None:
        return {"error": "Account not found."}
    if hash_password(password, row["salt"]) == row["password_hash"]:
        return {
            "message": f"Welcome back, {row['username']}",
            "username": row["username"],
            "role": row["role"],
            "tier": row["tier"],
            "token": secrets.token_hex(32),
        }
    return {"error": "Incorrect password."}

# ==========================================
# SETTINGS (Language Preference)
# ==========================================
@app.get("/settings")
def get_settings(viewer: str = ""):
    if not viewer:
        return {"error": "viewer required"}
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT profiles.language FROM profiles JOIN users ON users.id = profiles.user_id WHERE users.username = %s",
        (viewer,),
    )
    row = cursor.fetchone()
    conn.close()
    return {"language": (row["language"] if row else None) or "en"}

@app.put("/settings")
def update_settings(data: dict):
    viewer = data.get("viewer", "")
    language = data.get("language", "")
    if not viewer or not language:
        return {"error": "viewer and language required"}
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE profiles SET language = %s WHERE user_id = (SELECT id FROM users WHERE username = %s)",
        (language, viewer),
    )
    conn.commit()
    conn.close()
    return {"message": "settings updated", "language": language}

# ==========================================
# BIOMETRIC AUTH
# ==========================================
@app.post("/register_face")
def register_face(data: dict):
    username = data.get("username", "")
    embedding = data.get("embedding", [])
    if not username or not embedding:
        return {"error": "username and embedding required"}
    embedding_json = json.dumps(embedding)
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET face_embedding = %s WHERE username = %s",
                       (embedding_json, username))
        if cursor.rowcount == 0:
            conn.rollback()
            return {"error": "unknown user"}
        conn.commit()
        return {"message": f"face successfully registered for {username}"}
    finally:
        conn.close()

@app.post("/login_face")
def login_face(data: dict):
    embedding = data.get("embedding", [])
    if not embedding:
        return {"error": "embedding required"}

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT username, role, face_embedding FROM users WHERE face_embedding IS NOT NULL")
    rows = cursor.fetchall()
    conn.close()

    best_score = -1.0
    best_user = None
    best_role = None
    for row in rows:
        stored = json.loads(row["face_embedding"])
        score = cosine_similarity(embedding, stored)
        if score > best_score:
            best_score = score
            best_user = row["username"]
            best_role = row["role"]

    if best_user is not None and best_score >= FACE_THRESHOLD:
        return {"message": f"welcome back, {best_user}", "username": best_user,
                "role": best_role, "score": round(best_score, 3), "token": secrets.token_hex(32)}
    return {"error": "face not recognized", "score": round(best_score, 3)}

# ==========================================
# VIP MEMBERSHIP — mock upgrade, but PERSISTED to users.tier
# so the backend velvet rope (auction_access) actually opens.
# Real payment (Space Wallet) replaces this call later, same contract.
# ==========================================
@app.post("/vip/upgrade")
def vip_upgrade(data: dict):
    viewer = data.get("viewer", "")
    if not viewer:
        return {"error": "viewer required"}
    conn = get_db(); cursor = conn.cursor()
    cursor.execute("UPDATE users SET tier = 'vip' WHERE username = %s", (viewer,))
    if cursor.rowcount == 0:
        conn.close(); return {"error": "unknown user"}
    conn.commit(); conn.close()
    return {"message": "welcome to the inner circle", "tier": "vip"}

@app.post("/vip/cancel")
def vip_cancel(data: dict):
    viewer = data.get("viewer", "")
    if not viewer:
        return {"error": "viewer required"}
    conn = get_db(); cursor = conn.cursor()
    cursor.execute("UPDATE users SET tier = 'standard' WHERE username = %s", (viewer,))
    conn.commit(); conn.close()
    return {"message": "membership paused", "tier": "standard"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)