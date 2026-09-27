const AUTH = 'http://localhost:8000'

export type WalletData = {
  balance: string
  tier: string
  vip_price: number | string
  entries: LedgerEntry[]
  subscription?: VipSubscription
}
export type LedgerEntry = { id: number; amount: string; kind: string; reference: string | null; created_at: string }
export type Paddle = { auction_id: number; code: string; title: string; status: string; host_username: string; ends_at: string | null; obtained_at: string }

export async function fetchWallet(viewer: string): Promise<WalletData | null> {
  try { const d = await fetch(`${AUTH}/wallet?viewer=${encodeURIComponent(viewer)}`).then(r => r.json()); return d.error ? null : d }
  catch { return null }
}
export async function fetchPaddles(viewer: string): Promise<Paddle[]> {
  try { const d = await fetch(`${AUTH}/wallet/paddles?viewer=${encodeURIComponent(viewer)}`).then(r => r.json()); return d.paddles || [] }
  catch { return [] }
}
export async function topUp(viewer: string, amount: number) {
  try { return await fetch(`${AUTH}/wallet/topup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, amount }) }).then(r => r.json()) }
  catch { return { error: 'The server is unreachable.' } }
}
export function fmtMoney(n: number | string | null | undefined): string {
  const v = typeof n === 'string' ? parseFloat(n) : n
  return (v == null || isNaN(v) ? 0 : v).toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}
export type VipSubscription = {
  status: 'active' | 'past_due' | 'cancelled'
  price: string; renews_at: string | null; cancelled_at: string | null
  periods_paid: number; failure_reason: string | null
} | null
// extend WalletData with:  subscription?: VipSubscription
export type VipStatus = { vip: boolean; tier: string; balance: string; price: number | string; subscription: VipSubscription }

export async function fetchVipStatus(viewer: string): Promise<VipStatus | null> {
  try { const d = await fetch(`${AUTH}/vip/status?viewer=${encodeURIComponent(viewer)}`).then(r => r.json()); return d.error ? null : d }
  catch { return null }
}
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso.replace(' ', 'T')).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}