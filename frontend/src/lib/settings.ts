const ACCOUNT_API =
  (import.meta as any).env?.VITE_AUTH_API_URL || 'http://localhost:8000'

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

export type AccountSettings = {
  language: string
  notifications: Record<string, any>
  auctions: Record<string, any>
  privacy: Record<string, any>
  identity: {
    face_verification: string
  }
  blocked_count: number
  error?: string
}

export async function fetchAccountSettings(viewer: string): Promise<AccountSettings> {
  return jrequest(`/account/settings?viewer=${encodeURIComponent(viewer)}`, 'GET')
}

export async function updateAccountLanguage(viewer: string, language: string) {
  return jrequest('/account/settings/language', 'PATCH', { viewer, language })
}

export async function updateNotificationPreferences(viewer: string, notifications: Record<string, any>) {
  return jrequest('/account/settings/notifications', 'PATCH', { viewer, notifications })
}

export async function updateAuctionPreferences(viewer: string, auctions: Record<string, any>) {
  return jrequest('/account/settings/auctions', 'PATCH', { viewer, auctions })
}

export async function updatePrivacyPreferences(viewer: string, privacy: Record<string, any>) {
  return jrequest('/account/settings/privacy', 'PATCH', { viewer, privacy })
}

export async function fetchBlockedUsers(viewer: string) {
  const d = await jrequest(`/account/settings/blocked?viewer=${encodeURIComponent(viewer)}`, 'GET')
  return d.blocked || []
}