import { API } from './sales'

// ---------------------------------------------------------------------------
// Types mirror the chat.py payloads exactly.
// ---------------------------------------------------------------------------
export type ChatMessage = {
  id: number
  conversation_id: number
  sender: string
  kind: 'text' | 'image' | 'voice'
  body: string
  created_at: string
  sender_display: string | null
  sender_avatar: string | null
  sender_tier: string | null
}

export type Conversation = {
  id: number
  kind: 'direct' | 'group'
  name: string | null
  image_url: string | null
  last_body: string | null
  last_kind: string | null
  last_sender: string | null
  last_at: string | null
  unread: number
  counterpart: string | null
  counterpart_avatar: string | null
}

export type ChatEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'ack'; temp_id: string | null; message: ChatMessage }
  | { type: 'error'; temp_id: string | null; error: string }
  | { type: 'read'; conversation_id: number; user_name: string; last_read_id: number }
  | { type: 'delivery'; conversation_id: number; user_name: string; last_delivered_id: number }
  | { type: 'typing'; conversation_id: number; user_name: string }
  | { type: 'status'; online: boolean }
  | { type: 'reconnect' }
  | { type: 'disconnect' }

export type HistoryPayload = {
  messages: ChatMessage[]
  read_cursors: Record<string, number>
  delivered_cursors: Record<string, number>
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

async function jpost(path: string, body: unknown): Promise<any> {
  try {
    return await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json())
  } catch {
    return { error: 'network error' }
  }
}

export async function fetchConversations(viewer: string): Promise<Conversation[]> {
  const d = await jget(`/chat/conversations?viewer=${encodeURIComponent(viewer)}`)
  return d.conversations || []
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
): Promise<{ conversation_id?: number; error?: string }> {
  return jpost('/chat/conversations', { viewer, kind: 'group', name, members, image_url })
}

export async function addMember(
  viewer: string,
  convId: number,
  userName: string,
): Promise<{ error?: string }> {
  return jpost(`/chat/conversations/${convId}/members`, { viewer, user_name: userName })
}

export async function fetchHistory(
  convId: number,
  viewer: string,
  since = 0,
): Promise<HistoryPayload> {
  const d = await jget(
    `/chat/conversations/${convId}/messages?viewer=${encodeURIComponent(viewer)}&since=${since}`,
  )

  return {
    messages: d.messages || [],
    read_cursors: d.read_cursors || {},
    delivered_cursors: d.delivered_cursors || {},
  }
}

export async function sendMessageRest(
  convId: number,
  viewer: string,
  kind: ChatMessage['kind'],
  body: string,
): Promise<{ message?: ChatMessage; error?: string }> {
  return jpost(`/chat/conversations/${convId}/messages`, { viewer, kind, body })
}

export async function markReadRest(
  convId: number,
  viewer: string,
  lastReadId: number,
): Promise<{ error?: string }> {
  return jpost(`/chat/conversations/${convId}/read`, { viewer, last_read_id: lastReadId })
}