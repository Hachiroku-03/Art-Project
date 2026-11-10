"""
Admin moderation router — FEED service (port 8001), not auth.

Owns the reported-content queue and the soft-delete actions. These tables
(post_reports, posts.deleted_at, comments.deleted_at) are guaranteed only by
the feed process, so this router lives here and ensures the schema itself
before any query touches those columns.

Verified columns only:
  post_reports: id, post_id, reporter, reason, note, status, created_at
  posts:        id, type, title, image_url, author_id, deleted_at
  comments:     id, user_name, post_id, deleted_at
  users:        id, username
  profiles:     user_id, display_name, avatar_url

NOT covered (no schema yet — see module notes): stories, report audit trail.
"""
import os

from fastapi import APIRouter
from notification_service import create_notification

from db import get_db

router = APIRouter()

ADMIN_USERNAMES = {
    u.strip()
    for u in os.getenv("ADMIN_USERNAMES", "").split(",")
    if u.strip()
}

REPORT_STATUSES = {"open", "resolved", "dismissed"}

_admin_schema_ready = False


def _is_admin(viewer: str) -> bool:
    viewer = (viewer or "").strip()
    return bool(viewer) and viewer in ADMIN_USERNAMES


def _ensure_admin_schema(cursor):
    """
    Idempotent copy of feed.py's _ensure_post_schema DDL, guarded by its own
    flag. Runs once per process, COMMITTED before any read of deleted_at /
    post_reports, so a fresh DB never errors on a missing column.
    """
    global _admin_schema_ready
    if _admin_schema_ready:
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
    _admin_schema_ready = True


@router.get("/admin/reports")
def admin_reports(viewer: str = "", status: str = "open", limit: int = 30, offset: int = 0):
    """
    Admin-only report queue. status: open | resolved | dismissed | all.
    Returns each report joined to its post, the post author, and the reporter,
    with a post_removed flag (so admin can act on reports for already-removed
    posts too, rather than them vanishing from the queue).
    """
    if not _is_admin(viewer):
        return {"error": "admin only"}

    status = (status or "open").strip().lower()
    if status not in REPORT_STATUSES and status != "all":
        status = "open"
    limit = max(1, min(int(limit or 30), 100))
    offset = max(0, int(offset or 0))

    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        _ensure_admin_schema(cursor)
        conn.commit()

        where = []
        params = []
        if status != "all":
            where.append("pr.status = %s")
            params.append(status)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        cursor.execute(
            f"""
            SELECT COUNT(*)::int AS c
            FROM post_reports pr
            {where_sql}
            """,
            tuple(params),
        )
        total = int((cursor.fetchone() or {}).get("c") or 0)

        cursor.execute(
            f"""
            SELECT
                pr.id,
                pr.post_id,
                pr.reporter,
                pr.reason,
                pr.note,
                pr.status,
                pr.created_at::text AS created_at,
                p.title   AS post_title,
                p.type    AS post_type,
                p.image_url AS post_image,
                (p.deleted_at IS NOT NULL) AS post_removed,
                au.username AS author_username,
                COALESCE(ap.display_name, au.username) AS author_display,
                ap.avatar_url AS author_avatar,
                ru.username AS reporter_username,
                rp.display_name AS reporter_display
            FROM post_reports pr
            JOIN posts p ON p.id = pr.post_id
            JOIN users au ON au.id = p.author_id
            LEFT JOIN profiles ap ON ap.user_id = au.id
            LEFT JOIN users ru ON ru.username = pr.reporter
            LEFT JOIN profiles rp ON rp.user_id = ru.id
            {where_sql}
            ORDER BY pr.created_at DESC, pr.id DESC
            LIMIT %s OFFSET %s
            """,
            (*params, limit, offset),
        )
        rows = [dict(r) for r in cursor.fetchall()]

        return {"reports": rows, "total": total, "status_filter": status,
                "limit": limit, "offset": offset}

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/admin/reports/{report_id}/resolve")
def admin_resolve_report(report_id: int, data: dict):
    """
    Admin-only. Marks an open report resolved (handled). Flips status only —
    post_reports has no decided_at/decided_by column, so no audit trail is
    written (deliberate; see module notes). Idempotent.
    """
    viewer = str(data.get("viewer") or "").strip()
    if not _is_admin(viewer):
        return {"error": "admin only"}

    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        _ensure_admin_schema(cursor)

        cursor.execute("SELECT status FROM post_reports WHERE id = %s FOR UPDATE", (report_id,))
        row = cursor.fetchone()
        if not row:
            return {"error": "report not found"}
        if row["status"] == "resolved":
            return {"message": "already resolved", "id": report_id}

        cursor.execute("UPDATE post_reports SET status = 'resolved' WHERE id = %s", (report_id,))
        conn.commit()
        return {"message": "report resolved", "id": report_id}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/admin/reports/{report_id}/dismiss")
def admin_dismiss_report(report_id: int, data: dict):
    """
    Admin-only. Marks an open report dismissed (report rejected, content stays).
    Flips status only. Idempotent.
    """
    viewer = str(data.get("viewer") or "").strip()
    if not _is_admin(viewer):
        return {"error": "admin only"}

    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        _ensure_admin_schema(cursor)

        cursor.execute("SELECT status FROM post_reports WHERE id = %s FOR UPDATE", (report_id,))
        row = cursor.fetchone()
        if not row:
            return {"error": "report not found"}
        if row["status"] == "dismissed":
            return {"message": "already dismissed", "id": report_id}

        cursor.execute("UPDATE post_reports SET status = 'dismissed' WHERE id = %s", (report_id,))
        conn.commit()
        return {"message": "report dismissed", "id": report_id}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/admin/posts/{post_id}/remove")
def admin_remove_post(post_id: int, data: dict):
    """
    Admin-only soft delete. Reuses the SAME posts.deleted_at column the author
    path uses — no new schema. Also auto-resolves that post's open reports in
    the same transaction, so removing content clears its queue entries instead
    of leaving stale 'open' rows pointing at a removed post. Idempotent.
    """
    viewer = str(data.get("viewer") or "").strip()
    if not _is_admin(viewer):
        return {"error": "admin only"}

    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        _ensure_admin_schema(cursor)

        cursor.execute(
            "SELECT id, deleted_at FROM posts WHERE id = %s FOR UPDATE",
            (post_id,),
        )
        post = cursor.fetchone()
        if not post:
            return {"error": "post not found"}
        if post["deleted_at"] is not None:
            # Already removed; still sweep any lingering open reports.
            cursor.execute(
                "UPDATE post_reports SET status = 'resolved' WHERE post_id = %s AND status = 'open'",
                (post_id,),
            )
            conn.commit()
            return {"message": "already removed", "id": post_id}

        cursor.execute("UPDATE posts SET deleted_at = CURRENT_TIMESTAMP WHERE id = %s", (post_id,))
        cursor.execute(
            "UPDATE post_reports SET status = 'resolved' WHERE post_id = %s AND status = 'open'",
            (post_id,),
        )
        conn.commit()
        return {"message": "post removed", "id": post_id}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/admin/comments/{comment_id}/remove")
def admin_remove_comment(comment_id: int, data: dict):
    """
    Admin-only soft delete of a single comment, reusing comments.deleted_at.
    Pairs with the existing GET /posts/{id}/comments viewer (which already
    returns a `deleted` flag), so an admin can open a post's thread and remove
    an individual reply. Idempotent.
    """
    viewer = str(data.get("viewer") or "").strip()
    if not _is_admin(viewer):
        return {"error": "admin only"}

    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        _ensure_admin_schema(cursor)

        cursor.execute(
            "SELECT id, deleted_at FROM comments WHERE id = %s FOR UPDATE",
            (comment_id,),
        )
        row = cursor.fetchone()
        if not row:
            return {"error": "comment not found"}
        if row["deleted_at"] is not None:
            return {"message": "already removed", "id": comment_id}

        cursor.execute("UPDATE comments SET deleted_at = CURRENT_TIMESTAMP WHERE id = %s", (comment_id,))
        conn.commit()
        return {"message": "comment removed", "id": comment_id}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()

# ---------------------------------------------------------------------------
# ADMIN sales oversight — READ ONLY.
#
# This does not mutate auctions/lots/ledger. It exists so an admin can inspect:
# - sale state: upcoming / live / ended / settled
# - collection state: paid / pending / unpaid / failed lots
# - payout state: none / pending / paid
# - recent ledger entries tied to the sale's lots or the auction itself
# - house payout profile presence, without exposing full bank account numbers
#
# Money rail reminder:
# The browser must never call https://api.paystack.co directly.
# This endpoint only reads backend state. It does not initialize charges,
# verify charges, initiate transfers, or mark payments.
# ---------------------------------------------------------------------------

def _table_exists(cursor, name: str) -> bool:
    cursor.execute("SELECT to_regclass(%s) IS NOT NULL AS e", (name,))
    return bool((cursor.fetchone() or {}).get("e"))


SALE_STATUS_FILTERS = {"all", "upcoming", "live", "ended", "settled", "attention"}


@router.get("/admin/sales")
def admin_sales(
    viewer: str = "",
    status: str = "all",
    host: str = "",
    q: str = "",
    limit: int = 30,
    offset: int = 0,
):
    """
    Admin-only sales list.

    status:
      all       = every sale
      upcoming  = auctions.status = 'upcoming'
      live      = auctions.status = 'live'
      ended     = auctions.status = 'ended'
      settled   = auctions.settled_at IS NOT NULL
      attention = likely stuck states:
                  - ended but not settled
                  - sold lots unpaid/pending/failed
                  - settled but payout_status = none
    """
    if not _is_admin(viewer):
        return {"error": "admin only"}

    status = (status or "all").strip().lower()
    if status not in SALE_STATUS_FILTERS:
        status = "all"

    host = (host or "").strip()
    query = (q or "").strip()
    search = f"%{query}%" if query else None

    limit = max(1, min(int(limit or 30), 100))
    offset = max(0, int(offset or 0))

    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()

        if not _table_exists(cursor, "auctions") or not _table_exists(cursor, "lots"):
            return {
                "sales": [],
                "total": 0,
                "status_filter": status,
                "limit": limit,
                "offset": offset,
                "note": "auction tables not present yet",
            }

        where = []
        params = []

        if status == "settled":
            where.append("a.settled_at IS NOT NULL")
        elif status == "attention":
            where.append(
                """
                (
                    (a.status = 'ended' AND a.settled_at IS NULL)
                    OR EXISTS (
                        SELECT 1
                        FROM lots l
                        WHERE l.sale_id = a.id
                          AND l.status = 'sold'
                          AND l.winner_username IS NOT NULL
                          AND COALESCE(l.payment_status, 'unpaid') <> 'paid'
                    )
                    OR (
                        a.settled_at IS NOT NULL
                        AND COALESCE(a.payout_status, 'none') = 'none'
                    )
                )
                """
            )
        elif status != "all":
            where.append("a.status = %s")
            params.append(status)

        if host:
            where.append("a.host_username = %s")
            params.append(host)

        if search:
            where.append(
                "(a.title ILIKE %s OR COALESCE(a.description, '') ILIKE %s OR a.host_username ILIKE %s)"
            )
            params.extend([search, search, search])

        where_sql = ("WHERE " + " AND ".join(where)) if where else ""

        cursor.execute(
            f"""
            SELECT COUNT(*)::int AS c
            FROM auctions a
            {where_sql}
            """,
            tuple(params),
        )
        total = int((cursor.fetchone() or {}).get("c") or 0)

        cursor.execute(
            f"""
            SELECT
                a.id,
                a.host_username,
                COALESCE(p.display_name, u.username, a.host_username) AS host_display,
                p.avatar_url AS host_avatar,
                a.title,
                a.status,
                a.tier,
                a.currency,
                a.starts_at::text AS starts_at,
                a.ends_at::text AS ends_at,
                a.ended_at::text AS ended_at,
                a.settled_at::text AS settled_at,
                COALESCE(a.payout_status, 'none') AS payout_status,
                a.payout_reference,
                a.created_at::text AS created_at,
                (
                    SELECT COUNT(*)
                    FROM lots l
                    WHERE l.sale_id = a.id
                ) AS lot_count,
                (
                    SELECT COUNT(*)
                    FROM lots l
                    WHERE l.sale_id = a.id
                      AND l.status = 'sold'
                ) AS sold_count,
                (
                    SELECT COUNT(*)
                    FROM lots l
                    WHERE l.sale_id = a.id
                      AND l.status = 'sold'
                      AND COALESCE(l.payment_status, 'unpaid') = 'paid'
                ) AS paid_count,
                (
                    SELECT COUNT(*)
                    FROM lots l
                    WHERE l.sale_id = a.id
                      AND l.status = 'sold'
                      AND COALESCE(l.payment_status, 'unpaid') IN ('pending', 'processing')
                ) AS pending_count,
                (
                    SELECT COUNT(*)
                    FROM lots l
                    WHERE l.sale_id = a.id
                      AND l.status = 'sold'
                      AND COALESCE(l.payment_status, 'unpaid') IN ('unpaid', 'failed')
                ) AS unpaid_count,
                (
                    SELECT COALESCE(SUM(l.sold_price), 0)::text
                    FROM lots l
                    WHERE l.sale_id = a.id
                      AND l.status = 'sold'
                ) AS hammer_total,
                (
                    SELECT COUNT(*)
                    FROM tickets t
                    WHERE t.auction_id = a.id
                ) AS tickets_sold
            FROM auctions a
            LEFT JOIN users u ON u.username = a.host_username
            LEFT JOIN profiles p ON p.user_id = u.id
            {where_sql}
            ORDER BY
                CASE
                    WHEN a.status = 'live' THEN 0
                    WHEN a.status = 'upcoming' THEN 1
                    WHEN a.status = 'ended' AND a.settled_at IS NULL THEN 2
                    ELSE 3
                END,
                COALESCE(a.ended_at, a.ends_at, a.created_at) DESC NULLS LAST,
                a.id DESC
            LIMIT %s OFFSET %s
            """,
            (*params, limit, offset),
        )

        rows = [dict(r) for r in cursor.fetchall()]

        return {
            "sales": rows,
            "total": total,
            "status_filter": status,
            "host_filter": host or None,
            "query": query or None,
            "limit": limit,
            "offset": offset,
        }

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/admin/sales/{sale_id}/audit")
def admin_sale_audit(sale_id: int, viewer: str = ""):
    """
    Admin-only deep inspection for one sale.

    Returns:
      sale
      lots
      ledger
      payout_profile
      checks

    Deliberately excluded:
      - lot.checkout_url
      - full bank account numbers
      - Paystack secret material
      - any mutation/action

    This is diagnostic state only.
    """
    if not _is_admin(viewer):
        return {"error": "admin only"}

    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()

        if not _table_exists(cursor, "auctions") or not _table_exists(cursor, "lots"):
            return {"error": "auction tables not present yet"}

        cursor.execute(
            """
            SELECT
                a.id,
                a.host_username,
                COALESCE(p.display_name, u.username, a.host_username) AS host_display,
                p.avatar_url AS host_avatar,
                a.title,
                a.description,
                a.image_url,
                a.status,
                a.tier,
                a.currency,
                a.ticket_currency,
                a.ticket_price::text AS ticket_price,
                a.ticket_capacity,
                a.starts_at::text AS starts_at,
                a.ends_at::text AS ends_at,
                a.ended_at::text AS ended_at,
                a.settled_at::text AS settled_at,
                COALESCE(a.payout_status, 'none') AS payout_status,
                a.payout_reference,
                a.created_at::text AS created_at
            FROM auctions a
            LEFT JOIN users u ON u.username = a.host_username
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE a.id = %s
            """,
            (sale_id,),
        )

        sale_row = cursor.fetchone()
        if not sale_row:
            return {"error": "sale not found"}

        sale = dict(sale_row)

        cursor.execute(
            """
            SELECT
                l.id,
                l.position,
                l.title,
                l.status,
                l.currency,
                l.starting_price::text AS starting_price,
                l.estimate_low::text AS estimate_low,
                l.estimate_high::text AS estimate_high,
                l.sold_price::text AS sold_price,
                l.winner_username,
                COALESCE(l.payment_status, 'unpaid') AS payment_status,
                l.payment_reference,
                l.payment_updated_at::text AS payment_updated_at,
                l.hammer_at::text AS hammer_at,
                (
                    SELECT MAX(b.amount)::text
                    FROM lot_bids b
                    WHERE b.lot_id = l.id
                ) AS current_bid,
                (
                    SELECT COUNT(*)
                    FROM lot_bids b
                    WHERE b.lot_id = l.id
                ) AS bid_count
            FROM lots l
            WHERE l.sale_id = %s
            ORDER BY l.position
            """,
            (sale_id,),
        )

        lots = [dict(r) for r in cursor.fetchall()]

        ledger = []
        if _table_exists(cursor, "ledger_entries"):
            cursor.execute(
                """
                SELECT
                    le.user_name,
                    le.amount::text AS amount,
                    le.currency,
                    le.kind,
                    le.reference,
                    le.ref_table,
                    le.ref_id,
                    le.created_at::text AS created_at
                FROM ledger_entries le
                WHERE (
                    le.ref_table = 'lots'
                    AND le.ref_id IN (
                        SELECT l.id
                        FROM lots l
                        WHERE l.sale_id = %s
                    )
                )
                OR (
                    le.ref_table = 'auctions'
                    AND le.ref_id = %s
                )
                ORDER BY le.created_at DESC, le.id DESC
                LIMIT 50
                """,
                (sale_id, sale_id),
            )
            ledger = [dict(r) for r in cursor.fetchall()]

        payout_profile = None
        if _table_exists(cursor, "house_payout_profiles"):
            cursor.execute(
                """
                SELECT
                    business_name,
                    account_name,
                    bank_code,
                    currency,
                    status,
                    (
                        paystack_recipient_code IS NOT NULL
                        AND paystack_recipient_code <> ''
                    ) AS has_recipient,
                    updated_at::text AS updated_at
                FROM house_payout_profiles
                WHERE user_name = %s
                """,
                (sale.get("host_username"),),
            )
            profile_row = cursor.fetchone()
            payout_profile = dict(profile_row) if profile_row else None

        sold_lots = [
            l for l in lots
            if l.get("status") == "sold" and l.get("winner_username")
        ]
        paid_lots = [
            l for l in sold_lots
            if str(l.get("payment_status") or "unpaid").lower() == "paid"
        ]
        pending_lots = [
            l for l in sold_lots
            if str(l.get("payment_status") or "unpaid").lower() in ("pending", "processing")
        ]
        unpaid_lots = [
            l for l in sold_lots
            if str(l.get("payment_status") or "unpaid").lower() in ("unpaid", "failed")
        ]

        issues = []

        if sale.get("status") != "ended" and sale.get("settled_at"):
            issues.append("Sale is marked settled before it is ended.")

        if sale.get("status") == "ended" and not sale.get("settled_at"):
            issues.append("Sale has ended but has not been settled yet.")

        if unpaid_lots:
            issues.append(f"{len(unpaid_lots)} won lot(s) are unpaid or failed.")

        if pending_lots:
            issues.append(f"{len(pending_lots)} won lot(s) are pending collection.")

        if sale.get("settled_at") and str(sale.get("payout_status") or "none").lower() == "none":
            issues.append("Sale is settled but house payout has not been processed.")

        if (
            str(sale.get("payout_status") or "").lower() == "pending"
            and str(sale.get("payout_reference") or "").startswith("payout_transfer_")
        ):
            issues.append("A live house payout transfer is awaiting webhook confirmation.")

        return {
            "sale": sale,
            "lots": lots,
            "ledger": ledger,
            "payout_profile": payout_profile,
            "checks": {
                "lot_count": len(lots),
                "sold_count": len(sold_lots),
                "paid_count": len(paid_lots),
                "pending_count": len(pending_lots),
                "unpaid_count": len(unpaid_lots),
                "issues": issues,
            },
        }

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()

# ---------------------------------------------------------------------------
# ADMIN system broadcast — FEED service.
#
# Sends ONE notification row per recipient through the existing
# notification_service.create_notification helper, so the bell renders it
# exactly like every other notice (same column contract, same data shape).
#
# Scope guards (deliberate, narrow):
#   - admin only (_is_admin)
#   - category fixed to 'system'
#   - audience allowlist: all | houses | vip | artist | single
#   - hard recipient cap; over-cap REFUSES and tells admin to narrow it
#   - whole broadcast is ONE transaction: all recipients or none
#   - does NOT touch ledger, Paystack, auctions, lots, posts, comments
#
# Known gaps (named, not invented):
#   - No 'broadcasts' table → no server-side dedupe. Double-click sends twice;
#     UI guards with busy state + confirm, broadcast_ref stored in data.
#   - System notices bypass per-user mute (needs confirmed settings schema).
#   - notifications.source_id is passed NULL ("no source entity"). If your
#     notifications table declares source_id NOT NULL, run once:
#       ALTER TABLE notifications ALTER COLUMN source_id DROP NOT NULL;
#     (system notices genuinely have no source row; that ALTER is the correct
#     fix, not a sentinel id.)
# ---------------------------------------------------------------------------

BROADCAST_AUDIENCES = {"all", "houses", "vip", "artist", "single"}
BROADCAST_CATEGORY = "system"
BROADCAST_MAX_RECIPIENTS = int(os.getenv("BROADCAST_MAX_RECIPIENTS", "2000"))
BROADCAST_TITLE_MAX = 140
BROADCAST_BODY_MAX = 1000


def _audience_where(audience: str, username: str):
    """
    Return (where_sql_fragment, params) restricting users.username to the
    chosen audience. Always selects from users only, so holder accounts
    (__escrow__, __platform_revenue__) can never receive a broadcast.
    """
    if audience == "houses":
        return "u.role = 'house'", []
    if audience == "vip":
        # Cached tier, not a live sweep. A member whose renewal is due but
        # not yet swept may be missed; a lapsed-but-un-swept member may be
        # included. Acceptable for announcements; noted above.
        return "u.tier = 'vip'", []
    if audience == "artist":
        # role is 'artist' or 'house' (collector was retired to artist).
        return "u.role = 'artist'", []
    if audience == "single":
        return "u.username = %s", [username]
    return "", []  # all


@router.get("/admin/system/audience-count")
def admin_system_audience_count(
    viewer: str = "",
    audience: str = "all",
    username: str = "",
):
    """
    Admin-only blast-radius preview. Read-only. Returns how many members the
    chosen audience would reach, whether it exceeds the per-send cap, and
    (for single) whether that username actually exists.
    """
    if not _is_admin(viewer):
        return {"error": "admin only"}

    audience = (audience or "all").strip().lower()
    if audience not in BROADCAST_AUDIENCES:
        return {"error": "invalid audience"}

    username = (username or "").strip()
    if audience == "single" and not username:
        return {"error": "username required for single audience"}

    where_sql, params = _audience_where(audience, username)
    where = f"WHERE {where_sql}" if where_sql else ""

    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            f"SELECT COUNT(*)::int AS c FROM users u {where}",
            tuple(params),
        )
        count = int((cursor.fetchone() or {}).get("c") or 0)

        exists = True
        if audience == "single":
            cursor.execute("SELECT 1 FROM users WHERE username = %s", (username,))
            exists = cursor.fetchone() is not None

        return {
            "audience": audience,
            "username": username or None,
            "count": count,
            "exists": exists,
            "over_cap": count > BROADCAST_MAX_RECIPIENTS,
            "cap": BROADCAST_MAX_RECIPIENTS,
        }

    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/admin/notifications/broadcast")
def admin_broadcast(data: dict):
    """
    Admin-only system broadcast. One notification per recipient, atomically.
    Payload:
      {
        "viewer": "coura",
        "audience": "all" | "houses" | "vip" | "artist" | "single",
        "username": "emma",                 # required when audience == single
        "title": "Scheduled maintenance",
        "body": "The Space will be briefly unavailable tonight.",
        "broadcast_ref": "optional-client-ref"
      }
    """
    viewer = str(data.get("viewer") or "").strip()
    if not _is_admin(viewer):
        return {"error": "admin only"}

    audience = str(data.get("audience") or "all").strip().lower()
    if audience not in BROADCAST_AUDIENCES:
        return {"error": "invalid audience"}

    username = str(data.get("username") or "").strip()
    if audience == "single" and not username:
        return {"error": "username required for single audience"}

    title = str(data.get("title") or "").strip()[:BROADCAST_TITLE_MAX]
    body = str(data.get("body") or "").strip()[:BROADCAST_BODY_MAX]
    if not title:
        return {"error": "title required"}
    if not body:
        return {"error": "body required"}

    broadcast_ref = str(data.get("broadcast_ref") or "").strip()[:120] or None

    where_sql, params = _audience_where(audience, username)
    where = f"WHERE {where_sql}" if where_sql else ""

    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            f"SELECT username FROM users u {where} ORDER BY username",
            tuple(params),
        )
        recipients = [r["username"] for r in cursor.fetchall() if r.get("username")]

        if audience == "single" and not recipients:
            return {"error": "unknown recipient"}

        if not recipients:
            return {
                "message": "no recipients in audience",
                "sent": 0,
                "audience": audience,
            }

        if len(recipients) > BROADCAST_MAX_RECIPIENTS:
            return {
                "error": (
                    f"audience reaches {len(recipients)} members, over the "
                    f"per-send cap of {BROADCAST_MAX_RECIPIENTS}. Narrow it "
                    "(houses / vip / artist / single) or raise "
                    "BROADCAST_MAX_RECIPIENTS deliberately."
                ),
                "count": len(recipients),
                "cap": BROADCAST_MAX_RECIPIENTS,
            }

        for user_name in recipients:
            create_notification(
                user_name=user_name,
                category=BROADCAST_CATEGORY,
                type="system_announcement",
                title=title,
                body=body,
                actor=viewer,
                source_type="system",
                source_id=None,
                data={
                    "audience": audience,
                    "broadcast_ref": broadcast_ref,
                    "sent_by": viewer,
                },
                cursor=cursor,
            )

        conn.commit()
        return {
            "message": "broadcast sent",
            "sent": len(recipients),
            "audience": audience,
            "category": BROADCAST_CATEGORY,
            "broadcast_ref": broadcast_ref,
        }

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()