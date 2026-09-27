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

    cursor.execute("ALTER TABLE posts ADD COLUMN IF NOT EXISTS images JSONB DEFAULT '[]'")
    cursor.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS code TEXT")
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_sale_user ON tickets (auction_id, user_name)")
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_code ON tickets (code)")

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

    # ---- STORY INTERACTIONS (mirror the likes/comments grain) ----
    # story_likes: composite PK, no serial id — the PK itself rejects a double-like,
    # closing the race the app-level SELECT-then-INSERT toggle can't. Matches likes.
    cursor.execute('''CREATE TABLE IF NOT EXISTS story_likes (
        story_id INTEGER REFERENCES stories(id) ON DELETE CASCADE,
        user_name TEXT,
        PRIMARY KEY (story_id, user_name)
    )''')

    # story_comments: keeps id + created_at because the endpoint returns the id and
    # orders by time. Matches comments (minus kind/parent_id, which stories don't need).
    cursor.execute('''CREATE TABLE IF NOT EXISTS story_comments (
        id SERIAL PRIMARY KEY,
        story_id INTEGER REFERENCES stories(id) ON DELETE CASCADE,
        user_name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # The money ledger — append-only, balance = SUM(amount). Created in BOTH
    # init_db() calls (here + auth_server) so either server can boot first.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS ledger_entries (
            id SERIAL PRIMARY KEY,
            user_name TEXT NOT NULL,
            amount NUMERIC(12,2) NOT NULL,
            kind TEXT NOT NULL,
            reference TEXT,
            ref_table TEXT,
            ref_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entries (user_name, created_at DESC)")

    # VIP subscription — the TRUTH for "is this member VIP right now". users.tier is
    # only a display cache, re-synced by _sweep_vip() in auth_server. user_name TEXT
    # with no FK, matching likes/follows/tickets/ledger (schema-wide convention).
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS vip_subscriptions (
            user_name TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'active',          -- active | past_due | cancelled
            price NUMERIC(12,2) NOT NULL DEFAULT 0,         -- locked at signup; env changes don't touch existing subs
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            renews_at TIMESTAMP NOT NULL,
            cancelled_at TIMESTAMP,                         -- set = "stop at period end", access continues until renews_at
            last_charged_at TIMESTAMP,
            periods_paid INTEGER NOT NULL DEFAULT 0,
            failure_reason TEXT
        )
    ''')

        # ============ CHAT (1:1 + groups, websocket-delivered) ============
    # A conversation is 'direct' (exactly 2 members, pair_key set & unique) or
    # 'group' (N members, pair_key NULL — Postgres unique indexes treat NULLs as
    # distinct, so many groups coexist). Members live in chat_members.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_conversations (
            id SERIAL PRIMARY KEY,
            kind TEXT NOT NULL DEFAULT 'direct',          -- direct | group
            name TEXT,                                     -- group name; NULL for direct
            image_url TEXT,                                -- group avatar; NULL for direct
            pair_key TEXT,                                 -- 'a|b' sorted for direct; NULL for group
            created_by TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # No duplicate 1:1 rooms, enforced at the DB (races included). Groups skip this
    # entirely because their pair_key is NULL and NULLs never collide in a unique index.
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_direct_pair ON chat_conversations (pair_key) WHERE pair_key IS NOT NULL")

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_members (
            conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',           -- owner | member
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (conversation_id, user_name)
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_name)")

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_messages (
            id BIGSERIAL PRIMARY KEY,
            conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            sender TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'text',             -- text | image | voice
            body TEXT NOT NULL,                            -- text, or uploaded URL for image/voice
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages (conversation_id, id DESC)")

    # Per-member read cursor. Unread = messages with id > last_read_id and sender != me.
    # Kept separate from messages so sending never mutates history and reads never
    # fabricate activity.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_reads (
            conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            last_read_id BIGINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (conversation_id, user_name)
        )
    ''')

    cursor.execute("ALTER TABLE chat_reads ADD COLUMN IF NOT EXISTS last_delivered_id BIGINT NOT NULL DEFAULT 0")

    conn.commit()
    conn.close()