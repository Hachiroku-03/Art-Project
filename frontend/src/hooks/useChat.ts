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

const TYPING_TTL = 7000
const TYPING_PRUNE_MS = 3000
const TRANSLATE_DEBOUNCE = 250
const REACTION_SUPPRESS_MS = 2000

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

export function useChat(viewer: string, lang: string) {
  // ---- state ----
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messages, setMessages] = useState<Record<number, ChatMessage[]>>({})
  const [optimistic, setOptimistic] = useState<Record<number, OptimisticMsg[]>>({})
  const [typing, setTyping] = useState<Record<number, Record<string, number>>>({})
  const [readCursors, setReadCursors] = useState<Record<number, Record<string, number>>>({})
  const [deliveredCursors, setDeliveredCursors] = useState<Record<number, Record<string, number>>>({})
  const [hasMoreOlder, setHasMoreOlder] = useState<Record<number, boolean>>({})
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

  // Prevent double-counting reactions when the actor also receives the broadcast frame.
  const reactionSuppress = useRef<Map<number, number>>(new Map())

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
      const cid = msg.conversation_id

      const normalized: ChatMessage = {
        ...msg,
        meta: msg.meta || {},
        reactions: msg.reactions || [],
        starred_by_viewer: !!msg.starred_by_viewer,
        reply_to_id: msg.reply_to_id ?? null,
        forwarded_from_id: msg.forwarded_from_id ?? null,
        edited_at: msg.edited_at ?? null,
      }

      setMessages(prev => {
        const arr = prev[cid] || []
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

      if (normalized.kind === 'text') queueTranslate([normalized.body])
    },
    [queueTranslate],
  )

  const removeMessage = useCallback((convId: number, messageId: number) => {
    setMessages(prev => {
      const arr = prev[convId]
      if (!arr) return prev

      const next = arr.filter(m => m.id !== messageId)
      if (next.length === arr.length) return prev

      return { ...prev, [convId]: next }
    })
  }, [])

  const setStarredLocal = useCallback((convId: number, messageId: number, starred: boolean) => {
    setMessages(prev => {
      const arr = prev[convId]
      if (!arr) return prev

      const next = arr.map(m => (m.id === messageId ? { ...m, starred_by_viewer: starred } : m))
      return { ...prev, [convId]: next }
    })
  }, [])

  const applyReaction = useCallback(
    (convId: number, messageId: number, userName: string, emoji: string, added: boolean) => {
      const suppressUntil = reactionSuppress.current.get(messageId)
      if (suppressUntil && Date.now() < suppressUntil) return

      setMessages(prev => {
        const arr = prev[convId]
        if (!arr) return prev

        let changed = false

        const next = arr.map(m => {
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
    },
    [viewer],
  )

  const findMessage = useCallback((messageId: number) => {
    for (const [cidStr, arr] of Object.entries(messagesRef.current)) {
      const msg = arr.find(m => m.id === messageId)
      if (msg) return { cid: Number(cidStr), message: msg }
    }
    return null
  }, [])

  const commitMessage = useCallback(
    (msg: ChatMessage) => {
      const cid = msg.conversation_id
      const known = (messagesRef.current[cid] || []).some(m => m.id === msg.id)

      upsertMessage(msg)

      if (known) return

      const isActive = cid === activeConvIdRef.current

      setConversations(prev =>
        prev.map(c => {
          if (c.id !== cid) return c

          return {
            ...c,
            last_body: messagePreview(msg.kind, msg.body),
            last_kind: msg.kind,
            last_sender: msg.sender,
            last_at: msg.created_at,
            unread: isActive ? 0 : (c.unread || 0) + (msg.sender === viewer ? 0 : 1),
            mark_unread: isActive ? false : c.mark_unread,
          }
        }),
      )

      if (isActive) doMarkRead(cid, msg.id)
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
  // conversation refresh
  // ---------------------------------------------------------------------
  const refreshConversations = useCallback(() => {
    fetchConversations(viewer)
      .then(setConversations)
      .catch(() => {})
  }, [viewer])

  const closeConversation = useCallback(() => {
    activeConvIdRef.current = null
    setActiveConvId(null)
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

        case 'message_deleted':
          removeMessage(e.conversation_id, e.message_id)
          break

        case 'reaction_added':
          applyReaction(e.conversation_id, e.message_id, e.user_name, e.emoji, true)
          break

        case 'reaction_removed':
          applyReaction(e.conversation_id, e.message_id, e.user_name, e.emoji, false)
          break

        case 'member_removed':
          if (e.user_name === viewer) {
            closeConversation()
          }
          refreshConversations()
          break

        case 'conversation_updated':
          setConversations(prev =>
            prev.map(c => (c.id === e.conversation.id ? ({ ...c, ...e.conversation } as Conversation) : c)),
          )
          break

        case 'reconnect':
          fetchConversations(viewer)
            .then(setConversations)
            .catch(() => {})

          if (activeConvIdRef.current != null) {
            const cid = activeConvIdRef.current
            const arr = messagesRef.current[cid] || []
            const since = arr.length ? arr[arr.length - 1].id : 0

            fetchHistory(cid, viewer, { since })
              .then(p => {
                p.messages.forEach(upsertMessage)

                setReadCursors(prev => ({
                  ...prev,
                  [cid]: { ...(prev[cid] || {}), ...(p.read_cursors || {}) },
                }))

                setDeliveredCursors(prev => ({
                  ...prev,
                  [cid]: { ...(prev[cid] || {}), ...(p.delivered_cursors || {}) },
                }))

                if (p.messages.length && activeConvIdRef.current === cid) {
                  doMarkRead(cid, p.messages[p.messages.length - 1].id)
                }
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
  }, [
    viewer,
    commitMessage,
    dropOptimistic,
    markFailed,
    upsertMessage,
    removeMessage,
    applyReaction,
    refreshConversations,
    closeConversation,
    doMarkRead,
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
      activeConvIdRef.current = cid
      setActiveConvId(cid)

      setConversations(prev =>
        prev.map(c => (c.id === cid ? { ...c, unread: 0, mark_unread: false } : c)),
      )

      const load = (since: number, initial: boolean) =>
        fetchHistory(cid, viewer, { since, limit: 50 })
          .then(p => {
            p.messages.forEach(upsertMessage)

            if (initial) {
              setHasMoreOlder(prev => ({ ...prev, [cid]: p.has_more_older }))
            }

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
        load(0, true)
      } else {
        load(existing.length ? existing[existing.length - 1].id : 0, false)
      }
    },
    [viewer, upsertMessage, doMarkRead],
  )

  const loadOlder = useCallback(
    (cid: number) => {
      if (!hasMoreOlder[cid]) return

      const arr = messagesRef.current[cid] || []
      if (!arr.length) return

      const oldest = arr[0].id

      fetchHistory(cid, viewer, { beforeId: oldest, limit: 50 })
        .then(p => {
          p.messages.forEach(upsertMessage)
          setHasMoreOlder(prev => ({ ...prev, [cid]: p.has_more_older }))
        })
        .catch(() => {})
    },
    [viewer, hasMoreOlder, upsertMessage],
  )

  // ---------------------------------------------------------------------
  // sending
  // ---------------------------------------------------------------------
  const send = useCallback(
    (cid: number, kind: ChatMessage['kind'], body: string, options: SendOptions = {}): string => {
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
        d.messages.forEach(upsertMessage)
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
    hasMoreOlder,
    translations,

    refreshConversations,
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