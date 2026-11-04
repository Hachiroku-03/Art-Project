"""
feed.py — the social/feed router (your own origin; no Paystack, no YouTube, no tunnel).

Consolidated. Every original route is preserved; the additions/fixes folded in are:
  - /upload returns PUBLIC_BASE_URL (was hardcoded http://localhost:8001 -> mixed content on https)
  - _ensure_post_schema creates posts.deleted_at AND comments.deleted_at AND post_reports,
    once per process, committed before any query reads those columns
  - /feed and GET /posts/{id} filter deleted_at IS NULL (soft-delete aware)
  - GET /posts/{id}/comments joins users->profiles for avatar_url and returns the `deleted` flag
  - POST /posts/{id}/comments returns avatar_url + deleted:False so a fresh comment renders right
  - DELETE /posts/{id}        author-only soft delete (viewer via query OR body)
  - POST /posts/{id}/report   non-author report -> post_reports (self-report rejected)
  - DELETE /comments/{id}     comment-author-only soft delete (idempotent)
  - POST /comments/{id}/like  rejects liking a removed comment
  - GET /suggestions          now selects p.avatar_url (was the thin column that hid rail avatars)
"""

from fastapi import APIRouter, UploadFile, File
import os
import secrets
import json
from db import get_db

router = APIRouter()

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp3", ".wav", ".ogg", ".webm", ".m4a"}

# Uploaded assets must be served from the SAME scheme/host the browser is on, or an
# https page blocks an http image (mixed content). Override with PUBLIC_BASE_URL on
# deploy (e.g. https://yourdomain.com). Default keeps local dev working.
UPLOAD_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8001").rstrip("/")

# ---------------------------------------------------------------------------
# Soft-delete + reports schema, created once per process and COMMITTED before
# any query references posts.deleted_at / comments.deleted_at. Without the
# commit-first ordering, adding "AND deleted_at IS NULL" to /feed would error
# on a DB that does not yet have the column, taking the whole feed down.
# ---------------------------------------------------------------------------
_post_schema_ready = False


def _ensure_post_schema(cursor):
    global _post_schema_ready
    if _post_schema_ready:
        return
    cursor.execute("ALTER TABLE posts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ")
    cursor.execute("ALTER TABLE comments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ")
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS post_reports (
            id          SERIAL PRIMARY KEY,
            post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
            reporter    TEXT    NOT NULL,
            reason      TEXT    NOT NULL,
            note        TEXT,
            status      TEXT    NOT NULL DEFAULT 'open',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_post_reports_post ON post_reports(post_id)")
    _post_schema_ready = True


@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXT: return {"error": "file type not allowed"}
    name = f"{secrets.token_hex(8)}{ext}"
    with open(os.path.join(UPLOAD_DIR, name), "wb") as f: f.write(await file.read())
    return {"url": f"{UPLOAD_BASE_URL}/uploads/{name}"}

@router.get("/feed")
def get_feed(viewer: str = ""):
    conn = get_db(); cursor = conn.cursor()
    _ensure_post_schema(cursor); conn.commit()
    cursor.execute('''
        SELECT posts.id, posts.type, posts.title, posts.description, posts.image_url, posts.images, posts.price,
               posts.created_at::text AS created_at, users.username, users.role, users.tier,
               profiles.display_name, profiles.avatar_url,
               (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id) AS like_count,
               (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id AND comments.deleted_at IS NULL) AS comment_count,
               (SELECT MAX(amount)::text FROM bids WHERE bids.post_id = posts.id) AS current_bid,
               EXISTS(SELECT 1 FROM likes WHERE likes.post_id = posts.id AND likes.user_name = %s) AS liked_by_viewer,
               EXISTS(SELECT 1 FROM follows WHERE follower = %s AND followee = users.username) AS followed_by_viewer,
               EXISTS(SELECT 1 FROM bookmarks WHERE bookmarks.post_id = posts.id AND bookmarks.user_name = %s) AS bookmarked_by_viewer,
               (SELECT COUNT(*) FROM bookmarks WHERE bookmarks.post_id = posts.id) AS bookmark_count,
               EXISTS(SELECT 1 FROM stories WHERE user_name = users.username AND expires_at > CURRENT_TIMESTAMP) AS has_active_story
        FROM posts
        JOIN users ON posts.author_id = users.id
        LEFT JOIN profiles ON profiles.user_id = users.id
        WHERE posts.deleted_at IS NULL
        ORDER BY posts.created_at DESC LIMIT 20
    ''', (viewer, viewer, viewer))
    feed_items = cursor.fetchall(); conn.close()
    return {"feed": feed_items}

@router.post("/posts")
def create_post(data: dict):
    viewer, title = data.get("viewer", ""), data.get("title", "").strip()
    description = data.get("description", "").strip()
    post_type = data.get("type", "work")
    images = data.get("images") or []
    if not isinstance(images, list): images = []
    images = [u for u in images if isinstance(u, str) and u.strip()][:8]
    cover = images[0] if images else (data.get("image_url", "") or "").strip()
    if not viewer or not title: return {"error": "viewer and title required"}
    conn = get_db(); cursor = conn.cursor()
    _ensure_post_schema(cursor); conn.commit()
    cursor.execute("SELECT id FROM users WHERE username = %s", (viewer,))
    author = cursor.fetchone()
    if not author: conn.close(); return {"error": "unknown author"}
    cursor.execute(
        "INSERT INTO posts (author_id, type, title, description, image_url, images) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
        (author["id"], post_type, title, description, cover, json.dumps(images)))
    new_id = cursor.fetchone()["id"]; conn.commit(); conn.close()
    return {"message": "posted", "id": new_id}

@router.get("/posts/{post_id}")
def get_post(post_id: int, viewer: str = ""):
    conn = get_db(); cursor = conn.cursor()
    _ensure_post_schema(cursor); conn.commit()
    cursor.execute('''
        SELECT posts.id, posts.type, posts.title, posts.description, posts.image_url, posts.images, posts.price,
               posts.created_at::text AS created_at, users.username, users.role, users.tier,
               profiles.display_name, profiles.avatar_url,
               (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id) AS like_count,
               (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id AND comments.deleted_at IS NULL) AS comment_count,
               (SELECT MAX(amount)::text FROM bids WHERE bids.post_id = posts.id) AS current_bid,
               EXISTS(SELECT 1 FROM likes WHERE likes.post_id = posts.id AND likes.user_name = %s) AS liked_by_viewer,
               EXISTS(SELECT 1 FROM follows WHERE follower = %s AND followee = users.username) AS followed_by_viewer,
               EXISTS(SELECT 1 FROM bookmarks WHERE bookmarks.post_id = posts.id AND bookmarks.user_name = %s) AS bookmarked_by_viewer,
               (SELECT COUNT(*) FROM bookmarks WHERE bookmarks.post_id = posts.id) AS bookmark_count
        FROM posts
        JOIN users ON posts.author_id = users.id
        LEFT JOIN profiles ON profiles.user_id = users.id
        WHERE posts.id = %s AND posts.deleted_at IS NULL
    ''', (viewer, viewer, viewer, post_id))
    post = cursor.fetchone(); conn.close()
    if not post: return {"error": "post not found"}
    return {"post": post}

# ---------------------------------------------------------------------------
# NEW: author deletes own post (soft). viewer from query OR body (DELETE bodies
# are stripped by some proxies). Ownership via posts.author_id -> users.username.
# ---------------------------------------------------------------------------
@router.delete("/posts/{post_id}")
def delete_post(post_id: int, viewer: str = "", data: dict = {}):
    v = (str(viewer or "").strip() or str((data or {}).get("viewer") or "").strip())
    if not v: return {"error": "viewer required"}
    conn = get_db()
    try:
        cursor = conn.cursor()
        _ensure_post_schema(cursor); conn.commit()
        cursor.execute(
            """
            SELECT p.id, u.username
            FROM posts p JOIN users u ON u.id = p.author_id
            WHERE p.id = %s AND p.deleted_at IS NULL
            """,
            (post_id,),
        )
        row = cursor.fetchone()
        if not row: return {"error": "post not found"}
        if str(row["username"]).strip().lower() != v.strip().lower():
            return {"error": "not your post"}
        cursor.execute("UPDATE posts SET deleted_at = CURRENT_TIMESTAMP WHERE id = %s", (post_id,))
        conn.commit()
        return {"message": "post deleted", "id": post_id}
    except Exception as e:
        conn.rollback(); return {"error": str(e)}
    finally:
        conn.close()

# ---------------------------------------------------------------------------
# NEW: any authenticated non-author reports a post. Self-reports rejected.
# Rows accumulate in post_reports (status='open') for moderation.
# ---------------------------------------------------------------------------
@router.post("/posts/{post_id}/report")
def report_post(post_id: int, data: dict):
    v = str(data.get("viewer") or "").strip()
    reason = str(data.get("reason") or "").strip() or "Other"
    note = str(data.get("note") or "").strip() or None
    if not v: return {"error": "viewer required"}
    conn = get_db()
    try:
        cursor = conn.cursor()
        _ensure_post_schema(cursor); conn.commit()
        cursor.execute(
            """
            SELECT u.username FROM posts p JOIN users u ON u.id = p.author_id
            WHERE p.id = %s AND p.deleted_at IS NULL
            """,
            (post_id,),
        )
        row = cursor.fetchone()
        if not row: return {"error": "post not found"}
        if str(row["username"]).strip().lower() == v.strip().lower():
            return {"error": "you cannot report your own post"}
        cursor.execute(
            "INSERT INTO post_reports (post_id, reporter, reason, note) VALUES (%s,%s,%s,%s) RETURNING id",
            (post_id, v, reason[:200], note[:2000] if note else None),
        )
        rid = cursor.fetchone()["id"]
        conn.commit()
        return {"message": "report submitted", "id": rid}
    except Exception as e:
        conn.rollback(); return {"error": str(e)}
    finally:
        conn.close()

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
    """Join users->profiles so each comment carries avatar_url, and return the
    `deleted` flag so the frontend can render [removed] instead of hiding the row
    (which would orphan its replies)."""
    conn = get_db(); cursor = conn.cursor()
    _ensure_post_schema(cursor); conn.commit()
    cursor.execute('''
        SELECT c.id, c.user_name, c.body, c.kind, c.parent_id,
               c.created_at::text AS created_at,
               p.avatar_url,
               (c.deleted_at IS NOT NULL) AS deleted,
               (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS like_count,
               EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment_id = c.id AND cl.user_name = %s) AS liked_by_viewer
        FROM comments c
        LEFT JOIN users u ON u.username = c.user_name
        LEFT JOIN profiles p ON p.user_id = u.id
        WHERE c.post_id = %s
        ORDER BY c.created_at ASC
    ''', (viewer, post_id))
    rows = cursor.fetchall(); conn.close(); return {"comments": rows}

@router.post("/posts/{post_id}/comments")
def add_comment(post_id: int, data: dict):
    viewer, body, kind, parent_id = data.get("viewer", ""), data.get("body", "").strip(), data.get("kind", "text"), data.get("parent_id")
    conn = get_db(); cursor = conn.cursor()
    _ensure_post_schema(cursor); conn.commit()
    cursor.execute("INSERT INTO comments (post_id, user_name, body, kind, parent_id) VALUES (%s, %s, %s, %s, %s) RETURNING id, user_name, body, kind, parent_id, created_at::text AS created_at", (post_id, viewer, body, kind, parent_id))
    row = dict(cursor.fetchone())
    # RETURNING cannot join, so fetch the commenter's avatar separately -> a freshly
    # posted comment shows its photo immediately instead of waiting for a reload.
    cursor.execute(
        "SELECT p.avatar_url FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.username = %s",
        (viewer,),
    )
    av = cursor.fetchone()
    row["avatar_url"] = (av or {}).get("avatar_url")
    row["deleted"] = False
    conn.commit(); conn.close(); return {"comment": row}

# ---------------------------------------------------------------------------
# NEW: comment-author soft-deletes own comment (idempotent). viewer via query OR
# body. Mirrors delete_story's ownership check but case-insensitive/trimmed.
# ---------------------------------------------------------------------------
@router.delete("/comments/{comment_id}")
def delete_comment(comment_id: int, viewer: str = "", data: dict = {}):
    v = (str(viewer or "").strip() or str((data or {}).get("viewer") or "").strip())
    if not v: return {"error": "viewer required"}
    conn = get_db()
    try:
        cursor = conn.cursor()
        _ensure_post_schema(cursor); conn.commit()
        cursor.execute("SELECT user_name, deleted_at FROM comments WHERE id = %s", (comment_id,))
        row = cursor.fetchone()
        if not row: return {"error": "comment not found"}
        if str(row["user_name"]).strip().lower() != v.strip().lower():
            return {"error": "not your comment"}
        if row["deleted_at"] is not None:
            return {"message": "already deleted", "id": comment_id}   # idempotent no-op
        cursor.execute("UPDATE comments SET deleted_at = CURRENT_TIMESTAMP WHERE id = %s", (comment_id,))
        conn.commit()
        return {"message": "comment deleted", "id": comment_id}
    except Exception as e:
        conn.rollback(); return {"error": str(e)}
    finally:
        conn.close()

@router.post("/comments/{comment_id}/like")
def toggle_comment_like(comment_id: int, data: dict):
    viewer = data.get("viewer", ""); conn = get_db(); cursor = conn.cursor()
    _ensure_post_schema(cursor); conn.commit()
    # reject liking a removed comment
    cursor.execute("SELECT deleted_at FROM comments WHERE id = %s", (comment_id,))
    crow = cursor.fetchone()
    if not crow: conn.close(); return {"error": "comment not found"}
    if crow["deleted_at"] is not None: conn.close(); return {"error": "this comment was removed"}
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

@router.post("/posts/{post_id}/bookmark")
def toggle_bookmark(post_id: int, data: dict):
    viewer = data.get("viewer", "")
    if not viewer: return {"error": "viewer required"}
    conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM bookmarks WHERE post_id = %s AND user_name = %s", (post_id, viewer))
    if cursor.fetchone():
        cursor.execute("DELETE FROM bookmarks WHERE post_id = %s AND user_name = %s", (post_id, viewer)); bookmarked = False
    else:
        cursor.execute("INSERT INTO bookmarks (post_id, user_name) VALUES (%s, %s)", (post_id, viewer)); bookmarked = True
    conn.commit()
    cursor.execute("SELECT COUNT(*) AS c FROM bookmarks WHERE post_id = %s", (post_id,))
    count = cursor.fetchone()["c"]; conn.close()
    return {"bookmarked": bookmarked, "count": count}

@router.get("/suggestions")
def suggestions(viewer: str = ""):
    """Left rail: popular members the viewer doesn't already follow.
    Now selects p.avatar_url (was the thin column that hid rail avatars)."""
    conn = get_db(); cursor = conn.cursor()
    cursor.execute('''
        SELECT u.username, u.role, u.tier, p.display_name, p.avatar_url,
               (SELECT COUNT(*) FROM follows f2 WHERE f2.followee = u.username) AS follower_count
        FROM users u LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.username <> %s
          AND u.username NOT IN (SELECT followee FROM follows WHERE follower = %s)
        ORDER BY follower_count DESC LIMIT 5
    ''', (viewer, viewer))
    rows = cursor.fetchall(); conn.close()
    return {"suggestions": rows}

@router.get("/me/standing")
def my_standing(viewer: str = ""):
    """Right-rail Paddle: VIP status, lots you're currently top-bid on (live rooms), tickets, keeps."""
    if not viewer: return {"error": "viewer required"}
    conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT tier FROM users WHERE username = %s", (viewer,))
    u = cursor.fetchone()
    if not u: conn.close(); return {"error": "unknown user"}
    cursor.execute('''
        SELECT l.id AS lot_id, l.title, l.image_url, a.id AS sale_id, a.title AS sale_title,
               (SELECT MAX(amount)::text FROM lot_bids WHERE lot_id = l.id) AS top_amount,
               a.ends_at::text AS ends_at
        FROM lots l JOIN auctions a ON a.id = l.sale_id
        WHERE a.status = 'live' AND l.status = 'on_block'
          AND (SELECT user_name FROM lot_bids WHERE lot_id = l.id ORDER BY amount DESC LIMIT 1) = %s
        ORDER BY a.ends_at
    ''', (viewer,))
    leading = cursor.fetchall()
    cursor.execute("SELECT COUNT(*) AS c FROM tickets WHERE user_name = %s", (viewer,))
    tickets = cursor.fetchone()["c"]
    cursor.execute("SELECT COUNT(*) AS c FROM bookmarks WHERE user_name = %s", (viewer,))
    collects = cursor.fetchone()["c"]
    conn.close()
    return {"tier": u["tier"], "leading": leading, "tickets": tickets, "collects": collects}

@router.get("/me")
def get_me(viewer: str = ""):
    """Current user's profile — drives the navbar avatar."""
    if not viewer: return {"error": "viewer required"}
    conn = get_db(); cursor = conn.cursor()
    cursor.execute('''
        SELECT u.username, u.role, u.tier, p.display_name, p.avatar_url, p.banner_url
        FROM users u LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.username = %s
    ''', (viewer,))
    row = cursor.fetchone(); conn.close()
    if not row: return {"error": "unknown user"}
    return {"user": dict(row)}

@router.get("/stories")
def list_stories(viewer: str = ""):
    """
    Active stories, oldest-first within each user.
    Includes avatar_url so the frontend can show profile pictures inside rings.
    """
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT
                s.id,
                s.user_name,
                s.kind,
                s.body,
                s.created_at::text AS created_at,
                p.avatar_url
            FROM stories s
            LEFT JOIN users u ON u.username = s.user_name
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE s.expires_at > CURRENT_TIMESTAMP
            ORDER BY s.user_name, s.created_at ASC
            """
        )
        rows = cursor.fetchall()
        return {"stories": rows}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conn.close()


@router.get("/stories/followed")
def followed_stories(viewer: str = ""):
    """
    Stories from people the viewer follows + their own stories.
    This is what the feed should use.
    """
    viewer = str(viewer or "").strip()

    if not viewer:
        return {"stories": []}

    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT
                s.id,
                s.user_name,
                s.kind,
                s.body,
                s.created_at::text AS created_at,
                p.avatar_url
            FROM stories s
            LEFT JOIN users u ON u.username = s.user_name
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE s.expires_at > CURRENT_TIMESTAMP
              AND (
                  s.user_name = %s
                  OR s.user_name IN (
                      SELECT followee
                      FROM follows
                      WHERE follower = %s
                  )
              )
            ORDER BY s.user_name, s.created_at ASC
            """,
            (viewer, viewer),
        )
        rows = cursor.fetchall()
        return {"stories": rows}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conn.close()


@router.post("/stories")
def add_story(data: dict):
    """
    Create/append one story item.

    Image story:
      { "viewer": "amanai", "kind": "image", "body": "https://..." }

    Image story with caption:
      {
        "viewer": "amanai",
        "kind": "image",
        "body": "{\\"url\\":\\"https://...\\",\\"caption\\":\\"My caption\\"}"
      }

    Text story:
      { "viewer": "amanai", "kind": "text", "body": "Just a thought" }
    """
    viewer = str(data.get("viewer") or "").strip()
    kind = str(data.get("kind") or "image").strip()
    body = str(data.get("body") or "").strip()

    if not viewer:
        return {"error": "viewer required"}
    if not body:
        return {"error": "body required"}
    if kind not in ("image", "text"):
        return {"error": "invalid kind"}

    # Optional but important: reject ghost stories from unknown usernames.
    if kind == "image" and body.startswith("{"):
        try:
            parsed = json.loads(body)
            url = str(parsed.get("url") or "").strip()
            if not url:
                return {"error": "invalid image payload"}
        except Exception:
            return {"error": "invalid image payload"}

    conn = get_db()
    try:
        cursor = conn.cursor()

        cursor.execute("SELECT 1 FROM users WHERE username = %s", (viewer,))
        if not cursor.fetchone():
            return {"error": "unknown user"}

        cursor.execute(
            """
            INSERT INTO stories (user_name, kind, body, expires_at)
            VALUES (%s, %s, %s, CURRENT_TIMESTAMP + interval '24 hours')
            RETURNING id
            """,
            (viewer, kind, body),
        )

        sid = cursor.fetchone()["id"]
        conn.commit()

        return {
            "message": "status posted",
            "id": sid,
            "user_name": viewer,
            "kind": kind,
            "body": body,
        }

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


# ---- story interactions ----
@router.get("/stories/{story_id}/likes")
def get_story_likes(story_id: int, viewer: str = ""):
    conn = get_db()
    try:
        cursor = conn.cursor()

        cursor.execute(
            "SELECT COUNT(*) AS c FROM story_likes WHERE story_id = %s",
            (story_id,),
        )
        count = cursor.fetchone()["c"]

        cursor.execute(
            "SELECT 1 FROM story_likes WHERE story_id = %s AND user_name = %s",
            (story_id, viewer),
        )
        liked = cursor.fetchone() is not None

        return {"count": count, "liked": liked}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conn.close()


@router.post("/stories/{story_id}/like")
def toggle_story_like(story_id: int, data: dict):
    viewer = str(data.get("viewer") or "").strip()

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    try:
        cursor = conn.cursor()

        # Find story owner.
        cursor.execute(
            "SELECT user_name FROM stories WHERE id = %s",
            (story_id,),
        )
        story = cursor.fetchone()

        if not story:
            return {"error": "story not found"}

        owner = str(story["user_name"] or "").strip().lower()
        me = viewer.strip().lower()

        if owner == me:
            return {"error": "you cannot like your own story"}

        cursor.execute(
            "SELECT 1 FROM story_likes WHERE story_id = %s AND user_name = %s",
            (story_id, viewer),
        )

        if cursor.fetchone():
            cursor.execute(
                "DELETE FROM story_likes WHERE story_id = %s AND user_name = %s",
                (story_id, viewer),
            )
            liked = False
        else:
            cursor.execute(
                "INSERT INTO story_likes (story_id, user_name) VALUES (%s, %s)",
                (story_id, viewer),
            )
            liked = True

        conn.commit()

        cursor.execute(
            "SELECT COUNT(*) AS c FROM story_likes WHERE story_id = %s",
            (story_id,),
        )
        count = cursor.fetchone()["c"]

        return {"liked": liked, "count": count}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.get("/stories/{story_id}/comments")
def get_story_comments(story_id: int, viewer: str = ""):
    conn = get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, user_name, body, created_at::text AS created_at
            FROM story_comments
            WHERE story_id = %s
            ORDER BY created_at ASC
            """,
            (story_id,),
        )
        rows = cursor.fetchall()
        return {"comments": rows}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conn.close()


@router.post("/stories/{story_id}/comments")
def add_story_comment(story_id: int, data: dict):
    viewer = str(data.get("viewer") or "").strip()
    body = str(data.get("body") or "").strip()

    if not viewer:
        return {"error": "viewer required"}
    if not body:
        return {"error": "body required"}

    conn = get_db()
    try:
        cursor = conn.cursor()

        # Find story owner.
        cursor.execute(
            "SELECT user_name FROM stories WHERE id = %s",
            (story_id,),
        )
        story = cursor.fetchone()

        if not story:
            return {"error": "story not found"}

        owner = str(story["user_name"] or "").strip().lower()
        me = viewer.strip().lower()

        if owner == me:
            return {"error": "you cannot reply to your own story"}

        cursor.execute(
            """
            INSERT INTO story_comments (story_id, user_name, body)
            VALUES (%s, %s, %s)
            RETURNING id, user_name, body, created_at::text AS created_at
            """,
            (story_id, viewer, body),
        )

        row = cursor.fetchone()
        conn.commit()

        return {"comment": row}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()

@router.post("/stories/{story_id}/delete")
def delete_story(story_id: int, data: dict):
    """
    Delete one story item.

    Only the story owner can delete it.
    story_likes and story_comments cascade-delete because their FKs use ON DELETE CASCADE.
    """
    viewer = str(data.get("viewer") or "").strip()

    if not viewer:
        return {"error": "viewer required"}

    conn = get_db()
    try:
        cursor = conn.cursor()

        cursor.execute(
            "SELECT user_name FROM stories WHERE id = %s",
            (story_id,),
        )
        row = cursor.fetchone()

        if not row:
            return {"error": "story not found"}

        if row["user_name"] != viewer:
            return {"error": "not your story"}

        cursor.execute(
            "DELETE FROM stories WHERE id = %s",
            (story_id,),
        )

        conn.commit()
        return {"message": "story deleted", "id": story_id}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()