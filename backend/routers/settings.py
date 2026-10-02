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

    # Create default row lazily.
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

    return {
        "language": "en",
        "notifications": _default_notifications(),
        "auctions": _default_auctions(),
        "privacy": _default_privacy(),
    }


def get_notification_prefs(cursor, viewer: str):
    return get_settings(cursor, viewer)["notifications"]


def should_notify(prefs, category: str, surface: str = "in_app"):
    if not isinstance(prefs, dict):
        return True

    if prefs.get("master") is False:
        return False

    cat = prefs.get(category)
    if not isinstance(cat, dict):
        return True

    return bool(cat.get(surface, True))


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