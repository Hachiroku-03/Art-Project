import { API } from './sales'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ReactionSummary = {
  emoji: string
  count: number
  viewer_reacted: boolean
}

export type MessageMeta = Record<string, unknown>

export type ChatMessageKind =
  | 'text'
  | 'image'
  | 'voice'
  | 'file'
  | 'video'
  | 'location'
  | 'contact'
  | 'system'

export type ChatMessage = {
  id: number
  conversation_id: number
  sender: string
  kind: ChatMessageKind
  body: string
  reply_to_id: number | null
  forwarded_from_id: number | null
  meta: MessageMeta
  edited_at: string | null
  created_at: string
  sender_display: string | null
  sender_avatar: string | null
  sender_tier: string | null
  reactions: ReactionSummary[]
  starred_by_viewer: boolean

  reply_to_body?: string | null
  reply_to_kind?: ChatMessageKind | null
  reply_to_sender?: string | null
  reply_to_sender_display?: string | null
}

export type Conversation = {
  id: number
  kind: 'direct' | 'group'
  name: string | null
  image_url: string | null
  description: string | null
  updated_at: string | null

  archived: boolean
  muted: boolean
  pinned: boolean
  pinned_at: string | null
  mark_unread: boolean
  draft: string | null

  last_body: string | null
  last_kind: ChatMessageKind | null
  last_sender: string | null
  last_at: string | null
  unread: number

  counterpart: string | null
  counterpart_avatar: string | null
  counterpart_username: string | null
  counterpart_online?: boolean | null
  counterpart_last_seen_at?: string | null
  member_count: number

  join_mode?: 'open' | 'request' | 'invite' | 'private'
  allow_member_invites?: boolean
  announce_new_members?: boolean

  category?: string | null
  scene?: string | null
  tags?: string[] | null
}


export type ConversationUpdate = Partial<Conversation> & { id: number }

export type ChatEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'ack'; temp_id: string | null; message: ChatMessage }
  | { type: 'error'; temp_id: string | null; conversation_id?: number; error: string }
  | { type: 'read'; conversation_id: number; user_name: string; last_read_id: number }
  | { type: 'delivery'; conversation_id: number; user_name: string; last_delivered_id: number }
  | { type: 'typing'; conversation_id: number; user_name: string }
  | { type: 'recording'; conversation_id: number; user_name: string; active: boolean }
  | { type: 'message_edited'; message: ChatMessage }
  | { type: 'message_deleted'; conversation_id: number; message_id: number }
  | { type: 'reaction_added'; conversation_id: number; message_id: number; user_name: string; emoji: string }
  | { type: 'reaction_removed'; conversation_id: number; message_id: number; user_name: string; emoji: string }
  | { type: 'member_removed'; conversation_id: number; user_name: string }
  | { type: 'conversation_updated'; conversation: ConversationUpdate }
  | { type: 'status'; online: boolean }
  | { type: 'reconnect' }
  | { type: 'disconnect' }

export type SendOptions = {
  reply_to_id?: number | null
  forwarded_from_id?: number | null
  meta?: MessageMeta
}

export type HistoryOptions = {
  since?: number
  beforeId?: number
  afterId?: number
  limit?: number
}

export type HistoryPayload = {
  messages: ChatMessage[]
  read_cursors: Record<string, number>
  delivered_cursors: Record<string, number>
  has_more_older: boolean
  has_more_newer: boolean
}

export type Draft = {
  conversation_id: number
  body: string
  updated_at: string
}

export type ConversationPrefs = {
  conversation_id: number
  user_name: string
  archived: boolean
  muted: boolean
  pinned: boolean
  pinned_at: string | null
  muted_until: string | null
  last_opened_at: string | null
  mark_unread: boolean
  updated_at: string | null
}

export type GroupMember = {
  user_name: string
  role: string
  joined_at: string
  display_name: string
  avatar_url: string | null
  tier: string
  online: boolean
  last_seen_at: string | null
}

export type NotificationItem = {
  id: number
  conversation_id: number | null
  message_id: number | null
  type: string
  title: string | null
  body: string | null
  created_at: string
  read_at: string | null
}

export type PresenceItem = {
  user_name: string
  online: boolean
  last_seen_at: string | null
}

// ---------------------------------------------------------------------------
// Socket singleton.
// ---------------------------------------------------------------------------
const WS_URL = API.replace(/^http/, 'ws') + '/ws/chat'

let ws: WebSocket | null = null
let currentViewer = ''
let closedByUs = false
let attempt = 0
let reconnectTimer: number | null = null
const listeners = new Set<(e: ChatEvent) => void>()

function emit(e: ChatEvent) {
  for (const fn of Array.from(listeners)) {
    try {
      fn(e)
    } catch {
      // One bad listener must not kill the socket.
    }
  }
}

function clearReconnect() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect() {
  if (closedByUs || !currentViewer) return

  clearReconnect()
  attempt += 1

  const delay = Math.min(1000 * 2 ** (attempt - 1), 15000)
  reconnectTimer = window.setTimeout(() => open(currentViewer), delay)
}

function open(viewer: string) {
  currentViewer = viewer
  closedByUs = false

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }

  try {
    ws = new WebSocket(`${WS_URL}?viewer=${encodeURIComponent(viewer)}`)
  } catch {
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    attempt = 0
    emit({ type: 'status', online: true })
    emit({ type: 'reconnect' })
  }

  ws.onmessage = (ev) => {
    let data: ChatEvent
    try {
      data = JSON.parse(ev.data)
    } catch {
      return
    }
    emit(data)
  }

  ws.onclose = (ev) => {
    emit({ type: 'status', online: false })

    if (ev.code === 4401) {
      closedByUs = true
      return
    }

    scheduleReconnect()
  }

  ws.onerror = () => {
    // onerror is followed by onclose; reconnect is driven there.
  }
}

export function connect(viewer: string) {
  if (!viewer) return
  open(viewer)
}

export function teardown() {
  closedByUs = true
  currentViewer = ''
  clearReconnect()

  if (ws) {
    try {
      ws.close(1000)
    } catch {
      // already gone
    }
    ws = null
  }

  emit({ type: 'status', online: false })
}

export function subscribe(fn: (e: ChatEvent) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function wsSend(obj: Record<string, unknown>): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj))
    return true
  }
  return false
}

export function socketOpen(): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN
}

// ---------------------------------------------------------------------------
// REST helpers.
// ---------------------------------------------------------------------------
async function jget(path: string): Promise<any> {
  try {
    return await fetch(`${API}${path}`).then(r => r.json())
  } catch {
    return { error: 'network error' }
  }
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

function jpost(path: string, body: unknown) {
  return jrequest(path, 'POST', body)
}

function jput(path: string, body: unknown) {
  return jrequest(path, 'PUT', body)
}

function jpatch(path: string, body: unknown) {
  return jrequest(path, 'PATCH', body)
}

function jdelete(path: string) {
  return jrequest(path, 'DELETE')
}

// ---------------------------------------------------------------------------
// Core chat REST.
// ---------------------------------------------------------------------------
export async function fetchConversations(
  viewer: string,
  includeArchived = false,
): Promise<Conversation[]> {
  const d = await jget(
    `/chat/conversations?viewer=${encodeURIComponent(viewer)}&include_archived=${includeArchived}`,
  )
  return d.conversations || []
}

export type GroupJoinRequest = {
  id: number
  user_name: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | string
  message: string | null
  created_at: string
  reviewed_at: string | null
  display_name: string
  avatar_url: string | null
}

export async function fetchGroupJoinRequests(
  viewer: string,
  convId: number,
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'all' = 'pending',
): Promise<GroupJoinRequest[]> {
  const d = await jget(
    `/chat/conversations/${convId}/join-requests?viewer=${encodeURIComponent(viewer)}&status=${status}`,
  )
  return d.requests || []
}

export async function requestGroupJoin(
  viewer: string,
  convId: number,
  message?: string,
): Promise<{ status?: string; message?: string; error?: string }> {
  return jpost(`/chat/conversations/${convId}/join-request`, {
    viewer,
    message: message || null,
  })
}

export async function cancelGroupJoinRequest(
  viewer: string,
  convId: number,
): Promise<{ message?: string; error?: string }> {
  return jdelete(`/chat/conversations/${convId}/join-request?viewer=${encodeURIComponent(viewer)}`)
}

export async function approveGroupJoinRequest(
  viewer: string,
  convId: number,
  requestId: number,
): Promise<{ message?: string; error?: string }> {
  return jpost(`/chat/conversations/${convId}/join-requests/${requestId}/approve`, { viewer })
}

export async function rejectGroupJoinRequest(
  viewer: string,
  convId: number,
  requestId: number,
): Promise<{ message?: string; error?: string }> {
  return jpost(`/chat/conversations/${convId}/join-requests/${requestId}/reject`, { viewer })
}

export async function createDirect(
  viewer: string,
  target: string,
): Promise<{ conversation_id?: number; error?: string }> {
  return jpost('/chat/conversations', { viewer, kind: 'direct', target })
}

export async function createGroup(
  viewer: string,
  name: string,
  members: string[],
  image_url?: string,
  description?: string,
): Promise<{ conversation_id?: number; error?: string }> {
  return jpost('/chat/conversations', {
    viewer,
    kind: 'group',
    name,
    members,
    image_url,
    description,
  })
}

export async function addMember(
  viewer: string,
  convId: number,
  userName: string,
): Promise<{ error?: string }> {
  return jpost(`/chat/conversations/${convId}/members`, { viewer, user_name: userName })
}

export async function fetchConversationMembers(
  viewer: string,
  convId: number,
): Promise<GroupMember[]> {
  const d = await jget(`/chat/conversations/${convId}/members?viewer=${encodeURIComponent(viewer)}`)
  return d.members || []
}

export async function fetchHistory(
  convId: number,
  viewer: string,
  opts: HistoryOptions = {},
): Promise<HistoryPayload> {
  const params = new URLSearchParams()
  params.set('viewer', viewer)

  if (opts.since) params.set('since', String(opts.since))
  if (opts.afterId) params.set('after_id', String(opts.afterId))
  if (opts.beforeId) params.set('before_id', String(opts.beforeId))
  if (opts.limit) params.set('limit', String(opts.limit))

  const d = await jget(`/chat/conversations/${convId}/messages?${params.toString()}`)

  return {
    messages: d.messages || [],
    read_cursors: d.read_cursors || {},
    delivered_cursors: d.delivered_cursors || {},
    has_more_older: !!d.has_more_older,
    has_more_newer: !!d.has_more_newer,
  }
}

export async function sendMessageRest(
  convId: number,
  viewer: string,
  kind: ChatMessageKind,
  body: string,
  options: SendOptions = {},
): Promise<{ message?: ChatMessage; error?: string }> {
  return jpost(`/chat/conversations/${convId}/messages`, {
    viewer,
    kind,
    body,
    reply_to_id: options.reply_to_id ?? null,
    forwarded_from_id: options.forwarded_from_id ?? null,
    meta: options.meta || {},
  })
}

export async function markReadRest(
  convId: number,
  viewer: string,
  lastReadId: number,
): Promise<{ error?: string }> {
  return jpost(`/chat/conversations/${convId}/read`, {
    viewer,
    last_read_id: lastReadId,
  })
}

// ---------------------------------------------------------------------------
// Message lifecycle.
// ---------------------------------------------------------------------------
export async function editMessage(
  messageId: number,
  viewer: string,
  body: string,
): Promise<{ message?: ChatMessage; error?: string }> {
  return jpatch(`/chat/messages/${messageId}`, { viewer, body })
}

export async function deleteMessageForEveryone(
  messageId: number,
  viewer: string,
): Promise<{ error?: string }> {
  return jdelete(`/chat/messages/${messageId}?viewer=${encodeURIComponent(viewer)}`)
}

export async function hideMessageForMe(
  messageId: number,
  viewer: string,
): Promise<{ error?: string }> {
  return jpost(`/chat/messages/${messageId}/hide`, { viewer })
}

// ---------------------------------------------------------------------------
// Reactions.
// ---------------------------------------------------------------------------
export async function reactToMessage(
  messageId: number,
  viewer: string,
  emoji: string,
): Promise<{ message?: ChatMessage; error?: string }> {
  return jpost(`/chat/messages/${messageId}/react`, { viewer, emoji })
}

export async function unreactToMessage(
  messageId: number,
  viewer: string,
  emoji: string,
): Promise<{ message?: ChatMessage; error?: string }> {
  const params = new URLSearchParams()
  params.set('viewer', viewer)
  params.set('emoji', emoji)

  return jdelete(`/chat/messages/${messageId}/react?${params.toString()}`)
}

// ---------------------------------------------------------------------------
// Stars.
// ---------------------------------------------------------------------------
export async function starMessage(
  messageId: number,
  viewer: string,
): Promise<{ starred?: boolean; error?: string }> {
  return jpost(`/chat/messages/${messageId}/star`, { viewer })
}

export async function unstarMessage(
  messageId: number,
  viewer: string,
): Promise<{ starred?: boolean; error?: string }> {
  return jdelete(`/chat/messages/${messageId}/star?viewer=${encodeURIComponent(viewer)}`)
}

// ---------------------------------------------------------------------------
// Forwarding.
// ---------------------------------------------------------------------------
export async function forwardMessage(
  messageId: number,
  viewer: string,
  toConversationIds: number[],
): Promise<{ messages?: ChatMessage[]; error?: string }> {
  return jpost(`/chat/messages/${messageId}/forward`, {
    viewer,
    to_conversation_ids: toConversationIds,
  })
}

// ---------------------------------------------------------------------------
// Drafts.
// ---------------------------------------------------------------------------
export async function getDrafts(viewer: string): Promise<Draft[]> {
  const d = await jget(`/chat/drafts?viewer=${encodeURIComponent(viewer)}`)
  return d.drafts || []
}

export async function saveDraft(
  viewer: string,
  conversationId: number,
  body: string,
): Promise<{ draft?: Draft | null; error?: string }> {
  return jput('/chat/drafts', { viewer, conversation_id: conversationId, body })
}

export async function deleteDraft(
  viewer: string,
  conversationId: number,
): Promise<{ error?: string }> {
  return jdelete(`/chat/drafts/${conversationId}?viewer=${encodeURIComponent(viewer)}`)
}

// ---------------------------------------------------------------------------
// Conversation prefs.
// ---------------------------------------------------------------------------
export async function getConversationPrefs(
  viewer: string,
  convId: number,
): Promise<{ prefs?: ConversationPrefs; error?: string }> {
  return jget(`/chat/conversations/${convId}/prefs?viewer=${encodeURIComponent(viewer)}`)
}

export async function updateConversationPrefs(
  viewer: string,
  convId: number,
  prefs: Partial<
    Pick<
      ConversationPrefs,
      'archived' | 'muted' | 'pinned' | 'muted_until' | 'mark_unread'
    >
  >,
): Promise<{ prefs?: ConversationPrefs; error?: string }> {
  return jput(`/chat/conversations/${convId}/prefs`, { viewer, ...prefs })
}

// ---------------------------------------------------------------------------
// Search + media.
// ---------------------------------------------------------------------------
export async function searchMessages(
  viewer: string,
  q: string,
  conversationId = 0,
  limit = 50,
): Promise<ChatMessage[]> {
  const params = new URLSearchParams()
  params.set('viewer', viewer)
  params.set('q', q)
  params.set('conversation_id', String(conversationId))
  params.set('limit', String(limit))

  const d = await jget(`/chat/search?${params.toString()}`)
  return d.messages || []
}

export async function fetchConversationMedia(
  viewer: string,
  convId: number,
  kind: 'all' | 'image' | 'video' | 'voice' | 'file' = 'all',
  beforeId = 0,
  limit = 50,
): Promise<{ messages: ChatMessage[]; has_more: boolean }> {
  const params = new URLSearchParams()
  params.set('viewer', viewer)
  params.set('kind', kind)
  params.set('limit', String(limit))
  if (beforeId) params.set('before_id', String(beforeId))

  const d = await jget(`/chat/conversations/${convId}/media?${params.toString()}`)

  return {
    messages: d.messages || [],
    has_more: !!d.has_more,
  }
}

// ---------------------------------------------------------------------------
// Blocks.
// ---------------------------------------------------------------------------
export async function blockUser(viewer: string, blocked: string): Promise<{ error?: string }> {
  return jpost('/chat/blocks', { viewer, blocked })
}

export async function unblockUser(viewer: string, blocked: string): Promise<{ error?: string }> {
  return jdelete(`/chat/blocks/${encodeURIComponent(blocked)}?viewer=${encodeURIComponent(viewer)}`)
}

export async function listBlocks(
  viewer: string,
): Promise<{ blocked: string; created_at: string }[]> {
  const d = await jget(`/chat/blocks?viewer=${encodeURIComponent(viewer)}`)
  return d.blocks || []
}

// ---------------------------------------------------------------------------
// Reports.
// ---------------------------------------------------------------------------
export async function reportContent(data: {
  viewer: string
  target_type: 'message' | 'conversation' | 'user'
  target_id?: number | null
  target_text?: string | null
  reason: string
  details?: string
}): Promise<{ report_id?: number; error?: string }> {
  return jpost('/chat/reports', data)
}

// ---------------------------------------------------------------------------
// Notifications.
// ---------------------------------------------------------------------------
export async function fetchNotifications(
  viewer: string,
  unreadOnly = false,
  limit = 50,
): Promise<NotificationItem[]> {
  const params = new URLSearchParams()
  params.set('viewer', viewer)
  params.set('unread_only', String(unreadOnly))
  params.set('limit', String(limit))

  const d = await jget(`/chat/notifications?${params.toString()}`)
  return d.notifications || []
}

export async function markNotificationRead(
  viewer: string,
  notificationId: number,
): Promise<{ error?: string }> {
  return jpost(`/chat/notifications/${notificationId}/read`, { viewer })
}

export async function markAllNotificationsRead(viewer: string): Promise<{ error?: string }> {
  return jpost('/chat/notifications/read-all', { viewer })
}

export async function fetchUnreadTotal(
  viewer: string,
): Promise<{ messages: number; notifications: number; total: number }> {
  const d = await jget(`/chat/unread-total?viewer=${encodeURIComponent(viewer)}`)
  return {
    messages: Number(d.messages || 0),
    notifications: Number(d.notifications || 0),
    total: Number(d.total || 0),
  }
}

// ---------------------------------------------------------------------------
// Presence.
// ---------------------------------------------------------------------------
export async function fetchPresence(viewer: string, users: string[]): Promise<PresenceItem[]> {
  if (!users.length) return []

  const params = new URLSearchParams()
  params.set('viewer', viewer)
  params.set('users', users.join(','))

  const d = await jget(`/chat/presence?${params.toString()}`)
  return d.presence || []
}

// ---------------------------------------------------------------------------
// Group management.
// ---------------------------------------------------------------------------
export async function updateConversation(
  viewer: string,
  convId: number,
  data: {
    name?: string
    description?: string | null
    image_url?: string | null
  },
): Promise<{ conversation?: ConversationUpdate; error?: string }> {
  return jpatch(`/chat/conversations/${convId}`, { viewer, ...data })
}

export async function leaveConversation(
  viewer: string,
  convId: number,
): Promise<{ error?: string }> {
  return jpost(`/chat/conversations/${convId}/leave`, { viewer })
}

export async function deleteGroup(
  viewer: string,
  convId: number,
): Promise<{ error?: string }> {
  return jdelete(`/chat/conversations/${convId}?viewer=${encodeURIComponent(viewer)}`)
}

export async function removeGroupMember(
  viewer: string,
  convId: number,
  userName: string,
): Promise<{ error?: string }> {
  return jpost(
    `/chat/conversations/${convId}/members/${encodeURIComponent(userName)}/remove?viewer=${encodeURIComponent(viewer)}`,
    {},
  )
}

export async function promoteGroupMember(
  viewer: string,
  convId: number,
  userName: string,
): Promise<{ error?: string }> {
  return jpost(
    `/chat/conversations/${convId}/members/${encodeURIComponent(userName)}/promote?viewer=${encodeURIComponent(viewer)}`,
    {},
  )
}

export async function demoteGroupMember(
  viewer: string,
  convId: number,
  userName: string,
): Promise<{ error?: string }> {
  return jpost(
    `/chat/conversations/${convId}/members/${encodeURIComponent(userName)}/demote?viewer=${encodeURIComponent(viewer)}`,
    {},
  )
}

export type ReactionDetail = {
  emoji: string
  user_name: string
  display_name: string
  avatar_url: string | null
}

export async function fetchStarredMessages(
  viewer: string,
  limit = 100,
): Promise<ChatMessage[]> {
  const d = await jget(`/chat/starred?viewer=${encodeURIComponent(viewer)}&limit=${limit}`)
  return d.messages || []
}

export async function fetchPinnedMessages(
  viewer: string,
  convId: number,
): Promise<ChatMessage[]> {
  const d = await jget(`/chat/conversations/${convId}/pinned?viewer=${encodeURIComponent(viewer)}`)
  return d.messages || []
}

export async function pinMessage(
  viewer: string,
  messageId: number,
): Promise<{ message?: ChatMessage; error?: string }> {
  return jpost(`/chat/messages/${messageId}/pin`, { viewer })
}

export async function unpinMessage(
  viewer: string,
  messageId: number,
): Promise<{ message?: ChatMessage; error?: string }> {
  return jpost(`/chat/messages/${messageId}/unpin`, { viewer })
}

export async function fetchMessageReactions(
  viewer: string,
  messageId: number,
): Promise<{ reactions?: ReactionDetail[]; error?: string }> {
  const d = await jget(`/chat/messages/${messageId}/reactions?viewer=${encodeURIComponent(viewer)}`)
  return { reactions: d.reactions || [], error: d.error }
}

export async function clearConversationForMe(
  viewer: string,
  convId: number,
): Promise<{ hidden?: number; error?: string }> {
  return jpost(`/chat/conversations/${convId}/clear`, { viewer })
}

export async function markAllChatsRead(viewer: string): Promise<{ error?: string }> {
  return jpost('/chat/read-all', { viewer })
}

export async function muteConversation(
  viewer: string,
  convId: number,
  hours: number | null,
): Promise<{ error?: string }> {
  return jpost(`/chat/conversations/${convId}/mute`, { viewer, hours })
}

export type DiscoverGroup = {
  id: number
  name: string | null
  image_url: string | null
  description: string | null
  join_mode: 'open' | 'request' | string
  member_count: number
  request_status: 'none' | 'pending' | 'approved' | 'rejected' | 'cancelled' | string
}

export async function fetchDiscoverGroups(
  viewer: string,
  q = '',
  limit = 30,
): Promise<DiscoverGroup[]> {
  const params = new URLSearchParams()
  params.set('viewer', viewer)
  params.set('q', q)
  params.set('limit', String(limit))

  const d = await jget(`/chat/discover?${params.toString()}`)
  return d.groups || []
}

export async function joinOrRequestGroup(
  viewer: string,
  convId: number,
  message?: string,
): Promise<{ status?: string; message?: string; error?: string }> {
  return jpost(`/chat/conversations/${convId}/join-request`, {
    viewer,
    message: message || null,
  })
}