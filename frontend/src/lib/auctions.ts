export const AUCTION_API = 'http://localhost:8001'

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

export async function fetchAuctions(viewer: string): Promise<Auction[]> {
  const res = await fetch(`${AUCTION_API}/auctions?viewer=${encodeURIComponent(viewer)}`)
  const data = await res.json()
  return data.auctions || []
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

export type BidRow = { id: number; user_name: string; amount: string; created_at: string }