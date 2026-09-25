import { API } from './sales'

export type Suggestion = {
  username: string; role: string; tier: string
  display_name: string | null; follower_count: number
}
export type LeadingLot = {
  lot_id: number; title: string | null; image_url: string | null
  sale_id: number; sale_title: string; top_amount: string | null; ends_at: string | null
}
export type Standing = { tier: string; leading: LeadingLot[]; tickets: number; collects: number }

export async function fetchSuggestions(viewer: string): Promise<Suggestion[]> {
  try { const d = await fetch(`${API}/suggestions?viewer=${encodeURIComponent(viewer)}`).then(r => r.json()); return d.suggestions || [] }
  catch { return [] }
}
export async function fetchStanding(viewer: string): Promise<Standing | null> {
  try { const d = await fetch(`${API}/me/standing?viewer=${encodeURIComponent(viewer)}`).then(r => r.json()); return d.error ? null : d }
  catch { return null }
}
export type StoryItem = { kind: string; body: string }
export type StoryUser = { username: string; items: StoryItem[] }

export async function fetchStories(): Promise<StoryUser[]> {
  try {
    const d = await fetch(`${API}/stories`).then(r => r.json())
    const map = new Map<string, StoryItem[]>()
    for (const s of (d.stories || [])) {
      if (!map.has(s.user_name)) map.set(s.user_name, [])
      map.get(s.user_name)!.push({ kind: s.kind, body: s.body })
    }
    return Array.from(map, ([username, items]) => ({ username, items }))
  } catch { return [] }
}
export async function postStory(viewer: string, kind: 'image' | 'text', body: string) {
  const r = await fetch(`${API}/stories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, kind, body }) }).then(x => x.json()).catch(() => ({}))
  return r
}