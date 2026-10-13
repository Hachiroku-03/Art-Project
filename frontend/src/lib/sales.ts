// ============================================================================
// sales.ts — CANONICAL auction model: a house-hosted SALE of sequential, BLIND
// lots. One lot is on the block at a time; sealed lots have their content
// (title/description/image/estimate/reserve) OMITTED by the backend until they
// reach on_block. Live bidding happens on the on-block lot only.
//
// Access modes (open | vip | invite) govern WHO may be issued a paddle. The
// paddle governs ENTRY. Lots govern BIDDING. Settlement governs MONEY. Four
// separate layers — never collapse them.
//
// IMPORTANT: every per-viewer flag here (can_bid, has_paddle, access_mode,
// is_vip) is ADVISORY for rendering the UI. The real gate is the backend at
// issuance/entry/bid. A wrong flag degrades UX; it cannot grant access.
// ============================================================================

export const API = 'http://localhost:8001'

// ---- canonical access mode (the thing that separates open / vip / invite) ----
export type AccessMode = 'open' | 'vip' | 'invite'

// The two lib files (and possibly the backend) spell these inconsistently
// ('vip_only' vs 'vip', 'invite_only' vs 'invite'). Normalize at the boundary
// so downstream code speaks ONE language. Unknown -> 'open' is safe because
// entry is still enforced server-side at paddle issuance.
const ACCESS_ALIASES: Record<string, AccessMode> = {
  open: 'open',
  vip: 'vip',
  vip_only: 'vip',
  'vip-only': 'vip',
  invite: 'invite',
  invite_only: 'invite',
  'invite-only': 'invite',
}

export function normalizeAccessMode(raw: unknown): AccessMode {
  const k = String(raw ?? 'open').trim().toLowerCase()
  return ACCESS_ALIASES[k] ?? 'open'
}

// Single enum that drives the ticket-page CTA, so pages switch on ONE field
// instead of re-deriving from five booleans.
export type AccessReason =
  | 'ok'              // may buy / already holds a paddle
  | 'vip_required'    // sale is a VIP room, viewer is not VIP
  | 'not_invited'     // invite-only sale, viewer holds no issued paddle
  | 'sold_out'        // capacity reached
  | 'ended'           // sale over

// ASSUMPTION (verify against the sale page + sales.py): I read Sale.is_vip as
// "the VIEWER is a VIP" (matching the per-viewer can_* convention), and
// access_mode === 'vip' as "the SALE is a VIP room". If your backend means the
// opposite, flip these two — it is the one semantic I had to guess.
export function deriveAccessReason(sale: Sale, viewerIsVip: boolean): AccessReason {
  if (sale.status === 'ended') return 'ended'
  if (sale.has_paddle) return 'ok'
  if (sale.access_mode === 'invite') return 'not_invited'
  if (sale.access_mode === 'vip' && !viewerIsVip) return 'vip_required'
  if (
    sale.ticket_capacity != null &&
    sale.tickets_sold != null &&
    sale.tickets_sold >= sale.ticket_capacity
  )
    return 'sold_out'
  return 'ok'
}

// ---- lots: sequential + blind ----
// 'passed' added (lot failed reserve / no bids). Backend may not send it yet;
// the union just allows it.
export type LotStatus = 'sealed' | 'on_block' | 'sold' | 'passed'

export type Lot = {
  id: number
  position: number
  status: LotStatus
  // Content below is SERVER-OMITTED while status === 'sealed'. Never render
  // these without lotContentVisible(lot) — a sealed lot returns undefined here.
  title?: string
  description?: string
  image_url?: string
  estimate_low?: string
  estimate_high?: string
  reserve?: string
  // Pricing / state (present once on_block or after)
  starting_price?: string
  sold_price?: string
  current_bid?: string
  bid_count?: number
}

// The blind rule, made explicit: sealed = content hidden, even the description.
export function lotContentVisible(lot: Lot): boolean {
  return lot.status === 'on_block' || lot.status === 'sold' || lot.status === 'passed'
}

export type SaleStatus = 'upcoming' | 'live' | 'ended'

export type Sale = {
  id: number
  host_username: string
  title: string
  description: string
  image_url?: string
  // 'tier' KEPT for back-compat (existing components read it). New code reads
  // access_mode, which fetchSale populates by normalizing tier. Rename the DB
  // column to access_mode later to kill the users.tier vs auctions.tier clash.
  tier: string
  access_mode: AccessMode
  status: SaleStatus
  starts_at: string | null
  ends_at: string | null
  ticket_price: string
  ticket_currency?: string
  ticket_capacity?: number | null   // null = unlimited
  tickets_sold?: number
  stream_type: string
  stream_url: string
  stream_peer_id: string
  lot_count?: number
  // per-viewer (advisory; backend enforces)
  is_host?: boolean
  is_vip?: boolean                  // VIEWER is a VIP (see assumption above)
  can_bid?: boolean
  can_buy_ticket?: boolean
  needs_ticket?: boolean
  has_paddle?: boolean
  paddle_code?: string | null       // only when has_paddle && in room context
  access_reason?: AccessReason      // derived at fetch if backend doesn't send it
}

export type LotBid = { id: number; user_name: string; amount: string; created_at: string }

function normalizeSale(raw: any): Sale | null {
  if (!raw || typeof raw !== 'object') return raw ?? null
  const access_mode = normalizeAccessMode(raw.access_mode ?? raw.tier)
  const out: Sale = { ...raw, access_mode }
  if (!out.access_reason) out.access_reason = deriveAccessReason(out, !!raw.is_vip)
  return out
}

// Envelope auto-detect: preserves whatever shape your page already expects
// ({ sale: {...} } stays wrapped; a bare sale stays bare; errors pass through).
// If your envelope uses a key other than 'sale', tell me / paste the page and
// I'll fold normalization in safely.
export async function fetchSale(id: string, viewer: string) {
  const res = await fetch(`${API}/sales/${id}?viewer=${encodeURIComponent(viewer)}`)
  const d = await res.json()
  if (d && typeof d === 'object' && d.sale && typeof d.sale === 'object') {
    return { ...d, sale: normalizeSale(d.sale) }
  }
  if (d && typeof d === 'object' && !d.error) return normalizeSale(d)
  return d
}

export async function fetchLotBids(lotId: number, since: number = 0): Promise<LotBid[]> {
  try {
    const res = await fetch(`${API}/lots/${lotId}/bids?since=${since}`)
    const data = await res.json()
    return data.bids || []
  } catch {
    return []
  }
}

export function formatRemaining(diffMs: number): string {
  if (diffMs <= 0) return 'now'
  const totalSec = Math.floor(diffMs / 1000)
  const d = Math.floor(totalSec / 86400)
  const h = Math.floor((totalSec % 86400) / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (d >= 1) return `${d}d ${h}h`
  if (h >= 1) return `${h}h ${m}m`
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

// ===========================================================================
// PROVISIONAL MUTATIONS — DO NOT TRUST UNTIL VERIFIED AGAINST sales.py.
// These two follow the clearest pattern from the proven GETs above
// (GET /lots/{id}/bids -> POST same path; GET /sales/{id} -> POST /sales/{id}/ticket),
// but I have NOT seen the routers, so the exact verb / URL / payload / auth
// (viewer vs token) are extrapolations. Paste sales.py and I'll correct them.
// ===========================================================================

// Live bid on the ON-BLOCK lot only. Server must reject if lot.status !== 'on_block'.
export async function placeLotBid(lotId: number, userName: string, amount: string) {
  const res = await fetch(`${API}/lots/${lotId}/bids`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_name: userName, amount }),
  })
  return res.json()
}

// Buy a paddle for an open/vip sale. Server enforces access_mode + capacity +
// VIP status + payment; this just triggers it. Invite-only sales have NO buy.
export async function buyPaddle(saleId: number | string, viewer: string) {
  const res = await fetch(`${API}/sales/${saleId}/ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewer }),
  })
  return res.json()
}

// ===========================================================================
// NOT WRITTEN (payloads I can't guess safely) — rostrum / control-room writes.
// These are the heart of the blind model and need sales.py to shape:
//   POST /sales/{id}/lots/next        -> advance block: prev lot sold/passed,
//                                        next lot on_block (atomic; relies on
//                                        the one-on-the-block DB invariant)
//   POST /lots/{id}/hammer            -> knock down at current bid -> sold
//   POST /lots/{id}/pass              -> no sale -> passed
//   POST /sales/{id}/lots             -> catalogue create (sealed by default)
//   PATCH /lots/{id}                  -> edit sealed lot content (house only)
// Each must be house/rostrum-gated and must reveal content only via on_block.
// ===========================================================================