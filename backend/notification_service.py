"""
Combined /account router + notification/user-settings service.

This module is BOTH:
  - the FastAPI router mounted at prefix "/account" (languages, settings read,
    per-section PATCH writes, blocked list)
  - the service library imported by chat.py (create_notification, should_notify, ...)

Mount this router on the SAME app that owns db.py / chat / notifications /
community (port 8001 in this project). The frontend lib/settings.ts must point
ACCOUNT_API at that app. One Postgres backs every app, so users.face_embedding,
chat_blocks, user_settings and notifications are all visible here.

Preference enforcement split (deliberate):
  - in_app : enforced SERVER-SIDE here, at insert time. If a category's in_app
             is off (or master is off), create_notification writes NO row, so
             the notification never reaches the bell, dropdown, /notifications
             page, or a toast.
  - sound  : enforced CLIENT-SIDE (ToastHost reads prefs via GET /account/settings
             and pings only when prefs[category].sound). should_sound() is the
             shared rule for any future server-side push/email.
"""

import json

from db import get_db
from fastapi import APIRouter


router = APIRouter(prefix="/account", tags=["account"])

ALLOWED_LANGUAGES = {
    "en",
    "fr",
    "es",
    "de",
    "pt",
    "it",
    "nl",
    "ru",
    "zh",
    "ja",
    "ko",
    "hi",
    "sw",
    "ar",
}

NOTIFICATION_CATEGORIES = (
    "messages",
    "mentions",
    "groups",
    "posts",
    "auctions",
    "wallet",
    "security",
    "system",
)

TYPE_CATEGORY = {
    # Chat
    "chat_message": "messages",
    "message": "messages",
    "chat_mention": "mentions",
    "mention": "mentions",

    # Groups
    "group_invite": "groups",
    "group_join_request": "groups",
    "group_request_approved": "groups",
    "group_request_rejected": "groups",
    "group_new_member": "groups",
    "group_removed": "groups",
    "group_announcement": "groups",

    # Posts
    "post_like": "posts",
    "post_comment": "posts",
    "post_reply": "posts",
    "post_mention": "mentions",
    "post_follow": "posts",

    # Auctions
    "auction_starting_soon": "auctions",
    "lot_open": "auctions",
    "lot_outbid": "auctions",
    "lot_won": "auctions",
    "lot_lost": "auctions",
    "house_announcement": "auctions",

    # Wallet / tickets
    "ticket_purchase_success": "wallet",
    "ticket_purchase_failed": "wallet",
    "wallet_top_up_success": "wallet",
    "invoice_ready": "wallet",
    "payment_failed": "wallet",

    # Security
    "new_device_login": "security",
    "password_changed": "security",
    "passkey_added": "security",
    "passkey_removed": "security",
    "face_verification_enabled": "security",
    "face_verification_failed": "security",
}

LEGACY_CHAT_NOTIFICATION_TYPES = {
    "message",
    "mention",
    "group_invite",
}


# ---------------------------------------------------------------------------
# HTTP routes (prefix "/account"). Bodies reference helpers defined further
# down; that's fine — they execute at request time, after the module loads.
# ---------------------------------------------------------------------------
@router.get("/languages")
def list_languages():
    return {
        "languages": sorted(ALLOWED_LANGUAGES)
    }


@router.get("/settings")
def read_account_settings(viewer: str = ""):
    """Full merged settings + the two presentation-only fields the Settings
    page reads (identity.face_verification, blocked_count). Those are computed
    defensively so a missing table/column degrades to a safe value instead of
    500-ing the whole page (which previously white-screened on
    settings.identity.face_verification)."""
    v = resolve_viewer(viewer)
    if not v:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()
    try:
        core = get_settings(cursor, v)

        face = "none"
        try:
            cursor.execute(
                "SELECT 1 FROM users WHERE username = %s AND face_embedding IS NOT NULL",
                (v,),
            )
            if cursor.fetchone():
                face = "enabled"
        except Exception:
            face = "none"

        blocked_count = 0
        try:
            cursor.execute(
                "SELECT COUNT(*)::int AS c FROM chat_blocks WHERE blocker = %s",
                (v,),
            )
            row = cursor.fetchone()
            blocked_count = int((row or {}).get("c") or 0)
        except Exception:
            blocked_count = 0

        conn.commit()

        return {
            **core,
            "identity": {"face_verification": face},
            "blocked_count": blocked_count,
        }
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.patch("/settings/language")
def patch_language(data: dict):
    v = resolve_viewer(data.get("viewer") or "")
    if not v:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()
    try:
        s = save_settings(cursor, v, language=data.get("language"))
        conn.commit()
        return {"language": s["language"], "message": "language saved"}
    except ValueError as e:
        conn.rollback()
        return {"error": str(e)}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.patch("/settings/notifications")
def patch_notifications(data: dict):
    v = resolve_viewer(data.get("viewer") or "")
    if not v:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()
    try:
        s = save_settings(cursor, v, notifications_patch=data.get("notifications"))
        conn.commit()
        return {"notifications": s["notifications"], "message": "saved"}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.patch("/settings/auctions")
def patch_auctions(data: dict):
    v = resolve_viewer(data.get("viewer") or "")
    if not v:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()
    try:
        s = save_settings(cursor, v, auctions_patch=data.get("auctions"))
        conn.commit()
        return {"auctions": s["auctions"], "message": "saved"}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.patch("/settings/privacy")
def patch_privacy(data: dict):
    v = resolve_viewer(data.get("viewer") or "")
    if not v:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()
    try:
        s = save_settings(cursor, v, privacy_patch=data.get("privacy"))
        conn.commit()
        return {"privacy": s["privacy"], "message": "saved"}
    except Exception as e:
        conn.rollback()
        return {"error": str(e)}
    finally:
        conn.close()


@router.get("/settings/blocked")
def list_blocked(viewer: str = ""):
    v = resolve_viewer(viewer)
    if not v:
        return {"error": "viewer required"}

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            SELECT b.blocked AS user_name,
                   COALESCE(p.display_name, u.username) AS display_name,
                   p.avatar_url,
                   b.created_at::text AS created_at
            FROM chat_blocks b
            JOIN users u ON u.username = b.blocked
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE b.blocker = %s
            ORDER BY b.created_at DESC
            """,
            (v,),
        )
        rows = [dict(r) for r in cursor.fetchall()]
        conn.commit()
        return {"blocked": rows}
    except Exception as e:
        conn.rollback()
        # Degrade to empty rather than 500: the page may surface this list
        # anywhere; an unavailable block list must not break settings.
        return {"blocked": [], "error": str(e)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
def _default_notifications():
    return {
        "master": True,
        "messages": {"in_app": True, "sound": False},
        "mentions": {"in_app": True, "sound": True},
        "groups": {"in_app": True, "sound": False},
        "posts": {"in_app": True, "sound": False},
        "auctions": {"in_app": True, "sound": True},
        "wallet": {"in_app": True, "sound": False},
        "security": {"in_app": True, "sound": False},
        "system": {"in_app": True, "sound": False},
    }


def _default_auctions():
    return {
        "confirm_bids": True,
        "show_username_in_ledger": True,
        "paddle_nickname": None,
    }


def _default_privacy():
    return {
        "profile_visibility": "public",
        "allow_mentions": "everyone",
        "show_online_status": True,
    }


# ---------------------------------------------------------------------------
# Viewer resolution
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


def resolve_viewer(viewer_raw: str):
    if not viewer_raw:
        return None

    conn = get_db()
    cursor = conn.cursor()
    viewer = _canonical_username(cursor, viewer_raw)
    conn.close()
    return viewer


# ---------------------------------------------------------------------------
# Merge helpers
# ---------------------------------------------------------------------------
def _merge_notifications(stored):
    out = _default_notifications()

    if not isinstance(stored, dict):
        return out

    if isinstance(stored.get("master"), bool):
        out["master"] = stored["master"]

    for cat in NOTIFICATION_CATEGORIES:
        val = stored.get(cat)
        if isinstance(val, dict):
            if isinstance(val.get("in_app"), bool):
                out[cat]["in_app"] = val["in_app"]
            if isinstance(val.get("sound"), bool):
                out[cat]["sound"] = val["sound"]

    return out


def _merge_auctions(stored):
    out = _default_auctions()

    if not isinstance(stored, dict):
        return out

    if isinstance(stored.get("confirm_bids"), bool):
        out["confirm_bids"] = stored["confirm_bids"]

    if isinstance(stored.get("show_username_in_ledger"), bool):
        out["show_username_in_ledger"] = stored["show_username_in_ledger"]

    nickname = stored.get("paddle_nickname")
    if isinstance(nickname, str):
        nickname = nickname.strip()[:24]
        out["paddle_nickname"] = nickname or None
    elif nickname is None:
        out["paddle_nickname"] = None

    return out


def _merge_privacy(stored):
    out = _default_privacy()

    if not isinstance(stored, dict):
        return out

    visibility = stored.get("profile_visibility")
    if visibility in {"public", "followers", "private"}:
        out["profile_visibility"] = visibility

    mentions = stored.get("allow_mentions")
    if mentions in {"everyone", "followers", "group_members", "nobody"}:
        out["allow_mentions"] = mentions

    if isinstance(stored.get("show_online_status"), bool):
        out["show_online_status"] = stored["show_online_status"]

    return out


# ---------------------------------------------------------------------------
# Read (core 4 keys — used server-side by create_notification too)
# ---------------------------------------------------------------------------
def get_settings(cursor, viewer: str):
    cursor.execute(
        """
        SELECT language, notifications, auctions, privacy
        FROM user_settings
        WHERE user_name = %s
        """,
        (viewer,),
    )
    row = cursor.fetchone()

    if not row:
        # Lazily create a default row, then RE-READ so we never return defaults
        # that a concurrent writer already replaced with real config.
        cursor.execute(
            """
            INSERT INTO user_settings (
                user_name,
                language,
                notifications,
                auctions,
                privacy,
                updated_at
            )
            VALUES (%s, 'en', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)
            ON CONFLICT (user_name) DO NOTHING
            """,
            (viewer,),
        )
        cursor.execute(
            """
            SELECT language, notifications, auctions, privacy
            FROM user_settings
            WHERE user_name = %s
            """,
            (viewer,),
        )
        row = cursor.fetchone()

    if row:
        notifications = row["notifications"]
        auctions = row["auctions"]
        privacy = row["privacy"]

        if isinstance(notifications, str):
            notifications = json.loads(notifications)
        if isinstance(auctions, str):
            auctions = json.loads(auctions)
        if isinstance(privacy, str):
            privacy = json.loads(privacy)

        return {
            "language": row["language"] or "en",
            "notifications": _merge_notifications(notifications or {}),
            "auctions": _merge_auctions(auctions or {}),
            "privacy": _merge_privacy(privacy or {}),
        }

    # Defensive: still no row (unreachable after the lazy insert + re-read).
    return {
        "language": "en",
        "notifications": _default_notifications(),
        "auctions": _default_auctions(),
        "privacy": _default_privacy(),
    }


def get_notification_prefs(cursor, viewer: str):
    return get_settings(cursor, viewer)["notifications"]


# ---------------------------------------------------------------------------
# Enforcement rules
# ---------------------------------------------------------------------------
def should_notify(prefs, category: str, surface: str = "in_app"):
    if not isinstance(prefs, dict):
        return True

    if prefs.get("master") is False:
        return False

    cat = prefs.get(category)
    if not isinstance(cat, dict):
        return True

    return bool(cat.get(surface, True))


def should_sound(prefs, category: str) -> bool:
    """Sound surface rule, mirroring should_notify. Today sound is enforced
    client-side (ToastHost); this exists so a future server-side push/email
    reuses the exact same master + per-category logic."""
    return should_notify(prefs, category, "sound")


# ---------------------------------------------------------------------------
# Patch sanitizers
# ---------------------------------------------------------------------------
def sanitize_notifications_patch(current, patch):
    out = _merge_notifications(current)

    if not isinstance(patch, dict):
        return out

    if isinstance(patch.get("master"), bool):
        out["master"] = patch["master"]

    for cat in NOTIFICATION_CATEGORIES:
        val = patch.get(cat)
        if isinstance(val, dict):
            if isinstance(val.get("in_app"), bool):
                out[cat]["in_app"] = val["in_app"]
            if isinstance(val.get("sound"), bool):
                out[cat]["sound"] = val["sound"]

    return out


def sanitize_auctions_patch(current, patch):
    out = _merge_auctions(current)

    if not isinstance(patch, dict):
        return out

    if isinstance(patch.get("confirm_bids"), bool):
        out["confirm_bids"] = patch["confirm_bids"]

    if isinstance(patch.get("show_username_in_ledger"), bool):
        out["show_username_in_ledger"] = patch["show_username_in_ledger"]

    if "paddle_nickname" in patch:
        nickname = patch.get("paddle_nickname")
        if nickname is None:
            out["paddle_nickname"] = None
        elif isinstance(nickname, str):
            nickname = nickname.strip()[:24]
            out["paddle_nickname"] = nickname or None

    return out


def sanitize_privacy_patch(current, patch):
    out = _merge_privacy(current)

    if not isinstance(patch, dict):
        return out

    if patch.get("profile_visibility") in {"public", "followers", "private"}:
        out["profile_visibility"] = patch["profile_visibility"]

    if patch.get("allow_mentions") in {"everyone", "followers", "group_members", "nobody"}:
        out["allow_mentions"] = patch["allow_mentions"]

    if isinstance(patch.get("show_online_status"), bool):
        out["show_online_status"] = patch["show_online_status"]

    return out


# ---------------------------------------------------------------------------
# Write (single transactional path reused by every PATCH handler)
# ---------------------------------------------------------------------------
def save_settings(
    cursor,
    viewer: str,
    *,
    language=None,
    notifications_patch=None,
    auctions_patch=None,
    privacy_patch=None,
):
    """
    Atomic write path for user_settings. Each section is patched independently:
    pass None to leave it untouched, or a partial/full object — the sanitize_*
    mergers overlay only the keys you send onto the current stored config.
    Language is validated against ALLOWED_LANGUAGES. Returns the merged result
    in the same shape get_settings produces, so a PATCH response can drive an
    optimistic UI without a follow-up GET.

    Caller owns the transaction (passes its cursor and commits/rolls back).
    """
    current = get_settings(cursor, viewer)  # ensures a row exists + merged

    if language is not None:
        lang = (language or "").strip().lower()
        if lang not in ALLOWED_LANGUAGES:
            raise ValueError("invalid language")
    else:
        lang = current["language"]

    notifications = (
        sanitize_notifications_patch(current["notifications"], notifications_patch)
        if notifications_patch is not None
        else current["notifications"]
    )
    auctions = (
        sanitize_auctions_patch(current["auctions"], auctions_patch)
        if auctions_patch is not None
        else current["auctions"]
    )
    privacy = (
        sanitize_privacy_patch(current["privacy"], privacy_patch)
        if privacy_patch is not None
        else current["privacy"]
    )

    cursor.execute(
        """
        INSERT INTO user_settings (
            user_name,
            language,
            notifications,
            auctions,
            privacy,
            updated_at
        )
        VALUES (%s, %s, %s::jsonb, %s::jsonb, %s::jsonb, CURRENT_TIMESTAMP)
        ON CONFLICT (user_name) DO UPDATE SET
            language = EXCLUDED.language,
            notifications = EXCLUDED.notifications,
            auctions = EXCLUDED.auctions,
            privacy = EXCLUDED.privacy,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            viewer,
            lang,
            json.dumps(notifications),
            json.dumps(auctions),
            json.dumps(privacy),
        ),
    )

    return {
        "language": lang,
        "notifications": notifications,
        "auctions": auctions,
        "privacy": privacy,
    }


# ---------------------------------------------------------------------------
# Notification creation (unchanged — already enforces in_app at insert)
# ---------------------------------------------------------------------------
def create_notification(
    user_name: str,
    type: str,
    title: str,
    body: str = "",
    category: str | None = None,
    actor: str | None = None,
    source_type: str | None = None,
    source_id: int | None = None,
    secondary_id: int | None = None,
    data: dict | None = None,
    legacy_type: str | None = None,
    cursor=None,
):
    """
    Creates a notification only if user preferences allow it.

    Writes to unified notifications table.
    Also writes legacy chat_notifications for chat-compatible events during transition.
    """

    own_conn = cursor is None
    conn = get_db() if own_conn else None
    cur = cursor or conn.cursor()

    try:
        target = _canonical_username(cur, user_name)
        if not target:
            return None

        prefs = get_notification_prefs(cur, target)

        resolved_category = category or TYPE_CATEGORY.get(type, "system")

        if not should_notify(prefs, resolved_category, "in_app"):
            return None

        payload = data or {}
        payload_json = json.dumps(payload, default=str)

        cur.execute(
            """
            INSERT INTO notifications (
                user_name,
                category,
                type,
                actor,
                source_type,
                source_id,
                secondary_id,
                title,
                body,
                data
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            RETURNING id
            """,
            (
                target,
                resolved_category,
                type,
                actor,
                source_type,
                source_id,
                secondary_id,
                title,
                body,
                payload_json,
            ),
        )

        notification_id = cur.fetchone()["id"]

        # Transition dual-write for existing chat notification UI.
        if legacy_type in LEGACY_CHAT_NOTIFICATION_TYPES:
            conversation_id = None
            message_id = secondary_id

            if source_type in {"conversation", "chat"}:
                conversation_id = source_id
            elif isinstance(payload.get("conversation_id"), int):
                conversation_id = payload["conversation_id"]

            if isinstance(payload.get("message_id"), int):
                message_id = payload["message_id"]

            cur.execute(
                """
                INSERT INTO chat_notifications (
                    user_name,
                    conversation_id,
                    message_id,
                    type,
                    title,
                    body
                )
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (
                    target,
                    conversation_id,
                    message_id,
                    legacy_type,
                    title,
                    body,
                ),
            )

        if own_conn:
            conn.commit()

        return notification_id

    except Exception:
        if own_conn:
            conn.rollback()
        raise

    finally:
        if own_conn:
            conn.close()