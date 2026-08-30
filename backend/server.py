from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import json
from deep_translator import GoogleTranslator
import uvicorn
import sqlite3
from pathlib import Path # 👈 NEW: For foolproof file paths

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# 1. DATABASE SETUP
# ==========================================
def init_db():
    conn = sqlite3.connect('gallery.db')
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            artwork_id INTEGER,
            author TEXT,
            text TEXT,
            parent_id INTEGER,
            timestamp TEXT,
            likes INTEGER DEFAULT 0
        )
    ''')
    conn.commit()
    conn.close()

init_db()

# ==========================================
# 2. HTTP ENDPOINTS
# ==========================================
@app.get("/comments")
def get_comments(artwork_id: int):
    conn = sqlite3.connect('gallery.db')
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM comments WHERE artwork_id = ? ORDER BY id ASC", (artwork_id,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

@app.post("/translate")
async def translate_text(request: dict):
    text = request.get("text", "")
    target_lang = request.get("target", "en")
    
    if not text or target_lang == "en":
        return {"original": text, "translated": text}
        
    try:
        translated = GoogleTranslator(source='auto', target=target_lang).translate(text)
        return {"original": text, "translated": translated}
    except Exception as e:
        print(f"❌ Translation error: {e}")
        return {"original": text, "translated": text}

# ==========================================
# 3. WEBSOCKET ENDPOINT
# ==========================================
connected_clients = set()
current_highest_bid = 1000
LANG_MAP = {"en": "en", "fr": "fr", "es": "es", "ja": "ja", "zh": "zh-CN", "ar": "ar", "de": "de"}
client_languages = {} 

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global current_highest_bid
    await websocket.accept()
    connected_clients.add(websocket)
    client_languages[websocket] = "en" 
    print(f"✅ Client connected! Total: {len(connected_clients)}")

    try:
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)

            if "user_lang" in data:
                client_languages[websocket] = LANG_MAP.get(data.get("user_lang", "en"), "en")

            if data.get("type") == "bid":
                item = data.get("item")
                price_str = data.get("price")
                try:
                    new_price = int(price_str)
                except (ValueError, TypeError):
                    await websocket.send_text("ERROR: Invalid price format.")
                    continue

                if new_price > current_highest_bid:
                    current_highest_bid = new_price
                    broadcast_msg = f"Alert🚨 NEW BID: ${new_price} on '{item}'!"
                    for client in connected_clients:
                        await client.send_text(broadcast_msg)
                else:
                    await websocket.send_text(f"ERROR: Bid must be higher than ${current_highest_bid}!")

            elif data.get("type") == "chat":
                artwork_id = data.get("artwork_id")
                author = data.get("author")
                original_text = data.get("message")
                parent_id = data.get("parent_id")
                timestamp = data.get("timestamp")
                
                sender_lang = LANG_MAP.get(data.get("user_lang", "en"), "en")

                if artwork_id is None or not original_text:
                    continue

                conn = sqlite3.connect('gallery.db')
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO comments (artwork_id, author, text, parent_id, timestamp, likes)
                    VALUES (?, ?, ?, ?, ?, 0)
                ''', (artwork_id, author, original_text, parent_id if parent_id != "null" else None, timestamp))
                
                real_comment_id = cursor.lastrowid 
                conn.commit()
                conn.close()

                for client in connected_clients:
                    if client == websocket:
                        continue 
                    
                    target_lang = client_languages.get(client, "en")
                    translated_text = original_text 
                    
                    if target_lang != sender_lang:
                        try:
                            translated_text = GoogleTranslator(source='auto', target=target_lang).translate(original_text)
                        except Exception:
                            pass

                    broadcast_msg = f"COMMENT_NEW|{artwork_id}|{real_comment_id}|{author}|{parent_id}|{timestamp}|{translated_text}"
                    await client.send_text(broadcast_msg)

            elif data.get("type") == "like":
                artwork_id = data.get("artwork_id")
                comment_id = data.get("comment_id")
                likes = data.get("likes")
                liked = str(data.get("liked")).lower()

                broadcast_msg = f"COMMENT_LIKE|{artwork_id}|{comment_id}|{likes}|{liked}"
                for client in connected_clients:
                    if client != websocket:
                        await client.send_text(broadcast_msg)

    except WebSocketDisconnect:
        print("❌ A visitor just left the gallery.")
    finally:
        connected_clients.remove(websocket)
        if websocket in client_languages:
            del client_languages[websocket]
        print(f"👋 Client disconnected. Total: {len(connected_clients)}")

# ==========================================
# 4. SERVE FRONTEND FILES (FOOLPROOF)
# ==========================================
# This finds the exact folder containing server.py, then goes up one level to the root
BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")

if __name__ == "__main__":
    print("🚀 Starting FastAPI server with SQLite Database...")
    uvicorn.run(app, host="0.0.0.0", port=8000)