const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:8001'

export type CommunityGroup = {
  id: number
  name: string | null
  image_url: string | null
  description: string | null
  join_mode: 'open' | 'request' | 'invite' | 'private' | string
  category: string | null
  tags: string[]
  scene: string | null
  updated_at: string | null
  member_count: number
  initials: string[]
  request_status: 'none' | 'pending' | 'approved' | 'rejected' | 'cancelled' | string
}

export type Taxonomy = {
  categories: string[]
  scenes: { name: string; count: number }[]
}

export type CommunityRequest = {
  id: number
  group_id: number
  group_name: string | null
  user_name: string
  display_name: string
  avatar_url: string | null
  message: string | null
  created_at: string
}

export type CommunityInvite = {
  notification_id: number
  conversation_id: number
  group_name: string | null
  actor: string | null
  actor_display: string | null
  created_at: string
  read_at: string | null
}

export type CommunityPerson = {
  username: string
  role: string
  tier: string
  display_name: string | null
  avatar_url: string | null
  follower_count: number
  shared_groups: number
  house_name: string | null
  active_sales: number
  reason: string
}

export type CommunityLive = {
  id: number
  title: string
  host_username: string | null
  host_display: string | null
  ends_at: string | null
  lots_on_block: number
  top_amount: string | null
}

export type CommunityCalendar = {
  id: number
  title: string
  status: string
  host_username: string | null
  host_display: string | null
  ends_at: string | null
  lot_count: number
}

export type CommunityCall = {
  id: number
  host_user_name: string
  host_display: string | null
  host_avatar: string | null
  kind: string
  title: string
  description: string | null
  cover_url: string | null
  scene: string | null
  location: string | null
  online: boolean
  starts_at: string | null
  ends_at: string | null
  deadline_at: string | null
  status: string
  eligibility: Record<string, unknown>
  apply_url: string | null
  interest_count: number
  interested_by_viewer: boolean
  created_at: string
  updated_at: string
  can_host?: boolean
  can_edit?: boolean
}

async function jget(path: string): Promise<any> {
  try {
    const res = await fetch(`${API}${path}`)
    return await res.json()
  } catch {
    return { error: 'network error' }
  }
}

export async function fetchCommunityDiscover(
  viewer: string,
  opts: { q?: string; category?: string | null; scene?: string | null; limit?: number } = {},
): Promise<CommunityGroup[]> {
  const p = new URLSearchParams()
  p.set('viewer', viewer)
  if (opts.q) p.set('q', opts.q)
  if (opts.category) p.set('category', opts.category)
  if (opts.scene) p.set('scene', opts.scene)
  p.set('limit', String(opts.limit ?? 30))
  const d = await jget(`/community/discover?${p.toString()}`)
  return d.groups || []
}

export async function fetchCommunityTaxonomy(viewer: string): Promise<Taxonomy> {
  const d = await jget(`/community/taxonomy?viewer=${encodeURIComponent(viewer)}`)
  return { categories: d.categories || [], scenes: d.scenes || [] }
}

export async function fetchCommunityRequests(viewer: string): Promise<CommunityRequest[]> {
  const d = await jget(`/community/requests?viewer=${encodeURIComponent(viewer)}`)
  return d.requests || []
}

export async function fetchCommunityInvites(viewer: string): Promise<CommunityInvite[]> {
  const d = await jget(`/community/invites?viewer=${encodeURIComponent(viewer)}`)
  return d.invites || []
}

export async function fetchCommunityPeople(viewer: string): Promise<CommunityPerson[]> {
  const d = await jget(`/community/people?viewer=${encodeURIComponent(viewer)}`)
  return d.people || []
}

export async function fetchCommunityLive(viewer: string): Promise<CommunityLive[]> {
  const d = await jget(`/community/live?viewer=${encodeURIComponent(viewer)}`)
  return d.live || []
}

export async function fetchCommunityCalendar(viewer: string): Promise<CommunityCalendar[]> {
  const d = await jget(`/community/calendar?viewer=${encodeURIComponent(viewer)}`)
  return d.calendar || []
}

export async function fetchCommunityCalls(
  viewer: string,
  opts: { q?: string; kind?: string; scene?: string | null; status?: string; limit?: number } = {},
): Promise<CommunityCall[]> {
  const p = new URLSearchParams()
  p.set('viewer', viewer)
  if (opts.q) p.set('q', opts.q)
  if (opts.kind) p.set('kind', opts.kind)
  if (opts.scene) p.set('scene', opts.scene)
  p.set('status', opts.status || 'open')
  p.set('limit', String(opts.limit ?? 6))
  const d = await jget(`/community/calls?${p.toString()}`)
  return d.calls || []
}

export async function toggleCommunityCallInterest(
  viewer: string,
  callId: number,
): Promise<{ interested?: boolean; count?: number; error?: string }> {
  try {
    const res = await fetch(`${API}/community/calls/${callId}/interest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer }),
    })
    return await res.json()
  } catch {
    return { error: 'network error' }
  }
}

async function jsend(path: string, method: string, body: unknown): Promise<any> {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await res.json()
  } catch {
    return { error: 'network error' }
  }
}

export async function fetchCommunityCall(viewer: string, callId: number): Promise<CommunityCall | null> {
  const d = await jget(`/community/calls/${callId}?viewer=${encodeURIComponent(viewer)}`)
  return d.call || null
}

export async function fetchCanHostCalls(viewer: string): Promise<boolean> {
  const d = await jget(`/community/calls/can-host?viewer=${encodeURIComponent(viewer)}`)
  return !!d.can_host
}

export type CallPayload = {
  title: string
  kind: string
  status?: string
  description?: string | null
  scene?: string | null
  location?: string | null
  online?: boolean
  starts_at?: string | null
  ends_at?: string | null
  deadline_at?: string | null
  apply_url?: string | null
  cover_url?: string | null
  eligibility?: Record<string, unknown>
}

export async function createCommunityCall(
  viewer: string,
  payload: CallPayload,
): Promise<{ call?: CommunityCall; message?: string; error?: string }> {
  return jsend('/community/calls', 'POST', { viewer, ...payload })
}

export async function updateCommunityCall(
  viewer: string,
  callId: number,
  patch: Partial<CallPayload>,
): Promise<{ call?: CommunityCall; message?: string; error?: string }> {
  return jsend(`/community/calls/${callId}`, 'PATCH', { viewer, ...patch })
}

export async function updateCommunityGroupMeta(
  viewer: string,
  convId: number,
  patch: {
    category?: string | null
    scene?: string | null
    tags?: string[] | null
    join_mode?: string
    allow_member_invites?: boolean
    announce_new_members?: boolean
  },
): Promise<{ message?: string; error?: string }> {
  try {
    const res = await fetch(`${API}/community/groups/${convId}/meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer, ...patch }),
    })
    return await res.json()
  } catch {
    return { error: 'network error' }
  }
}