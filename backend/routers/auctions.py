# backend/routers/auctions.py  — full, drop-in
from fastapi import APIRouter
from db import get_db
from helpers import auction_access

router = APIRouter()


@router.get("/auctions")
def list_auctions(viewer: str = ""):
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''SELECT a.id, a.host_username, a.title, a.description, a.image_url, a.tier, a.starting_bid::text AS starting_bid, a.status, a.starts_at::text AS starts_at, a.ends_at::text AS ends_at, a.ticket_price::text AS ticket_price, (SELECT MAX(amount)::text FROM auction_bids b WHERE b.auction_id = a.id) AS current_bid, (SELECT COUNT(*) FROM auction_bids b WHERE b.auction_id = a.id) AS bid_count FROM auctions a ORDER BY a.created_at DESC''')
        rows = cursor.fetchall(); out = []
        for a in rows:
            acc = auction_access(cursor, a, viewer)
            if acc["visible"]: out.append({**a, **acc})
        return {"auctions": out}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()


@router.get("/auctions/{auction_id}")
def get_auction(auction_id: int, viewer: str = ""):
    conn = None
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''SELECT a.id, a.host_username, a.title, a.description, a.image_url, a.tier, a.starting_bid::text AS starting_bid, a.status, a.starts_at::text AS starts_at, a.ends_at::text AS ends_at, a.ticket_price::text AS ticket_price, (SELECT MAX(amount)::text FROM auction_bids b WHERE b.auction_id = a.id) AS current_bid, (SELECT COUNT(*) FROM auction_bids b WHERE b.auction_id = a.id) AS bid_count FROM auctions a WHERE a.id = %s''', (auction_id,))
        row = cursor.fetchone()
        if not row:
            return {"error": "auction not found"}
        acc = auction_access(cursor, row, viewer)
        if not acc["visible"]:
            return {"error": "this auction is private"}
        return {"auction": {**row, **acc}}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn:
            conn.close()