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

EMAIL_REGEX = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
FACE_THRESHOLD = 0.363

def get_db():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)

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
            role TEXT DEFAULT 'collector',
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

    # Migration safety net
    for column, definition in [
        ("email", "TEXT UNIQUE"),
        ("role", "TEXT DEFAULT 'collector'"),
        ("tier", "TEXT DEFAULT 'standard'"),
        ("face_embedding", "TEXT"),
    ]:
        cursor.execute(f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {column} {definition}")
        
    # New: Add language column to profiles
    cursor.execute("ALTER TABLE profiles ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en'")

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
# SIGNUP (Captures browser language)
# ==========================================
@app.post("/signup")
def signup(data: dict):
    username = data.get("username", "").strip()
    password = data.get("password", "")
    email = data.get("email", "").strip().lower()
    full_name = data.get("fullName", "").strip()
    role = data.get("role", "collector")
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
    if role not in ("collector", "artist", "house"):
        return {"error": "Invalid role."}

    salt = secrets.token_hex(16)
    pw_hash = hash_password(password, salt)

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (username, email, password_hash, salt, role) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (username, email, pw_hash, salt, role),
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)