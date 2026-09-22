from fastapi import APIRouter, UploadFile, File
import os
import secrets
from db import get_db

router = APIRouter()

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp3", ".wav", ".ogg", ".webm", ".m4a"}

@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXT: return {"error": "file type not allowed"}
    name = f"{secrets.token_hex(8)}{ext}"
    with open(os.path.join(UPLOAD_DIR, name), "wb") as f: f.write(await file.read())
    return {"url": f"http://localhost:8001/uploads/{name}"}

@router.get("/feed")
def get_feed(viewer: str = ""):
    conn = get_db(); cursor = conn.cursor()
    cursor.execute('''SELECT posts.id, posts.type, posts.title, posts.description, posts.image_url, posts.price, posts.created_at::text AS created_at, users.username, users.role, users.tier, profiles.display_name, (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id) AS like_count, (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS comment_count, (SELECT MAX(amount)::text FROM bids WHERE bids.post_id = posts.id) AS current_bid, EXISTS(SELECT 1 FROM likes WHERE likes.post_id = posts.id AND likes.user_name = %s) AS liked_by_viewer, EXISTS(SELECT 1 FROM follows WHERE follower = %s AND followee = users.username) AS followed_by_viewer FROM posts JOIN users ON posts.author_id = users.id LEFT JOIN profiles ON profiles.user_id = users.id ORDER BY posts.created_at DESC LIMIT 20''', (viewer, viewer))
    feed_items = cursor.fetchall(); conn.close()
    return {"feed": feed_items}

@router.post("/posts")
def create_post(data: dict):
    viewer, p_type, title = data.get("viewer", ""), data.get("type", "drop"), data.get("title", "").strip()
    description, image_url, price = data.get("description", "").strip(), data.get("image_url", "").strip(), data.get("price", "").strip()
    if not viewer or not title: return {"error": "viewer and title required"}
    conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT id, role FROM users WHERE username = %s", (viewer,))
    author = cursor.fetchone()
    if not author: conn.close(); return {"error": "unknown author"}
    if author["role"] == "collector": conn.close(); return {"error": "collectors cannot post"}
    cursor.execute("INSERT INTO posts (author_id, type, title, description, image_url, price) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id", (author["id"], p_type, title, description, image_url, price))
    new_id = cursor.fetchone()["id"]; conn.commit(); conn.close()
    return {"message": "posted", "id": new_id}

@router.get("/posts/{post_id}")
def get_post(post_id: int, viewer: str = ""):
    conn = get_db(); cursor = conn.cursor()
    cursor.execute('''SELECT posts.id, posts.type, posts.title, posts.description, posts.image_url, posts.price, posts.created_at::text AS created_at, users.username, users.role, users.tier, profiles.display_name, (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id) AS like_count, (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS comment_count, (SELECT MAX(amount)::text FROM bids WHERE bids.post_id = posts.id) AS current_bid, EXISTS(SELECT 1 FROM likes WHERE likes.post_id = posts.id AND likes.user_name = %s) AS liked_by_viewer, EXISTS(SELECT 1 FROM follows WHERE follower = %s AND followee = users.username) AS followed_by_viewer FROM posts JOIN users ON posts.author_id = users.id LEFT JOIN profiles ON profiles.user_id = users.id WHERE posts.id = %s''', (viewer, viewer, post_id))
    post = cursor.fetchone(); conn.close()
    if not post: return {"error": "post not found"}
    return {"post": post}

@router.post("/posts/{post_id}/like")
def toggle_like(post_id: int, data: dict):
    viewer = data.get("viewer", ""); conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM likes WHERE post_id = %s AND user_name = %s", (post_id, viewer))
    if cursor.fetchone(): cursor.execute("DELETE FROM likes WHERE post_id = %s AND user_name = %s", (post_id, viewer)); liked = False
    else: cursor.execute("INSERT INTO likes (post_id, user_name) VALUES (%s, %s)", (post_id, viewer)); liked = True
    conn.commit(); cursor.execute("SELECT COUNT(*) AS c FROM likes WHERE post_id = %s", (post_id,)); count = cursor.fetchone()["c"]; conn.close()
    return {"liked": liked, "count": count}

@router.get("/posts/{post_id}/comments")
def get_comments(post_id: int, viewer: str = ""):
    conn = get_db(); cursor = conn.cursor()
    cursor.execute('''SELECT comments.id, comments.user_name, comments.body, comments.kind, comments.parent_id, comments.created_at::text AS created_at, (SELECT COUNT(*) FROM comment_likes WHERE comment_likes.comment_id = comments.id) AS like_count, EXISTS(SELECT 1 FROM comment_likes WHERE comment_likes.comment_id = comments.id AND comment_likes.user_name = %s) AS liked_by_viewer FROM comments WHERE comments.post_id = %s ORDER BY comments.created_at ASC''', (viewer, post_id))
    rows = cursor.fetchall(); conn.close(); return {"comments": rows}

@router.post("/posts/{post_id}/comments")
def add_comment(post_id: int, data: dict):
    viewer, body, kind, parent_id = data.get("viewer", ""), data.get("body", "").strip(), data.get("kind", "text"), data.get("parent_id")
    conn = get_db(); cursor = conn.cursor()
    cursor.execute("INSERT INTO comments (post_id, user_name, body, kind, parent_id) VALUES (%s, %s, %s, %s, %s) RETURNING id, user_name, body, kind, parent_id, created_at::text AS created_at", (post_id, viewer, body, kind, parent_id))
    row = cursor.fetchone(); conn.commit(); conn.close(); return {"comment": row}

@router.post("/comments/{comment_id}/like")
def toggle_comment_like(comment_id: int, data: dict):
    viewer = data.get("viewer", ""); conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM comment_likes WHERE comment_id = %s AND user_name = %s", (comment_id, viewer))
    if cursor.fetchone(): cursor.execute("DELETE FROM comment_likes WHERE comment_id = %s AND user_name = %s", (comment_id, viewer)); liked = False
    else: cursor.execute("INSERT INTO comment_likes (comment_id, user_name) VALUES (%s, %s)", (comment_id, viewer)); liked = True
    conn.commit(); cursor.execute("SELECT COUNT(*) AS c FROM comment_likes WHERE comment_id = %s", (comment_id,)); count = cursor.fetchone()["c"]; conn.close()
    return {"liked": liked, "count": count}

@router.post("/follow")
def toggle_follow(data: dict):
    viewer, target = data.get("viewer", ""), data.get("target", ""); conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM follows WHERE follower = %s AND followee = %s", (viewer, target))
    if cursor.fetchone(): cursor.execute("DELETE FROM follows WHERE follower = %s AND followee = %s", (viewer, target)); following = False
    else: cursor.execute("INSERT INTO follows (follower, followee) VALUES (%s, %s)", (viewer, target)); following = True
    conn.commit(); conn.close(); return {"following": following}

@router.post("/posts/{post_id}/bid")
def place_bid(post_id: int, data: dict):
    viewer = data.get("viewer", ""); amount = float(data.get("amount", 0)); conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT COALESCE(MAX(amount), 0) AS top FROM bids WHERE post_id = %s", (post_id,)); top = float(cursor.fetchone()["top"])
    if amount <= top: conn.close(); return {"error": f"bid must exceed {top}"}
    cursor.execute("INSERT INTO bids (post_id, user_name, amount) VALUES (%s, %s, %s)", (post_id, viewer, amount)); conn.commit(); conn.close()
    return {"message": "bid placed", "current_bid": amount}