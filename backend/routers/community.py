import json
import os

from fastapi import APIRouter

from db import get_db
from notification_service import create_notification

router = APIRouter()

GROUP_JOIN_MODES = {"open", "request", "invite", "private"}
DISCOVER_MODES = ("open", "request")

CALL_KINDS = {
    "exhibition",
    "residency",
    "consignment",
    "open_call",
    "award",
    "talk",
    "studio_visit",
    "deadline",
}

CALL_STATUSES = {
    "open",
    "closed",
    "cancelled",
}

ADMIN_USERNAMES = {
    u.strip()
    for u in os.getenv("ADMIN_USERNAMES", "").split(",")
    if u.strip()
}


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
# Open calls / events
# MVP: external apply_url only, interest/save toggle, no internal applications.
# ---------------------------------------------------------------------------
def _ts_param(value):
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def _eligibility_param(value):
    if isinstance(value, dict):
        return json.dumps(value)

    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return json.dumps(parsed)
        except Exception:
            pass

    return "{}"


def _can_host_calls(cursor, username: str) -> bool:
    cursor.execute(
        "SELECT role FROM users WHERE username = %s",
        (username,),
    )
    row = cursor.fetchone()
    if not row:
        return False

    return row["role"] == "house" or username in ADMIN_USERNAMES


def _call_select_sql():
    return """
        SELECT c.id,
               c.host_user_name,
               c.kind,
               c.title,
               c.description,
               c.cover_url,
               c.scene,
               c.location,
               c.online,
               c.starts_at,
               c.ends_at,
               c.deadline_at,
               c.status,
               c.eligibility,
               c.apply_url,
               c.created_at,
               c.updated_at,
               COALESCE(hp.display_name, hu.username) AS host_display,
               hp.avatar_url AS host_avatar,
               (
                   SELECT COUNT(*)
                   FROM call_interest ci
                   WHERE ci.call_id = c.id
               ) AS interest_count,
               EXISTS(
                   SELECT 1
                   FROM call_interest ci2
                   WHERE ci2.call_id = c.id
                     AND ci2.user_name = %s
               ) AS interested_by_viewer
        FROM community_calls c
        LEFT JOIN users hu ON hu.username = c.host_user_name
        LEFT JOIN profiles hp ON hp.user_id = hu.id
    """


def _clean_call(row):
    if row is None:
        return None

    d = dict(row)

    for key in ("starts_at", "ends_at", "deadline_at", "created_at", "updated_at"):
        d[key] = _iso(d.get(key))

    eligibility = d.get("eligibility")
    if isinstance(eligibility, str):
        try:
            eligibility = json.loads(eligibility)
        except Exception:
            eligibility = {}

    if not isinstance(eligibility, dict):
        eligibility = {}

    d["eligibility"] = eligibility
    d["online"] = bool(d.get("online"))
    d["interest_count"] = int(d.get("interest_count") or 0)
    d["interested_by_viewer"] = bool(d.get("interested_by_viewer"))

    return d


def _fetch_call(cursor, call_id: int, viewer: str = ""):
    cursor.execute(
        _call_select_sql() + " WHERE c.id = %s",
        (viewer, call_id),
    )
    return _clean_call(cursor.fetchone())


@router.get("/community/calls")
def community_calls(
    viewer: str = "",
    q: str = "",
    kind: str = "",
    scene: str = "",
    status: str = "open",
    limit: int = 20,
):
    v = _resolve_viewer(viewer) or ""

    limit = max(1, min(int(limit or 20), 50))
    kind = (kind or "").strip().lower()
    scene = (scene or "").strip()
    status = (status or "open").strip().lower()
    query = (q or "").strip()
    search = f"%{query}%" if query else None

    if kind and kind not in CALL_KINDS:
        return {"error": "invalid kind"}

    where = []
    params = []

    if status in CALL_STATUSES:
        where.append("c.status = %s")
        params.append(status)
    else:
        where.append("c.status IN ('open', 'closed')")

    if kind:
        where.append("c.kind = %s")
        params.append(kind)

    if scene:
        where.append("c.scene = %s")
        params.append(scene)

    if search:
        where.append("(c.title ILIKE %s OR COALESCE(c.description, '') ILIKE %s)")
        params.extend([search, search])

    sql = (
        _call_select_sql()
        + " WHERE "
        + " AND ".join(where)
        + """
        ORDER BY
            (c.deadline_at IS NULL),
            c.deadline_at ASC,
            c.created_at DESC
        LIMIT %s
        """
    )

    conn = get_db()
    cursor = conn.cursor()

    try:
        cursor.execute(sql, (v, *params, limit))
        rows = [_clean_call(r) for r in cursor.fetchall()]
        conn.commit()
        return {"calls": rows}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.get("/community/calls/can-host")
def community_calls_can_host(viewer: str = ""):
    v = _resolve_viewer(viewer)
    if not v:
        return {"can_host": False}

    conn = get_db()
    cursor = conn.cursor()
    try:
        can_host = _can_host_calls(cursor, v)
        conn.commit()
        return {"can_host": bool(can_host)}
    except Exception:
        conn.rollback()
        return {"can_host": False}
    finally:
        conn.close()


@router.get("/community/calls/{call_id}")
def community_call_detail(call_id: int, viewer: str = ""):
    v = _resolve_viewer(viewer) or ""

    conn = get_db()
    cursor = conn.cursor()

    try:
        row = _fetch_call(cursor, call_id, v)

        if not row:
            conn.rollback()
            return {"error": "call not found"}

        row["can_host"] = bool(v) and _can_host_calls(cursor, v)
        row["can_edit"] = bool(v) and (row.get("host_user_name") == v or v in ADMIN_USERNAMES)

        conn.commit()
        return {"call": row}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.post("/community/calls")
def create_community_call(data: dict):
    viewer_raw = (data.get("viewer") or "").strip()
    title = (data.get("title") or "").strip()[:180]
    kind = (data.get("kind") or "open_call").strip().lower()
    status = (data.get("status") or "open").strip().lower()

    if not viewer_raw:
        return {"error": "viewer required"}

    if not title:
        return {"error": "title required"}

    if kind not in CALL_KINDS:
        return {"error": "invalid kind"}

    if status not in CALL_STATUSES:
        return {"error": "invalid status"}

    description = (data.get("description") or "").strip() or None
    cover_url = (data.get("cover_url") or "").strip() or None
    scene = (data.get("scene") or "").strip()[:40] or None
    location = (data.get("location") or "").strip()[:120] or None
    online = bool(data.get("online", False))
    starts_at = _ts_param(data.get("starts_at"))
    ends_at = _ts_param(data.get("ends_at"))
    deadline_at = _ts_param(data.get("deadline_at"))
    eligibility = _eligibility_param(data.get("eligibility"))
    apply_url = (data.get("apply_url") or "").strip()[:500] or None

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        if not _can_host_calls(cursor, viewer):
            conn.rollback()
            return {"error": "only accredited houses or admins can post open calls"}

        cursor.execute(
            """
            INSERT INTO community_calls (
                host_user_name,
                kind,
                title,
                description,
                cover_url,
                scene,
                location,
                online,
                starts_at,
                ends_at,
                deadline_at,
                status,
                eligibility,
                apply_url
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s,
                %s::timestamptz,
                %s::timestamptz,
                %s::timestamptz,
                %s,
                %s::jsonb,
                %s
            )
            RETURNING id
            """,
            (
                viewer,
                kind,
                title,
                description,
                cover_url,
                scene,
                location,
                online,
                starts_at,
                ends_at,
                deadline_at,
                status,
                eligibility,
                apply_url,
            ),
        )

        call_id = cursor.fetchone()["id"]
        row = _fetch_call(cursor, call_id, viewer)
        conn.commit()

        return {"message": "call created", "call": row}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.patch("/community/calls/{call_id}")
def update_community_call(call_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()

    if not viewer_raw:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        cursor.execute(
            "SELECT host_user_name FROM community_calls WHERE id = %s",
            (call_id,),
        )
        existing = cursor.fetchone()

        if not existing:
            conn.rollback()
            return {"error": "call not found"}

        if existing["host_user_name"] != viewer and viewer not in ADMIN_USERNAMES:
            conn.rollback()
            return {"error": "not allowed to edit this call"}

        sets = []
        params = []

        if "title" in data:
            title = (data.get("title") or "").strip()[:180]
            if not title:
                conn.rollback()
                return {"error": "title cannot be empty"}
            sets.append("title = %s")
            params.append(title)

        if "kind" in data:
            kind = (data.get("kind") or "").strip().lower()
            if kind not in CALL_KINDS:
                conn.rollback()
                return {"error": "invalid kind"}
            sets.append("kind = %s")
            params.append(kind)

        if "status" in data:
            status = (data.get("status") or "").strip().lower()
            if status not in CALL_STATUSES:
                conn.rollback()
                return {"error": "invalid status"}
            sets.append("status = %s")
            params.append(status)

        if "description" in data:
            sets.append("description = %s")
            params.append((data.get("description") or "").strip() or None)

        if "cover_url" in data:
            sets.append("cover_url = %s")
            params.append((data.get("cover_url") or "").strip() or None)

        if "scene" in data:
            sets.append("scene = %s")
            params.append((data.get("scene") or "").strip()[:40] or None)

        if "location" in data:
            sets.append("location = %s")
            params.append((data.get("location") or "").strip()[:120] or None)

        if "online" in data:
            sets.append("online = %s")
            params.append(bool(data.get("online")))

        if "starts_at" in data:
            sets.append("starts_at = %s::timestamptz")
            params.append(_ts_param(data.get("starts_at")))

        if "ends_at" in data:
            sets.append("ends_at = %s::timestamptz")
            params.append(_ts_param(data.get("ends_at")))

        if "deadline_at" in data:
            sets.append("deadline_at = %s::timestamptz")
            params.append(_ts_param(data.get("deadline_at")))

        if "eligibility" in data:
            sets.append("eligibility = %s::jsonb")
            params.append(_eligibility_param(data.get("eligibility")))

        if "apply_url" in data:
            sets.append("apply_url = %s")
            params.append((data.get("apply_url") or "").strip()[:500] or None)

        if not sets:
            conn.rollback()
            return {"error": "nothing to update"}

        sets.append("updated_at = CURRENT_TIMESTAMP")
        params.append(call_id)

        cursor.execute(
            f"""
            UPDATE community_calls
            SET {", ".join(sets)}
            WHERE id = %s
            """,
            tuple(params),
        )

        row = _fetch_call(cursor, call_id, viewer)
        conn.commit()

        return {"message": "call updated", "call": row}

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.post("/community/calls/{call_id}/interest")
def toggle_call_interest(call_id: int, data: dict):
    viewer_raw = (data.get("viewer") or "").strip()

    if not viewer_raw:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()

    try:
        viewer = _canonical_username(cursor, viewer_raw)
        if not viewer:
            conn.rollback()
            return {"error": "unknown viewer"}

        cursor.execute(
            "SELECT 1 FROM community_calls WHERE id = %s",
            (call_id,),
        )
        if not cursor.fetchone():
            conn.rollback()
            return {"error": "call not found"}

        cursor.execute(
            """
            SELECT 1
            FROM call_interest
            WHERE call_id = %s
              AND user_name = %s
            """,
            (call_id, viewer),
        )

        already = cursor.fetchone() is not None

        if already:
            cursor.execute(
                """
                DELETE FROM call_interest
                WHERE call_id = %s
                  AND user_name = %s
                """,
                (call_id, viewer),
            )
            interested = False
        else:
            cursor.execute(
                """
                INSERT INTO call_interest (call_id, user_name)
                VALUES (%s, %s)
                ON CONFLICT (call_id, user_name) DO NOTHING
                """,
                (call_id, viewer),
            )
            interested = True

        conn.commit()

        cursor.execute(
            "SELECT COUNT(*)::int AS c FROM call_interest WHERE call_id = %s",
            (call_id,),
        )
        count = int(cursor.fetchone()["c"])

        return {
            "interested": interested,
            "count": count,
        }

    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Deadline reminders (called by the lifespan sweep in main.py)
#
# Disjoint buckets so a saved call never double-pings: as time advances a
# deadline crosses (3d,7d] then (1d,3d] then (0,1d] exactly once each. The
# UNIQUE (call_id,user_name,window_days) triple is the idempotency key — only
# the worker whose INSERT returns a row creates the notification, so the sweep
# is safe under multiple uvicorn workers without a lock.
# ---------------------------------------------------------------------------
WINDOWS = (7, 3, 1)  # days; descending. bucket for w is (next_smaller, w].

_reminders_schema_ready = False


def _ensure_reminders_schema(cursor):
    global _reminders_schema_ready
    if _reminders_schema_ready:
        return
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS call_reminders (
            id SERIAL PRIMARY KEY,
            call_id INTEGER NOT NULL REFERENCES community_calls(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            window_days INTEGER NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (call_id, user_name, window_days)
        )
        """
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_call_reminders_call "
        "ON call_reminders (call_id, window_days)"
    )
    _reminders_schema_ready = True


def _window_label(w: int) -> str:
    return "within a day" if w == 1 else f"within {w} days"


def sweep_call_deadlines():
    """Scan saved (open) calls whose deadline falls in each bucket and notify
    the interested users once per bucket. Best-effort: any error aborts the
    current cycle (caller catches); already-committed reminders are not rolled
    back, so a retry never re-notifies thanks to the UNIQUE guard."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        _ensure_reminders_schema(cursor)
        conn.commit()

        for i, w in enumerate(WINDOWS):
            lower = WINDOWS[i + 1] if i + 1 < len(WINDOWS) else 0

            cursor.execute(
                """
                SELECT c.id AS call_id,
                       c.title,
                       c.scene,
                       c.host_user_name,
                       COALESCE(hp.display_name, hu.username) AS host_display,
                       ci.user_name,
                       c.deadline_at
                FROM community_calls c
                JOIN call_interest ci ON ci.call_id = c.id
                LEFT JOIN users hu ON hu.username = c.host_user_name
                LEFT JOIN profiles hp ON hp.user_id = hu.id
                WHERE c.status = 'open'
                  AND c.deadline_at IS NOT NULL
                  AND c.deadline_at >  CURRENT_TIMESTAMP + make_interval(days => %s)
                  AND c.deadline_at <= CURRENT_TIMESTAMP + make_interval(days => %s)
                  AND NOT EXISTS (
                      SELECT 1
                      FROM call_reminders r
                      WHERE r.call_id = c.id
                        AND r.user_name = ci.user_name
                        AND r.window_days = %s
                  )
                """,
                (lower, w, w),
            )
            candidates = [dict(r) for r in cursor.fetchall()]

            for cand in candidates:
                # Win the race: only proceed if OUR insert actually created the row.
                cursor.execute(
                    """
                    INSERT INTO call_reminders (call_id, user_name, window_days)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (call_id, user_name, window_days) DO NOTHING
                    RETURNING id
                    """,
                    (cand["call_id"], cand["user_name"], w),
                )
                if cursor.fetchone() is None:
                    continue  # another worker already reminded this user

                host = cand.get("host_display") or cand.get("host_user_name") or "a house"
                scene = cand.get("scene")
                body = f"Saved by you · hosted by {host}"
                if scene:
                    body += f" · {scene}"

                create_notification(
                    user_name=cand["user_name"],
                    category="calls",
                    type="call_deadline_soon",
                    title=f"{cand['title']} closes {_window_label(w)}",
                    body=body,
                    actor=None,
                    source_type="call",
                    source_id=cand["call_id"],
                    data={
                        "call_id": cand["call_id"],
                        "window_days": w,
                        "deadline_at": _iso(cand.get("deadline_at")),
                    },
                    cursor=cursor,
                )

            conn.commit()

    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

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