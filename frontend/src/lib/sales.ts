export const API = 'http://localhost:8001'

export type LotStatus = 'sealed' | 'on_block' | 'sold'

// A sale's status is one of three things — not any string. This is the fix.
export type SaleStatus = 'upcoming' | 'live' | 'ended'

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
}

export type Sale = {
  id: number
  host_username: string
  title: string
  description: string
  image_url?: string            // floor poster (SaleCard renders it)
  tier: string
  status: SaleStatus            // ← was `string`; now the closed union
  starts_at: string | null
  ends_at: string | null        // live "hammer in…" target
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
}

export type LotBid = { id: number; user_name: string; amount: string; created_at: string }

export async function fetchSale(id: string, viewer: string) {
  const res = await fetch(`${API}/sales/${id}?viewer=${encodeURIComponent(viewer)}`)
  return res.json()
}

export async function fetchLotBids(lotId: number, since: number = 0): Promise<LotBid[]> {
  try {
    const res = await fetch(`${API}/lots/${lotId}/bids?since=${since}`)
    const data = await res.json()
    return data.bids || []
  } catch { return [] }
}

// Smart countdown for the floor tiles: far = "3d 14h", near = "2h 14m",
// imminent = "14:33" ticking. Never "313 Days".
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