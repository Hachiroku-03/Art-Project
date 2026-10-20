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
export type LotStatus = 'sealed' | 'on_block' | 'sold' | 'passed'
export type SaleStatus = 'upcoming' | 'live' | 'ended'

// ---- Lot ----
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
  reserve?: string | null
  estimate_low?: string | null
  estimate_high?: string | null
  currency?: string
  winner_username?: string | null
  payment_status?: string | null
  hammer_at?: string | null
}

// ---- Sale ----
export type Sale = {
  id: number
  host_username: string
  title: string
  description: string
  image_url?: string
  tier: string
  status: SaleStatus
  starts_at: string | null
  ends_at: string | null
  ended_at?: string | null
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
  access_mode?: AccessMode
  currency?: string
  ticket_currency?: string
  ticket_capacity?: number | null
  tickets_sold?: number | null
  tickets_remaining?: number | null
  visible?: boolean
  is_invited?: boolean
  has_ticket?: boolean
  can_watch?: boolean
  locked?: boolean
  payout_status?: string
  settled_at?: string | null
}

export type LotBid = {
  id: number
  user_name: string
  amount: string
  created_at: string
  currency?: string
}

// ---- ORIGINAL auction-lib exports (kept verbatim) ----
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
  return res.json()
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
export type SaleFetch = { sale?: Sale; lots?: Lot[]; error?: string }
export type SalesFetch = { sales?: Sale[]; error?: string }

export type BuyPaddleResult = {
  message?: string
  code?: string
  price?: string
  currency?: string
  charged?: boolean
  error?: string
}

export type EnterSaleResult = { ok?: boolean; error?: string }

export type PlaceBidResult = {
  message?: string
  bid?: LotBid
  current_bid?: string
  id?: number
  amount?: number | string
  error?: string
}

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
  return {
    ...raw,
    access_mode: normalizeAccessMode(raw?.access_mode ?? raw?.tier),
  } as Sale
}

// ---------------------------------------------------------------------------
// HARDENED FETCH HELPERS — the lot-save fix lives here.
//
// Old versions returned res.json() unconditionally, so a FastAPI 422 (validation)
// or 500 came back shaped like { detail: [...] } with NO `.error` field. Callers
// that only check `if (r.error)` therefore treated a FAILED save as a SUCCESS and
// closed the form — which is exactly your "lot not saving" symptom. These now
// inspect res.ok and convert 422 detail / 500 HTML into a real { error }.
// ---------------------------------------------------------------------------
function extractError(data: any, status: number): string {
  if (!data) return status ? `server error (${status})` : 'empty response'
  if (typeof data === 'string') return data
  if (data.error) return String(data.error)
  if (data.detail) {
    if (typeof data.detail === 'string') return data.detail
    if (Array.isArray(data.detail)) {
      return data.detail
        .map((d: any) => d?.msg || d?.message || (typeof d === 'string' ? d : JSON.stringify(d)))
        .join('; ')
    }
    return JSON.stringify(data.detail)
  }
  return status ? `request failed (${status})` : 'unknown error'
}

async function jget(path: string): Promise<any> {
  try {
    const res = await fetch(`${API}${path}`)
    const data = await res.json().catch(() => null)
    if (!res.ok) return { error: extractError(data, res.status) }
    return data ?? { error: 'empty response' }
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
    const data = await res.json().catch(() => null)
    if (!res.ok) return { error: extractError(data, res.status) }
    return data ?? { error: 'empty response' }
  } catch {
    return { error: 'network error' }
  }
}

async function jpatch(path: string, body: unknown): Promise<any> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) return { error: extractError(data, res.status) }
    return data ?? { error: 'empty response' }
  } catch {
    return { error: 'network error' }
  }
}

export async function getSaleView(saleId: number | string, viewer: string, code = ''): Promise<SaleFetch> {
  const p = new URLSearchParams()
  p.set('viewer', viewer)
  if (code) p.set('code', code)
  const d = await jget(`/sales/${saleId}?${p.toString()}`)
  if (d?.error) return { error: d.error }
  return { sale: d.sale ? normalizeSale(d.sale) : undefined, lots: d.lots || [] }
}

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
  tickets_sold?: number | null
  tickets_remaining?: number | null
  starts_at?: string | null
  ends_at?: string | null
  ended_at?: string | null
  settled_at?: string | null
  payout_status?: string
  lot_count?: number
}

export type MySalesFetch = { sales?: MySale[]; error?: string }

export async function fetchMySales(viewer: string): Promise<MySalesFetch> {
  const p = new URLSearchParams()
  p.set('viewer', viewer)
  const d = await jget(`/my_sales?${p.toString()}`)
  if (d?.error) return { error: d.error }
  const rows: any[] = d?.sales || []
  return { sales: rows.map(r => ({ ...r, access_mode: normalizeAccessMode(r.access_mode ?? r.tier) })) }
}

// ---- Section 2: sale mutations ----
export type SaleMutationResult = { id?: number; message?: string; error?: string }

export async function createSale(viewer: string, payload: Record<string, unknown>): Promise<SaleMutationResult> {
  return jpost('/sales', { viewer, ...payload })
}

export async function updateSale(saleId: number | string, viewer: string, payload: Record<string, unknown>): Promise<SaleMutationResult> {
  return jpatch(`/sales/${saleId}`, { viewer, ...payload })
}

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
  lot?: { id: number; position: number; title?: string; status?: string; currency?: string }
  error?: string
}

// GUARDED: a NaN saleId or empty viewer used to POST to /sales/NaN/lots and come
// back as a 422 that the old jpost swallowed -> silent "save". Now it fails loud.
export async function addLot(saleId: number | string, viewer: string, payload: AddLotPayload): Promise<AddLotResult> {
  const sid = Number(saleId)
  if (!Number.isFinite(sid) || sid <= 0) {
    return { error: 'missing or invalid sale id — the lot was NOT saved' }
  }
  if (!String(viewer || '').trim()) {
    return { error: 'no signed-in house detected — the lot was NOT saved' }
  }
  return jpost(`/sales/${sid}/lots`, { viewer, ...payload })
}

export type UpdateLotPayload = {
  title?: string
  description?: string
  image_url?: string | null
  starting_price?: number | null
  reserve?: number | null
  estimate_low?: number | null
  estimate_high?: number | null
  currency?: string
}

export type UpdateLotResult = {
  lot?: { id: number; position: number; title?: string; status?: string; currency?: string }
  message?: string
  error?: string
}

export async function updateLot(lotId: number | string, viewer: string, payload: UpdateLotPayload): Promise<UpdateLotResult> {
  const lid = Number(lotId)
  if (!Number.isFinite(lid) || lid <= 0) {
    return { error: 'missing or invalid lot id — changes were NOT saved' }
  }
  if (!String(viewer || '').trim()) {
    return { error: 'no signed-in house detected — changes were NOT saved' }
  }
  return jpatch(`/lots/${lid}`, { viewer, ...payload })
}

export type DeleteLotResult = { message?: string; lot_id?: number; error?: string }

export async function deleteLot(lotId: number | string, viewer: string): Promise<DeleteLotResult> {
  return jpost(`/lots/${lotId}/delete`, { viewer })
}

// ---- Section 4: entry / paddles ----
export type Paddle = {
  id: number
  user_name: string
  source: string
  code_masked?: string | null
  purchased_at?: string | null
  role?: string | null
  tier?: string | null
  display_name?: string | null
  avatar_url?: string | null
  won_lots?: number
  won_total?: string | null
}

export type PaddlesFetch = {
  paddles?: Paddle[]
  capacity?: number | null
  sold?: number
  status?: string
  error?: string
}

export type InvitePaddleResult = { message?: string; user_name?: string; code?: string; error?: string }

export async function fetchPaddles(saleId: number | string, viewer: string): Promise<PaddlesFetch> {
  const p = new URLSearchParams()
  p.set('viewer', viewer)
  return jget(`/sales/${saleId}/paddles?${p.toString()}`)
}

export async function invitePaddle(saleId: number | string, viewer: string, userName: string): Promise<InvitePaddleResult> {
  return jpost(`/sales/${saleId}/invite`, { viewer, user_name: userName })
}

// ---- Section 5: rostrum / live ----
export type RostrumActionResult = {
  message?: string
  lot?: { id: number; position: number }
  sold_price?: string
  winner?: string
  reason?: string
  error?: string
}

export async function goLive(saleId: number | string, viewer: string): Promise<RostrumActionResult> {
  return jpost(`/sales/${saleId}/go_live`, { viewer })
}
export async function revealNext(saleId: number | string, viewer: string): Promise<RostrumActionResult> {
  return jpost(`/sales/${saleId}/reveal_next`, { viewer })
}
export async function hammerLot(lotId: number | string, viewer: string): Promise<RostrumActionResult> {
  return jpost(`/lots/${lotId}/hammer`, { viewer })
}
export async function passLot(lotId: number | string, viewer: string): Promise<RostrumActionResult> {
  return jpost(`/lots/${lotId}/pass`, { viewer })
}
export async function endSale(saleId: number | string, viewer: string): Promise<RostrumActionResult> {
  return jpost(`/sales/${saleId}/end`, { viewer })
}

// ---- Section 6: settlement ----
export type SettlementLot = {
  id: number
  position: number
  title?: string | null
  sold_price?: string | null
  winner_username?: string | null
  payment_status?: string | null
  hammer_at?: string | null
  currency?: string | null
  hammer?: string
  premium?: string
  collected?: string
  commission?: string
  net_to_house?: string
}

export type SettlementSale = {
  id: number
  host_username: string
  title: string
  status: string
  currency?: string | null
  ticket_currency?: string | null
  settled_at?: string | null
  ended_at?: string | null
  payout_status?: string | null
  payout_reference?: string | null
}

export type SettlementTotals = {
  hammer_total?: string
  premium_total?: string
  collected_total?: string
  commission_total?: string
  net_to_house?: string
  currency?: string
}

export type SettlementCounts = { paid: number; pending: number; unpaid: number; failed: number }

export type SettlementView = {
  sale?: SettlementSale
  lots?: SettlementLot[]
  totals?: SettlementTotals
  counts?: SettlementCounts
  settled?: boolean
  collection_state?: string
  rates?: { buyer_premium_rate?: number; platform_commission_rate?: number }
  error?: string
}

export type SettleOutcome = {
  lot_id: number
  position: number
  winner: string
  hammer: string
  premium: string
  collected: string
  commission: string
  net_to_house: string
  currency: string
  status: string
  reason?: string
  checkout?: string
}

export type SettleResult = {
  message?: string
  lots_sold?: number
  hammer_total?: string
  premium_total?: string
  collected_total?: string
  commission_total?: string
  net_to_house?: string
  charges_initiated?: number
  awaiting_collection?: number
  payout_status?: string
  collection_state?: string
  outcomes?: SettleOutcome[]
  error?: string
}

export async function fetchSettlement(saleId: number | string, viewer: string): Promise<SettlementView> {
  const p = new URLSearchParams()
  p.set('viewer', viewer)
  return jget(`/sales/${saleId}/settlement?${p.toString()}`)
}
export async function settleSale(saleId: number | string, viewer: string): Promise<SettleResult> {
  return jpost(`/sales/${saleId}/settle`, { viewer })
}
export async function collectSale(saleId: number | string, viewer: string): Promise<SettleResult> {
  return jpost(`/sales/${saleId}/collect`, { viewer })
}

// ---- Section 7: payout / settings ----
export type HousePayoutProfile = {
  user_name: string
  business_name?: string | null
  bank_code?: string | null
  account_number?: string | null
  account_name?: string | null
  currency?: string | null
  paystack_subaccount_code?: string | null
  paystack_recipient_code?: string | null
  status?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export type HousePayoutFetch = { profile?: HousePayoutProfile | null; error?: string }
export type HousePayoutSaveResult = { message?: string; profile?: HousePayoutProfile | null; error?: string }
export type SalePayoutView = SettlementView & { payout_profile?: HousePayoutProfile | null }
export type MarkPayoutPaidResult = { message?: string; payout_status?: string; payout_reference?: string | null; error?: string }

export async function fetchHousePayout(viewer: string): Promise<HousePayoutFetch> {
  const p = new URLSearchParams()
  p.set('viewer', viewer)
  return jget(`/house/payout?${p.toString()}`)
}
export async function saveHousePayout(
  viewer: string,
  payload: {
    business_name: string
    bank_code: string
    account_number: string
    account_name: string
    currency: string
    paystack_subaccount_code?: string | null
    paystack_recipient_code?: string | null
  },
): Promise<HousePayoutSaveResult> {
  return jpost('/house/payout', { viewer, ...payload })
}
export async function fetchSalePayout(saleId: number | string, viewer: string): Promise<SalePayoutView> {
  const p = new URLSearchParams()
  p.set('viewer', viewer)
  return jget(`/sales/${saleId}/payout?${p.toString()}`)
}
export async function markPayoutPaid(saleId: number | string, viewer: string, reference?: string): Promise<MarkPayoutPaidResult> {
  return jpost(`/sales/${saleId}/payout/mark_paid`, { viewer, reference: reference || '' })
}

// ---- Won lots / payment status ----
export type WonLot = {
  lot_id: number
  position: number
  lot_title?: string | null
  lot_description?: string | null
  lot_image_url?: string | null
  hammer: string
  premium: string
  collected: string
  currency: string
  payment_status: 'paid' | 'pending' | 'unpaid' | 'failed' | string
  checkout_url?: string | null
  payment_reference?: string | null
  payment_updated_at?: string | null
  hammered_at?: string | null
  sale_id: number
  sale_title: string
  host_username: string
  sale_status: string
  settled_at?: string | null
}

export type WonLotsSummary = {
  count: number
  total_hammer: string
  total_premium: string
  total_collected: string
  total_paid: string
  total_outstanding: string
  currency: string
}

export type WonLotsResponse = {
  lots?: WonLot[]
  summary?: WonLotsSummary
  rates?: { buyer_premium_rate?: number }
  error?: string
}

export async function fetchWonLots(viewer: string): Promise<WonLotsResponse> {
  const p = new URLSearchParams()
  p.set('viewer', viewer)
  return jget(`/my/won-lots?${p.toString()}`)
}