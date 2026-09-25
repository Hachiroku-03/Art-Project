import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL missing — check your .env file")

def get_db():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)

def init_db():
    conn = get_db()
    cursor = conn.cursor()

    # ============ FEED TABLES ============
    cursor.execute('''CREATE TABLE IF NOT EXISTS posts (id SERIAL PRIMARY KEY, author_id INTEGER REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL, title TEXT NOT NULL, description TEXT, image_url TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    cursor.execute("ALTER TABLE posts ADD COLUMN IF NOT EXISTS price TEXT")

    cursor.execute('''CREATE TABLE IF NOT EXISTS likes (post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE, user_name TEXT, PRIMARY KEY (post_id, user_name))''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS comments (id SERIAL PRIMARY KEY, post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE, user_name TEXT, body TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    cursor.execute("ALTER TABLE comments ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'text'")
    cursor.execute("ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE")

    cursor.execute('''CREATE TABLE IF NOT EXISTS comment_likes (comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE, user_name TEXT, PRIMARY KEY (comment_id, user_name))''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS follows (follower TEXT, followee TEXT, PRIMARY KEY (follower, followee))''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS bids (id SERIAL PRIMARY KEY, post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE, user_name TEXT, amount NUMERIC(12,2), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

    # ============ AUCTION TABLES (Legacy Floor) ============
    cursor.execute('''CREATE TABLE IF NOT EXISTS auctions (id SERIAL PRIMARY KEY, host_username TEXT NOT NULL, title TEXT NOT NULL, description TEXT, image_url TEXT, tier TEXT NOT NULL DEFAULT 'open', starting_bid NUMERIC(12,2) DEFAULT 0, status TEXT NOT NULL DEFAULT 'upcoming', starts_at TIMESTAMP, ends_at TIMESTAMP, ticket_price NUMERIC(12,2) DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS stream_type TEXT DEFAULT 'external'")
    cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS stream_url TEXT DEFAULT ''")
    cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS stream_peer_id TEXT DEFAULT ''")

    cursor.execute('''CREATE TABLE IF NOT EXISTS invitations (id SERIAL PRIMARY KEY, auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE, user_name TEXT NOT NULL, UNIQUE (auction_id, user_name))''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS tickets (id SERIAL PRIMARY KEY, auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE, user_name TEXT NOT NULL, purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE (auction_id, user_name))''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS auction_bids (id SERIAL PRIMARY KEY, auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE, user_name TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

    # ============ SALES TABLES (Live Broadcast System) ============
    cursor.execute('''CREATE TABLE IF NOT EXISTS lots (id SERIAL PRIMARY KEY, sale_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE, position INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, image_url TEXT, starting_price NUMERIC(12,2) DEFAULT 0, status TEXT NOT NULL DEFAULT 'sealed', sold_price NUMERIC(12,2), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS lot_bids (id SERIAL PRIMARY KEY, lot_id INTEGER REFERENCES lots(id) ON DELETE CASCADE, user_name TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS bookmarks (
            post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
            user_name TEXT,
            PRIMARY KEY (post_id, user_name)
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS stories (
            id SERIAL PRIMARY KEY,
            user_name TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'image',
            body TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP NOT NULL
        )
    ''')

    conn.commit()
    conn.close()