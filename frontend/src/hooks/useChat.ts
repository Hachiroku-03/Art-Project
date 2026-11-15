import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { translateMany } from '../lib/translate'
import {
  connect,
  subscribe,
  wsSend,
  socketOpen,
  teardown,
  fetchConversations,
  fetchHistory,
  sendMessageRest,
  markReadRest,
  createDirect,
  createGroup,
  addMember,
  editMessage as apiEditMessage,
  deleteMessageForEveryone as apiDeleteMessageForEveryone,
  hideMessageForMe as apiHideMessageForMe,
  reactToMessage as apiReactToMessage,
  unreactToMessage as apiUnreactToMessage,
  starMessage as apiStarMessage,
  unstarMessage as apiUnstarMessage,
  forwardMessage as apiForwardMessage,
  saveDraft as apiSaveDraft,
  deleteDraft as apiDeleteDraft,
  updateConversationPrefs as apiUpdateConversationPrefs,
  leaveConversation as apiLeaveConversation,
  removeGroupMember as apiRemoveGroupMember,
  promoteGroupMember as apiPromoteGroupMember,
  demoteGroupMember as apiDemoteGroupMember,
  updateConversation as apiUpdateConversation,
  type ChatMessage,
  type ChatEvent,
  type Conversation,
  type SendOptions,
  type HistoryOptions,
} from '../lib/chat'

type OptStatus = 'sending' | 'failed'

export type OptimisticMsg = {
  temp_id: string
  seq: number
  kind: ChatMessage['kind']
  body: string
  status: OptStatus
  error?: string
  created_at: string
  reply_to_id?: number | null
  forwarded_from_id?: number | null
  meta?: Record<string, unknown>
}

export type ThreadItem = ChatMessage | OptimisticMsg

export const isOptimistic = (t: ThreadItem): t is OptimisticMsg => 'temp_id' in t

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'error'

const TYPING_TTL = 7000
const TYPING_PRUNE_MS = 3000
const TRANSLATE_DEBOUNCE = 250
const REACTION_SUPPRESS_MS = 2000
const CONVERSATION_SYNC_THROTTLE_MS = 4000

function messagePreview(kind: ChatMessage['kind'], body: string): string {
  if (kind === 'text') return body
  if (kind === 'image') return '📷 Photo'
  if (kind === 'voice') return '🎤 Voice note'
  if (kind === 'video') return '🎬 Video'
  if (kind === 'file') return '📎 File'
  if (kind === 'location') return '📍 Location'
  if (kind === 'contact') return '👤 Contact'
  return body || 'System message'
}

function browserIsOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine
}

// ---------------------------------------------------------------------------
// Defensive input helpers.
//
// The backend can momentarily return partial / undefined message objects
// during Neon cold starts, stale-SSL retries, or REST fallback races.
// Anything that reads `.id` from an array element MUST go through these
// first, otherwise we crash with:
//   Cannot read properties of undefined (reading 'id')
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function isValidMessage(m: unknown): m is ChatMessage {
  if (!m || typeof m !== 'object') return false

  const msg = m as Record<string, unknown>

  return (
    toFiniteNumber(msg.id) !== null &&
    toFiniteNumber(msg.conversation_id) !== null
  )
}

function isValidOptimistic(o: unknown): o is OptimisticMsg {
  if (!o || typeof o !== 'object') return false

  const opt = o as Record<string, unknown>

  return (
    typeof opt.temp_id === 'string' &&
    opt.temp_id.length > 0 &&
    toFiniteNumber(opt.seq) !== null
  )
}

function sanitizeMessages(arr: unknown): ChatMessage[] {
  if (!Array.isArray(arr)) return []

  return arr
    .filter(isValidMessage)
    .map(m => {
      const id = toFiniteNumber(m.id)!
      const conversation_id = toFiniteNumber(m.conversation_id)!

      return {
        ...m,
        id,
        conversation_id,
        meta: m.meta && typeof m.meta === 'object' ? m.meta : {},
        reactions: Array.isArray(m.reactions) ? m.reactions : [],
        starred_by_viewer: !!m.starred_by_viewer,
        reply_to_id: toFiniteNumber(m.reply_to_id),
        forwarded_from_id: toFiniteNumber(m.forwarded_from_id),
        edited_at: m.edited_at ?? null,
      } as ChatMessage
    })
    .sort((a, b) => a.id - b.id)
}

function sanitizeOptimistic(arr: unknown): OptimisticMsg[] {
  if (!Array.isArray(arr)) return []

  return arr
    .filter(isValidOptimistic)
    .map(o => ({
      ...o,
      seq: toFiniteNumber(o.seq) ?? 0,
      reply_to_id: toFiniteNumber(o.reply_to_id) ?? null,
      forwarded_from_id: toFiniteNumber(o.forwarded_from_id) ?? null,
      meta: o.meta && typeof o.meta === 'object' ? o.meta : {},
    }))
    .sort((a, b) => a.seq - b.seq)
}

function safeLastMessageId(arr: unknown): number {
  const clean = sanitizeMessages(arr)
  if (!clean.length) return 0

  const last = clean[clean.length - 1]
  return isFiniteNumber(last.id) ? last.id : 0
}

function safeFirstMessageId(arr: unknown): number {
  const clean = sanitizeMessages(arr)
  if (!clean.length) return 0

  const first = clean[0]
  return isFiniteNumber(first.id) ? first.id : 0
}

// ---------------------------------------------------------------------------
// Module-level conversation cache.
//
// This survives component unmount/remount. When the user switches tabs or
// routes and comes back, the conversation list is already in memory.
//
// 15s TTL: short enough that presence (counterpart_online) and profile
// changes feel near-real-time during local testing, long enough to absorb
// route remounts without refetching every time.
// ---------------------------------------------------------------------------
const CONV_CACHE_TTL = 15_000

type ConvCacheEntry = {
  ts: number
  viewer: string
  conversations: Conversation[]
}

let convCache: ConvCacheEntry | null = null

function getCachedConversations(viewer: string): Conversation[] | null {
  if (!convCache) return null
  if (convCache.viewer !== viewer) return null
  if (Date.now() - convCache.ts > CONV_CACHE_TTL) return null
  return convCache.conversations
}

function setCachedConversations(viewer: string, conversations: Conversation[]) {
  convCache = {
    ts: Date.now(),
    viewer,
    conversations,
  }
}

function invalidateConvCache() {
  convCache = null
}

// ---------------------------------------------------------------------------
// Module-level message/thread cache.
//
// This lets an open chat hydrate instantly after remount, then do a small
// incremental fetch for anything new since the cached last message.
// ---------------------------------------------------------------------------
const MSG_CACHE_TTL = 45_000
const MSG_CACHE_MAX = 80

type MsgCacheEntry = {
  ts: number
  messages: ChatMessage[]
  read_cursors: Record<string, number>
  delivered_cursors: Record<string, number>
  has_more_older: boolean
}

const msgCache = new Map<string, MsgCacheEntry>()

function msgCacheKey(viewer: string, cid: number): string {
  return `${viewer}:${cid}`
}

function trimMsgCache() {
  if (msgCache.size <= MSG_CACHE_MAX) return

  const entries = Array.from(msgCache.entries()).sort((a, b) => a[1].ts - b[1].ts)
  const removeCount = msgCache.size - MSG_CACHE_MAX

  for (let i = 0; i < removeCount; i += 1) {
    msgCache.delete(entries[i][0])
  }
}

function getCachedMessages(viewer: string, cid: number): MsgCacheEntry | null {
  const key = msgCacheKey(viewer, cid)
  const entry = msgCache.get(key)

  if (!entry) return null
  if (Date.now() - entry.ts > MSG_CACHE_TTL) {
    msgCache.delete(key)
    return null
  }

  return entry
}

function setCachedMessages(
  viewer: string,
  cid: number,
  entry: Omit<MsgCacheEntry, 'ts'>,
) {
  const key = msgCacheKey(viewer, cid)
  msgCache.set(key, {
    ts: Date.now(),
    ...entry,
  })
  trimMsgCache()
}

function invalidateMsgCache(viewer?: string, cid?: number) {
  if (viewer != null && cid != null) {
    msgCache.delete(msgCacheKey(viewer, cid))
    return
  }

  if (viewer != null) {
    const prefix = `${viewer}:`
    for (const key of Array.from(msgCache.keys())) {
      if (key.startsWith(prefix)) {
        msgCache.delete(key)
      }
    }
    return
  }

  msgCache.clear()
}

function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const existingClean = sanitizeMessages(existing)
  const incomingClean = sanitizeMessages(incoming)

  if (!incomingClean.length) return existingClean

  const map = new Map<number, ChatMessage>()

  for (const m of existingClean) {
    map.set(m.id, m)
  }

  for (const m of incomingClean) {
    map.set(m.id, m)
  }

  return Array.from(map.values()).sort((a, b) => a.id - b.id)
}

function cacheUpsertMessage(viewer: string, msg: ChatMessage) {
  if (!isValidMessage(msg)) return

  const cid = toFiniteNumber(msg.conversation_id)
  if (cid == null) return

  const key = msgCacheKey(viewer, cid)
  const entry = msgCache.get(key)

  if (!entry) return

  const messages = mergeMessages(entry.messages, [msg])

  msgCache.set(key, {
    ...entry,
    ts: Date.now(),
    messages,
  })
}

function cacheRemoveMessage(viewer: string, cid: number, messageId: number) {
  const key = msgCacheKey(viewer, cid)
  const entry = msgCache.get(key)

  if (!entry) return

  const messages = sanitizeMessages(entry.messages).filter(m => m.id !== messageId)

  if (messages.length === entry.messages.length) return

  msgCache.set(key, {
    ...entry,
    ts: Date.now(),
    messages,
  })
}

function cacheSetStarred(
  viewer: string,
  cid: number,
  messageId: number,
  starred: boolean,
) {
  const key = msgCacheKey(viewer, cid)
  const entry = msgCache.get(key)

  if (!entry) return

  const messages = sanitizeMessages(entry.messages).map(m =>
    m.id === messageId ? { ...m, starred_by_viewer: starred } : m,
  )

  msgCache.set(key, {
    ...entry,
    ts: Date.now(),
    messages,
  })
}

// ---------------------------------------------------------------------------
// Last open conversation persistence.
//
// This is sessionStorage-based, so it survives route/tab remounts during the
// same browser session but does not leak across logout/new browser session.
// ---------------------------------------------------------------------------
const ACTIVE_CONV_PREFIX = 'space_active_conv_'

function getStoredActiveConv(viewer: string): number | null {
  if (!viewer || typeof sessionStorage === 'undefined') return null

  try {
    const raw = sessionStorage.getItem(`${ACTIVE_CONV_PREFIX}${viewer}`)
    if (!raw) return null

    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function setStoredActiveConv(viewer: string, cid: number | null) {
  if (!viewer || typeof sessionStorage === 'undefined') return

  try {
    if (cid == null) {
      sessionStorage.removeItem(`${ACTIVE_CONV_PREFIX}${viewer}`)
    } else {
      sessionStorage.setItem(`${ACTIVE_CONV_PREFIX}${viewer}`, String(cid))
    }
  } catch {
    // ignore
  }
}

export function useChat(viewer: string, lang: string) {
  // ---- state ----
  const [conversations, setConversations] = useState<Conversation[]>(
    () => getCachedConversations(viewer) || [],
  )
  const [messages, setMessages] = useState<Record<number, ChatMessage[]>>({})
  const [optimistic, setOptimistic] = useState<Record<number, OptimisticMsg[]>>({})
  const [typing, setTyping] = useState<Record<number, Record<string, number>>>({})
  const [readCursors, setReadCursors] = useState<Record<number, Record<string, number>>>({})
  const [deliveredCursors, setDeliveredCursors] = useState<Record<number, Record<string, number>>>({})
  const [hasMoreOlder, setHasMoreOlder] = useState<Record<number, boolean>>({})
  const [translations, setTranslations] = useState<Record<string, string>>({})

  // Never restore a stored conversation straight into visible state. That is
  // what made "Conversation unavailable" flash on startup before the list had
  // loaded. We park it in a ref (pendingActiveConvRef) and only promote it once
  // syncConversations confirms the id exists in the freshly loaded list.
  const [activeConvId, setActiveConvIdState] = useState<number | null>(null)
  const [conversationsLoaded, setConversationsLoaded] = useState(false)
  const [online, setOnline] = useState(false)
  const [connection, setConnection] = useState<ConnectionState>('idle')

  // ---- refs used by the socket handler ----
  const activeConvIdRef = useRef<number | null>(activeConvId)
  const langRef = useRef(lang)
  const messagesRef = useRef(messages)
  const conversationsRef = useRef(conversations)
  const lastReadSent = useRef<Record<number, number>>({})
  const seqRef = useRef(0)

  // temp_id -> conversation_id
  const tempConv = useRef<Map<string, number>>(new Map())

  // Prevent double-counting reactions when the actor also receives the broadcast frame.
  const reactionSuppress = useRef<Map<number, number>>(new Map())

  // translation bookkeeping
  const doneTranslate = useRef<Set<string>>(new Set())
  const inFlight = useRef<Set<string>>(new Set())
  const pending = useRef<Set<string>>(new Set())
  const translateTimer = useRef<number | null>(null)

  // conversation sync dedupe
  const conversationsFetchRef = useRef<Promise<Conversation[]> | null>(null)
  const lastConversationsFetchRef = useRef(0)
  const initialSocketSetupRef = useRef<string | null>(null)
  const conversationsLoadedRef = useRef(false)
  const activeViewerRef = useRef<string | null>(viewer || null)
  const wasDisconnectedRef = useRef(false)

  // Loop guards. openedConvRef claims "we have already started opening this
  // cid" so the auto-open effect cannot re-enter; fetchingConvRef dedupes
  // concurrent history fetches for the same cid (StrictMode / double socket).
  const openedConvRef = useRef<number | null>(null)
  const fetchingConvRef = useRef<number | null>(null)

  // Restored-from-sessionStorage id, awaiting validation against the loaded list.
  const pendingActiveConvRef = useRef<number | null>(
    viewer ? getStoredActiveConv(viewer) : null,
  )

  const setActiveConvId = useCallback(
    (cid: number | null) => {
      setActiveConvIdState(cid)
      if (viewer) {
        setStoredActiveConv(viewer, cid)
      }
    },
    [viewer],
  )

  // keep handler-facing refs in sync with render state
  useEffect(() => {
    activeConvIdRef.current = activeConvId
  }, [activeConvId])

  useEffect(() => {
    langRef.current = lang
  }, [lang])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    conversationsRef.current = conversations
  }, [conversations])

  // Keep module conversation cache aligned with state after successful loads.
  useEffect(() => {
    if (viewer && conversationsLoadedRef.current) {
      setCachedConversations(viewer, conversations)
    }
  }, [viewer, conversations])

  // ---------------------------------------------------------------------
  // connection / browser network state
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!viewer) {
      setOnline(false)
      setConnection('idle')
      wasDisconnectedRef.current = false
      return
    }

    const syncConnection = () => {
      if (!browserIsOnline()) {
        setOnline(false)
        setConnection('offline')
        wasDisconnectedRef.current = true
        return
      }

      if (socketOpen()) {
        setOnline(true)
        setConnection('connected')
        return
      }

      setOnline(false)
      setConnection('reconnecting')
      wasDisconnectedRef.current = true
    }

    syncConnection()

    const onOnline = () => syncConnection()
    const onOffline = () => syncConnection()

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    // If the socket never opens shortly after mount, show reconnecting instead of idle.
    const settleTimer = window.setTimeout(() => {
      if (!socketOpen()) {
        setOnline(false)
        setConnection(browserIsOnline() ? 'reconnecting' : 'offline')
        wasDisconnectedRef.current = true
      }
    }, 1500)

    return () => {
      window.clearTimeout(settleTimer)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [viewer])

  // ---------------------------------------------------------------------
  // translation
  // ---------------------------------------------------------------------
  const flushTranslate = useCallback(() => {
    translateTimer.current = null

    const batch = Array.from(pending.current)
    pending.current.clear()

    if (!batch.length) return

    batch.forEach(t => inFlight.current.add(t))

    translateMany(batch, langRef.current)
      .then(out => {
        const map: Record<string, string> = {}

        batch.forEach((orig, i) => {
          const tr = out?.[i]
          if (tr && tr !== orig) {
            map[orig] = tr
            doneTranslate.current.add(orig)
          }
          inFlight.current.delete(orig)
        })

        if (Object.keys(map).length) {
          setTranslations(prev => ({ ...prev, ...map }))
        }
      })
      .catch(() => {
        batch.forEach(t => inFlight.current.delete(t))
      })
  }, [])

  const queueTranslate = useCallback(
    (texts: string[]) => {
      let added = false

      for (const t of texts) {
        if (!t) continue
        if (doneTranslate.current.has(t) || inFlight.current.has(t) || pending.current.has(t)) continue

        pending.current.add(t)
        added = true
      }

      if (!added) return

      if (translateTimer.current !== null) {
        window.clearTimeout(translateTimer.current)
      }

      translateTimer.current = window.setTimeout(flushTranslate, TRANSLATE_DEBOUNCE)
    },
    [flushTranslate],
  )

  useEffect(() => {
    setTranslations({})
    doneTranslate.current.clear()
    inFlight.current.clear()
    pending.current.clear()

    if (translateTimer.current !== null) {
      window.clearTimeout(translateTimer.current)
      translateTimer.current = null
    }

    const all: string[] = []

    // Sanitize each thread before touching m.kind / m.body, because a dirty
    // array element (undefined) would crash here too.
    Object.values(messagesRef.current).forEach(arr => {
      sanitizeMessages(arr).forEach(m => {
        if (m.kind === 'text') all.push(m.body)
      })
    })

    if (all.length) queueTranslate(all)
  }, [lang, queueTranslate])

  // ---------------------------------------------------------------------
  // read receipts
  // ---------------------------------------------------------------------
  const doMarkRead = useCallback(
    (convId: number, id: number) => {
      if (!Number.isFinite(id) || id <= (lastReadSent.current[convId] || 0)) return

      lastReadSent.current[convId] = id

      if (!wsSend({ type: 'read', conversation_id: convId, last_read_id: id })) {
        markReadRest(convId, viewer, id).catch(() => {})
      }

      setReadCursors(prev => ({
        ...prev,
        [convId]: {
          ...(prev[convId] || {}),
          [viewer]: id,
        },
      }))

      setConversations(prev =>
        prev.map(c => (c.id === convId ? { ...c, unread: 0, mark_unread: false } : c)),
      )
    },
    [viewer],
  )

  // ---------------------------------------------------------------------
  // message state helpers
  // ---------------------------------------------------------------------
  const upsertMessage = useCallback(
    (msg: ChatMessage) => {
      if (!isValidMessage(msg)) return

      const cid = toFiniteNumber(msg.conversation_id)
      if (cid == null) return

      const normalized: ChatMessage = {
        ...msg,
        id: toFiniteNumber(msg.id)!,
        conversation_id: cid,
        meta: msg.meta && typeof msg.meta === 'object' ? msg.meta : {},
        reactions: Array.isArray(msg.reactions) ? msg.reactions : [],
        starred_by_viewer: !!msg.starred_by_viewer,
        reply_to_id: toFiniteNumber(msg.reply_to_id),
        forwarded_from_id: toFiniteNumber(msg.forwarded_from_id),
        edited_at: msg.edited_at ?? null,
      }

      setMessages(prev => {
        const arr = sanitizeMessages(prev[cid])
        const idx = arr.findIndex(m => m.id === normalized.id)

        if (idx >= 0) {
          const existing = arr[idx]
          const merged: ChatMessage = {
            ...existing,
            ...normalized,
            starred_by_viewer: normalized.starred_by_viewer ?? existing.starred_by_viewer,
          }

          const next = [...arr]
          next[idx] = merged

          return { ...prev, [cid]: next }
        }

        return {
          ...prev,
          [cid]: [...arr, normalized].sort((a, b) => a.id - b.id),
        }
      })

      if (viewer) {
        cacheUpsertMessage(viewer, normalized)
      }

      if (normalized.kind === 'text') queueTranslate([normalized.body])
    },
    [queueTranslate, viewer],
  )

  const removeMessage = useCallback(
    (convId: number, messageId: number) => {
      setMessages(prev => {
        const arr = prev[convId]
        if (!arr) return prev

        const clean = sanitizeMessages(arr)
        const next = clean.filter(m => m.id !== messageId)
        if (next.length === clean.length) return prev

        return { ...prev, [convId]: next }
      })

      if (viewer) {
        cacheRemoveMessage(viewer, convId, messageId)
      }
    },
    [viewer],
  )

  const setStarredLocal = useCallback(
    (convId: number, messageId: number, starred: boolean) => {
      setMessages(prev => {
        const arr = prev[convId]
        if (!arr) return prev

        const next = sanitizeMessages(arr).map(m =>
          m.id === messageId ? { ...m, starred_by_viewer: starred } : m,
        )

        return { ...prev, [convId]: next }
      })

      if (viewer) {
        cacheSetStarred(viewer, convId, messageId, starred)
      }
    },
    [viewer],
  )

  const applyReaction = useCallback(
    (convId: number, messageId: number, userName: string, emoji: string, added: boolean) => {
      const suppressUntil = reactionSuppress.current.get(messageId)
      if (suppressUntil && Date.now() < suppressUntil) return

      setMessages(prev => {
        const arr = prev[convId]
        if (!arr) return prev

        let changed = false

        const next = sanitizeMessages(arr).map(m => {
          if (m.id !== messageId) return m

          const reactions = [...(m.reactions || [])]
          const idx = reactions.findIndex(r => r.emoji === emoji)

          if (added) {
            if (idx >= 0) {
              const r = reactions[idx]

              if (userName === viewer && r.viewer_reacted) return m

              reactions[idx] = {
                ...r,
                count: r.count + 1,
                viewer_reacted: r.viewer_reacted || userName === viewer,
              }
            } else {
              reactions.push({
                emoji,
                count: 1,
                viewer_reacted: userName === viewer,
              })
            }

            changed = true
            return { ...m, reactions }
          }

          if (idx < 0) return m

          const r = reactions[idx]

          if (userName === viewer && !r.viewer_reacted) return m

          const count = Math.max(0, r.count - 1)
          const viewer_reacted = userName === viewer ? false : r.viewer_reacted

          if (count <= 0) {
            reactions.splice(idx, 1)
          } else {
            reactions[idx] = { ...r, count, viewer_reacted }
          }

          changed = true
          return { ...m, reactions }
        })

        return changed ? { ...prev, [convId]: next } : prev
      })

      // Reaction payloads can change old messages. Invalidate that thread cache
      // so the next remount refetches a clean snapshot.
      if (viewer) {
        invalidateMsgCache(viewer, convId)
      }
    },
    [viewer],
  )

  const findMessage = useCallback((messageId: number) => {
    for (const [cidStr, arr] of Object.entries(messagesRef.current)) {
      const msg = sanitizeMessages(arr).find(m => m.id === messageId)
      if (msg) return { cid: Number(cidStr), message: msg }
    }
    return null
  }, [])

  const commitMessage = useCallback(
    (msg: ChatMessage) => {
      if (!isValidMessage(msg)) return

      const cid = toFiniteNumber(msg.conversation_id)
      if (cid == null) return

      const msgId = toFiniteNumber(msg.id)
      if (msgId == null) return

      const known = sanitizeMessages(messagesRef.current[cid]).some(m => m.id === msgId)

      upsertMessage(msg)

      // INSTANT BADGE: a foreign message just arrived over the socket. Tell the
      // NotificationBell (and ToastHost) to refresh the unread count now instead
      // of waiting for the 45s poll. The bell already listens for this event and
      // debounces it ~250ms, so the badge updates almost immediately.
      if (msg.sender !== viewer) {
        try {
          window.dispatchEvent(new CustomEvent('space:unread-count'))
        } catch {
          // SSR / no window — ignore
        }
      }

      if (known) return

      const isActive = cid === activeConvIdRef.current

      setConversations(prev =>
        prev.map(c => {
          const convId = toFiniteNumber(c.id)
          if (convId !== cid) return c

          return {
            ...c,
            last_body: messagePreview(msg.kind, msg.body),
            last_kind: msg.kind,
            last_sender: msg.sender,
            last_at: msg.created_at,
            unread: isActive ? 0 : (Number(c.unread) || 0) + (msg.sender === viewer ? 0 : 1),
            mark_unread: isActive ? false : c.mark_unread,
          }
        }),
      )

      if (isActive) doMarkRead(cid, msgId)
    },
    [viewer, upsertMessage, doMarkRead],
  )

  const markFailed = useCallback((convId: number, tempId: string, error: string) => {
    setOptimistic(prev => ({
      ...prev,
      [convId]: (prev[convId] || []).map(o =>
        o.temp_id === tempId ? { ...o, status: 'failed', error } : o,
      ),
    }))
  }, [])

  const dropOptimistic = useCallback((convId: number, tempId: string) => {
    tempConv.current.delete(tempId)

    setOptimistic(prev => {
      const arr = prev[convId]
      if (!arr) return prev

      const nextArr = arr.filter(o => o.temp_id !== tempId)
      if (nextArr.length === arr.length) return prev

      return { ...prev, [convId]: nextArr }
    })
  }, [])

  // ---------------------------------------------------------------------
  // Pending-activation validation.
  //
  // Called after every successful conversation load (cache hit or fetch).
  // If a stored active id still exists in the list, promote it to state.
  // If it does not (deleted / archived / wrong account), clear it silently
  // so the user never sees a stale "Conversation unavailable".
  // ---------------------------------------------------------------------
  const validatePendingActiveConv = useCallback(
    (rows: Conversation[]) => {
      const pending = pendingActiveConvRef.current
      if (pending == null) return

      const exists = rows.some(c => c && Number(c.id) === pending)

      if (exists) {
        pendingActiveConvRef.current = null
        setActiveConvId(pending)
      } else {
        pendingActiveConvRef.current = null
        setStoredActiveConv(viewer, null)
      }
    },
    [viewer, setActiveConvId],
  )

  // ---------------------------------------------------------------------
  // conversation refresh / dedupe / cache
  //
  // IMPORTANT TRANSIENT-FAILURE GUARD:
  // fetchConversations() returns [] both when the account genuinely has
  // no chats AND when the backend query failed (stale Neon SSL socket,
  // cold compute, etc). If we previously had a good non-empty list, an
  // empty response is treated as a transient failure: we keep the last
  // good list in state and do NOT poison the cache with [].
  // ---------------------------------------------------------------------
  const syncConversations = useCallback(
    (force = false): Promise<Conversation[]> => {
      if (!viewer) return Promise.resolve([] as Conversation[])

      const now = Date.now()

      // If cached data is fresh enough and not forced, use it immediately.
      if (!force) {
        const cached = getCachedConversations(viewer)
        if (cached) {
          setConversations(cached)
          conversationsLoadedRef.current = true
          setConversationsLoaded(true)
          validatePendingActiveConv(cached)
          return Promise.resolve(cached)
        }
      }

      // Throttle repeated fetches.
      if (!force && now - lastConversationsFetchRef.current < CONVERSATION_SYNC_THROTTLE_MS) {
        return Promise.resolve(conversationsRef.current)
      }

      // Deduplicate in-flight fetches.
      if (conversationsFetchRef.current) {
        return conversationsFetchRef.current
      }

      lastConversationsFetchRef.current = now

      const p = fetchConversations(viewer)
        .then(rawRows => {
          const rows = Array.isArray(rawRows)
            ? rawRows.filter(c => c && Number.isFinite(Number(c.id)))
            : []

          const prev = conversationsRef.current

          // Transient-failure guard: empty response + we had a good list
          // before → keep the good list, do not overwrite cache.
          const keepPrev =
            rows.length === 0 &&
            prev.length > 0 &&
            conversationsLoadedRef.current

          const next = keepPrev ? prev : rows

          setConversations(next)

          if (!keepPrev) {
            setCachedConversations(viewer, next)
          }

          conversationsLoadedRef.current = true
          setConversationsLoaded(true)
          validatePendingActiveConv(next)
          return next
        })
        .catch(() => {
          // Network/parse failure: keep whatever we had.
          return conversationsRef.current
        })
        .finally(() => {
          conversationsFetchRef.current = null
        })

      conversationsFetchRef.current = p

      return p
    },
    [viewer, validatePendingActiveConv],
  )

  const refreshConversations = useCallback(() => {
    invalidateConvCache()
    void syncConversations(true)
  }, [syncConversations])

  const closeConversation = useCallback(() => {
    activeConvIdRef.current = null
    openedConvRef.current = null
    setActiveConvId(null)
  }, [setActiveConvId])

  // ---------------------------------------------------------------------
  // history fetch + cache helper
  // ---------------------------------------------------------------------
  const fetchHistoryAndCache = useCallback(
    async (
      cid: number,
      opts: HistoryOptions,
      options: {
        initial?: boolean
        markRead?: boolean
        updateHasMoreOlder?: boolean
      } = {},
    ) => {
      const {
        initial = false,
        markRead = false,
        updateHasMoreOlder = false,
      } = options

      try {
        const raw = await fetchHistory(cid, viewer, opts)

        const incoming = sanitizeMessages(raw?.messages)

        incoming.forEach(upsertMessage)

        if (initial || updateHasMoreOlder) {
          setHasMoreOlder(prev => ({ ...prev, [cid]: !!raw?.has_more_older }))
        }

        setReadCursors(prev => ({
          ...prev,
          [cid]: { ...(prev[cid] || {}), ...(raw?.read_cursors || {}) },
        }))

        setDeliveredCursors(prev => ({
          ...prev,
          [cid]: { ...(prev[cid] || {}), ...(raw?.delivered_cursors || {}) },
        }))

        if (markRead && incoming.length) {
          doMarkRead(cid, incoming[incoming.length - 1].id)
        }

        const old = getCachedMessages(viewer, cid)
        const baseMessages = sanitizeMessages(old?.messages ?? messagesRef.current[cid])
        const merged = mergeMessages(baseMessages, incoming)

        setCachedMessages(viewer, cid, {
          messages: merged,
          read_cursors: {
            ...(old?.read_cursors || {}),
            ...(raw?.read_cursors || {}),
          },
          delivered_cursors: {
            ...(old?.delivered_cursors || {}),
            ...(raw?.delivered_cursors || {}),
          },
          has_more_older:
            initial || updateHasMoreOlder
              ? !!raw?.has_more_older
              : old?.has_more_older ?? !!raw?.has_more_older,
        })

        return {
          messages: incoming,
          read_cursors: raw?.read_cursors || {},
          delivered_cursors: raw?.delivered_cursors || {},
          has_more_older: !!raw?.has_more_older,
          has_more_newer: !!raw?.has_more_newer,
        }
      } catch {
        return {
          messages: [],
          read_cursors: {},
          delivered_cursors: {},
          has_more_older: false,
          has_more_newer: false,
        }
      }
    },
    [viewer, upsertMessage, doMarkRead],
  )

  // ---------------------------------------------------------------------
  // socket handler
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!viewer) {
      setOnline(false)
      setConnection('idle')
      wasDisconnectedRef.current = false
      return
    }

    // If the viewer changed in the same mounted component, tear down the old socket first.
    if (activeViewerRef.current && activeViewerRef.current !== viewer) {
      const oldViewer = activeViewerRef.current

      try {
        teardown()
      } catch {
        // ignore
      }

      invalidateConvCache()
      invalidateMsgCache(oldViewer)
      setStoredActiveConv(oldViewer, null)

      setMessages({})
      setOptimistic({})
      setReadCursors({})
      setDeliveredCursors({})
      setHasMoreOlder({})
      setTranslations({})
      doneTranslate.current.clear()
      inFlight.current.clear()
      pending.current.clear()

      openedConvRef.current = null
      fetchingConvRef.current = null

      const cachedConv = getCachedConversations(viewer)
      setConversations(cachedConv || [])
      conversationsLoadedRef.current = !!cachedConv
      setConversationsLoaded(!!cachedConv)

      // Park the restored id; do not promote it into visible state yet.
      pendingActiveConvRef.current = getStoredActiveConv(viewer)
      setActiveConvIdState(null)
      activeConvIdRef.current = null

      initialSocketSetupRef.current = null

      // If we already have a cached list, validate immediately.
      if (cachedConv) {
        validatePendingActiveConv(cachedConv)
      }
    }

    activeViewerRef.current = viewer

    // Connect and do the initial conversation sync only once per viewer.
    // Use non-force sync so cached conversations hydrate instantly.
    if (initialSocketSetupRef.current !== viewer) {
      initialSocketSetupRef.current = viewer
      connect(viewer)
      void syncConversations(false)
    }

    const ensureConversationKnown = (cid: number) => {
      const known = conversationsRef.current.some(c => c.id === cid)
      if (!known) {
        void syncConversations(true)
      }
    }

    const off = subscribe((e: ChatEvent) => {
      switch (e.type) {
        case 'message': {
          const msg = e.message
          if (!isValidMessage(msg)) break

          const cid = toFiniteNumber(msg.conversation_id)
          if (cid == null) break

          ensureConversationKnown(cid)
          commitMessage(msg)
          break
        }

        case 'ack': {
          const msg = e.message
          if (!isValidMessage(msg)) break

          const cid = toFiniteNumber(msg.conversation_id)
          if (cid == null) break

          ensureConversationKnown(cid)

          if (e.temp_id) dropOptimistic(cid, e.temp_id)

          commitMessage(msg)
          break
        }

        case 'error': {
          if (!e.temp_id) break

          const cid = e.conversation_id ?? tempConv.current.get(e.temp_id)
          if (cid != null) {
            markFailed(cid, e.temp_id, e.error)
          }
          break
        }

        case 'read':
          setReadCursors(prev => ({
            ...prev,
            [e.conversation_id]: {
              ...(prev[e.conversation_id] || {}),
              [e.user_name]: e.last_read_id,
            },
          }))
          break

        case 'delivery':
          setDeliveredCursors(prev => ({
            ...prev,
            [e.conversation_id]: {
              ...(prev[e.conversation_id] || {}),
              [e.user_name]: e.last_delivered_id,
            },
          }))
          break

        case 'typing':
          if (e.user_name !== viewer) {
            setTyping(prev => ({
              ...prev,
              [e.conversation_id]: {
                ...(prev[e.conversation_id] || {}),
                [e.user_name]: Date.now(),
              },
            }))
          }
          break

        case 'message_edited':
          upsertMessage(e.message)
          break

        case 'message_deleted': {
          const cid = toFiniteNumber(e.conversation_id)
          const messageId = toFiniteNumber(e.message_id)
          if (cid != null && messageId != null) {
            removeMessage(cid, messageId)
          }
          break
        }

        case 'reaction_added': {
          const cid = toFiniteNumber(e.conversation_id)
          const messageId = toFiniteNumber(e.message_id)
          if (cid != null && messageId != null) {
            applyReaction(cid, messageId, e.user_name, e.emoji, true)
          }
          break
        }

        case 'reaction_removed': {
          const cid = toFiniteNumber(e.conversation_id)
          const messageId = toFiniteNumber(e.message_id)
          if (cid != null && messageId != null) {
            applyReaction(cid, messageId, e.user_name, e.emoji, false)
          }
          break
        }

        case 'member_removed':
          if (e.user_name === viewer) {
            closeConversation()
          }

          void syncConversations(true)
          break

        case 'conversation_updated':
          setConversations(prev =>
            prev.map(c =>
              c.id === e.conversation.id ? ({ ...c, ...e.conversation } as Conversation) : c,
            ),
          )
          break

        case 'reconnect': {
          // If this reconnect follows a real disconnect, force a fresh conversation sync.
          // If it is just the initial socket open, use cache to keep the UI instant.
          const forceConvSync = wasDisconnectedRef.current
          void syncConversations(forceConvSync)
          wasDisconnectedRef.current = false

          const cid = activeConvIdRef.current

          if (cid != null && fetchingConvRef.current !== cid) {
            const since = safeLastMessageId(messagesRef.current[cid])
            void fetchHistoryAndCache(cid, { since }, { markRead: true })
          }
          break
        }

        case 'status': {
          setOnline(e.online)

          if (e.state) {
            setConnection(e.state)
          } else if (e.online) {
            setConnection('connected')
          } else {
            setConnection(browserIsOnline() ? 'reconnecting' : 'offline')
          }

          if (
            !e.online ||
            e.state === 'reconnecting' ||
            e.state === 'offline' ||
            e.state === 'error'
          ) {
            wasDisconnectedRef.current = true
          }

          // IMPORTANT:
          // Do not refetch conversations here. The reconnect event handles sync.
          break
        }
      }
    })

    return off
  }, [
    viewer,
    syncConversations,
    fetchHistoryAndCache,
    commitMessage,
    dropOptimistic,
    markFailed,
    upsertMessage,
    removeMessage,
    applyReaction,
    closeConversation,
    validatePendingActiveConv,
  ])

  // prune typing flags
  useEffect(() => {
    const interval = window.setInterval(() => {
      const now = Date.now()

      setTyping(prev => {
        let changed = false
        const next: Record<number, Record<string, number>> = {}

        for (const [cidStr, users] of Object.entries(prev)) {
          const cid = Number(cidStr)
          const keep: Record<string, number> = {}

          for (const [u, ts] of Object.entries(users)) {
            if (now - ts < TYPING_TTL) {
              keep[u] = ts
            } else {
              changed = true
            }
          }

          if (Object.keys(keep).length) {
            next[cid] = keep
          } else {
            changed = true
          }
        }

        return changed ? next : prev
      })
    }, TYPING_PRUNE_MS)

    return () => window.clearInterval(interval)
  }, [])

  // clear translate timer
  useEffect(
    () => () => {
      if (translateTimer.current !== null) {
        window.clearTimeout(translateTimer.current)
      }
    },
    [],
  )

  // ---------------------------------------------------------------------
  // conversation open/load/pagination
  // ---------------------------------------------------------------------
  const openConversation = useCallback(
    (cid: number) => {
      // Re-entry / double-fetch guard. If a fetch for this cid is already in
      // flight, do nothing — this alone kills the limit=50 storm.
      if (fetchingConvRef.current === cid) return

      fetchingConvRef.current = cid
      openedConvRef.current = cid

      activeConvIdRef.current = cid
      setActiveConvId(cid)

      setConversations(prev =>
        prev.map(c => (c.id === cid ? { ...c, unread: 0, mark_unread: false } : c)),
      )

      const cached = getCachedMessages(viewer, cid)
      const cachedMessages = sanitizeMessages(cached?.messages)

      if (cachedMessages.length) {
        setMessages(prev => ({
          ...prev,
          [cid]: mergeMessages(sanitizeMessages(prev[cid]), cachedMessages),
        }))

        setReadCursors(prev => ({
          ...prev,
          [cid]: { ...(prev[cid] || {}), ...cached?.read_cursors },
        }))

        setDeliveredCursors(prev => ({
          ...prev,
          [cid]: { ...(prev[cid] || {}), ...cached?.delivered_cursors },
        }))

        setHasMoreOlder(prev => ({ ...prev, [cid]: !!cached?.has_more_older }))
      }

      const refArr = sanitizeMessages(messagesRef.current[cid])
      const lastId = Math.max(
        safeLastMessageId(refArr),
        safeLastMessageId(cachedMessages),
      )

      const initial = cachedMessages.length === 0 && refArr.length === 0

      fetchHistoryAndCache(
        cid,
        initial ? { limit: 50 } : { since: lastId, limit: 50 },
        {
          initial,
          markRead: true,
        },
      ).finally(() => {
        if (fetchingConvRef.current === cid) {
          fetchingConvRef.current = null
        }
      })
    },
    [viewer, setActiveConvId, fetchHistoryAndCache],
  )

  // Auto-open a restored active conversation exactly once.
  //
  // NOTE: `conversations` is deliberately NOT a dependency. Including it made
  // this effect re-fire on every setConversations identity change, and because
  // messagesRef lags state by one render the `arr.length === 0` guard stayed
  // true, producing the limit=50 polling storm that saturated the Neon pool.
  // openedConvRef + fetchingConvRef claim the cid synchronously so neither a
  // re-render nor StrictMode's double-invoke can re-enter.
  useEffect(() => {
    if (!viewer || activeConvId == null) {
      openedConvRef.current = null
      return
    }

    if (!conversationsLoadedRef.current) return
    if (openedConvRef.current === activeConvId) return
    if (fetchingConvRef.current === activeConvId) return

    const arr = sanitizeMessages(messagesRef.current[activeConvId])

    if (arr.length > 0) {
      openedConvRef.current = activeConvId
      return
    }

    openedConvRef.current = activeConvId
    openConversation(activeConvId)
  }, [viewer, activeConvId, openConversation])

  const loadOlder = useCallback(
    (cid: number) => {
      if (!hasMoreOlder[cid]) return

      const arr = sanitizeMessages(messagesRef.current[cid])
      if (!arr.length) return

      const oldest = safeFirstMessageId(arr)
      if (!Number.isFinite(oldest) || oldest <= 0) return

      void fetchHistoryAndCache(
        cid,
        { beforeId: oldest, limit: 50 },
        { updateHasMoreOlder: true },
      )
    },
    [hasMoreOlder, fetchHistoryAndCache],
  )

  // ---------------------------------------------------------------------
  // sending
  // ---------------------------------------------------------------------
  const send = useCallback(
    (
      cid: number,
      kind: ChatMessage['kind'],
      body: string,
      options: SendOptions = {},
    ): string => {
      const tempId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const seq = ++seqRef.current

      const opt: OptimisticMsg = {
        temp_id: tempId,
        seq,
        kind,
        body,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_id: options.reply_to_id ?? null,
        forwarded_from_id: options.forwarded_from_id ?? null,
        meta: options.meta || {},
      }

      tempConv.current.set(tempId, cid)

      setOptimistic(prev => ({
        ...prev,
        [cid]: [...(prev[cid] || []), opt],
      }))

      if (
        socketOpen() &&
        wsSend({
          type: 'message',
          conversation_id: cid,
          kind,
          body,
          temp_id: tempId,
          reply_to_id: options.reply_to_id ?? null,
          forwarded_from_id: options.forwarded_from_id ?? null,
          meta: options.meta || {},
        })
      ) {
        return tempId
      }

      sendMessageRest(cid, viewer, kind, body, options)
        .then(d => {
          dropOptimistic(cid, tempId)

          if (d.message) {
            commitMessage(d.message)
          } else {
            markFailed(cid, tempId, d.error || 'send failed')
          }
        })
        .catch(() => markFailed(cid, tempId, 'network error'))

      return tempId
    },
    [viewer, commitMessage, dropOptimistic, markFailed],
  )

  const retrySend = useCallback(
    (cid: number, tempId: string) => {
      const opt = (optimistic[cid] || []).find(o => o.temp_id === tempId)
      if (!opt) return

      dropOptimistic(cid, tempId)
      send(cid, opt.kind, opt.body, {
        reply_to_id: opt.reply_to_id,
        forwarded_from_id: opt.forwarded_from_id,
        meta: opt.meta,
      })
    },
    [optimistic, dropOptimistic, send],
  )

  const dismissFailed = useCallback(
    (cid: number, tempId: string) => dropOptimistic(cid, tempId),
    [dropOptimistic],
  )

  const typingThrottle = useRef<Record<number, number>>({})

  const notifyTyping = useCallback((cid: number) => {
    const now = Date.now()
    if (now - (typingThrottle.current[cid] || 0) < 2000) return

    typingThrottle.current[cid] = now
    wsSend({ type: 'typing', conversation_id: cid })
  }, [])

  // ---------------------------------------------------------------------
  // message feature actions
  // ---------------------------------------------------------------------
  const editMessage = useCallback(
    async (messageId: number, body: string) => {
      const d = await apiEditMessage(messageId, viewer, body)
      if (d.message) upsertMessage(d.message)
      return d
    },
    [viewer, upsertMessage],
  )

  const deleteMessageForEveryone = useCallback(
    async (messageId: number) => {
      const found = findMessage(messageId)
      const d = await apiDeleteMessageForEveryone(messageId, viewer)

      if (found) removeMessage(found.cid, messageId)

      return d
    },
    [viewer, findMessage, removeMessage],
  )

  const hideMessageForMe = useCallback(
    async (messageId: number) => {
      const found = findMessage(messageId)
      const d = await apiHideMessageForMe(messageId, viewer)

      if (!d.error && found) removeMessage(found.cid, messageId)

      return d
    },
    [viewer, findMessage, removeMessage],
  )

  const react = useCallback(
    async (messageId: number, emoji: string) => {
      const d = await apiReactToMessage(messageId, viewer, emoji)

      if (d.message) {
        upsertMessage(d.message)
        reactionSuppress.current.set(messageId, Date.now() + REACTION_SUPPRESS_MS)
      }

      return d
    },
    [viewer, upsertMessage],
  )

  const unreact = useCallback(
    async (messageId: number, emoji: string) => {
      const d = await apiUnreactToMessage(messageId, viewer, emoji)

      if (d.message) {
        upsertMessage(d.message)
        reactionSuppress.current.set(messageId, Date.now() + REACTION_SUPPRESS_MS)
      }

      return d
    },
    [viewer, upsertMessage],
  )

  const star = useCallback(
    async (messageId: number) => {
      const found = findMessage(messageId)
      const d = await apiStarMessage(messageId, viewer)

      if (!d.error && found) setStarredLocal(found.cid, messageId, true)

      return d
    },
    [viewer, findMessage, setStarredLocal],
  )

  const unstar = useCallback(
    async (messageId: number) => {
      const found = findMessage(messageId)
      const d = await apiUnstarMessage(messageId, viewer)

      if (!d.error && found) setStarredLocal(found.cid, messageId, false)

      return d
    },
    [viewer, findMessage, setStarredLocal],
  )

  const forward = useCallback(
    async (messageId: number, toConversationIds: number[]) => {
      const d = await apiForwardMessage(messageId, viewer, toConversationIds)

      if (d.messages) {
        sanitizeMessages(d.messages).forEach(upsertMessage)
      }

      refreshConversations()
      return d
    },
    [viewer, upsertMessage, refreshConversations],
  )

  // ---------------------------------------------------------------------
  // drafts
  // ---------------------------------------------------------------------
  const saveDraft = useCallback(
    async (cid: number, body: string) => {
      const d = await apiSaveDraft(viewer, cid, body)

      if (!d.error) {
        setConversations(prev =>
          prev.map(c => (c.id === cid ? { ...c, draft: d.draft?.body ?? null } : c)),
        )
      }

      return d
    },
    [viewer],
  )

  const deleteDraft = useCallback(
    async (cid: number) => {
      const d = await apiDeleteDraft(viewer, cid)

      if (!d.error) {
        setConversations(prev => prev.map(c => (c.id === cid ? { ...c, draft: null } : c)))
      }

      return d
    },
    [viewer],
  )

  // ---------------------------------------------------------------------
  // conversation prefs
  // ---------------------------------------------------------------------
  const updatePrefs = useCallback(
    async (
      cid: number,
      prefs: Partial<{
        archived: boolean
        muted: boolean
        pinned: boolean
        muted_until: string | null
        mark_unread: boolean
      }>,
    ) => {
      const d = await apiUpdateConversationPrefs(viewer, cid, prefs)

      if (!d.error && d.prefs) {
        setConversations(prev =>
          prev.map(c =>
            c.id === cid
              ? {
                  ...c,
                  archived: d.prefs!.archived,
                  muted: d.prefs!.muted,
                  pinned: d.prefs!.pinned,
                  pinned_at: d.prefs!.pinned_at,
                  mark_unread: d.prefs!.mark_unread,
                }
              : c,
          ),
        )

        refreshConversations()
      }

      return d
    },
    [viewer, refreshConversations],
  )

  // ---------------------------------------------------------------------
  // conversation creation / group actions
  // ---------------------------------------------------------------------
  const startDirect = useCallback(
    async (target: string) => {
      const d = await createDirect(viewer, target)
      if (!d.error && d.conversation_id != null) refreshConversations()
      return d
    },
    [viewer, refreshConversations],
  )

  const startGroup = useCallback(
    async (name: string, members: string[], image_url?: string, description?: string) => {
      const d = await createGroup(viewer, name, members, image_url, description)
      if (!d.error && d.conversation_id != null) refreshConversations()
      return d
    },
    [viewer, refreshConversations],
  )

  const inviteMember = useCallback(
    async (cid: number, userName: string) => {
      const d = await addMember(viewer, cid, userName)
      if (!d.error) refreshConversations()
      return d
    },
    [viewer, refreshConversations],
  )

  const leaveConversation = useCallback(
    async (cid: number) => {
      const d = await apiLeaveConversation(viewer, cid)

      if (!d.error) {
        if (activeConvIdRef.current === cid) closeConversation()
        refreshConversations()
      }

      return d
    },
    [viewer, closeConversation, refreshConversations],
  )

  const removeMember = useCallback(
    async (cid: number, userName: string) => {
      const d = await apiRemoveGroupMember(viewer, cid, userName)
      if (!d.error) refreshConversations()
      return d
    },
    [viewer, refreshConversations],
  )

  const promoteMember = useCallback(
    async (cid: number, userName: string) => {
      const d = await apiPromoteGroupMember(viewer, cid, userName)
      if (!d.error) refreshConversations()
      return d
    },
    [viewer, refreshConversations],
  )

  const demoteMember = useCallback(
    async (cid: number, userName: string) => {
      const d = await apiDemoteGroupMember(viewer, cid, userName)
      if (!d.error) refreshConversations()
      return d
    },
    [viewer, refreshConversations],
  )

  const updateConversationInfo = useCallback(
    async (
      cid: number,
      data: {
        name?: string
        description?: string | null
        image_url?: string | null
      },
    ) => {
      const d = await apiUpdateConversation(viewer, cid, data)

      if (!d.error && d.conversation) {
        setConversations(prev =>
          prev.map(c => (c.id === cid ? ({ ...c, ...d.conversation } as Conversation) : c)),
        )
      }

      return d
    },
    [viewer],
  )

  // ---------------------------------------------------------------------
  // derived
  // ---------------------------------------------------------------------
  const activeThread: ThreadItem[] = useMemo(() => {
    if (activeConvId == null) return []

    const committed = sanitizeMessages(messages[activeConvId])
    const opts = sanitizeOptimistic(optimistic[activeConvId])

    return [...committed, ...opts]
  }, [activeConvId, messages, optimistic])

  const typingNames = useCallback(
    (cid: number): string[] => {
      const m = typing[cid]
      if (!m) return []

      const now = Date.now()
      return Object.keys(m).filter(u => now - m[u] < TYPING_TTL)
    },
    [typing],
  )

  const textFor = useCallback(
    (original: string): string => translations[original] ?? '',
    [translations],
  )

  return {
    conversations,
    conversationsLoaded,
    activeConvId,
    activeThread,
    online,
    connection,
    readCursors,
    deliveredCursors,
    hasMoreOlder,
    translations,

    refreshConversations,
    syncConversations,
    openConversation,
    closeConversation,
    loadOlder,

    send,
    retrySend,
    dismissFailed,
    notifyTyping,

    typingNames,
    textFor,

    editMessage,
    deleteMessageForEveryone,
    hideMessageForMe,
    react,
    unreact,
    star,
    unstar,
    forward,

    saveDraft,
    deleteDraft,
    updatePrefs,

    startDirect,
    startGroup,
    inviteMember,
    leaveConversation,
    removeMember,
    promoteMember,
    demoteMember,
    updateConversationInfo,
  }
}