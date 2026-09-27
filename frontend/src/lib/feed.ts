import { API } from './sales'

export type Suggestion = {
  username: string; role: string; tier: string
  display_name: string | null; follower_count: number
}

export type LeadingLot = {
  lot_id: number; title: string | null; image_url: string | null
  sale_id: number; sale_title: string; top_amount: string | null; ends_at: string | null
}

export type Standing = {
  tier: string
  leading: LeadingLot[]
  tickets: number
  collects: number
}

export async function fetchSuggestions(viewer: string): Promise<Suggestion[]> {
  try {
    const d = await fetch(`${API}/suggestions?viewer=${encodeURIComponent(viewer)}`).then(r => r.json())
    return d.suggestions || []
  } catch { return [] }
}

export async function fetchStanding(viewer: string): Promise<Standing | null> {
  try {
    const d = await fetch(`${API}/me/standing?viewer=${encodeURIComponent(viewer)}`).then(r => r.json())
    return d.error ? null : d
  } catch { return null }
}

// ---- stories ----
export type StoryItem = { id: number; kind: string; body: string }
export type StoryUser = { username: string; items: StoryItem[] }
export type StoryComment = { id: number; user_name: string; body: string; created_at?: string }

type StoryRow = { id: number; user_name: string; kind: string; body: string }

function groupStories(rows: StoryRow[]): StoryUser[] {
  const map = new Map<string, StoryItem[]>()
  for (const s of rows) {
    if (!map.has(s.user_name)) map.set(s.user_name, [])
    map.get(s.user_name)!.push({ id: s.id, kind: s.kind, body: s.body })
  }
  return Array.from(map, ([username, items]) => ({ username, items }))
}

export async function fetchStories(): Promise<StoryUser[]> {
  try {
    const d = await fetch(`${API}/stories`).then(r => r.json())
    return groupStories(d.stories || [])
  } catch { return [] }
}

export async function fetchFollowedStories(viewer: string): Promise<StoryUser[]> {
  try {
    const d = await fetch(`${API}/stories/followed?viewer=${encodeURIComponent(viewer)}`).then(r => r.json())
    return groupStories(d.stories || [])
  } catch { return [] }
}

export async function postStory(viewer: string, kind: 'image' | 'text', body: string) {
  try {
    return await fetch(`${API}/stories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer, kind, body }),
    }).then(r => r.json())
  } catch { return { error: 'network error' } }
}

// ---- story interactions ----
export async function fetchStoryInteractions(storyId: number, viewer: string) {
  try {
    const [likes, comments] = await Promise.all([
      fetch(`${API}/stories/${storyId}/likes?viewer=${encodeURIComponent(viewer)}`).then(r => r.json()),
      fetch(`${API}/stories/${storyId}/comments?viewer=${encodeURIComponent(viewer)}`).then(r => r.json()),
    ])
    return {
      likes: Number(likes?.count || 0),
      liked: !!likes?.liked,
      comments: (comments?.comments || []) as StoryComment[],
    }
  } catch {
    return { likes: 0, liked: false, comments: [] as StoryComment[] }
  }
}

export async function toggleStoryLike(storyId: number, viewer: string) {
  try {
    return await fetch(`${API}/stories/${storyId}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer }),
    }).then(r => r.json())
  } catch {
    return { error: 'network error' }
  }
}

export async function addStoryComment(storyId: number, viewer: string, body: string) {
  try {
    return await fetch(`${API}/stories/${storyId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer, body }),
    }).then(r => r.json())
  } catch {
    return { error: 'network error' }
  }
}