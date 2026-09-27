import secrets

from fastapi import APIRouter
from db import get_db
from helpers import auction_access
from ledger import spend

router = APIRouter()

@router.post("/sales")
def create_sale(data: dict):
    host = data.get("viewer", ""); title = data.get("title", "").strip()
    conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT role FROM users WHERE username = %s", (host,)); u = cursor.fetchone()
    if not u or u["role"] != "house": conn.close(); return {"error": "only accredited houses may open a room"}
    cursor.execute('''INSERT INTO auctions (host_username, title, description, tier, status, starts_at, ticket_price, stream_type, stream_url) VALUES (%s,%s,%s,%s,'upcoming',%s,%s,%s,%s) RETURNING id''', (host, title, data.get("description", ""), data.get("tier", "open"), data.get("starts_at") or None, float(data.get("ticket_price", 0) or 0), data.get("stream_type", "external"), data.get("stream_url", "")))
    sid = cursor.fetchone()["id"]; conn.commit(); conn.close(); return {"id": sid}

@router.get("/my_sales")
def my_sales(viewer: str = ""):
    conn = get_db(); cursor = conn.cursor()
    cursor.execute('''SELECT a.id, a.title, a.status, a.tier, a.starts_at::text AS starts_at, (SELECT COUNT(*) FROM lots l WHERE l.sale_id = a.id) AS lot_count FROM auctions a WHERE a.host_username = %s ORDER BY a.created_at DESC''', (viewer,))
    rows = cursor.fetchall(); conn.close(); return {"sales": rows}

@router.get("/sales")
def list_sales(viewer: str = ""):
    conn = get_db(); cursor = conn.cursor()
    cursor.execute('''
        SELECT a.id, a.host_username, a.title, a.description, a.image_url, a.tier, a.status,
               a.starts_at::text AS starts_at, a.ends_at::text AS ends_at,
               a.ticket_price::text AS ticket_price,
               (SELECT COUNT(*) FROM lots l WHERE l.sale_id = a.id) AS lot_count
        FROM auctions a WHERE a.status IN ('upcoming', 'live', 'ended')
        ORDER BY a.created_at DESC
    ''')  # image_url + ends_at ← added so the floor card can show a poster & a live timer
    rows = cursor.fetchall()
    out = []
    for s in rows:
        acc = auction_access(cursor, s, viewer)
        if acc["visible"]:
            out.append({**s, **acc})
    conn.close()
    return {"sales": out}

@router.post("/sales/{sale_id}/stream")
def set_stream(sale_id: int, data: dict):
    host = data.get("viewer", ""); conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT host_username FROM auctions WHERE id = %s", (sale_id,)); row = cursor.fetchone()
    if not row or row["host_username"] != host: conn.close(); return {"error": "not your sale"}
    cursor.execute("UPDATE auctions SET stream_type=%s, stream_url=%s, stream_peer_id=%s WHERE id=%s", (data.get("stream_type", "external"), data.get("stream_url", ""), data.get("stream_peer_id", ""), sale_id))
    conn.commit(); conn.close(); return {"message": "stream updated"}

@router.post("/sales/{sale_id}/lots")
def add_lot(sale_id: int, data: dict):
    host = data.get("viewer", ""); title = data.get("title", "").strip()
    conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT host_username FROM auctions WHERE id = %s", (sale_id,)); row = cursor.fetchone()
    if not row or row["host_username"] != host: conn.close(); return {"error": "not your sale"}
    cursor.execute("SELECT COALESCE(MAX(position),0)+1 AS p FROM lots WHERE sale_id = %s", (sale_id,)); pos = cursor.fetchone()["p"]
    cursor.execute("INSERT INTO lots (sale_id, position, title, description, image_url, starting_price) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id, position", (sale_id, pos, title, data.get("description", ""), data.get("image_url", ""), float(data.get("starting_price", 0) or 0)))
    lot = cursor.fetchone(); conn.commit(); conn.close(); return {"lot": lot}

@router.get("/sales/{sale_id}")
def get_sale(sale_id: int, viewer: str = "", code: str = ""):
    conn = get_db(); cursor = conn.cursor()
    cursor.execute('''SELECT id, host_username, title, description, tier, status, starts_at::text AS starts_at, ends_at::text AS ends_at, ticket_price::text AS ticket_price, stream_type, stream_url, stream_peer_id FROM auctions WHERE id = %s''', (sale_id,))
    sale = cursor.fetchone()
    if not sale: conn.close(); return {"error": "sale not found"}
    acc = auction_access(cursor, sale, viewer)
    if not acc["visible"]: conn.close(); return {"error": "this sale is private"}
    is_host = viewer == sale["host_username"]

    cursor.execute("SELECT 1 FROM tickets WHERE auction_id = %s AND user_name = %s", (sale_id, viewer))
    has_ticket = cursor.fetchone() is not None
    proved = False
    if code:
        cursor.execute("SELECT 1 FROM tickets WHERE auction_id = %s AND code = %s AND user_name = %s", (sale_id, code.strip(), viewer))
        proved = cursor.fetchone() is not None

    allowed = is_host or proved
    meta = {**sale, **acc, "is_host": is_host, "has_ticket": has_ticket, "locked": not allowed}
    if not allowed:
        conn.close(); return {"sale": meta, "lots": []}   # no catalogue for the unproven

    cursor.execute('''SELECT l.id, l.position, l.title, l.description, l.image_url, l.starting_price::text AS starting_price, l.status, l.sold_price::text AS sold_price, (SELECT MAX(amount)::text FROM lot_bids b WHERE b.lot_id = l.id) AS current_bid, (SELECT COUNT(*) FROM lot_bids b WHERE b.lot_id = l.id) AS bid_count FROM lots l WHERE l.sale_id = %s ORDER BY l.position''', (sale_id,))
    lots = cursor.fetchall(); out_lots = []
    for l in lots:
        if l["status"] == "sealed" and not is_host: out_lots.append({"id": l["id"], "position": l["position"], "status": "sealed"})
        else: out_lots.append(dict(l))
    conn.close(); return {"sale": meta, "lots": out_lots}

@router.post("/sales/{sale_id}/go_live")
def go_live(sale_id: int, data: dict):
    host = data.get("viewer", ""); conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT host_username FROM auctions WHERE id = %s", (sale_id,)); row = cursor.fetchone()
    if not row or row["host_username"] != host: conn.close(); return {"error": "not your sale"}
    cursor.execute("UPDATE auctions SET status='live' WHERE id = %s", (sale_id,)); conn.commit(); conn.close(); return {"message": "sale is live"}

@router.post("/sales/{sale_id}/reveal_next")
def reveal_next(sale_id: int, data: dict):
    host = data.get("viewer", ""); conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT host_username FROM auctions WHERE id = %s", (sale_id,)); row = cursor.fetchone()
    if not row or row["host_username"] != host: conn.close(); return {"error": "not your sale"}
    cursor.execute("SELECT id FROM lots WHERE sale_id = %s AND status = 'sealed' ORDER BY position LIMIT 1", (sale_id,)); nxt = cursor.fetchone()
    if not nxt: conn.close(); return {"error": "no sealed lots left"}
    cursor.execute("UPDATE lots SET status='on_block' WHERE id = %s RETURNING id, position", (nxt["id"],)); lot = cursor.fetchone()
    conn.commit(); conn.close(); return {"lot": lot}

@router.post("/lots/{lot_id}/hammer")
def hammer_lot(lot_id: int, data: dict):
    host = data.get("viewer", ""); conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT l.id, l.starting_price, a.host_username FROM lots l JOIN auctions a ON a.id = l.sale_id WHERE l.id = %s", (lot_id,)); row = cursor.fetchone()
    if not row or row["host_username"] != host: conn.close(); return {"error": "not your sale"}
    cursor.execute("SELECT COALESCE(MAX(amount), starting_price) AS top FROM lot_bids WHERE lot_id = %s", (lot_id,)); top = cursor.fetchone()["top"]
    cursor.execute("UPDATE lots SET status='sold', sold_price=%s WHERE id=%s", (top, lot_id)); conn.commit(); conn.close(); return {"message": "sold", "sold_price": str(top)}

@router.post("/lots/{lot_id}/bid")
def bid_on_lot(lot_id: int, data: dict):
    viewer = data.get("viewer", ""); amount = float(data.get("amount", 0)); conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT l.status AS lot_status, l.sale_id, l.starting_price, a.status AS sale_status, a.tier FROM lots l JOIN auctions a ON a.id = l.sale_id WHERE l.id = %s", (lot_id,)); row = cursor.fetchone()
    if not row: conn.close(); return {"error": "lot not found"}
    if row["lot_status"] != "on_block": conn.close(); return {"error": "this lot is not on the block"}
    if row["sale_status"] != "live": conn.close(); return {"error": "the sale is not live"}
    acc = auction_access(cursor, {"id": row["sale_id"], "tier": row["tier"]}, viewer)
    if not acc["can_bid"]: conn.close(); return {"error": "you do not have bidding rights here"}
    cursor.execute("SELECT COALESCE(MAX(amount),0) AS top FROM lot_bids WHERE lot_id = %s", (lot_id,)); floor = max(float(cursor.fetchone()["top"]), float(row["starting_price"]))
    if amount <= floor: conn.close(); return {"error": f"bid must exceed {floor}"}
    cursor.execute("INSERT INTO lot_bids (lot_id, user_name, amount) VALUES (%s,%s,%s) RETURNING id", (lot_id, viewer, amount)); bid_id = cursor.fetchone()["id"]
    conn.commit(); conn.close(); return {"id": bid_id, "amount": amount}

@router.get("/lots/{lot_id}/bids")
def lot_bids_feed(lot_id: int, since: int = 0):
    conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT id, user_name, amount::text AS amount, created_at::text AS created_at FROM lot_bids WHERE lot_id = %s AND id > %s ORDER BY id", (lot_id, since)); rows = cursor.fetchall()
    conn.close(); return {"bids": rows}

@router.post("/sales/{sale_id}/ticket")
def issue_paddle(sale_id: int, data: dict):
    viewer = data.get("viewer", "")
    if not viewer: return {"error": "viewer required"}
    conn = get_db(); cursor = conn.cursor()
    try:
        cursor.execute("SELECT id, host_username, title, tier, ticket_price::text AS ticket_price FROM auctions WHERE id = %s", (sale_id,))
        row = cursor.fetchone()
        if not row: conn.rollback(); return {"error": "sale not found"}
        acc = auction_access(cursor, row, viewer)
        if not acc["can_buy_ticket"]: conn.rollback(); return {"error": "you are not permitted to claim a paddle for this sale"}
        cursor.execute("SELECT 1 FROM tickets WHERE auction_id = %s AND user_name = %s", (sale_id, viewer))
        if cursor.fetchone(): conn.rollback(); return {"error": "you already hold a paddle for this room"}

        price = float(row["ticket_price"] or 0)
        if price > 0:
            # Atomic debit INSIDE this transaction: if the code-mint below fails,
            # the rollback discards the spend too. No money moves without a paddle.
            ok, err, _ = spend(cursor, viewer, price, "ticket_purchase", f"Paddle · {row['title']}", "auctions", sale_id)
            if not ok: conn.rollback(); return {"error": err}

        code = ""
        for _ in range(6):
            c = f"{secrets.randbelow(900000) + 100000}"
            cursor.execute("SELECT 1 FROM tickets WHERE code = %s", (c,))
            if not cursor.fetchone(): code = c; break
        if not code: conn.rollback(); return {"error": "could not mint a paddle, try again"}

        cursor.execute("INSERT INTO tickets (auction_id, user_name, code) VALUES (%s, %s, %s)", (sale_id, viewer, code))
        conn.commit()
        return {"message": "paddle issued", "code": code, "price": f"{price:.2f}", "charged": price > 0}  # code shown ONCE
    except Exception as e:
        conn.rollback(); return {"error": str(e)}
    finally:
        conn.close()

@router.post("/sales/{sale_id}/enter")
def enter_sale(sale_id: int, data: dict):
    viewer = data.get("viewer", ""); code = (data.get("code") or "").strip()
    if not viewer or not code: return {"error": "viewer and paddle number required"}
    conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT user_name FROM tickets WHERE auction_id = %s AND code = %s", (sale_id, code))
    row = cursor.fetchone(); conn.close()
    if not row: return {"error": "That paddle number isn't valid for this room."}
    if row["user_name"] != viewer: return {"error": "Tickets are unique to one account."}
    return {"ok": True}