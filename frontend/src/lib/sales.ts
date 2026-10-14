// ============================================================================
// sales.ts — auction lib. SUPERSET: every original export is kept with its
// original signature/return so existing pages (AuctionsPage, AuctionRoomPage,
// chat.ts via `API`) are untouched. New typed helpers use NEW names
// (getSaleView / fetchSales) so they never collide with the old fetchSale(any).
// ============================================================================

export const API = 'http://localhost:8001'
export const AUCTION_API = 'http://localhost:8001'

// ---- access mode (new canonical union; old `tier` string is kept on Sale) ----
export type AccessMode = 'open' | 'vip' | 'invite'

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
  const key = String(raw ?? 'open').trim().toLowerCase()
  return ACCESS_ALIASES[key] ?? 'open'
}

// ---- statuses ----
// 'passed' ADDED (lot failed reserve / no bids). Additive to the union; if any
// old page had an exhaustive `switch(lot.status)` with a `never` check, add a
// `case 'passed'` there. Low risk, flagged honestly.
export type LotStatus = 'sealed' | 'on_block' | 'sold' | 'passed'
export type SaleStatus = 'upcoming' | 'live' | 'ended'

// ---- Lot (original fields kept; new fields OPTIONAL/additive) ----
export type Lot = {
  id: number
  position: number
  status: LotStatus
  title?: string
  description?: string
  image_url?: string
  starting_price?: string
  sold_price?: string
  current_bid?: string
  bid_count?: number
  // additive (blind/settlement payload the backend now returns)
  reserve?: string | null
  estimate_low?: string | null
  estimate_high?: string | null
  currency?: string
  winner_username?: string | null
  payment_status?: string | null
  hammer_at?: string | null
}

// ---- Sale (original fields kept; new fields OPTIONAL/additive) ----
export type Sale = {
  id: number
  host_username: string
  title: string
  description: string
  image_url?: string
  tier: string                 // kept: old pages read sale.tier directly
  status: SaleStatus
  starts_at: string | null
  ends_at: string | null
  ticket_price: string
  stream_type: string
  stream_url: string
  stream_peer_id: string
  lot_count?: number
  is_host?: boolean
  can_bid?: boolean
  can_buy_ticket?: boolean
  needs_ticket?: boolean
  is_vip?: boolean
  // additive
  access_mode?: AccessMode     // populated by getSaleView/fetchSales normalization
  currency?: string
  ticket_currency?: string
  ticket_capacity?: number | null
  tickets_sold?: number | null
  visible?: boolean
  is_invited?: boolean
  has_ticket?: boolean
  can_watch?: boolean
  locked?: boolean
  payout_status?: string
  settled_at?: string | null
}

export type LotBid = { id: number; user_name: string; amount: string; created_at: string }

// ---- ORIGINAL auction-lib exports (kept verbatim for AuctionsPage etc.) ----
export type AuctionTier = 'open' | 'vip_only' | 'invite_only'
export type AuctionStatus = 'upcoming' | 'live' | 'ended'

export type Auction = {
  id: number
  host_username: string
  title: string
  description: string
  image_url: string
  tier: AuctionTier
  starting_bid: string
  status: AuctionStatus
  starts_at: string | null
  ends_at: string | null
  ticket_price: string
  current_bid: string | null
  bid_count: number
  visible: boolean
  is_vip: boolean
  is_invited: boolean
  has_ticket: boolean
  can_bid: boolean
  needs_ticket: boolean
  can_buy_ticket: boolean
  can_watch: boolean
}

export type BidRow = { id: number; user_name: string; amount: string; created_at: string }

// ---- ORIGINAL functions, ORIGINAL signatures/returns (do not "improve") ----
export async function fetchSale(id: string, viewer: string) {
  const res = await fetch(`${API}/sales/${id}?viewer=${encodeURIComponent(viewer)}`)
  return res.json() // any — old pages rely on this exact shape/typing
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

export async function fetchAuctions(viewer: string): Promise<Auction[]> {
  const res = await fetch(`${AUCTION_API}/auctions?viewer=${encodeURIComponent(viewer)}`)
  const data = await res.json()
  return data.auctions || []
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

export function timeLeft(target: string | null): string {
  if (!target) return ''
  const diff = new Date(target.replace(' ', 'T')).getTime() - Date.now()
  if (diff <= 0) return 'now'
  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff % 86400000) / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// ============================ NEW (typed) helpers ============================
// Used ONLY by the new SaleDetailPage / AuctionFloorPage / components. Old pages
// never import these, so changing them can't regress existing screens.

export type SaleFetch = { sale?: Sale; lots?: Lot[]; error?: string }
export type SalesFetch = { sales?: Sale[]; error?: string }
export type BuyPaddleResult = { message?: string; code?: string; price?: string; currency?: string; charged?: boolean; error?: string }
export type EnterSaleResult = { ok?: boolean; error?: string }
export type PlaceBidResult = { id?: number; amount?: number; error?: string }

export function parseTs(value?: string | null): Date | null {
  if (!value) return null
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const d = new Date(normalized)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatMoney(value: string | number | null | undefined, currency = 'NGN'): string {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
}

function normalizeSale(raw: any): Sale {
  return { ...raw, access_mode: normalizeAccessMode(raw?.access_mode ?? raw?.tier) } as Sale
}

async function jget(path: string): Promise<any> {
  try {
    const res = await fetch(`${API}${path}`)
    return await res.json()
  } catch {
    return { error: 'network error' }
  }
}

async function jpost(path: string, body: unknown): Promise<any> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await res.json()
  } catch {
    return { error: 'network error' }
  }
}

// typed single-sale fetch (normalizes tier -> access_mode)
export async function getSaleView(saleId: number | string, viewer: string, code = ''): Promise<SaleFetch> {
  const p = new URLSearchParams()
  p.set('viewer', viewer)
  if (code) p.set('code', code)
  const d = await jget(`/sales/${saleId}?${p.toString()}`)
  if (d?.error) return { error: d.error }
  return { sale: d.sale ? normalizeSale(d.sale) : undefined, lots: d.lots || [] }
}

// typed sale-list fetch (for the floor, if/when you repoint it)
export async function fetchSales(viewer: string): Promise<SalesFetch> {
  const p = new URLSearchParams()
  p.set('viewer', viewer)
  const d = await jget(`/sales?${p.toString()}`)
  if (d?.error) return { error: d.error }
  const rows: any[] = d?.sales || []
  return { sales: rows.map(normalizeSale) }
}

export async function buyPaddle(saleId: number | string, viewer: string): Promise<BuyPaddleResult> {
  return jpost(`/sales/${saleId}/ticket`, { viewer })
}

export async function enterSale(saleId: number | string, viewer: string, code: string): Promise<EnterSaleResult> {
  return jpost(`/sales/${saleId}/enter`, { viewer, code })
}

export async function placeLotBid(lotId: number, viewer: string, amount: number): Promise<PlaceBidResult> {
  return jpost(`/lots/${lotId}/bid`, { viewer, amount })
}

export type MySale = {
  id: number
  title: string
  status: SaleStatus
  tier: string
  access_mode?: AccessMode

  currency?: string
  ticket_currency?: string
  ticket_price?: string
  ticket_capacity?: number | null

  starts_at?: string | null
  ends_at?: string | null
  settled_at?: string | null
  payout_status?: string

  lot_count?: number
  tickets_sold?: number
}

export type MySalesFetch = {
  sales?: MySale[]
  error?: string
}

export async function fetchMySales(viewer: string): Promise<MySalesFetch> {
  const p = new URLSearchParams()
  p.set('viewer', viewer)

  const d = await jget(`/my_sales?${p.toString()}`)
  if (d?.error) return { error: d.error }

  const rows: any[] = d?.sales || []
  return {
    sales: rows.map(r => ({
      ...r,
      access_mode: normalizeAccessMode(r.access_mode ?? r.tier),
    })),
  }
}

// ---- Section 2: sale mutations (create / edit / stream) ----
export type SaleMutationResult = { id?: number; message?: string; error?: string }

async function jpatch(path: string, body: unknown): Promise<any> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await res.json()
  } catch {
    return { error: 'network error' }
  }
}

// create_sale is POST /sales and accepts image_url + stream_type/stream_url in the
// same body (after the backend fix above), so creation is a single call.
export async function createSale(
  viewer: string,
  payload: Record<string, unknown>,
): Promise<SaleMutationResult> {
  return jpost('/sales', { viewer, ...payload })
}

// update_sale is PATCH /sales/{id}; it ignores stream fields, so stream is a
// separate set_stream call on edit (see below).
export async function updateSale(
  saleId: number | string,
  viewer: string,
  payload: Record<string, unknown>,
): Promise<SaleMutationResult> {
  return jpatch(`/sales/${saleId}`, { viewer, ...payload })
}

// set_stream is POST /sales/{id}/stream and OVERWRITES stream_peer_id, so callers
// must pass the existing peer_id through or it gets blanked. We do that in the form.
export async function setStream(
  saleId: number | string,
  viewer: string,
  payload: { stream_type?: string; stream_url?: string; stream_peer_id?: string },
): Promise<SaleMutationResult> {
  return jpost(`/sales/${saleId}/stream`, { viewer, ...payload })
}

// ---- Section 3: lot mutations ----
export type AddLotPayload = {
  title: string
  description?: string
  image_url?: string
  starting_price: number
  reserve?: number | null
  estimate_low?: number | null
  estimate_high?: number | null
  currency?: string
}

export type AddLotResult = {
  lot?: {
    id: number
    position: number
  }
  error?: string
}

export async function addLot(
  saleId: number | string,
  viewer: string,
  payload: AddLotPayload,
): Promise<AddLotResult> {
  return jpost(`/sales/${saleId}/lots`, { viewer, ...payload })
}