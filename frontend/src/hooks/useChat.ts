import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { translateMany } from '../lib/translate'
import {
  connect,
  subscribe,
  wsSend,
  socketOpen,
  fetchConversations,
  fetchHistory,
  sendMessageRest,
  markReadRest,
  createDirect,
  createGroup,
  addMember,
  type ChatMessage,
  type ChatEvent,
  type Conversation,
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
}

export type ThreadItem = ChatMessage | OptimisticMsg

export const isOptimistic = (t: ThreadItem): t is OptimisticMsg => 'temp_id' in t

const TYPING_TTL = 7000
const TYPING_PRUNE_MS = 3000
const TRANSLATE_DEBOUNCE = 250

export function useChat(viewer: string, lang: string) {
  // ---- state ----
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messages, setMessages] = useState<Record<number, ChatMessage[]>>({})
  const [optimistic, setOptimistic] = useState<Record<number, OptimisticMsg[]>>({})
  const [typing, setTyping] = useState<Record<number, Record<string, number>>>({})
  const [readCursors, setReadCursors] = useState<Record<number, Record<string, number>>>({})
  const [deliveredCursors, setDeliveredCursors] = useState<Record<number, Record<string, number>>>({})
  const [translations, setTranslations] = useState<Record<string, string>>({})
  const [activeConvId, setActiveConvId] = useState<number | null>(null)
  const [online, setOnline] = useState(false)

  // ---- refs used by the socket handler ----
  const activeConvIdRef = useRef<number | null>(null)
  const langRef = useRef(lang)
  const messagesRef = useRef(messages)
  const conversationsRef = useRef(conversations)
  const lastReadSent = useRef<Record<number, number>>({})
  const seqRef = useRef(0)

  // temp_id -> conversation_id
  const tempConv = useRef<Map<string, number>>(new Map())

  // translation bookkeeping
  const doneTranslate = useRef<Set<string>>(new Set())
  const inFlight = useRef<Set<string>>(new Set())
  const pending = useRef<Set<string>>(new Set())
  const translateTimer = useRef<number | null>(null)

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

    Object.values(messagesRef.current).forEach(arr => {
      arr.forEach(m => {
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
        prev.map(c => (c.id === convId ? { ...c, unread: 0 } : c)),
      )
    },
    [viewer],
  )

  // ---------------------------------------------------------------------
  // commit authoritative message
  // ---------------------------------------------------------------------
  const commitMessage = useCallback(
    (msg: ChatMessage) => {
      const cid = msg.conversation_id

      setMessages(prev => {
        const arr = prev[cid] || []
        if (arr.some(m => m.id === msg.id)) return prev

        return {
          ...prev,
          [cid]: [...arr, msg].sort((a, b) => a.id - b.id),
        }
      })

      if (msg.kind === 'text') queueTranslate([msg.body])

      const isActive = cid === activeConvIdRef.current

      setConversations(prev =>
        prev.map(c => {
          if (c.id !== cid) return c

          const next: Conversation = {
            ...c,
            last_body:
              msg.kind === 'text'
                ? msg.body
                : msg.kind === 'image'
                  ? '📷 Photo'
                  : '🎤 Voice note',
            last_kind: msg.kind,
            last_sender: msg.sender,
            last_at: msg.created_at,
            unread: isActive ? 0 : (c.unread || 0) + (msg.sender === viewer ? 0 : 1),
          }

          return next
        }),
      )

      if (isActive) doMarkRead(cid, msg.id)
    },
    [viewer, queueTranslate, doMarkRead],
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
  // socket handler
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!viewer) return

    connect(viewer)

    fetchConversations(viewer)
      .then(setConversations)
      .catch(() => {})

    const ensureConversationKnown = (cid: number) => {
      const known = conversationsRef.current.some(c => c.id === cid)
      if (!known) {
        fetchConversations(viewer)
          .then(setConversations)
          .catch(() => {})
      }
    }

    const off = subscribe((e: ChatEvent) => {
      switch (e.type) {
        case 'message':
          ensureConversationKnown(e.message.conversation_id)
          commitMessage(e.message)
          break

        case 'ack': {
          const cid = e.message.conversation_id
          ensureConversationKnown(cid)
          if (e.temp_id) dropOptimistic(cid, e.temp_id)
          commitMessage(e.message)
          break
        }

        case 'error': {
          if (!e.temp_id) break

          const cid = tempConv.current.get(e.temp_id)
          if (cid != null) {
            markFailed(cid, e.temp_id, e.error)
            tempConv.current.delete(e.temp_id)
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

        case 'reconnect':
          fetchConversations(viewer)
            .then(setConversations)
            .catch(() => {})

          if (activeConvIdRef.current != null) {
            const cid = activeConvIdRef.current
            const arr = messagesRef.current[cid] || []
            const since = arr.length ? arr[arr.length - 1].id : 0

            fetchHistory(cid, viewer, since)
              .then(p => {
                p.messages.forEach(commitMessage)

                setReadCursors(prev => ({
                  ...prev,
                  [cid]: { ...(prev[cid] || {}), ...(p.read_cursors || {}) },
                }))

                setDeliveredCursors(prev => ({
                  ...prev,
                  [cid]: { ...(prev[cid] || {}), ...(p.delivered_cursors || {}) },
                }))
              })
              .catch(() => {})
          }
          break

        case 'status':
          setOnline(e.online)
          if (e.online) {
            fetchConversations(viewer)
              .then(setConversations)
              .catch(() => {})
          }
          break
      }
    })

    return off
  }, [viewer, commitMessage, dropOptimistic, markFailed])

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
  // actions
  // ---------------------------------------------------------------------
  const refreshConversations = useCallback(() => {
    fetchConversations(viewer)
      .then(setConversations)
      .catch(() => {})
  }, [viewer])

  const openConversation = useCallback(
    (cid: number) => {
      activeConvIdRef.current = cid
      setActiveConvId(cid)

      setConversations(prev =>
        prev.map(c => (c.id === cid ? { ...c, unread: 0 } : c)),
      )

      const load = (since: number) =>
        fetchHistory(cid, viewer, since)
          .then(p => {
            p.messages.forEach(commitMessage)

            setReadCursors(prev => ({
              ...prev,
              [cid]: { ...(prev[cid] || {}), ...(p.read_cursors || {}) },
            }))

            setDeliveredCursors(prev => ({
              ...prev,
              [cid]: { ...(prev[cid] || {}), ...(p.delivered_cursors || {}) },
            }))

            if (p.messages.length) {
              doMarkRead(cid, p.messages[p.messages.length - 1].id)
            }
          })
          .catch(() => {})

      const existing = messagesRef.current[cid]

      if (!existing) {
        load(0)
      } else {
        load(existing.length ? existing[existing.length - 1].id : 0)
      }
    },
    [viewer, commitMessage, doMarkRead],
  )

  const closeConversation = useCallback(() => {
    activeConvIdRef.current = null
    setActiveConvId(null)
  }, [])

  const send = useCallback(
    (cid: number, kind: ChatMessage['kind'], body: string): string => {
      const tempId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const seq = ++seqRef.current

      const opt: OptimisticMsg = {
        temp_id: tempId,
        seq,
        kind,
        body,
        status: 'sending',
        created_at: new Date().toISOString(),
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
        })
      ) {
        return tempId
      }

      sendMessageRest(cid, viewer, kind, body)
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
      send(cid, opt.kind, opt.body)
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

  const startDirect = useCallback(
    async (target: string) => {
      const d = await createDirect(viewer, target)
      if (!d.error && d.conversation_id != null) refreshConversations()
      return d
    },
    [viewer, refreshConversations],
  )

  const startGroup = useCallback(
    async (name: string, members: string[], image_url?: string) => {
      const d = await createGroup(viewer, name, members, image_url)
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

  // ---------------------------------------------------------------------
  // derived
  // ---------------------------------------------------------------------
  const activeThread: ThreadItem[] = useMemo(() => {
    if (activeConvId == null) return []

    const committed = messages[activeConvId] || []
    const opts = (optimistic[activeConvId] || [])
      .slice()
      .sort((a, b) => a.seq - b.seq)

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
    activeConvId,
    activeThread,
    online,
    readCursors,
    deliveredCursors,
    translations,

    refreshConversations,
    openConversation,
    closeConversation,

    send,
    retrySend,
    dismissFailed,
    notifyTyping,

    typingNames,
    textFor,

    startDirect,
    startGroup,
    inviteMember,
  }
}