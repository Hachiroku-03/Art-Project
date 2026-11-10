# The Space

> Contemporary art · social gallery · live auction floor.

Artists hang work on a wall. Accredited houses run live sales. Every paddle
raised is a real bid, and every naira lands in an append-only ledger you can
read.

A production-grade marketplace split into three deployable units:

| Unit | Tech | Default port | Owns |
|------|------|--------------|------|
| **Frontend** | Vite · React · TypeScript · react-three-fiber · GSAP | `5173` | Landing, feed, auction room, control room, wallet, admin |
| **Auth service** | FastAPI · psycopg2 | `8000` | Signup/login/Google/face, profile, settings, house accreditation, wallet ledger, VIP, `/me`, admin console |
| **Core backend** | FastAPI · psycopg2 | `8001` | Feed, posts, auctions, lots, rostrum, paddles/tickets, settlement, Paystack, webhooks, notifications |

Both Python services share **one PostgreSQL database** (Neon) and **one ledger
table**. They are separate processes so they can scale and deploy independently,
but the money rules must stay byte-identical between them (see *Ledger parity*).

---

## Features

### Social gallery
- Feed of works at their real proportions, artist-first labelling (medium · size · year).
- Follow, keep, studio stories (24h), messenger, notifications.
- Auto-translation of descriptions, applied in the background so the feed paints first.

### Live auction floor
- Houses open sales with an access mode: `open` · `vip` · `invite`.
- Sealed catalogue — lots stay hidden until a paddle is presented at the door.
- Six-digit paddle minted per room; paid rooms debit the wallet in the same breath.
- Rostrum: go live → reveal → bid → hammer / pass → end → settle → payout.
- Bid ledger refreshes ~1.5s; reopen a passed lot; revert a mis-hammered sold lot (pre-settlement only).

### Money
- Append-only ledger: balances are **sums of entries**, never mutable columns.
- Multi-currency (NGN default), advisory-locked per `account|currency`.
- Buyer pays `hammer + premium`; platform withholds `commission`; house gets net.
- Paystack rail (server-to-server) + offline collection marking for high-value lots.
- House payout processor: mock/test mode (default) or live Paystack transfer.

### Membership
- Free Member tier; monthly VIP billed from the Space Wallet.
- Lazy VIP sweep on sign-in / wallet / pricing — no scheduler, never mid-room.

### Admin console
- Env-gated control room: overview, houses, users, moderation, sales, system.

---

## Tech stack

**Frontend**
- React 18 + TypeScript, Vite
- react-router-dom
- three · @react-three/fiber · @react-three/drei (WebGL hero + corridor)
- gsap + ScrollTrigger (pinned scroll sections)
- lucide-react

**Backend**
- FastAPI + Uvicorn
- psycopg2 (PostgreSQL)
- python-dotenv
- stdlib `urllib` for Google tokeninfo (no PyJWT/requests dependency)

**Data / infra**
- Neon (PostgreSQL)
- Render (frontend static + two backend web services)
- Paystack (charges + transfers, server-to-server only)

---

## Prerequisites

- Node 18+
- Python 3.11+ (the code uses `list[float] | None` union syntax)
- A Neon PostgreSQL project (or any Postgres 14+)
- Paystack account (optional for local dev — settlement runs without keys)
- Google Cloud OAuth client ID (optional — for Sign in with Google)

---

## Quick start

### 0. Database

Create a Neon project and copy the connection string. Both services run
`init_db()` on boot and create/migrate their own tables idempotently, so you do
**not** hand-create schema — just point both services at the same `DATABASE_URL`.

```
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxx.neon.tech/neondb?sslmode=require
```

### 1. Auth service (port 8000)

```bash
cd backend-auth            # wherever auth_server.py lives
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install fastapi uvicorn psycopg2-binary python-dotenv
cp .env.example .env       # fill DATABASE_URL, ADMIN_USERNAMES, etc.
python auth_server.py      # or: uvicorn auth_server:app --reload --port 8000
```

Health check:

```bash
curl http://localhost:8000/health
# {"ok":true,"service":"auth","port":8000}
```

### 2. Core backend (port 8001)

```bash
cd backend                 # wherever main.py / routers/ lives
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env       # fill DATABASE_URL, Paystack keys, FRONTEND_URL, etc.
uvicorn main:app --reload --port 8001
```

### 3. Frontend

```bash
cd frontend
npm install
cp .env.example .env       # VITE_AUTH_API_URL, VITE_FEED_API_URL
npm run dev                # http://localhost:5173
```

Sign up, then visit `/admin` while logged in as a username listed in
`ADMIN_USERNAMES`.

---

## Environment variables

### Auth service (8000) — `backend-auth/.env`

```env
DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require

# Admins for the console + house approvals. Comma-separated usernames.
# This is the ONLY source of admin truth — there is no admins table.
ADMIN_USERNAMES=coura

VIP_PRICE=20                  # monthly, NGN-denominated if your wallet is NGN
WALLET_TOPUP_CAP=10000        # dev/mock single top-up ceiling
FACE_THRESHOLD=0.363          # cosine similarity cutoff for face login

GOOGLE_CLIENT_ID=             # public id only; credential/ID-token flow, no secret

ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
ALLOW_CREDENTIALS=true
PORT=8000
```

### Core backend (8001) — `backend/.env`

```env
DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require

BUYER_PREMIUM_RATE=0.15
PLATFORM_COMMISSION_RATE=0.10
ENDED_FLOOR_RETENTION_HOURS=72

FRONTEND_URL=http://localhost:5173
PAYSTACK_CALLBACK_URL=${FRONTEND_URL}/wins?payment=completed

PAYSTACK_SECRET_KEY=sk_test_...        # consumed by paystack.py
PAYSTACK_MAX_CHARGE_NGN=10000000       # online card ceiling; 0 disables guard
MAX_AUCTION_AMOUNT=1000000000000       # hard input ceiling

# false (default) = mock payout, no real transfer.
# true  = live Paystack transfer, needs a funded + KYC account and a house
#         payout profile with a BT_ recipient code.
PAYSTACK_TRANSFERS_ENABLED=false

PORT=8001
```

### Frontend — `frontend/.env`

```env
VITE_AUTH_API_URL=http://localhost:8000
VITE_FEED_API_URL=http://localhost:8001

# Optional frontend-only admin fallback for local testing only.
# Leave empty in production; real gating is backend ADMIN_USERNAMES.
VITE_ADMIN_USERNAMES=
```

---

## Project structure

```
.
├── frontend/
│   ├── src/
│   │   ├── auth/                # LoginPage, SignupPage (the only things in auth/)
│   │   ├── pages/               # FeedPage, AuctionRoomPage, ControlRoomPage,
│   │   │   ├── landing/         #   LandingPage + its section tree
│   │   │   ├── AdminPage.tsx    #   requires viewer + isAdmin props (see AdminRoute)
│   │   │   └── ...
│   │   ├── components/          # Navbar, PostCard, admin/*, auctions/*, feed/*
│   │   ├── scene/               # CorridorScene, HeroScene, Painting, works.ts
│   │   ├── art/                 # a0..a6.jpg — IMPORTED & bundled (single source)
│   │   ├── lib/                 # config, session, feed, translate, sales, motion
│   │   └── App.tsx              # routes + AdminRoute wrapper
│   └── package.json
│
├── backend-auth/
│   └── auth_server.py           # port 8000: auth/profile/wallet/VIP/admin
│
└── backend/
    ├── main.py                  # port 8001: app + router mounting
    ├── db.py                    # get_db()
    ├── ledger.py                # spend/credit/balance_of — MUST match auth ledger
    ├── paystack.py              # server-to-server Paystack client
    ├── helpers.py               # auction_access (visibility/bidding gates)
    ├── notification_service.py  # create_notification
    └── routers/
        ├── sales.py             # auction/settlement/buyer-payment router
        ├── webhooks.py          # POST /webhooks/paystack (canonical)
        └── ...                  # feed, posts, community, etc.
```

> **Path gotcha:** `LandingPage` lives in `src/pages/` (with its `src/pages/landing/`
> tree), **not** `src/auth/`. Only the login/signup pages are in `auth/`.

---

## How money works (the rules that must not drift)

### Ledger parity across 8000 and 8001
Both processes write the same `ledger_entries` table. To avoid double-spend they
serialize on a Postgres advisory lock keyed by `f"{account}|{currency}"`.

- The lock-key formula and currency filtering in `auth_server.py` **must be
  byte-identical** to `backend/ledger.py`.
- Do **not** "optimize" this back to a `users`-row `FOR UPDATE` — that breaks
  cross-process serialization.
- Holder accounts `__escrow__` and `__platform_revenue__` have no users row and
  are exempt from the existence check.

### Append-only
Balances are `SUM(amount)`. Money is never edited — only added to. A reversal is
a new opposite-sign entry, never a `DELETE`.

### Paystack boundary
The browser must **never** call `https://api.paystack.co` directly (it is
Cloudflare-protected server-to-server; a direct call returns "Why have I been
blocked?").

```
frontend → backend → paystack.py → Paystack
backend stores checkout_url + payment_reference
buyer opens the backend-returned checkout_url
Paystack → backend webhook (POST /webhooks/paystack)
backend verifies signature → marks lot paid
frontend reads payment_status from backend
```

A pull-path safety net exists at `POST /my/won-lots/{id}/verify` for
delayed/lost webhooks: the backend re-verifies the reference server-to-server
and applies `apply_charge_success` idempotently.

### Settlement math (Flow A, house-net)
```
buyer pays platform  = hammer + premium
platform commission  = collected × PLATFORM_COMMISSION_RATE
net to house         = collected − commission
```
Commission is withheld from the house payout; the house needs no funded wallet
to settle. Offline-collected lots never touched escrow, so they contribute
nothing to the payout ledger split — correctly, because the platform never held
that money.

---

## Admin access

There is **no `admins` table**. Admin identity is the `ADMIN_USERNAMES` env set:

```python
def _is_admin(viewer: str) -> bool:
    return bool(viewer) and viewer in ADMIN_USERNAMES
```

`/me` returns `is_admin` so the frontend can gate the console:

```json
{ "username": "coura", "role": "artist", "is_admin": true, ... }
```

The frontend `AdminRoute` in `App.tsx` reads `/me`, passes `viewer` + `isAdmin`
into `AdminPage`, and redirects logged-out users to `/login`. The frontend flag
is convenience; **the backend `_is_admin` check on every `/admin/*` route is the
authority.**

To add an admin: edit `ADMIN_USERNAMES` (comma-separated) and redeploy the auth
service. Env vars do not hot-reload.

---

## Database schema (created by `init_db()`)

| Table | Owner | Purpose |
|-------|-------|---------|
| `users` | auth | identity, role (`artist`/`house`), tier, face embedding |
| `profiles` | auth | display_name, bio, avatar/banner, language, extra JSONB |
| `house_applications` | auth | accreditation requests (pending/approved/rejected/revoked) |
| `ledger_entries` | shared | append-only money, multi-currency |
| `vip_subscriptions` | auth | monthly membership, renews_at, periods_paid |
| `house_payout_profiles` | backend | bank details / Paystack recipient for payouts |
| `auctions` | backend | sales: status, tier, currency, ticketing, settlement stamps |
| `lots` | backend | catalogue: position, prices, status, winner, payment_status |
| `lot_bids` | backend | bid ledger per lot |
| `tickets` | backend | paddles (purchased/invited), six-digit codes |
| `posts` / `post_reports` / `follows` | backend | feed + moderation + social graph |
| `notifications` | backend | in-app notices |

`init_db()` is idempotent and includes `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
migrations, so restarting against an existing DB is safe.

---

## Performance notes (the things that actually bite on Render)

### Images
- Artwork is imported from `src/art/` so Vite bundles + hashes it (immutable
  cache). **Do not** also keep a `public/art/` copy — that ships raw, unhashed,
  and doubles the payload.
- Compress source files to ≤1600px wide, quality ~80, or convert to `.webp`:
  ```bash
  cd frontend
  npx sharp-cli -i "src/art/*.jpg" -o src/art --format webp --quality 80 --resize 1600
  # then update the 7 imports in works.ts (and poster imports) to .webp
  ```
  sharp-cli operations are flags (`--resize`, `--format`, `--quality`); a bare
  positional `resize 1600` is ignored. Run from `frontend/`, not the repo root.
- The WebGL corridor (7 textures) is gated behind an IntersectionObserver so it
  only loads when `#gallery` approaches the viewport; the hero loads one texture
  on first paint.

### FeedPage
Requests are parallelized and the preloader stops as soon as `/feed` arrives.
Translation, avatar, and stories load in the background. Language is cached in
`localStorage` so repeat visits don't wait on `/settings`.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `column "unpaid" does not exist` on lot revert/reopen | `sales.py` used `payment_status = unpaid` (unquoted = column name) or `= NULL` (violates NOT NULL). Use `payment_status = 'unpaid'`. |
| `/me` 404 or no `is_admin` | Auth service not booted, or `/me` lacks the `is_admin` field. Confirm `ADMIN_USERNAMES` is set and the service restarted. |
| `/admin` shows Restricted / `{"error":"admin only"}` | Username not in `ADMIN_USERNAMES`, or frontend not sending `?viewer=`. Env doesn't hot-reload — redeploy. |
| "Why have I been blocked?" on payment | Frontend called `api.paystack.co` directly. It must go through the backend. |
| Feed preloader slow | Was blocking on translation/`/settings`. Use the parallelized version; check `/feed` response time + image sizes in DevTools → Network. |
| Tables missing in Neon | Wrong DB/branch, or `init_db()` crashed before commit. Check backend logs for `DATABASE_URL missing` / connection errors. |
| YouTube embed shows "Unable to execute JavaScript" | A bare `/embed`, private, or embedding-disabled video. Only iframe real `youtube.com/embed/<id>`; the external fallback link covers the rest. |
| CORS error with credentials | Never `allow_origins=["*"]` + `allow_credentials=True`. Use explicit `ALLOWED_ORIGINS`. |
| `No input files` from sharp-cli | Ran from repo root instead of `frontend/`, or missing `--` on operations. |

---

## Scripts

```bash
# Frontend
npm run dev          # local dev
npm run build        # production build
npm run preview      # preview the build

# Auth service
python auth_server.py
python -m py_compile auth_server.py    # syntax check

# Core backend
uvicorn main:app --reload --port 8001
```

---

## Deployment (Render)

1. **Neon** — one project; both services use the same `DATABASE_URL`.
2. **Backend 8001** — Render Web Service, build `pip install -r requirements.txt`,
   start `uvicorn main:app --port 8001`. Set all 8001 env vars.
3. **Backend 8000** — second Web Service, start `python auth_server.py`. Set all
   8000 env vars.
4. **Frontend** — Static Site, build `npm run build`, publish `dist`. Set
   `VITE_AUTH_API_URL` / `VITE_FEED_API_URL` to the deployed backend URLs, and
   `ALLOWED_ORIGINS` on both backends to the deployed frontend URL.
5. Set `PAYSTACK_TRANSFERS_ENABLED=false` until the account is funded + KYC'd.

---

## Security

- Passwords: PBKDF2-HMAC-SHA256, 100k iterations, per-user salt.
- Google ID tokens verified server-side (aud/iss/exp/verified-email enforced);
  cross-app replay blocked by the audience check.
- Admin is env-gated and re-checked on **every** `/admin/*` route; the frontend
  flag is UX only.
- The browser never holds Paystack secrets and never calls Paystack directly.
- Escrow debits are capped by collections via advisory-locked `spend()`.
- CORS uses explicit origins, never `*` with credentials.

---

## License

Proprietary — The Space. All works remain the property of their makers.