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
            description TEXT,                              -- group description
            pair_key TEXT,                                 -- 'a|b' sorted for direct; NULL for group
            created_by TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS description TEXT")
    cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP")

    # No duplicate 1:1 rooms, enforced at the DB (races included). Groups skip this
    # entirely because their pair_key is NULL and NULLs never collide in a unique index.
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_direct_pair ON chat_conversations (pair_key) WHERE pair_key IS NOT NULL")

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_members (
            conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',           -- owner | admin | member
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
            kind TEXT NOT NULL DEFAULT 'text',             -- text | image | voice | file | video | location | contact | system
            body TEXT NOT NULL,                            -- text, or uploaded URL for media, or structured payload for location/contact
            reply_to_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL,
            forwarded_from_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL,
            meta JSONB NOT NULL DEFAULT '{}'::jsonb,       -- file_name, file_size, mime_type, duration, lat/lng, caption, etc.
            edited_at TIMESTAMP,
            deleted_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL")
    cursor.execute("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS forwarded_from_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL")
    cursor.execute("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb")
    cursor.execute("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP")
    cursor.execute("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP")

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages (conversation_id, id DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_reply ON chat_messages (reply_to_id) WHERE reply_to_id IS NOT NULL")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_forwarded ON chat_messages (forwarded_from_id) WHERE forwarded_from_id IS NOT NULL")

    # Per-member read cursor. Unread = messages with id > last_read_id and sender != me.
    # Kept separate from messages so sending never mutates history and reads never
    # fabricate activity.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_reads (
            conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            last_read_id BIGINT NOT NULL DEFAULT 0,
            last_delivered_id BIGINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (conversation_id, user_name)
        )
    ''')

    cursor.execute("ALTER TABLE chat_reads ADD COLUMN IF NOT EXISTS last_delivered_id BIGINT NOT NULL DEFAULT 0")

    # ============ MESSENGER FEATURE SCHEMA ============

    # Delete for me: hides a message from one user's view without deleting it globally.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_message_hidden (
            message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            hidden_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (message_id, user_name)
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_hidden_user ON chat_message_hidden (user_name)")

    # Starred / saved messages, private per user.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_starred_messages (
            message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            starred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (message_id, user_name)
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_starred_user ON chat_starred_messages (user_name, starred_at DESC)")

    # Emoji reactions.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_reactions (
            message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            emoji TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (message_id, user_name, emoji)
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_reactions_message ON chat_reactions (message_id)")

    # Drafts per user per conversation.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_drafts (
            conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (conversation_id, user_name)
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_drafts_user ON chat_drafts (user_name)")

    # Per-user conversation preferences: archive, mute, pin, mark unread, last opened.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_conversation_prefs (
            conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            archived BOOLEAN NOT NULL DEFAULT FALSE,
            muted BOOLEAN NOT NULL DEFAULT FALSE,
            pinned BOOLEAN NOT NULL DEFAULT FALSE,
            pinned_at TIMESTAMP,
            muted_until TIMESTAMP,
            last_opened_at TIMESTAMP,
            mark_unread BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (conversation_id, user_name)
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_prefs_user ON chat_conversation_prefs (user_name)")

    # User blocks. For MVP, blocking disables direct messaging both ways.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_blocks (
            blocker TEXT NOT NULL,
            blocked TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (blocker, blocked)
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_blocks_blocked ON chat_blocks (blocked)")

    # Reports for moderation. target_type can be message | conversation | user.
    # target_id is used for message/conversation ids; target_text is used for usernames.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_reports (
            id SERIAL PRIMARY KEY,
            reporter TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id BIGINT,
            target_text TEXT,
            reason TEXT NOT NULL,
            details TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            reviewed_at TIMESTAMP
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_reports_reporter ON chat_reports (reporter, created_at DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_reports_status ON chat_reports (status, created_at DESC)")

    # Presence / last seen.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_presence (
            user_name TEXT PRIMARY KEY,
            online BOOLEAN NOT NULL DEFAULT FALSE,
            last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # In-app notifications. Browser push is deferred; this powers the bell/notification center.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_notifications (
            id SERIAL PRIMARY KEY,
            user_name TEXT NOT NULL,
            conversation_id INTEGER REFERENCES chat_conversations(id) ON DELETE CASCADE,
            message_id BIGINT REFERENCES chat_messages(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            title TEXT,
            body TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            read_at TIMESTAMP
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_notifications_user ON chat_notifications (user_name, created_at DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chat_notifications_unread ON chat_notifications (user_name, read_at, created_at DESC)")

    # ============ COMMUNITY / NOTIFICATIONS / SETTINGS (added by the calls +
    # notification slices; idempotent, matches the no-FK-on-user_name + naive
    # TIMESTAMP house convention above) ============

    # Groups gained community metadata (discover + list_conversations read these).
    cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS join_mode TEXT NOT NULL DEFAULT 'request'")
    cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS allow_member_invites BOOLEAN NOT NULL DEFAULT FALSE")
    cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS announce_new_members BOOLEAN NOT NULL DEFAULT FALSE")
    cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS category TEXT")
    cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS scene TEXT")
    cursor.execute("ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb")

    # Group join requests (request/approve/reject/cancel).
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS group_join_requests (
            id SERIAL PRIMARY KEY,
            group_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',          -- pending | approved | rejected | cancelled
            message TEXT,
            reviewed_by TEXT,
            reviewed_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (group_id, user_name)
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_gjr_group_status ON group_join_requests (group_id, status)")

    # Unified in-app notification center (bell / dropdown / page / sweep).
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            user_name TEXT NOT NULL,
            category TEXT NOT NULL,                           -- messages | mentions | groups | posts | auctions | calls | wallet | security | system
            type TEXT NOT NULL,
            actor TEXT,
            source_type TEXT,                                 -- conversation | post | comment | sale | lot | call ...
            source_id INTEGER,
            secondary_id INTEGER,
            title TEXT NOT NULL,
            body TEXT,
            data JSONB NOT NULL DEFAULT '{}'::jsonb,
            read_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_name, created_at DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_name, read_at, created_at DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_notifications_source ON notifications (source_type, source_id)")

    # Per-user settings: language + notification/auction/privacy prefs (the PATCH contract).
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS user_settings (
            user_name TEXT PRIMARY KEY,
            language TEXT NOT NULL DEFAULT 'en',
            notifications JSONB NOT NULL DEFAULT '{}'::jsonb,
            auctions JSONB NOT NULL DEFAULT '{}'::jsonb,
            privacy JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # Community open calls / events.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS community_calls (
            id SERIAL PRIMARY KEY,
            host_user_name TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'open_call',           -- exhibition | residency | consignment | open_call | award | talk | studio_visit | deadline
            title TEXT NOT NULL,
            description TEXT,
            cover_url TEXT,
            scene TEXT,
            location TEXT,
            online BOOLEAN NOT NULL DEFAULT FALSE,
            starts_at TIMESTAMP,
            ends_at TIMESTAMP,
            deadline_at TIMESTAMP,
            status TEXT NOT NULL DEFAULT 'open',              -- open | closed | cancelled
            eligibility JSONB NOT NULL DEFAULT '{}'::jsonb,
            apply_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_community_calls_status_deadline ON community_calls (status, deadline_at)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_community_calls_host ON community_calls (host_user_name)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_community_calls_scene ON community_calls (scene) WHERE scene IS NOT NULL")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_community_calls_kind ON community_calls (kind)")

    # Saved / "remind me" interest in a call.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS call_interest (
            id SERIAL PRIMARY KEY,
            call_id INTEGER NOT NULL REFERENCES community_calls(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (call_id, user_name)
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_call_interest_user ON call_interest (user_name, created_at DESC)")

    # Deadline-reminder idempotency key (one row per call/user/window).
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS call_reminders (
            id SERIAL PRIMARY KEY,
            call_id INTEGER NOT NULL REFERENCES community_calls(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            window_days INTEGER NOT NULL,                     -- 7 | 3 | 1
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (call_id, user_name, window_days)
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_call_reminders_call ON call_reminders (call_id, window_days)")

        # ============ MULTI-CURRENCY + ESCROW-READY LEDGER FOUNDATION (Phase 1.1) ============
    # Every money column gains a currency (ISO 4217, default NGN). Balances are
    # PER-CURRENCY (see ledger.py): a user holding NGN 50,000 and USD 200 has two
    # independent balances and can never spend one from the other. No in-app FX —
    # conversion happens only at the processor (Paystack) when a wallet is topped
    # up. Holder accounts (__platform_revenue__, __escrow__) are recorded in
    # ledger_entries like any account but have NO users row; ledger.py serializes
    # them by advisory lock instead. This one schema serves E2-now (Paystack split
    # at charge, recorded here) AND E1-later (true hold/release via __escrow__)
    # without a rewrite — that's the whole point of laying it now.

    # --- currency on existing money columns (additive, default NGN) ---
    cursor.execute("ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")
    cursor.execute("ALTER TABLE bids ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")
    cursor.execute("ALTER TABLE auction_bids ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")
    cursor.execute("ALTER TABLE lot_bids ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")
    cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")
    cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")          # sale/lot currency
    cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS ticket_currency TEXT NOT NULL DEFAULT 'NGN'")  # paddle-fee currency
    cursor.execute("ALTER TABLE vip_subscriptions ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'NGN'")

    # --- settlement / blind-lot columns (folded from the un-applied earlier pass;
    #     orthogonal to currency, required by the final corrected sales.py) ---
    cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS winner_username TEXT")
    cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS reserve NUMERIC(12,2)")
    cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS estimate_low NUMERIC(12,2)")
    cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS estimate_high NUMERIC(12,2)")
    cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS hammer_at TIMESTAMP")
    cursor.execute("ALTER TABLE lots ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'")  #-- unpaid|paid|refunded (E2 chase path)
    cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS ticket_capacity INTEGER")                    #-- null = unlimited
    cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS settled_at TIMESTAMP")
    cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS payout_status TEXT NOT NULL DEFAULT 'none'")  #-- none|pending|paid|failed
    cursor.execute("ALTER TABLE auctions ADD COLUMN IF NOT EXISTS payout_reference TEXT")
    cursor.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'purchased'")     #purchased|invited|complimentary|void
    # NOTE: lots.status is plain TEXT with no CHECK, so the new 'passed' value
    # (lot failed reserve / no bids) needs no migration — the corrected hammer writes it directly.

    # --- invariants ---
    # exactly ONE lot on the block per sale: the blind sequential rule, race-safe.
    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_one_lot_on_block ON lots (sale_id) WHERE status = 'on_block'")
    # per-currency balance lookups + reveal/hammer scans
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_ledger_acct_cur ON ledger_entries (user_name, currency, created_at DESC)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_lots_sale_status ON lots (sale_id, status)")

    # --- payment-event idempotency (webhook replay-safe; the Paystack rail writes here) ---
    # A replayed charge.success must never double-credit a wallet. UNIQUE(provider,
    # event_id) is the gate: the rail inserts and only proceeds if the insert wins.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS payment_events (
            id SERIAL PRIMARY KEY,
            provider TEXT NOT NULL,                 -- paystack
            event_id TEXT NOT NULL,                 -- provider reference / notification id
            type TEXT NOT NULL,                     -- charge.success | transfer.success | ...
            account TEXT,                           -- user or holder the event affects
            currency TEXT,
            amount NUMERIC(12,2),
            reference TEXT,                         -- our metadata (topup id, sale_id, ...)
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            processed_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (provider, event_id)
        )
    ''')
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_payment_events_account ON payment_events (account, created_at DESC)")

    conn.commit()
    conn.close()

    # ============ HOUSE PAYOUT PROFILE ============
    # Stores the house's payout destination. This is not a wallet. It is the
    # bank/subaccount information used later for real payouts.
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS house_payout_profiles (
            user_name TEXT PRIMARY KEY,
            business_name TEXT,
            bank_code TEXT,
            account_number TEXT,
            account_name TEXT,
            currency TEXT NOT NULL DEFAULT 'NGN',
            paystack_subaccount_code TEXT,
            paystack_recipient_code TEXT,
            status TEXT NOT NULL DEFAULT 'draft',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_house_payout_status ON house_payout_profiles (status)")