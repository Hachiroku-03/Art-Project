import json

from fastapi import APIRouter

from db import get_db

router = APIRouter()

GROUP_JOIN_MODES = {"open", "request", "invite", "private"}
DISCOVER_MODES = ("open", "request")


# ---------------------------------------------------------------------------
# helpers (mirrors the per-router style used by chat.py / notifications.py)
# ---------------------------------------------------------------------------
def _canonical_username(cursor, name: str):
    name = (name or "").strip()
    if not name:
        return None
    cursor.execute("SELECT username FROM users WHERE username = %s", (name,))
    row = cursor.fetchone()
    if row:
        return row["username"]
    cursor.execute("SELECT username FROM users WHERE lower(username) = lower(%s)", (name,))
    row = cursor.fetchone()
    return row["username"] if row else None


def _resolve_viewer(viewer_raw: str):
    if not viewer_raw:
        return None
    conn = get_db()
    cursor = conn.cursor()
    viewer = _canonical_username(cursor, viewer_raw)
    conn.close()
    return viewer


def _parse_json(value, default):
    if value is None:
        return default
    if isinstance(value, (list, dict)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return default
    return default


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else (str(v) if v is not None else None)


def _group_role(cursor, conv_id: int, user: str):
    cursor.execute(
        "SELECT role FROM chat_members WHERE conversation_id=%s AND user_name=%s",
        (conv_id, user),
    )
    row = cursor.fetchone()
    return row["role"] if row else None


# ---------------------------------------------------------------------------
# GET /community/discover
# ---------------------------------------------------------------------------
@router.get("/community/discover")
def community_discover(
    viewer: str = "",
    q: str = "",
    category: str = "",
    scene: str = "",
    limit: int = 30,
):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    limit = max(1, min(int(limit or 30), 60))
    search = f"%{(q or '').strip()}%" if (q or "").strip() else None
    category = (category or "").strip() or None
    scene = (scene or "").strip() or None

    conn = get_db()
    cursor = conn.cursor()

    where = [
        "c.kind = 'group'",
        "c.join_mode = ANY(%s)",
        """NOT EXISTS (
               SELECT 1 FROM chat_members cm2
               WHERE cm2.conversation_id = c.id AND cm2.user_name = %s
           )""",
    ]
    params = [list(DISCOVER_MODES), viewer]

    if search:
        where.append("(c.name ILIKE %s OR COALESCE(c.description,'') ILIKE %s)")
        params += [search, search]
    if category:
        where.append("c.category = %s")
        params.append(category)
    if scene:
        where.append("c.scene = %s")
        params.append(scene)

    params.append(limit)

    cursor.execute(
        f"""
        SELECT c.id, c.name, c.image_url, c.description, c.join_mode,
               c.category, c.tags, c.scene, c.updated_at,
               (SELECT COUNT(*) FROM chat_members cm WHERE cm.conversation_id = c.id) AS member_count,
               (
                   SELECT ARRAY_AGG(x) FROM (
                       SELECT UPPER(LEFT(COALESCE(p.display_name, u.username), 1)) AS x
                       FROM chat_members cm
                       JOIN users u ON u.username = cm.user_name
                       LEFT JOIN profiles p ON p.user_id = u.id
                       WHERE cm.conversation_id = c.id
                       ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, cm.user_name
                       LIMIT 3
                   ) s
               ) AS initials,
               COALESCE(gjr.status, 'none') AS request_status
        FROM chat_conversations c
        LEFT JOIN group_join_requests gjr
               ON gjr.group_id = c.id AND gjr.user_name = %s
        WHERE {' AND '.join(where)}
        ORDER BY c.updated_at DESC NULLS LAST, c.id DESC
        LIMIT %s
        """,
        (*params, viewer),
    )

    rows = []
    for r in cursor.fetchall():
        d = dict(r)
        d["tags"] = _parse_json(d.get("tags"), [])
        if not isinstance(d["tags"], list):
            d["tags"] = []
        d["initials"] = d.get("initials") or []
        d["updated_at"] = _iso(d.get("updated_at"))
        rows.append(d)

    conn.close()
    return {"groups": rows}


# ---------------------------------------------------------------------------
# GET /community/taxonomy  (drives the chips with REAL counts)
# ---------------------------------------------------------------------------
@router.get("/community/taxonomy")
def community_taxonomy(viewer: str = ""):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    member_filter = """NOT EXISTS (
        SELECT 1 FROM chat_members cm2
        WHERE cm2.conversation_id = c.id AND cm2.user_name = %s
    )"""
    base = f"c.kind = 'group' AND c.join_mode = ANY(%s) AND {member_filter}"

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        f"""
        SELECT DISTINCT c.category
        FROM chat_conversations c
        WHERE {base} AND c.category IS NOT NULL AND c.category <> ''
        ORDER BY c.category
        """,
        (viewer, list(DISCOVER_MODES)),
    )
    categories = [r["category"] for r in cursor.fetchall()]

    cursor.execute(
        f"""
        SELECT c.scene, COUNT(*)::int AS count
        FROM chat_conversations c
        WHERE {base} AND c.scene IS NOT NULL AND c.scene <> ''
        GROUP BY c.scene
        ORDER BY COUNT(*) DESC, c.scene
        """,
        (viewer, list(DISCOVER_MODES)),
    )
    scenes = [{"name": r["scene"], "count": int(r["count"])} for r in cursor.fetchall()]

    conn.close()
    return {"categories": categories, "scenes": scenes}


# ---------------------------------------------------------------------------
# GET /community/requests  (pending join requests in groups you admin)
# ---------------------------------------------------------------------------
@router.get("/community/requests")
def community_requests(viewer: str = "", limit: int = 20):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    limit = max(1, min(int(limit or 20), 50))

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT r.id, r.group_id, c.name AS group_name,
               r.user_name,
               COALESCE(p.display_name, u.username) AS display_name,
               p.avatar_url, r.message, r.created_at
        FROM group_join_requests r
        JOIN chat_conversations c ON c.id = r.group_id AND c.kind = 'group'
        JOIN chat_members m ON m.conversation_id = c.id
                           AND m.user_name = %s
                           AND m.role IN ('owner','admin')
        JOIN users u ON u.username = r.user_name
        LEFT JOIN profiles p ON p.user_id = u.id
        WHERE r.status = 'pending'
        ORDER BY r.created_at DESC
        LIMIT %s
        """,
        (viewer, limit),
    )

    rows = []
    for r in cursor.fetchall():
        d = dict(r)
        d["created_at"] = _iso(d.get("created_at"))
        rows.append(d)

    conn.close()
    return {"requests": rows}


# ---------------------------------------------------------------------------
# GET /community/invites  (group_invite notifications you received)
# ---------------------------------------------------------------------------
@router.get("/community/invites")
def community_invites(viewer: str = "", limit: int = 10):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    limit = max(1, min(int(limit or 10), 30))

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT n.id AS notification_id,
               n.source_id AS conversation_id,
               c.name AS group_name,
               n.actor,
               COALESCE(ap.display_name, au.username) AS actor_display,
               n.created_at, n.read_at
        FROM notifications n
        JOIN chat_conversations c ON c.id = n.source_id AND c.kind = 'group'
        JOIN chat_members cm ON cm.conversation_id = c.id AND cm.user_name = %s
        LEFT JOIN users au ON au.username = n.actor
        LEFT JOIN profiles ap ON ap.user_id = au.id
        WHERE n.user_name = %s
          AND n.category = 'groups'
          AND n.type = 'group_invite'
        ORDER BY (n.read_at IS NULL) DESC, n.id DESC
        LIMIT %s
        """,
        (viewer, viewer, limit),
    )

    rows = []
    for r in cursor.fetchall():
        d = dict(r)
        d["created_at"] = _iso(d.get("created_at"))
        rows.append(d)

    conn.close()
    return {"invites": rows}


# ---------------------------------------------------------------------------
# GET /community/people  (enriched suggestions, real reasons only)
# ---------------------------------------------------------------------------
@router.get("/community/people")
def community_people(viewer: str = "", limit: int = 6):
    viewer = _resolve_viewer(viewer)
    if not viewer:
        return {"error": "viewer required"}

    limit = max(1, min(int(limit or 6), 12))

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        WITH cand AS (
            SELECT u.id, u.username, u.role, u.tier,
                   p.display_name, p.avatar_url,
                   (SELECT COUNT(*) FROM follows f WHERE f.followee = u.username) AS follower_count
            FROM users u
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE u.username <> %s
              AND u.username NOT IN (SELECT followee FROM follows WHERE follower = %s)
        )
        SELECT c.username, c.role, c.tier, c.display_name, c.avatar_url, c.follower_count,
               (SELECT COUNT(*)
                  FROM chat_members a
                  JOIN chat_members b ON b.conversation_id = a.conversation_id
                 WHERE a.user_name = %s AND b.user_name = c.username) AS shared_groups,
               (SELECT h.house_name FROM house_applications h
                 WHERE h.user_id = c.id AND h.status = 'approved'
                 ORDER BY h.created_at DESC LIMIT 1) AS house_name,
               (SELECT COUNT(*) FROM auctions au
                 WHERE au.host_username = c.username AND au.status IN ('live','upcoming')) AS active_sales
        FROM cand c
        ORDER BY shared_groups DESC, c.follower_count DESC
        LIMIT %s
        """,
        (viewer, viewer, viewer, limit),
    )

    rows = []
    for r in cursor.fetchall():
        d = dict(r)
        shared = int(d.get("shared_groups") or 0)
        followers = int(d.get("follower_count") or 0)
        sales = int(d.get("active_sales") or 0)
        house = d.get("house_name")

        if d.get("role") == "house" and house:
            reason = f"{house} · {sales} sale{'s' if sales != 1 else ''} on the floor"
        elif shared > 0:
            reason = f"in {shared} of your groups"
        elif followers > 0:
            reason = f"{followers} follower{'s' if followers != 1 else ''}"
        else:
            reason = "new to the space"

        d["reason"] = reason
        d["follower_count"] = followers
        d["shared_groups"] = shared
        d["active_sales"] = sales
        rows.append(d)

    conn.close()
    return {"people": rows}


# ---------------------------------------------------------------------------
# GET /community/live  (real live auctions only)
# ---------------------------------------------------------------------------
@router.get("/community/live")
def community_live(viewer: str = "", limit: int = 6):
    _ = _resolve_viewer(viewer)  # auth gate; data is public
    limit = max(1, min(int(limit or 6), 12))

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT a.id, a.title, a.host_username, a.ends_at,
               COALESCE(hp.display_name, hu.username) AS host_display,
               (SELECT COUNT(*) FROM lots l WHERE l.sale_id = a.id AND l.status = 'on_block') AS lots_on_block,
               (SELECT MAX(lb.amount)
                  FROM lot_bids lb
                  JOIN lots l2 ON l2.id = lb.lot_id
                 WHERE l2.sale_id = a.id) AS top_amount
        FROM auctions a
        LEFT JOIN users hu ON hu.username = a.host_username
        LEFT JOIN profiles hp ON hp.user_id = hu.id
        WHERE a.status = 'live'
        ORDER BY a.ends_at ASC
        LIMIT %s
        """,
        (limit,),
    )

    rows = []
    for r in cursor.fetchall():
        d = dict(r)
        d["ends_at"] = _iso(d.get("ends_at"))
        d["top_amount"] = str(d["top_amount"]) if d.get("top_amount") is not None else None
        rows.append(d)

    conn.close()
    return {"live": rows}


# ---------------------------------------------------------------------------
# GET /community/calendar  (upcoming + live auctions, real dates only)
# ---------------------------------------------------------------------------
@router.get("/community/calendar")
def community_calendar(viewer: str = "", limit: int = 8):
    _ = _resolve_viewer(viewer)
    limit = max(1, min(int(limit or 8), 20))

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT a.id, a.title, a.status, a.host_username, a.ends_at,
               COALESCE(hp.display_name, hu.username) AS host_display,
               (SELECT COUNT(*) FROM lots l WHERE l.sale_id = a.id) AS lot_count
        FROM auctions a
        LEFT JOIN users hu ON hu.username = a.host_username
        LEFT JOIN profiles hp ON hp.user_id = hu.id
        WHERE a.status IN ('upcoming','live')
        ORDER BY (a.status = 'live') DESC, a.ends_at ASC
        LIMIT %s
        """,
        (limit,),
    )

    rows = []
    for r in cursor.fetchall():
        d = dict(r)
        d["ends_at"] = _iso(d.get("ends_at"))
        rows.append(d)

    conn.close()
    return {"calendar": rows}


# ---------------------------------------------------------------------------
# POST /community/groups/{conv_id}/meta  (owner/admin sets category/tags/scene)
# ---------------------------------------------------------------------------
@router.post("/community/groups/{conv_id}/meta")
def community_group_meta(conv_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        role = _group_role(cursor, conv_id, viewer)
        if role not in ("owner", "admin"):
            conn.rollback()
            return {"error": "only admins can edit group community info"}

        sets, params = [], []

        if "category" in data:
            cat = (data.get("category") or "").strip()[:40] or None
            sets.append("category = %s")
            params.append(cat)

        if "scene" in data:
            sc = (data.get("scene") or "").strip()[:40] or None
            sets.append("scene = %s")
            params.append(sc)

        if "tags" in data:
            raw = data.get("tags")
            if raw is None:
                tags = []
            elif isinstance(raw, list):
                tags = [str(t).strip()[:24] for t in raw if str(t).strip()][:8]
            else:
                tags = []
            sets.append("tags = %s::jsonb")
            params.append(json.dumps(tags))

        if "join_mode" in data:
            jm = (data.get("join_mode") or "").strip().lower()
            if jm not in GROUP_JOIN_MODES:
                conn.rollback()
                return {"error": "invalid join_mode"}
            sets.append("join_mode = %s")
            params.append(jm)

        if "allow_member_invites" in data:
            sets.append("allow_member_invites = %s")
            params.append(bool(data.get("allow_member_invites")))

        if "announce_new_members" in data:
            sets.append("announce_new_members = %s")
            params.append(bool(data.get("announce_new_members")))

        if not sets:
            conn.rollback()
            return {"error": "nothing to update"}

        params.append(conv_id)
        cursor.execute(
            f"UPDATE chat_conversations SET {', '.join(sets)}, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
            tuple(params),
        )

        conn.commit()
        return {"message": "community info updated"}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()