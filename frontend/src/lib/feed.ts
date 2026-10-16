import { API } from './sales'

export type Suggestion = {
  username: string
  role: string
  tier: string
  display_name: string | null
  follower_count: number
}

export type LeadingLot = {
  lot_id: number
  title: string | null
  image_url: string | null
  sale_id: number
  sale_title: string
  top_amount: string | null
  ends_at: string | null
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
  } catch {
    return []
  }
}

export async function fetchStanding(viewer: string): Promise<Standing | null> {
  try {
    const d = await fetch(`${API}/me/standing?viewer=${encodeURIComponent(viewer)}`).then(r => r.json())
    return d.error ? null : d
  } catch {
    return null
  }
}

// ---- stories ----
export type StoryItem = {
  id: number
  kind: string
  body: string
  url?: string | null
  caption?: string | null
}

export type StoryUser = {
  username: string
  avatar_url?: string | null
  items: StoryItem[]
}

export type StoryComment = {
  id: number
  user_name: string
  body: string
  created_at?: string
}

type StoryRow = {
  id: number
  user_name: string
  kind: string
  body: string
  avatar_url?: string | null
}

function parseStoryBody(kind: string, body: string): { url: string | null; caption: string | null } {
  if (kind !== 'image') return { url: null, caption: null }

  const trimmed = (body || '').trim()

  // New image-with-caption stories are stored as:
  // { "url": "https://...", "caption": "..." }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)

      if (parsed && typeof parsed.url === 'string') {
        return {
          url: parsed.url,
          caption: typeof parsed.caption === 'string' ? parsed.caption : null,
        }
      }
    } catch {
      // fall through
    }
  }

  // Old/plain image stories are just the URL.
  return { url: body, caption: null }
}

function groupStories(rows: StoryRow[]): StoryUser[] {
  const map = new Map<string, { avatar_url: string | null; items: StoryItem[] }>()

  for (const s of rows) {
    if (!map.has(s.user_name)) {
      map.set(s.user_name, { avatar_url: s.avatar_url ?? null, items: [] })
    }

    const entry = map.get(s.user_name)!

    if (!entry.avatar_url && s.avatar_url) {
      entry.avatar_url = s.avatar_url
    }

    const parsed = parseStoryBody(s.kind, s.body)

    entry.items.push({
      id: s.id,
      kind: s.kind,
      body: s.body,
      url: parsed.url,
      caption: parsed.caption,
    })
  }

  return Array.from(map, ([username, value]) => ({
    username,
    avatar_url: value.avatar_url,
    items: value.items,
  }))
}

export async function fetchStories(): Promise<StoryUser[]> {
  try {
    const d = await fetch(`${API}/stories`).then(r => r.json())
    return groupStories(d.stories || [])
  } catch {
    return []
  }
}

export async function fetchFollowedStories(viewer: string): Promise<StoryUser[]> {
  try {
    const d = await fetch(`${API}/stories/followed?viewer=${encodeURIComponent(viewer)}`).then(r => r.json())
    return groupStories(d.stories || [])
  } catch {
    return []
  }
}

export async function postStory(viewer: string, kind: 'image' | 'text', body: string) {
  try {
    return await fetch(`${API}/stories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer, kind, body }),
    }).then(r => r.json())
  } catch {
    return { error: 'network error' }
  }
}

// ---- per-story-item seen tracking ----
const SEEN_STORY_IDS_KEY = 'seen_story_ids'

export function loadSeenStoryIds(): Set<number> {
  if (typeof window === 'undefined') return new Set()

  try {
    const raw = localStorage.getItem(SEEN_STORY_IDS_KEY)
    if (!raw) return new Set()

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()

    return new Set(parsed.filter(n => typeof n === 'number'))
  } catch {
    return new Set()
  }
}

export function saveSeenStoryIds(ids: Set<number>): void {
  if (typeof window === 'undefined') return

  try {
    // Keep only the most recent 1000 seen ids so localStorage does not grow forever.
    const arr = Array.from(ids).slice(-1000)
    localStorage.setItem(SEEN_STORY_IDS_KEY, JSON.stringify(arr))
  } catch {
    // ignore
  }
}

export function hasUnseenStory(user: StoryUser | null | undefined, seenIds: Set<number>): boolean {
  if (!user || !user.items.length) return false
  return user.items.some(item => !seenIds.has(item.id))
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

export async function deleteStory(storyId: number, viewer: string) {
  try {
    return await fetch(`${API}/stories/${storyId}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer }),
    }).then(r => r.json())
  } catch {
    return { error: 'network error' }
  }
}