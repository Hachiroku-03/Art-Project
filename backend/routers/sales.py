import secrets

from fastapi import APIRouter
from db import get_db
from helpers import auction_access
from ledger import spend
from notification_service import create_notification
import paystack

router = APIRouter()

# Platform-controlled v1 rates. Become per-sale columns when houses set their own
# premium; until then the platform owns the money math (safer than letting a house
# discount itself into unpaid commission).
#
# FLOW A (charge at settlement), HOUSE-NET split:
#   buyer pays platform  = hammer + premium        (one Paystack charge per won lot)
#   platform commission  = collected * COMMISSION_RATE   (withheld from house payout)
#   net to house         = collected - commission        (paid to house via transfer)
#
# The platform's revenue is the commission — it is NOT debited from the house
# wallet; it is kept out of what would have been the house's payout. So the house
# never needs a funded wallet to settle. Money MOVES only via the rail (webhook ->
# escrow credit now; payout transfer later). With NO Paystack keys, settle still
# runs end-to-end: it computes the split, records it, sends notices, and leaves
# lots 'unpaid' (collection pending) — developable and testable today.
BUYER_PREMIUM_RATE = 0.15        # added to the buyer's hammer; part of the settle charge
PLATFORM_COMMISSION_RATE = 0.10  # platform's cut of the collected total (withheld at payout)

ACCESS_MODES = {"open", "vip", "invite"}            # canonical storage values
ACCESS_ALIASES = {                                   # accept the drifted spellings on write
    "open": "open",
    "vip": "vip",
    "vip_only": "vip",
    "invite": "invite",
    "invite_only": "invite",
}

DEFAULT_CCY = "NGN"
DEFAULT_CURRENCY = DEFAULT_CCY    # compatibility alias, safe if anything references it


def _ccy(value, default=DEFAULT_CCY):
    c = (str(value or default)).strip().upper()
    return c if (len(c) == 3 and c.isalpha()) else default


def _money_or_none(value):
    """Return (amount, error). None means unset/null."""
    if value in (None, ""):
        return None, None
    try:
        f = round(float(value), 2)
    except (TypeError, ValueError):
        return None, "invalid amount"
    if f < 0:
        return None, "amount cannot be negative"
    return f, None


def _capacity_or_none(value):
    if value in (None, ""):
        return None, None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None, "invalid capacity"
    if n <= 0:
        return None, "capacity must be positive"
    return n, None


def _refresh_payout_status(cursor, sale_id: int) -> str:
    """
    payout_status reflects collection/payout state:
      pending = one or more charges initiated and awaiting webhook
      none    = settled but collection not initiated yet (e.g. no Paystack keys)
      paid    = all won lots paid
    """
    cursor.execute(
        """
        SELECT
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END), 0)::int AS paid,
            COALESCE(SUM(CASE WHEN payment_status = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending,
            COALESCE(SUM(CASE WHEN payment_status IN ('unpaid', 'failed') THEN 1 ELSE 0 END), 0)::int AS unpaid
        FROM lots
        WHERE sale_id = %s
          AND status = 'sold'
          AND winner_username IS NOT NULL
        """,
        (sale_id,),
    )
    row = cursor.fetchone() or {}
    paid = int(row.get("paid") or 0)
    pending = int(row.get("pending") or 0)
    unpaid = int(row.get("unpaid") or 0)

    if pending > 0:
        status = "pending"
    elif unpaid > 0:
        status = "none"
    elif paid > 0:
        status = "paid"
    else:
        status = "none"

    cursor.execute(
        "UPDATE auctions SET payout_status = %s WHERE id = %s",
        (status, sale_id),
    )
    return status


@router.post("/sales")
def create_sale(data: dict):
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        title = (data.get("title") or "").strip()

        if not host:
            return {"error": "viewer required"}
        if not title:
            return {"error": "title required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT role FROM users WHERE username = %s", (host,))
        u = cursor.fetchone()
        if not u or u["role"] != "house":
            return {"error": "only accredited houses may open a room"}

        tier = ACCESS_ALIASES.get(str(data.get("tier", "open")).strip().lower(), "open")
        currency = _ccy(data.get("currency"))
        ticket_currency = _ccy(data.get("ticket_currency"), currency)

        try:
            ticket_price = round(float(data.get("ticket_price", 0) or 0), 2)
        except (TypeError, ValueError):
            return {"error": "invalid ticket_price"}
        if ticket_price < 0:
            return {"error": "ticket_price cannot be negative"}

        ticket_capacity, cap_err = _capacity_or_none(data.get("ticket_capacity"))
        if cap_err:
            return {"error": cap_err}

        cursor.execute(
            """
            INSERT INTO auctions (
                host_username, title, description, image_url, tier, status,
                starts_at, ends_at,
                ticket_price, ticket_currency, ticket_capacity,
                currency, stream_type, stream_url
            )
            VALUES (%s, %s, %s, %s, %s, 'upcoming', %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                host,
                title,
                data.get("description", ""),
                data.get("image_url") or None,
                tier,
                data.get("starts_at") or None,
                data.get("ends_at") or None,
                ticket_price,
                ticket_currency,
                ticket_capacity,
                currency,
                data.get("stream_type", "external"),
                data.get("stream_url", ""),
            ),
        )

        sid = cursor.fetchone()["id"]
        conn.commit()
        return {"id": sid}

    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/my_sales")
def my_sales(viewer: str = ""):
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT a.id, a.title, a.status, a.tier, a.currency, a.ticket_currency,
                   a.ticket_price::text AS ticket_price,
                   a.starts_at::text AS starts_at,
                   a.ends_at::text AS ends_at,
                   a.settled_at::text AS settled_at,
                   a.payout_status,
                   (SELECT COUNT(*) FROM lots l WHERE l.sale_id = a.id) AS lot_count
            FROM auctions a
            WHERE a.host_username = %s
            ORDER BY a.created_at DESC
            """,
            (viewer,),
        )
        rows = cursor.fetchall()
        return {"sales": rows}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/sales")
def list_sales(viewer: str = ""):
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT a.id, a.host_username, a.title, a.description, a.image_url,
                   a.tier, a.status,
                   a.starts_at::text AS starts_at,
                   a.ends_at::text AS ends_at,
                   a.ticket_price::text AS ticket_price,
                   a.ticket_currency,
                   a.currency,
                   a.ticket_capacity,
                   (SELECT COUNT(*) FROM tickets t WHERE t.auction_id = a.id) AS tickets_sold,
                   (SELECT COUNT(*) FROM lots l WHERE l.sale_id = a.id) AS lot_count
            FROM auctions a
            WHERE a.status IN ('upcoming', 'live', 'ended')
            ORDER BY a.created_at DESC
            """
        )

        rows = cursor.fetchall()
        out = []
        for s in rows:
            acc = auction_access(cursor, s, viewer)
            if acc["visible"]:
                out.append({**s, **acc})

        return {"sales": out}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/stream")
def set_stream(sale_id: int, data: dict):
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status FROM auctions WHERE id = %s", (sale_id,))
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] == "ended":
            return {"error": "sale has ended"}

        cursor.execute(
            "UPDATE auctions SET stream_type=%s, stream_url=%s, stream_peer_id=%s WHERE id=%s",
            (
                data.get("stream_type", "external"),
                data.get("stream_url", ""),
                data.get("stream_peer_id", ""),
                sale_id,
            ),
        )
        conn.commit()
        return {"message": "stream updated"}
    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.patch("/sales/{sale_id}")
def update_sale(sale_id: int, data: dict):
    """
    Control-room schedule / access / content editor. House-gated.
    tier is validated STRICTLY so a typo can't silently flip a VIP room to open.
    """
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status FROM auctions WHERE id = %s", (sale_id,))
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] == "ended":
            return {"error": "sale has ended"}

        sets, params = [], []

        if "title" in data:
            t = (data.get("title") or "").strip()
            if not t:
                return {"error": "title cannot be empty"}
            sets.append("title = %s")
            params.append(t)

        if "description" in data:
            sets.append("description = %s")
            params.append(data.get("description") or "")

        if "image_url" in data:
            sets.append("image_url = %s")
            params.append(data.get("image_url") or None)

        if "tier" in data:
            canon = ACCESS_ALIASES.get(str(data.get("tier") or "").strip().lower())
            if canon not in ACCESS_MODES:
                return {"error": "invalid access mode"}
            sets.append("tier = %s")
            params.append(canon)

        if "starts_at" in data:
            sets.append("starts_at = %s")
            params.append(data.get("starts_at") or None)

        if "ends_at" in data:
            sets.append("ends_at = %s")
            params.append(data.get("ends_at") or None)

        if "ticket_price" in data:
            try:
                tp = round(float(data.get("ticket_price") or 0), 2)
            except (TypeError, ValueError):
                return {"error": "invalid ticket_price"}
            if tp < 0:
                return {"error": "ticket_price cannot be negative"}
            sets.append("ticket_price = %s")
            params.append(tp)

        if "ticket_currency" in data:
            sets.append("ticket_currency = %s")
            params.append(_ccy(data.get("ticket_currency")))

        if "currency" in data:
            sets.append("currency = %s")
            params.append(_ccy(data.get("currency")))

        if "ticket_capacity" in data:
            cap, cap_err = _capacity_or_none(data.get("ticket_capacity"))
            if cap_err:
                return {"error": cap_err}
            sets.append("ticket_capacity = %s")
            params.append(cap)

        if not sets:
            return {"error": "nothing to update"}

        params.append(sale_id)
        cursor.execute(
            f"UPDATE auctions SET {', '.join(sets)} WHERE id = %s",
            tuple(params),
        )

        conn.commit()
        return {"message": "sale updated"}
    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/lots")
def add_lot(sale_id: int, data: dict):
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        title = (data.get("title") or "").strip()

        if not host:
            return {"error": "viewer required"}
        if not title:
            return {"error": "title required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status, currency FROM auctions WHERE id = %s", (sale_id,))
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] == "ended":
            return {"error": "sale has ended"}

        cursor.execute(
            "SELECT COALESCE(MAX(position), 0) + 1 AS p FROM lots WHERE sale_id = %s",
            (sale_id,),
        )
        pos = cursor.fetchone()["p"]

        try:
            starting_price = round(float(data.get("starting_price", 0) or 0), 2)
        except (TypeError, ValueError):
            return {"error": "invalid starting_price"}
        if starting_price < 0:
            return {"error": "starting_price cannot be negative"}

        reserve, err = _money_or_none(data.get("reserve"))
        if err:
            return {"error": f"reserve: {err}"}

        estimate_low, err = _money_or_none(data.get("estimate_low"))
        if err:
            return {"error": f"estimate_low: {err}"}

        estimate_high, err = _money_or_none(data.get("estimate_high"))
        if err:
            return {"error": f"estimate_high: {err}"}

        if estimate_low is not None and estimate_high is not None and estimate_high < estimate_low:
            return {"error": "estimate_high cannot be lower than estimate_low"}

        lot_ccy = _ccy(data.get("currency"), _ccy(row["currency"]))

        cursor.execute(
            """
            INSERT INTO lots (
                sale_id, position, title, description, image_url,
                starting_price, reserve, estimate_low, estimate_high, currency
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, position
            """,
            (
                sale_id,
                pos,
                title,
                data.get("description", ""),
                data.get("image_url", ""),
                starting_price,
                reserve,
                estimate_low,
                estimate_high,
                lot_ccy,
            ),
        )

        lot = cursor.fetchone()
        conn.commit()
        return {"lot": lot}
    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()
        cursor.execute(
            """
            SELECT id, host_username, title, description, image_url, tier, status,
                   starts_at::text AS starts_at,
                   ends_at::text AS ends_at,
                   ticket_price::text AS ticket_price,
                   ticket_currency,
                   currency,
                   ticket_capacity,
                   payout_status,
                   settled_at::text AS settled_at,
                   stream_type, stream_url, stream_peer_id
            FROM auctions
            WHERE id = %s
            """,
            (sale_id,),
        )

@router.get("/sales/{sale_id}")
def get_sale(sale_id: int, viewer: str = "", code: str = ""):
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()


        sale = cursor.fetchone()
        if not sale:
            return {"error": "sale not found"}

        acc = auction_access(cursor, sale, viewer)
        if not acc["visible"]:
            return {"error": "this sale is private"}

        is_host = bool(viewer) and viewer == sale["host_username"]

        cursor.execute(
            "SELECT 1 FROM tickets WHERE auction_id = %s AND user_name = %s",
            (sale_id, viewer),
        )
        has_ticket = cursor.fetchone() is not None

        proved = False
        if code:
            cursor.execute(
                "SELECT 1 FROM tickets WHERE auction_id = %s AND code = %s AND user_name = %s",
                (sale_id, code.strip(), viewer),
            )
            proved = cursor.fetchone() is not None

        # Holding a ticket already proves you. Code is only the device-switch
        # escape hatch.
        allowed = is_host or has_ticket or proved
        meta = {**sale, **acc, "is_host": is_host, "has_ticket": has_ticket, "locked": not allowed}

        if not allowed:
            return {"sale": meta, "lots": []}

        cursor.execute(
            """
            SELECT l.id, l.position, l.title, l.description, l.image_url,
                   l.starting_price::text AS starting_price,
                   l.reserve::text AS reserve,
                   l.estimate_low::text AS estimate_low,
                   l.estimate_high::text AS estimate_high,
                   l.currency,
                   l.status,
                   l.sold_price::text AS sold_price,
                   l.winner_username,
                   l.payment_status,
                   l.hammer_at::text AS hammer_at,
                   (SELECT MAX(amount)::text FROM lot_bids b WHERE b.lot_id = l.id) AS current_bid,
                   (SELECT COUNT(*) FROM lot_bids b WHERE b.lot_id = l.id) AS bid_count
            FROM lots l
            WHERE l.sale_id = %s
            ORDER BY l.position
            """,
            (sale_id,),
        )

        lots = cursor.fetchall()
        out_lots = []

        for l in lots:
            d = dict(l)

            # Blind rule: sealed content is omitted for everyone but the host.
            if d["status"] == "sealed" and not is_host:
                out_lots.append({
                    "id": d["id"],
                    "position": d["position"],
                    "status": "sealed",
                })
                continue

            # Reserve is house-sensitive. Never expose it to buyers, even after reveal.
            if not is_host:
                d.pop("reserve", None)

                # Payment status is only meaningful to the host and the winner.
                if d.get("winner_username") != viewer:
                    d.pop("payment_status", None)

            out_lots.append(d)

        return {"sale": meta, "lots": out_lots}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/go_live")
def go_live(sale_id: int, data: dict):
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status FROM auctions WHERE id = %s", (sale_id,))
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] == "ended":
            return {"error": "sale has ended"}
        if row["status"] == "live":
            return {"message": "sale is already live"}

        cursor.execute("UPDATE auctions SET status='live' WHERE id = %s", (sale_id,))
        conn.commit()
        return {"message": "sale is live"}
    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/end")
def end_sale(sale_id: int, data: dict):
    """
    Rostrum 'close sale': stamps ended + ends_at=now.
    Required before settle. Refuses while a lot is still on the block.
    """
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status FROM auctions WHERE id = %s", (sale_id,))
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] == "ended":
            return {"message": "sale already ended"}
        if row["status"] != "live":
            return {"error": "only a live sale can be ended"}

        cursor.execute(
            "SELECT 1 FROM lots WHERE sale_id = %s AND status = 'on_block'",
            (sale_id,),
        )
        if cursor.fetchone():
            return {"error": "hammer or pass the current lot before ending the sale"}

        cursor.execute(
            """
            UPDATE auctions
            SET status = 'ended',
                ends_at = COALESCE(ends_at, CURRENT_TIMESTAMP)
            WHERE id = %s
            """,
            (sale_id,),
        )
        conn.commit()
        return {"message": "sale ended"}
    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/reveal_next")
def reveal_next(sale_id: int, data: dict):
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status FROM auctions WHERE id = %s", (sale_id,))
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] != "live":
            return {"error": "sale is not live"}

        # One lot on the block at a time.
        cursor.execute(
            "SELECT 1 FROM lots WHERE sale_id = %s AND status = 'on_block'",
            (sale_id,),
        )
        if cursor.fetchone():
            return {"error": "hammer or pass the current lot before revealing the next"}

        cursor.execute(
            """
            SELECT id
            FROM lots
            WHERE sale_id = %s AND status = 'sealed'
            ORDER BY position
            LIMIT 1
            """,
            (sale_id,),
        )
        nxt = cursor.fetchone()
        if not nxt:
            return {"error": "no sealed lots left"}

        cursor.execute(
            "UPDATE lots SET status='on_block' WHERE id = %s RETURNING id, position",
            (nxt["id"],),
        )
        lot = cursor.fetchone()
        conn.commit()
        return {"lot": lot}
    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/lots/{lot_id}/hammer")
def hammer_lot(lot_id: int, data: dict):
    """
    Close the on-block lot: SOLD to the top bidder at/above reserve, else PASSED.
    """
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT l.status AS lot_status,
                   l.reserve,
                   a.host_username,
                   a.status AS sale_status
            FROM lots l
            JOIN auctions a ON a.id = l.sale_id
            WHERE l.id = %s
            """,
            (lot_id,),
        )
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["sale_status"] != "live":
            return {"error": "sale is not live"}
        if row["lot_status"] != "on_block":
            return {"error": "lot is not on the block"}

        cursor.execute(
            """
            SELECT user_name, amount
            FROM lot_bids
            WHERE lot_id = %s
            ORDER BY amount DESC, id DESC
            LIMIT 1
            """,
            (lot_id,),
        )
        win = cursor.fetchone()
        reserve = row["reserve"]

        if not win:
            cursor.execute("UPDATE lots SET status='passed' WHERE id = %s", (lot_id,))
            conn.commit()
            return {"message": "passed", "reason": "no bids"}

        top_user, top_amt = win["user_name"], win["amount"]

        if reserve is not None and top_amt < reserve:
            cursor.execute("UPDATE lots SET status='passed' WHERE id = %s", (lot_id,))
            conn.commit()
            return {"message": "passed", "reason": "below reserve", "reserve": str(reserve)}

        cursor.execute(
            """
            UPDATE lots
            SET status = 'sold',
                sold_price = %s,
                winner_username = %s,
                hammer_at = CURRENT_TIMESTAMP
            WHERE id = %s
            """,
            (top_amt, top_user, lot_id),
        )
        conn.commit()
        return {"message": "sold", "sold_price": str(top_amt), "winner": top_user}
    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/lots/{lot_id}/bid")
def bid_on_lot(lot_id: int, data: dict):
    conn = None
    try:
        viewer = (data.get("viewer") or "").strip()
        if not viewer:
            return {"error": "viewer required"}

        try:
            amount = round(float(data.get("amount", 0)), 2)
        except (TypeError, ValueError):
            return {"error": "invalid amount"}

        if amount <= 0:
            return {"error": "bid must be positive"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT l.status AS lot_status,
                   l.sale_id,
                   l.starting_price,
                   l.currency,
                   a.status AS sale_status,
                   a.tier
            FROM lots l
            JOIN auctions a ON a.id = l.sale_id
            WHERE l.id = %s
            """,
            (lot_id,),
        )
        row = cursor.fetchone()
        if not row:
            return {"error": "lot not found"}
        if row["lot_status"] != "on_block":
            return {"error": "this lot is not on the block"}
        if row["sale_status"] != "live":
            return {"error": "the sale is not live"}

        acc = auction_access(cursor, {"id": row["sale_id"], "tier": row["tier"]}, viewer)
        if not acc["can_bid"]:
            return {"error": "you do not have bidding rights here"}

        cursor.execute(
            "SELECT COALESCE(MAX(amount), 0) AS top FROM lot_bids WHERE lot_id = %s",
            (lot_id,),
        )
        top = float(cursor.fetchone()["top"] or 0)
        floor = max(top, float(row["starting_price"] or 0))

        if amount <= floor:
            return {"error": f"bid must exceed {floor}"}

        cursor.execute(
            """
            INSERT INTO lot_bids (lot_id, user_name, amount, currency)
            VALUES (%s, %s, %s, %s)
            RETURNING id
            """,
            (lot_id, viewer, amount, _ccy(row["currency"])),
        )
        bid_id = cursor.fetchone()["id"]
        conn.commit()
        return {"id": bid_id, "amount": amount}
    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/lots/{lot_id}/bids")
def lot_bids_feed(lot_id: int, since: int = 0):
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, user_name, amount::text AS amount, created_at::text AS created_at
            FROM lot_bids
            WHERE lot_id = %s AND id > %s
            ORDER BY id
            """,
            (lot_id, since),
        )
        rows = cursor.fetchall()
        return {"bids": rows}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/enter")
def enter_sale(sale_id: int, data: dict):
    """
    Room entry by paddle code. This is the manual/device-switch path.
    Normal logged-in users can enter through get_sale because has_ticket is enough.
    """
    conn = None
    try:
        viewer = (data.get("viewer") or "").strip()
        code = (data.get("code") or "").strip()

        if not viewer:
            return {"error": "viewer required"}
        if not code:
            return {"error": "paddle code required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute("SELECT host_username, status FROM auctions WHERE id = %s", (sale_id,))
        sale = cursor.fetchone()
        if not sale:
            return {"error": "sale not found"}

        if viewer == sale["host_username"]:
            return {"ok": True}

        cursor.execute(
            "SELECT user_name FROM tickets WHERE auction_id = %s AND code = %s",
            (sale_id, code),
        )
        row = cursor.fetchone()
        if not row:
            return {"error": "That paddle number isn't valid for this room."}
        if row["user_name"] != viewer:
            return {"error": "Tickets are unique to one account."}

        return {"ok": True}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/ticket")
def issue_paddle(sale_id: int, data: dict):
    conn = None
    try:
        viewer = (data.get("viewer") or "").strip()
        if not viewer:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT id, host_username, title, tier, status,
                   ticket_price::text AS ticket_price,
                   ticket_currency,
                   ticket_capacity
            FROM auctions
            WHERE id = %s
            FOR UPDATE
            """,
            (sale_id,),
        )
        row = cursor.fetchone()
        if not row:
            return {"error": "sale not found"}
        if row["status"] == "ended":
            return {"error": "sale has ended"}

        # Host-shill block: a house may not buy a paddle for its own room and
        # bid its own lots.
        if viewer == row["host_username"]:
            return {"error": "houses cannot hold a paddle in their own room"}

        acc = auction_access(cursor, row, viewer)
        if not acc["can_buy_ticket"]:
            return {"error": "you are not permitted to claim a paddle for this sale"}

        cursor.execute(
            "SELECT 1 FROM tickets WHERE auction_id = %s AND user_name = %s",
            (sale_id, viewer),
        )
        if cursor.fetchone():
            return {"error": "you already hold a paddle for this room"}

        cap = row["ticket_capacity"]
        if cap is not None:
            cursor.execute(
                "SELECT COUNT(*)::int AS c FROM tickets WHERE auction_id = %s",
                (sale_id,),
            )
            if cursor.fetchone()["c"] >= int(cap):
                return {"error": "this room is sold out"}

        price = float(row["ticket_price"] or 0)
        ticket_ccy = _ccy(row["ticket_currency"])

        if price > 0:
            # Per-currency debit: a buyer's NGN cannot pay a USD paddle fee.
            ok, err, _ = spend(
                cursor,
                viewer,
                price,
                "ticket_purchase",
                f"Paddle · {row['title']}",
                "auctions",
                sale_id,
                currency=ticket_ccy,
            )
            if not ok:
                return {"error": err}

        code = ""
        for _ in range(6):
            c = f"{secrets.randbelow(900000) + 100000}"
            cursor.execute("SELECT 1 FROM tickets WHERE code = %s", (c,))
            if not cursor.fetchone():
                code = c
                break

        if not code:
            return {"error": "could not mint a paddle, try again"}

        cursor.execute(
            """
            INSERT INTO tickets (auction_id, user_name, code, source)
            VALUES (%s, %s, %s, 'purchased')
            """,
            (sale_id, viewer, code),
        )

        conn.commit()
        return {
            "message": "paddle issued",
            "code": code,
            "price": f"{price:.2f}",
            "currency": ticket_ccy,
            "charged": price > 0,
        }
    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/invite")
def invite_paddle(sale_id: int, data: dict):
    """
    House ISSUES a paddle to a named user.

    Unified issuance: an invited paddle is a ticket row with source='invited',
    price 0 — same credential a purchase mints, so the door treats them identically.
    """
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        target_raw = (data.get("user_name") or "").strip()

        if not host:
            return {"error": "viewer required"}
        if not target_raw:
            return {"error": "user_name required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            "SELECT host_username, title, status FROM auctions WHERE id = %s FOR UPDATE",
            (sale_id,),
        )
        row = cursor.fetchone()
        if not row or row["host_username"] != host:
            return {"error": "not your sale"}
        if row["status"] == "ended":
            return {"error": "sale has ended"}

        cursor.execute("SELECT username FROM users WHERE username = %s", (target_raw,))
        u = cursor.fetchone()
        if not u:
            cursor.execute("SELECT username FROM users WHERE lower(username) = lower(%s)", (target_raw,))
            u = cursor.fetchone()
        if not u:
            return {"error": "unknown user"}

        target = u["username"]
        if target == host:
            return {"error": "cannot invite yourself to your own room"}

        cursor.execute(
            "SELECT 1 FROM tickets WHERE auction_id = %s AND user_name = %s",
            (sale_id, target),
        )
        if cursor.fetchone():
            return {"error": "that user already holds a paddle here"}

        cursor.execute("SELECT ticket_capacity FROM auctions WHERE id = %s", (sale_id,))
        cr = cursor.fetchone()
        cap = cr["ticket_capacity"] if cr else None
        if cap is not None:
            cursor.execute(
                "SELECT COUNT(*)::int AS c FROM tickets WHERE auction_id = %s",
                (sale_id,),
            )
            if cursor.fetchone()["c"] >= int(cap):
                return {"error": "this room is sold out"}

        code = ""
        for _ in range(6):
            c = f"{secrets.randbelow(900000) + 100000}"
            cursor.execute("SELECT 1 FROM tickets WHERE code = %s", (c,))
            if not cursor.fetchone():
                code = c
                break

        if not code:
            return {"error": "could not mint a paddle, try again"}

        cursor.execute(
            """
            INSERT INTO tickets (auction_id, user_name, code, source)
            VALUES (%s, %s, %s, 'invited')
            """,
            (sale_id, target, code),
        )

        create_notification(
            user_name=target,
            category="auctions",
            type="paddle_invited",
            title=f"You're invited to {row['title']}",
            body="The house issued you a paddle for this room.",
            actor=host,
            source_type="sale",
            source_id=sale_id,
            data={"sale_id": sale_id, "code": code},
            cursor=cursor,
        )

        conn.commit()
        return {"message": "paddle issued", "user_name": target, "code": code}
    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


# ---------------------------------------------------------------------------
# Settlement (Flow A, house-net).
#
# settle computes + queues collection; the rail (webhook) moves the money.
# With no Paystack keys, settle still runs fully and leaves lots 'unpaid'
# (collection pending) — developable today.
# ---------------------------------------------------------------------------
def _winner_emails(cursor, winners):
    if not winners:
        return {}
    ph = ",".join(["%s"] * len(winners))
    cursor.execute(f"SELECT username, email FROM users WHERE username IN ({ph})", tuple(winners))
    return {r["username"]: r["email"] for r in cursor.fetchall()}


def _attempt_settle_charges(cursor, sale, won):
    """
    Initiate one Paystack charge per won lot (hammer + premium) for lots not yet paid.

    Returns (initiated, awaiting, outcomes). Safe to call again from /collect once
    keys exist: it only touches unpaid/failed lots, so a paid lot is never re-charged.
    """
    initiated = 0
    awaiting = 0
    outcomes = []

    emails = _winner_emails(cursor, list({w["winner_username"] for w in won}))
    sale_ccy = _ccy(sale["currency"])

    for w in won:
        hammer = float(w["sold_price"] or 0)
        premium = round(hammer * BUYER_PREMIUM_RATE, 2)
        collected = round(hammer + premium, 2)
        commission = round(collected * PLATFORM_COMMISSION_RATE, 2)
        net = round(collected - commission, 2)

        base = {
            "lot_id": w["id"],
            "position": w["position"],
            "winner": w["winner_username"],
            "hammer": f"{hammer:.2f}",
            "premium": f"{premium:.2f}",
            "collected": f"{collected:.2f}",
            "commission": f"{commission:.2f}",
            "net_to_house": f"{net:.2f}",
            "currency": sale_ccy,
        }

        if w.get("payment_status") == "paid":
            outcomes.append({**base, "status": "paid"})
            continue

        email = emails.get(w["winner_username"])
        if not email:
            awaiting += 1
            outcomes.append({**base, "status": "unpaid", "reason": "winner has no email on file"})
            continue

        ref = f"settle_{sale['id']}_{w['id']}_{secrets.token_hex(4)}"

        resp = paystack.initialize_charge(
            email=email,
            amount=collected,
            currency=sale_ccy,
            reference=ref,
            metadata={
                "kind": "settle_charge",
                "sale_id": sale["id"],
                "lot_id": w["id"],
                "winner": w["winner_username"],
                "hammer": base["hammer"],
                "premium": base["premium"],
                "commission": base["commission"],
                "net_to_house": base["net_to_house"],
            },
        )

        if resp.get("status") and (resp.get("data") or {}).get("authorization_url"):
            initiated += 1
            cursor.execute("UPDATE lots SET payment_status='pending' WHERE id = %s", (w["id"],))
            outcomes.append({**base, "status": "pending", "checkout": resp["data"]["authorization_url"]})
        else:
            awaiting += 1
            reason = resp.get("error") or resp.get("message") or "charge not initiated"
            outcomes.append({**base, "status": "unpaid", "reason": reason})

    return initiated, awaiting, outcomes


@router.post("/sales/{sale_id}/settle")
def settle_sale(sale_id: int, data: dict):
    """
    Compute the Flow A house-net split for an ENDED sale, send the notices, and
    queue collection (one charge per won lot).

    Idempotent on the math via settled_at; collection is retried via /collect
    once the rail is configured.

    No consignor, no house-wallet debit — commission is withheld from the payout.
    """
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT id, host_username, title, status, settled_at, currency, ticket_currency
            FROM auctions
            WHERE id = %s
            FOR UPDATE
            """,
            (sale_id,),
        )
        sale = cursor.fetchone()
        if not sale or sale["host_username"] != host:
            return {"error": "not your sale"}
        if sale["status"] != "ended":
            return {"error": "end the sale before settling"}
        if sale["settled_at"] is not None:
            return {"error": "already settled (use /collect to retry payment)"}

        cursor.execute(
            """
            SELECT id, position, sold_price, winner_username, payment_status
            FROM lots
            WHERE sale_id = %s
              AND status = 'sold'
              AND winner_username IS NOT NULL
            ORDER BY position
            """,
            (sale_id,),
        )
        won = [dict(r) for r in cursor.fetchall()]

        if not won:
            cursor.execute(
                "UPDATE auctions SET settled_at = CURRENT_TIMESTAMP, payout_status = 'none' WHERE id = %s",
                (sale_id,),
            )
            conn.commit()
            return {"message": "settled", "lots_sold": 0, "note": "no winning lots"}

        initiated, awaiting, outcomes = _attempt_settle_charges(cursor, sale, won)
        by_lot = {o["lot_id"]: o for o in outcomes}

        hammer_total = round(sum(float(w["sold_price"] or 0) for w in won), 2)
        premium_total = round(sum(float(by_lot[w["id"]]["premium"]) for w in won), 2)
        collected_total = round(sum(float(by_lot[w["id"]]["collected"]) for w in won), 2)
        commission_total = round(sum(float(by_lot[w["id"]]["commission"]) for w in won), 2)
        net_total = round(sum(float(by_lot[w["id"]]["net_to_house"]) for w in won), 2)

        # Notices sent ONCE (guarded by settled_at).
        for w in won:
            o = by_lot[w["id"]]

            if o["status"] == "pending":
                body = (
                    f"Hammer {o['hammer']}. Buyer's premium {o['premium']}. "
                    f"Total {o['collected']} {o['currency']}. "
                    "A secure payment link has been sent to your email."
                )
            elif o["status"] == "paid":
                body = (
                    f"Hammer {o['hammer']}. Buyer's premium {o['premium']}. "
                    f"Total {o['collected']} {o['currency']} — paid."
                )
            else:
                body = (
                    f"Hammer {o['hammer']}. Buyer's premium {o['premium']}. "
                    f"Total {o['collected']} {o['currency']} — payment will be requested shortly."
                )

            create_notification(
                user_name=w["winner_username"],
                category="auctions",
                type="lot_won",
                title=f"You won Lot {w['position']} · {sale['title']}",
                body=body,
                actor=host,
                source_type="sale",
                source_id=sale_id,
                secondary_id=w["id"],
                data={
                    "sale_id": sale_id,
                    "lot_id": w["id"],
                    **{
                        k: o[k]
                        for k in (
                            "hammer",
                            "premium",
                            "collected",
                            "commission",
                            "net_to_house",
                            "currency",
                            "status",
                        )
                    },
                },
                cursor=cursor,
            )

        create_notification(
            user_name=host,
            category="wallet",
            type="settlement_complete",
            title=f"Settlement · {sale['title']}",
            body=(
                f"{len(won)} lots · hammer {hammer_total} · premium {premium_total} · "
                f"collected {collected_total} {_ccy(sale['currency'])} · "
                f"platform commission {commission_total} (withheld from payout) · "
                f"net to house {net_total}. "
                + (
                    f"{initiated} payment link(s) sent; {awaiting} awaiting collection."
                    if initiated
                    else "Collection pending — set Paystack keys, then run /collect."
                )
            ),
            actor=None,
            source_type="sale",
            source_id=sale_id,
            data={
                "sale_id": sale_id,
                "lots_sold": len(won),
                "hammer_total": f"{hammer_total:.2f}",
                "premium_total": f"{premium_total:.2f}",
                "collected_total": f"{collected_total:.2f}",
                "commission_total": f"{commission_total:.2f}",
                "net_to_house": f"{net_total:.2f}",
                "charges_initiated": initiated,
                "awaiting_collection": awaiting,
                "currency": _ccy(sale["currency"]),
            },
            cursor=cursor,
        )

        cursor.execute(
            "UPDATE auctions SET settled_at = CURRENT_TIMESTAMP WHERE id = %s",
            (sale_id,),
        )
        payout_status = _refresh_payout_status(cursor, sale_id)
        conn.commit()

        return {
            "message": "settled",
            "lots_sold": len(won),
            "hammer_total": f"{hammer_total:.2f}",
            "premium_total": f"{premium_total:.2f}",
            "collected_total": f"{collected_total:.2f}",
            "commission_total": f"{commission_total:.2f}",
            "net_to_house": f"{net_total:.2f}",
            "charges_initiated": initiated,
            "awaiting_collection": awaiting,
            "payout_status": payout_status,
            "collection_state": "pending" if initiated else "awaiting_rail",
            "outcomes": outcomes,
        }
    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.post("/sales/{sale_id}/collect")
def collect_sale(sale_id: int, data: dict):
    """
    Retry collection for a settled sale whose lots are still unpaid.

    Example: the first settle ran before Paystack keys existed. This re-attempts
    charges only — it does NOT recompute the split or resend notices.
    """
    conn = None
    try:
        host = (data.get("viewer") or "").strip()
        if not host:
            return {"error": "viewer required"}

        conn = get_db()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT id, host_username, title, status, settled_at, currency, ticket_currency
            FROM auctions
            WHERE id = %s
            FOR UPDATE
            """,
            (sale_id,),
        )
        sale = cursor.fetchone()
        if not sale or sale["host_username"] != host:
            return {"error": "not your sale"}
        if sale["settled_at"] is None:
            return {"error": "settle the sale first"}

        cursor.execute(
            """
            SELECT id, position, sold_price, winner_username, payment_status
            FROM lots
            WHERE sale_id = %s
              AND status = 'sold'
              AND winner_username IS NOT NULL
              AND payment_status IN ('unpaid', 'failed')
            ORDER BY position
            """,
            (sale_id,),
        )
        due = [dict(r) for r in cursor.fetchall()]

        if not due:
            payout_status = _refresh_payout_status(cursor, sale_id)
            conn.commit()
            return {
                "message": "nothing to collect",
                "charges_initiated": 0,
                "awaiting_collection": 0,
                "payout_status": payout_status,
                "outcomes": [],
            }

        initiated, awaiting, outcomes = _attempt_settle_charges(cursor, sale, due)
        payout_status = _refresh_payout_status(cursor, sale_id)
        conn.commit()

        return {
            "message": "collection retried",
            "charges_initiated": initiated,
            "awaiting_collection": awaiting,
            "payout_status": payout_status,
            "outcomes": outcomes,
        }
    except Exception as e:
        if conn:
            conn.rollback()
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()