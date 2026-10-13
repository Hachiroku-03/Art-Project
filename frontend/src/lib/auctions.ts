// ============================================================================
// auctions.ts — LEGACY whole-event model: one bid stream per AUCTION
// (current_bid / bid_count), no sequential lots. This is the frontend mirror of
// auctions + auction_bids in db.py.
//
// Your agreed model is the SEQUENTIAL BLIND LOT model in sales.ts. This file is
// therefore NOT the canonical path. I have kept it (you said do not retire open
// access, and single-piece quick auctions may still be a real product need) but
// it is marked for consolidation: once you confirm whether whole-event auctions
// are real or vestigial, we either (a) delete it and point the floor at sales.ts,
// or (b) keep it as a second sale type and align its paddle/settlement semantics
// so "sale" and "auction" don't drift into two incompatible money paths.
//
// The ACCESS MODE (open | vip | invite) is preserved here too — retiring open
// was never the plan. Only the whole-event BID model is in question.
// ============================================================================

import { type AccessMode, normalizeAccessMode } from './sales'

export const AUCTION_API = 'http://localhost:8001'

// Old literal union KEPT for back-compat (components may compare tier === 'vip_only').
// New code reads auction.access_mode instead, which fetchAuctions normalizes.
export type AuctionTier = 'open' | 'vip_only' | 'invite_only'
export type AuctionStatus = 'upcoming' | 'live' | 'ended'

export type Auction = {
  id: number
  host_username: string
  title: string
  description: string
  image_url: string
  tier: AuctionTier          // raw, back-compat
  access_mode: AccessMode    // normalized, canonical
  starting_bid: string
  status: AuctionStatus
  starts_at: string | null
  ends_at: string | null
  ticket_price: string
  current_bid: string | null
  bid_count: number
  // per-viewer (advisory; backend enforces)
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
  const rows: any[] = data.auctions || []
  return rows.map(r => ({ ...r, access_mode: normalizeAccessMode(r.access_mode ?? r.tier) }))
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