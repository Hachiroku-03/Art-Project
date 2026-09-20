from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import psycopg2
from psycopg2.extras import RealDictCursor
import os
import secrets
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

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp3", ".wav", ".ogg", ".webm", ".m4a"}

def get_db():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)

def init_db():
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS posts (
            id SERIAL PRIMARY KEY,
            author_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            image_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute("ALTER TABLE posts ADD COLUMN IF NOT EXISTS price TEXT")

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS likes (
            post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
            user_name TEXT,
            PRIMARY KEY (post_id, user_name)
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS comments (
            id SERIAL PRIMARY KEY,
            post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
            user_name TEXT,
            body TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute("ALTER TABLE comments ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'text'")
    cursor.execute("ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE")

    # NEW: Comment likes table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS comment_likes (
            comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
            user_name TEXT,
            PRIMARY KEY (comment_id, user_name)
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS follows (
            follower TEXT,
            followee TEXT,
            PRIMARY KEY (follower, followee)
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS bids (
            id SERIAL PRIMARY KEY,
            post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
            user_name TEXT,
            amount NUMERIC(12,2),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    conn.commit()
    conn.close()

init_db()

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXT:
        return {"error": "file type not allowed"}
    name = f"{secrets.token_hex(8)}{ext}"
    with open(os.path.join(UPLOAD_DIR, name), "wb") as f:
        f.write(await file.read())
    return {"url": f"http://localhost:8001/uploads/{name}"}

@app.get("/feed")
def get_feed(viewer: str = ""):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT posts.id, posts.type, posts.title, posts.description, posts.image_url, posts.price,
               posts.created_at::text AS created_at,
               users.username, users.role, users.tier,
               profiles.display_name,
               (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id) AS like_count,
               (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS comment_count,
               (SELECT MAX(amount)::text FROM bids WHERE bids.post_id = posts.id) AS current_bid,
               EXISTS(SELECT 1 FROM likes WHERE likes.post_id = posts.id AND likes.user_name = %s) AS liked_by_viewer,
               EXISTS(SELECT 1 FROM follows WHERE follower = %s AND followee = users.username) AS followed_by_viewer
        FROM posts
        JOIN users ON posts.author_id = users.id
        LEFT JOIN profiles ON profiles.user_id = users.id
        ORDER BY posts.created_at DESC
        LIMIT 20
    ''', (viewer, viewer))
    feed_items = cursor.fetchall()
    conn.close()
    return {"feed": feed_items}

@app.post("/posts/{post_id}/like")
def toggle_like(post_id: int, data: dict):
    viewer = data.get("viewer", "")
    if not viewer:
        return {"error": "viewer required"}
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM likes WHERE post_id = %s AND user_name = %s", (post_id, viewer))
    if cursor.fetchone():
        cursor.execute("DELETE FROM likes WHERE post_id = %s AND user_name = %s", (post_id, viewer))
        liked = False
    else:
        cursor.execute("INSERT INTO likes (post_id, user_name) VALUES (%s, %s)", (post_id, viewer))
        liked = True
    conn.commit()
    cursor.execute("SELECT COUNT(*) AS c FROM likes WHERE post_id = %s", (post_id,))
    count = cursor.fetchone()["c"]
    conn.close()
    return {"liked": liked, "count": count}

@app.get("/posts/{post_id}/comments")
def get_comments(post_id: int, viewer: str = ""):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        '''SELECT comments.id, comments.user_name, comments.body, comments.kind, comments.parent_id,
                  comments.created_at::text AS created_at,
                  (SELECT COUNT(*) FROM comment_likes WHERE comment_likes.comment_id = comments.id) AS like_count,
                  EXISTS(SELECT 1 FROM comment_likes WHERE comment_likes.comment_id = comments.id AND comment_likes.user_name = %s) AS liked_by_viewer
           FROM comments WHERE comments.post_id = %s ORDER BY comments.created_at ASC''',
        (viewer, post_id),
    )
    rows = cursor.fetchall()
    conn.close()
    return {"comments": rows}

@app.post("/posts/{post_id}/comments")
def add_comment(post_id: int, data: dict):
    viewer = data.get("viewer", "")
    body = data.get("body", "").strip()
    kind = data.get("kind", "text")
    parent_id = data.get("parent_id")
    if not viewer or not body:
        return {"error": "viewer and body required"}
    if kind not in ("text", "image", "voice"):
        return {"error": "invalid comment kind"}
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO comments (post_id, user_name, body, kind, parent_id) VALUES (%s, %s, %s, %s, %s) RETURNING id, user_name, body, kind, parent_id, created_at::text AS created_at",
        (post_id, viewer, body, kind, parent_id),
    )
    row = cursor.fetchone()
    conn.commit()
    conn.close()
    return {"comment": row}

@app.post("/comments/{comment_id}/like")
def toggle_comment_like(comment_id: int, data: dict):
    viewer = data.get("viewer", "")
    if not viewer:
        return {"error": "viewer required"}
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM comment_likes WHERE comment_id = %s AND user_name = %s", (comment_id, viewer))
    if cursor.fetchone():
        cursor.execute("DELETE FROM comment_likes WHERE comment_id = %s AND user_name = %s", (comment_id, viewer))
        liked = False
    else:
        cursor.execute("INSERT INTO comment_likes (comment_id, user_name) VALUES (%s, %s)", (comment_id, viewer))
        liked = True
    conn.commit()
    cursor.execute("SELECT COUNT(*) AS c FROM comment_likes WHERE comment_id = %s", (comment_id,))
    count = cursor.fetchone()["c"]
    conn.close()
    return {"liked": liked, "count": count}

@app.post("/follow")
def toggle_follow(data: dict):
    viewer = data.get("viewer", "")
    target = data.get("target", "")
    if not viewer or not target or viewer == target:
        return {"error": "invalid follow"}
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM follows WHERE follower = %s AND followee = %s", (viewer, target))
    if cursor.fetchone():
        cursor.execute("DELETE FROM follows WHERE follower = %s AND followee = %s", (viewer, target))
        following = False
    else:
        cursor.execute("INSERT INTO follows (follower, followee) VALUES (%s, %s)", (viewer, target))
        following = True
    conn.commit()
    conn.close()
    return {"following": following}

@app.post("/seed_feed")
def seed_feed():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE role = 'artist' LIMIT 1")
    artist = cursor.fetchone()
    if not artist:
        conn.close()
        return {"error": "No artists exist yet. Sign up as an artist first!"}
    artist_id = artist["id"]

    dummy_posts = [
        ("drop", "Midnight in Obsidian", "New sculpture series exploring negative space.",
         "https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?w=800", "4500"),
        ("studio", "Process: Carving the Marble", "A look into the 40 hours it took to shape the base.",
         "https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=800", ""),
        ("hammer", "SOLD: Echoes of Tomorrow", "Final hammer price: $14,500. Thank you to the collectors.",
         "https://images.unsplash.com/photo-1578321272176-b7bbc0679853?w=800", "14500"),
    ]
    for p_type, title, desc, img, price in dummy_posts:
        cursor.execute(
            "INSERT INTO posts (author_id, type, title, description, image_url, price) VALUES (%s, %s, %s, %s, %s, %s)",
            (artist_id, p_type, title, desc, img, price),
        )
    conn.commit()
    conn.close()
    return {"message": "Feed seeded with 3 posts!"}

@app.post("/posts")
def create_post(data: dict):
    viewer = data.get("viewer", "")
    p_type = data.get("type", "drop")
    title = data.get("title", "").strip()
    description = data.get("description", "").strip()
    image_url = data.get("image_url", "").strip()
    price = data.get("price", "").strip()

    if not viewer or not title:
        return {"error": "viewer and title required"}
    if p_type not in ("drop", "studio", "hammer"):
        return {"error": "invalid post type"}

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id, role FROM users WHERE username = %s", (viewer,))
    author = cursor.fetchone()
    if not author:
        conn.close()
        return {"error": "unknown author"}
    if author["role"] == "collector":
        conn.close()
        return {"error": "collectors cannot post"}

    cursor.execute(
        "INSERT INTO posts (author_id, type, title, description, image_url, price) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
        (author["id"], p_type, title, description, image_url, price),
    )
    new_id = cursor.fetchone()["id"]
    conn.commit()
    conn.close()
    return {"message": "posted", "id": new_id}

@app.get("/posts/{post_id}")
def get_post(post_id: int, viewer: str = ""):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT posts.id, posts.type, posts.title, posts.description, posts.image_url, posts.price,
               posts.created_at::text AS created_at,
               users.username, users.role, users.tier,
               profiles.display_name,
               (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id) AS like_count,
               (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS comment_count,
               (SELECT MAX(amount)::text FROM bids WHERE bids.post_id = posts.id) AS current_bid,
               EXISTS(SELECT 1 FROM likes WHERE likes.post_id = posts.id AND likes.user_name = %s) AS liked_by_viewer,
               EXISTS(SELECT 1 FROM follows WHERE follower = %s AND followee = users.username) AS followed_by_viewer
        FROM posts
        JOIN users ON posts.author_id = users.id
        LEFT JOIN profiles ON profiles.user_id = users.id
        WHERE posts.id = %s
    ''', (viewer, viewer, post_id))
    post = cursor.fetchone()
    conn.close()
    if not post:
        return {"error": "post not found"}
    return {"post": post}

@app.post("/posts/{post_id}/bid")
def place_bid(post_id: int, data: dict):
    viewer = data.get("viewer", "")
    try:
        amount = float(data.get("amount", 0))
    except (TypeError, ValueError):
        return {"error": "invalid amount"}
    if not viewer or amount <= 0:
        return {"error": "viewer and positive amount required"}
        
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT COALESCE(MAX(amount), 0) AS top FROM bids WHERE post_id = %s", (post_id,))
    top = float(cursor.fetchone()["top"])
    
    if amount <= top:
        conn.close()
        return {"error": f"bid must exceed current bid of {top}"}
        
    cursor.execute("INSERT INTO bids (post_id, user_name, amount) VALUES (%s, %s, %s)", (post_id, viewer, amount))
    conn.commit()
    conn.close()
    return {"message": "bid placed", "current_bid": amount}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)