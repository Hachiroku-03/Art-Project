const API =
  (import.meta as any).env?.VITE_API_URL || 'http://localhost:8001'

export type NotificationCategory =
  | 'messages'
  | 'mentions'
  | 'groups'
  | 'posts'
  | 'auctions'
  | 'wallet'
  | 'security'
  | 'system'

export type AppNotification = {
  id: number
  category: NotificationCategory | string
  type: string
  actor: string | null
  actor_display: string | null
  actor_avatar: string | null
  source_type: string | null
  source_id: number | null
  secondary_id: number | null
  title: string
  body: string | null
  data: Record<string, unknown>
  read_at: string | null
  created_at: string
}

export type NotificationListResponse = {
  notifications?: AppNotification[]
  has_more?: boolean
  error?: string
}

export type NotificationCountResponse = {
  count?: number
  error?: string
}

export type NotificationActionResponse = {
  message?: string
  error?: string
}

async function jrequest(path: string, method: string, body?: unknown): Promise<any> {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    return await res.json()
  } catch {
    return { error: 'network error' }
  }
}

export async function fetchNotifications(
  viewer: string,
  opts: {
    category?: NotificationCategory | 'all'
    unreadOnly?: boolean
    limit?: number
    beforeId?: number
  } = {},
): Promise<NotificationListResponse> {
  const params = new URLSearchParams()
  params.set('viewer', viewer)
  params.set('category', opts.category || 'all')

  if (opts.unreadOnly) params.set('unread_only', 'true')
  params.set('limit', String(opts.limit || 40))

  if (opts.beforeId) params.set('before_id', String(opts.beforeId))

  return jrequest(`/notifications?${params.toString()}`, 'GET')
}

export async function fetchNotificationsSince(
  viewer: string,
  afterId: number,
  limit = 20,
): Promise<{ notifications?: AppNotification[]; error?: string }> {
  const params = new URLSearchParams()
  params.set('viewer', viewer)
  params.set('after_id', String(afterId))
  params.set('limit', String(limit))

  return jrequest(`/notifications/since?${params.toString()}`, 'GET')
}

export async function fetchUnreadNotificationCount(
  viewer: string,
): Promise<NotificationCountResponse> {
  return jrequest(`/notifications/unread-count?viewer=${encodeURIComponent(viewer)}`, 'GET')
}

export async function markNotificationRead(
  viewer: string,
  notificationId: number,
): Promise<NotificationActionResponse> {
  return jrequest(`/notifications/${notificationId}/read`, 'POST', { viewer })
}

export async function markAllNotificationsRead(
  viewer: string,
): Promise<NotificationActionResponse> {
  return jrequest('/notifications/read-all', 'POST', { viewer })
}

export async function deleteNotification(
  viewer: string,
  notificationId: number,
): Promise<NotificationActionResponse> {
  return jrequest(`/notifications/${notificationId}/delete`, 'POST', { viewer })
}