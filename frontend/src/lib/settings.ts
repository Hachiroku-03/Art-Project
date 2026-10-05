const ACCOUNT_API =
  (import.meta as any).env?.VITE_AUTH_API_URL || 'http://localhost:8000'

export type NotificationCategoryKey =
  | 'messages'
  | 'mentions'
  | 'groups'
  | 'posts'
  | 'auctions'
  | 'calls'
  | 'wallet'
  | 'security'
  | 'system'

export type NotificationCategoryPrefs = {
  in_app: boolean
  sound: boolean
}

export type NotificationPrefs = {
  master: boolean
} & Record<NotificationCategoryKey, NotificationCategoryPrefs>

export type AuctionPrefs = {
  confirm_bids: boolean
  show_username_in_ledger: boolean
  paddle_nickname: string | null
}

export type PrivacyPrefs = {
  profile_visibility: 'public' | 'followers' | 'private'
  allow_mentions: 'everyone' | 'followers' | 'group_members' | 'nobody'
  show_online_status: boolean
}

export type IdentityPrefs = {
  face_verification: 'none' | 'pending' | 'enabled' | 'disabled' | 'locked' | string
}

export type AccountSettings = {
  language: string
  notifications: NotificationPrefs
  auctions: AuctionPrefs
  privacy: PrivacyPrefs
  identity: IdentityPrefs
  blocked_count: number
  error?: string
}

export type NotificationPatch = {
  master?: boolean
} & Partial<Record<NotificationCategoryKey, Partial<NotificationCategoryPrefs>>>

export type AuctionPatch = Partial<{
  confirm_bids: boolean
  show_username_in_ledger: boolean
  paddle_nickname: string | null
}>

export type PrivacyPatch = Partial<{
  profile_visibility: PrivacyPrefs['profile_visibility']
  allow_mentions: PrivacyPrefs['allow_mentions']
  show_online_status: boolean
}>

async function jrequest(path: string, method: string, body?: unknown): Promise<any> {
  try {
    const res = await fetch(`${ACCOUNT_API}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    return await res.json()
  } catch {
    return { error: 'network error' }
  }
}

export async function fetchAccountSettings(viewer: string): Promise<AccountSettings> {
  return jrequest(`/account/settings?viewer=${encodeURIComponent(viewer)}`, 'GET')
}

export async function updateAccountLanguage(
  viewer: string,
  language: string,
): Promise<{ language?: string; message?: string; error?: string }> {
  return jrequest('/account/settings/language', 'PATCH', { viewer, language })
}

export async function updateNotificationPreferences(
  viewer: string,
  notifications: NotificationPatch,
): Promise<{ notifications?: NotificationPrefs; message?: string; error?: string }> {
  return jrequest('/account/settings/notifications', 'PATCH', { viewer, notifications })
}

export async function updateAuctionPreferences(
  viewer: string,
  auctions: AuctionPatch,
): Promise<{ auctions?: AuctionPrefs; message?: string; error?: string }> {
  return jrequest('/account/settings/auctions', 'PATCH', { viewer, auctions })
}

export async function updatePrivacyPreferences(
  viewer: string,
  privacy: PrivacyPatch,
): Promise<{ privacy?: PrivacyPrefs; message?: string; error?: string }> {
  return jrequest('/account/settings/privacy', 'PATCH', { viewer, privacy })
}

export async function fetchBlockedUsers(
  viewer: string,
): Promise<
  {
    user_name: string
    display_name: string
    avatar_url: string | null
    created_at: string
  }[]
> {
  const d = await jrequest(`/account/settings/blocked?viewer=${encodeURIComponent(viewer)}`, 'GET')
  return d.blocked || []
}