import { API, type Sale } from './sales'

export type ProfilePost = {
  id: number; type: string; title: string; image_url?: string
  price?: string; current_bid?: string | null
}

export type ProfilePayload = {
  user: ProfileUser
  counts: { works: number; followers: number; following: number; collects: number }
  posts: ProfilePost[]; rooms: Sale[]; collects: ProfilePost[]
}

export async function fetchProfile(username: string, viewer: string): Promise<ProfilePayload | { error: string }> {
  const res = await fetch(`${API}/profile/${encodeURIComponent(username)}?viewer=${encodeURIComponent(viewer)}`)
  return res.json()
}

export type ProfileUser = {
  username: string; role: string; tier: string
  display_name: string | null; bio: string | null
  avatar_url: string | null; banner_url: string | null   // ← new
  house_status: string | null; house_name: string | null  // ← new
  is_self: boolean; followed_by_viewer: boolean
}