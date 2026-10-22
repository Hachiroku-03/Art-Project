const API =
  (import.meta as any).env?.VITE_API_URL || 'http://localhost:8001'

export type NotificationCategory =
  | 'messages'
  | 'mentions'
  | 'groups'
  | 'posts'
  | 'auctions'
  | 'calls'
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

function extractError(data: any, status: number): string {
  if (!data) return status ? `server error (${status})` : 'empty response'
  if (typeof data === 'string') return data
  if (data.error) return String(data.error)

  if (data.detail) {
    if (typeof data.detail === 'string') return data.detail

    if (Array.isArray(data.detail)) {
      return data.detail
        .map((d: any) =>
          d?.msg || d?.message || (typeof d === 'string' ? d : JSON.stringify(d)),
        )
        .join('; ')
    }

    return JSON.stringify(data.detail)
  }

  return status ? `request failed (${status})` : 'unknown error'
}

async function jrequest(path: string, method: string, body?: unknown): Promise<any> {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const data = await res.json().catch(() => null)

    if (!res.ok) {
      return { error: extractError(data, res.status) }
    }

    return data ?? { error: 'empty response' }
  } catch {
    return { error: 'network error' }
  }
}

function num(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v

    if (typeof v === 'string' && v.trim()) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }

  return null
}

function stateObj(
  ...entries: [string, unknown][]
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}

  for (const [key, value] of entries) {
    if (value !== undefined && value !== null) out[key] = value
  }

  return Object.keys(out).length ? out : undefined
}

/**
 * Single source of truth for "where does this notification take the user".
 *
 * Imported by NotificationBell, ToastHost and NotificationsPage.
 * Keep routing rules here so the three surfaces never disagree about a click.
 *
 * Deep-link rules:
 * - paddle_invited              → /sales/{sale_id}
 * - lot_won                     → /wins
 * - lot_payment_required        → /wins
 * - payment_confirmed           → /wins
 * - payment_failed              → /wins
 * - lot_payment_received        → /sales/{sale_id}/control?tab=settlement
 * - collection_marked_paid      → /sales/{sale_id}/control?tab=settlement
 * - collection_retry_result     → /sales/{sale_id}/control?tab=settlement
 * - settlement_complete         → /sales/{sale_id}/control?tab=settlement
 * - lot-related wallet events   → /wins
 * - other auction events        → /sales/{sale_id}
 */
export function routeFor(n: AppNotification): {
  to: string
  state?: Record<string, unknown>
} {
  const data =
    n.data && typeof n.data === 'object'
      ? (n.data as Record<string, unknown>)
      : {}

  const sourceSaleId = n.source_type === 'sale' ? n.source_id : null
  const sourceLotId = n.source_type === 'lot' ? n.source_id : null

  const saleId = num(sourceSaleId, data.sale_id)
  const lotId = num(n.secondary_id, sourceLotId, data.lot_id)

  // -----------------------------------------------------------------------
  // Buyer-facing payment / won-lot events.
  // These must go to /wins, not the sale room.
  // -----------------------------------------------------------------------

  const buyerPaymentTypes = new Set([
    'lot_won',
    'payment_confirmed',
    'payment_failed',
    'lot_payment_required',
  ])

  if (buyerPaymentTypes.has(n.type)) {
    return {
      to: '/wins',
      state: stateObj(['saleId', saleId], ['lotId', lotId]),
    }
  }

  // -----------------------------------------------------------------------
  // House-facing settlement / collection events.
  // These must go to the control room settlement tab.
  // -----------------------------------------------------------------------

  const hostSettlementTypes = new Set([
    'lot_payment_received',
    'collection_marked_paid',
    'collection_retry_result',
    'settlement_complete',
    'settlement',
    'collect_retry',
    'collection_retry',
    'payout_marked_paid',
    'payout_paid',
  ])

  if (hostSettlementTypes.has(n.type)) {
    if (saleId) {
      return {
        to: `/sales/${saleId}/control?tab=settlement`,
        state: stateObj(['saleId', saleId]),
      }
    }

    return { to: '/sales/control?tab=settlement' }
  }

  // -----------------------------------------------------------------------
  // Paddle invitation.
  // -----------------------------------------------------------------------

  if (n.type === 'paddle_invited') {
    if (saleId) {
      return {
        to: `/sales/${saleId}`,
        state: stateObj(['paddle', true], ['saleId', saleId]),
      }
    }

    return { to: '/auctions' }
  }

  // -----------------------------------------------------------------------
  // Social / community routes.
  // -----------------------------------------------------------------------

  if (n.source_type === 'post' && n.source_id) {
    return { to: `/post/${n.source_id}` }
  }

  if (n.source_type === 'comment') {
    const postId = n.secondary_id || n.source_id
    if (postId) return { to: `/post/${postId}` }
  }

  if (n.source_type === 'conversation' || n.source_type === 'chat') {
    if (n.source_id) {
      return {
        to: '/messenger',
        state: { openConversationId: n.source_id },
      }
    }
  }

  if (
    n.category === 'messages' ||
    n.category === 'mentions' ||
    n.category === 'groups'
  ) {
    if (n.source_id) {
      return {
        to: '/messenger',
        state: { openConversationId: n.source_id },
      }
    }
  }

  // -----------------------------------------------------------------------
  // Generic auction routes.
  // -----------------------------------------------------------------------

  if (n.category === 'auctions') {
    if (saleId) {
      return {
        to: `/sales/${saleId}`,
        state: stateObj(['saleId', saleId], ['lotId', lotId]),
      }
    }

    return { to: '/auctions' }
  }

  // -----------------------------------------------------------------------
  // Calls.
  // -----------------------------------------------------------------------

  if (n.source_type === 'call' && n.source_id) {
    return { to: `/calls/${n.source_id}` }
  }

  if (n.category === 'calls' && n.source_id) {
    return { to: `/calls/${n.source_id}` }
  }

  // -----------------------------------------------------------------------
  // Wallet / payment routes.
  // If it carries a lot id, it is buyer auction money, so send them to /wins.
  // Otherwise normal wallet.
  // -----------------------------------------------------------------------

  if (n.category === 'wallet') {
    if (lotId != null) {
      return {
        to: '/wins',
        state: stateObj(['saleId', saleId], ['lotId', lotId]),
      }
    }

    return { to: '/wallet' }
  }

  // -----------------------------------------------------------------------
  // Security / system / fallback.
  // -----------------------------------------------------------------------

  if (n.category === 'security' || n.category === 'system') {
    return { to: '/settings' }
  }

  return { to: '/notifications' }
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
  return jrequest(
    `/notifications/unread-count?viewer=${encodeURIComponent(viewer)}`,
    'GET',
  )
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