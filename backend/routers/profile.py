from fastapi import APIRouter
from db import get_db
from helpers import auction_access

router = APIRouter()

@router.get("/profile/{username}")
def get_profile(username: str, viewer: str = ""):
    conn = get_db(); cursor = conn.cursor()

    # identity + house_status (latest application) + the editable media fields
    cursor.execute(
        """SELECT u.username, u.role, u.tier, p.display_name, p.bio, p.avatar_url, p.banner_url,
                  (SELECT h.status FROM house_applications h
                   WHERE h.user_id = u.id ORDER BY h.created_at DESC LIMIT 1) AS house_status,
                  (SELECT h.house_name FROM house_applications h
                   WHERE h.user_id = u.id AND h.status = 'approved'
                   ORDER BY h.decided_at DESC NULLS LAST, h.created_at DESC LIMIT 1) AS house_name
           FROM users u LEFT JOIN profiles p ON p.user_id = u.id
           WHERE u.username = %s""", (username,))
    user = cursor.fetchone()
    if not user:
        conn.close(); return {"error": "no such member"}

    cursor.execute(
        """SELECT
             (SELECT COUNT(*) FROM posts ps JOIN users a ON ps.author_id = a.id WHERE a.username = %s) AS works,
             (SELECT COUNT(*) FROM follows WHERE followee = %s) AS followers,
             (SELECT COUNT(*) FROM follows WHERE follower = %s) AS following,
             (SELECT COUNT(*) FROM bookmarks WHERE user_name = %s) AS collects""",
        (username, username, username, username))
    counts = cursor.fetchone()

    cursor.execute("SELECT 1 FROM follows WHERE follower = %s AND followee = %s", (viewer, username))
    followed_by_viewer = cursor.fetchone() is not None

    cursor.execute(
        """SELECT ps.id, ps.type, ps.title, ps.image_url, ps.price,
                  (SELECT MAX(amount)::text FROM bids b WHERE b.post_id = ps.id) AS current_bid
           FROM posts ps JOIN users a ON ps.author_id = a.id
           WHERE a.username = %s ORDER BY ps.created_at DESC""", (username,))
    posts = cursor.fetchall()

    cursor.execute(
        """SELECT a.id, a.host_username, a.title, a.description, a.image_url, a.tier, a.status,
                  a.starts_at::text AS starts_at, a.ends_at::text AS ends_at,
                  a.ticket_price::text AS ticket_price,
                  (SELECT COUNT(*) FROM lots l WHERE l.sale_id = a.id) AS lot_count
           FROM auctions a WHERE a.host_username = %s ORDER BY a.created_at DESC""", (username,))
    rooms = []
    for r in cursor.fetchall():
        acc = auction_access(cursor, r, viewer)
        rooms.append({**r, **acc})

    cursor.execute(
        """SELECT ps.id, ps.type, ps.title, ps.image_url, ps.price
           FROM bookmarks bm JOIN posts ps ON ps.id = bm.post_id JOIN users a ON ps.author_id = a.id
           WHERE bm.user_name = %s ORDER BY ps.created_at DESC""", (username,))
    collects = cursor.fetchall()

    conn.close()
    return {
        "user": {**user, "is_self": viewer == username, "followed_by_viewer": followed_by_viewer},
        "counts": {k: int(v or 0) for k, v in counts.items()},
        "posts": posts, "rooms": rooms, "collects": collects,
    }

# Owner-only wall edit. Column names come from a fixed whitelist (no injection).
@router.put("/profile/{username}")
def update_profile(username: str, data: dict):
    viewer = data.get("viewer", "")
    if not viewer:
        return {"error": "viewer required"}
    if viewer != username:
        return {"error": "you can only edit your own wall"}
    conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE username = %s", (username,))
    u = cursor.fetchone()
    if not u:
        conn.close(); return {"error": "no such member"}
    sets, vals = [], []
    for col, key in [("display_name", "displayName"), ("bio", "bio"), ("avatar_url", "avatarUrl"), ("banner_url", "bannerUrl")]:
        if key in data:
            sets.append(f"{col} = %s"); vals.append(data[key])
    if not sets:
        conn.close(); return {"error": "nothing to update"}
    vals.append(u["id"])
    cursor.execute(f"UPDATE profiles SET {', '.join(sets)} WHERE user_id = %s", vals)
    conn.commit(); conn.close()
    return {"message": "wall updated"}