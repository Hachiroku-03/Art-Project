import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  BellOff,
  Check,
  CheckCheck,
  Clock,
  Copy,
  Download,
  Eraser,
  ExternalLink,
  Forward,
  Image as ImageIcon,
  Info,
  Maximize2,
  MessageCircle,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Reply,
  RotateCcw,
  Search,
  Send,
  Smile,
  Star,
  Trash2,
  Undo,
  Users,
  X,
} from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { VoiceRecorder } from '../components/VoiceRecorder'
import { VoiceNote } from '../components/VoiceNote'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { Lightbox } from '../components/Lightbox'
import { ChatBackground } from '../components/chat/ChatBackground'
import { ChatInfoPanel } from '../components/chat/ChatInfoPanel'
import { useChat, isOptimistic } from '../hooks/useChat'
import { API } from '../lib/sales'
import { updateCommunityGroupMeta } from '../lib/community'
import {
  searchMessages,
  fetchConversationMembers,
  fetchConversations,
  fetchStarredMessages,
  fetchPinnedMessages,
  fetchMessageReactions,
  pinMessage,
  unpinMessage,
  clearConversationForMe,
  markAllChatsRead,
  muteConversation,
  subscribe,
  wsSend,
  type ChatMessage,
  type Conversation,
  type GroupMember,
  type ReactionDetail,
} from '../lib/chat'
import styles from './MessengerPage.module.css'

const AUTH_API = 'http://localhost:8000'
const QUICK_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🙏']

const RECORDING_TTL = 15000
const RECORDING_HEARTBEAT = 7000

type Filter = 'all' | 'unread' | 'starred' | 'groups' | 'archived'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'starred', label: 'Starred' },
  { key: 'groups', label: 'Groups' },
  { key: 'archived', label: 'Archived' },
]

type MenuKind = 'conversation' | 'thread' | 'message' | 'reaction'

type ActiveMenu = {
  kind: MenuKind
  id?: number
  x: number
  y: number
  align: 'left' | 'right'
  vertical: 'up' | 'down'
} | null

type LinkItem = {
  url: string
  domain: string
}

function parseDate(raw?: string | null) {
  if (!raw) return new Date(NaN)
  return new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
}

function shortTime(raw?: string | null) {
  const d = parseDate(raw)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function fromNow(raw?: string | null) {
  const d = parseDate(raw)
  if (isNaN(d.getTime())) return ''

  const s = Math.round((Date.now() - d.getTime()) / 1000)

  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`

  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function firstLetter(name?: string | null) {
  return (name || '?')[0]?.toUpperCase() || '?'
}

function dayLabel(d: Date) {
  if (isNaN(d.getTime())) return ''

  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'

  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

function isDesktop() {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 900px)').matches
}

function fileNameFromUrl(url: string) {
  try {
    const u = new URL(url, window.location.origin)
    const name = u.pathname.split('/').pop()
    return name && name.trim() ? name : 'image'
  } catch {
    return 'image'
  }
}

function metaString(msg: ChatMessage | null, key: string, fallback = '') {
  if (!msg) return fallback

  const v = (msg.meta as Record<string, unknown> | undefined)?.[key]
  return v == null ? fallback : String(v)
}

function previewForKind(kind: ChatMessage['kind'] | null, body: string) {
  if (kind === 'text') return body
  if (kind === 'image') return '📷 Photo'
  if (kind === 'voice') return '🎤 Voice note'
  if (kind === 'video') return '🎬 Video'
  if (kind === 'file') return '📎 File'
  if (kind === 'location') return '📍 Location'
  if (kind === 'contact') return '👤 Contact'
  if (kind === 'system') return body || 'System message'
  return body || 'New message'
}

function convMatches(c: Conversation, q: string) {
  const title = (c.kind === 'group' ? c.name || 'Group' : c.counterpart || 'Direct').toLowerCase()
  return title.includes(q) || (c.last_body || '').toLowerCase().includes(q)
}

function isUnread(c: Conversation) {
  return (c.unread || 0) > 0 || c.mark_unread
}

function extractLinks(body: string): LinkItem[] {
  const matches = body.match(/https?:\/\/[^\s<>"')\]]+/g) || []

  return matches.slice(0, 5).map(url => {
    let domain = url
    try {
      domain = new URL(url).hostname
    } catch {
      domain = url
    }
    return { url, domain }
  })
}

function getLinks(msg: ChatMessage | null, body: string): LinkItem[] {
  const metaLinks = (msg?.meta as Record<string, unknown> | undefined)?.links

  if (Array.isArray(metaLinks)) {
    return metaLinks
      .filter(x => typeof x === 'object' && x !== null && 'url' in x)
      .map(x => {
        const item = x as { url?: unknown; domain?: unknown }
        const url = String(item.url || '')
        let domain = String(item.domain || '')

        if (!domain) {
          try {
            domain = new URL(url).hostname
          } catch {
            domain = url
          }
        }

        return { url, domain }
      })
      .filter(x => x.url)
  }

  return extractLinks(body)
}

function renderTextWithMentions(text: string) {
  const parts = text.split(/(@[A-Za-z0-9_.\-]+)/g)

  return parts.map((part, i) =>
    part.startsWith('@') ? (
      <span key={`${part}-${i}`} className={styles.mention}>
        {part}
      </span>
    ) : (
      part
    ),
  )
}

function Avatar({
  src,
  name,
  className,
}: {
  src?: string | null
  name?: string | null
  className: string
}) {
  return (
    <span className={className}>
      {src ? <img src={src} alt="" className={styles.avatarImg} /> : firstLetter(name)}
    </span>
  )
}

export function MessengerPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const viewer = localStorage.getItem('space_user') || ''

  const [lang, setLang] = useState('en')

  const {
    conversations,
    activeConvId: cid,
    activeThread,
    online,
    readCursors,
    deliveredCursors,
    hasMoreOlder,
    openConversation,
    closeConversation,
    loadOlder,
    refreshConversations,
    send,
    retrySend,
    dismissFailed,
    notifyTyping,
    typingNames,
    textFor,
    startGroup,
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
    leaveConversation,
  } = useChat(viewer, lang)

  const [showThreadMobile, setShowThreadMobile] = useState(false)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [lightbox, setLightbox] = useState<{ items: string[]; index: number } | null>(null)

  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [editing, setEditing] = useState<ChatMessage | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)

  const [forwardMessage, setForwardMessage] = useState<ChatMessage | null>(null)
  const [forwardTargets, setForwardTargets] = useState<number[]>([])

  const [showGroupModal, setShowGroupModal] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupMemberText, setGroupMemberText] = useState('')
  const [groupDescription, setGroupDescription] = useState('')
  const [groupCategory, setGroupCategory] = useState('')
  const [groupScene, setGroupScene] = useState('')
  const [groupJoinMode, setGroupJoinMode] = useState('request')
  const [creatingGroup, setCreatingGroup] = useState(false)

  const [searchResults, setSearchResults] = useState<ChatMessage[]>([])
  const [searching, setSearching] = useState(false)

  const [filter, setFilter] = useState<Filter>('all')
  const [archivedConvs, setArchivedConvs] = useState<Conversation[]>([])
  const [members, setMembers] = useState<Record<number, GroupMember[]>>({})

  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(null)

  const [remoteRecording, setRemoteRecording] = useState<Record<number, Record<string, number>>>({})
  const localRecordingCidRef = useRef<number | null>(null)
  const localRecordingTimerRef = useRef<number | null>(null)

  const [starredMessages, setStarredMessages] = useState<ChatMessage[]>([])
  const [loadingStarred, setLoadingStarred] = useState(false)

  const [pinnedMessages, setPinnedMessages] = useState<ChatMessage[]>([])
  const [showPinned, setShowPinned] = useState(true)

  const [threadSearchOpen, setThreadSearchOpen] = useState(false)
  const [threadQuery, setThreadQuery] = useState('')
  const [threadResults, setThreadResults] = useState<ChatMessage[]>([])
  const [searchingThread, setSearchingThread] = useState(false)
  const [jumpToMessageId, setJumpToMessageId] = useState<number | null>(null)

  const [reactionDetail, setReactionDetail] = useState<{ messageId: number; items: ReactionDetail[] } | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const draftTimer = useRef<number | null>(null)
  const lastDraftSaved = useRef<string>('')
  const audioCtxRef = useRef<AudioContext | null>(null)

  const autosizeComposer = useCallback(() => {
    const el = inputRef.current
    if (!el) return

    el.style.height = 'auto'

    const maxHeight = window.matchMedia('(max-width: 900px)').matches ? 132 : 180
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [])

  useEffect(() => {
    autosizeComposer()
  }, [autosizeComposer, cid, draft, editing])

  const activeConv = useMemo(() => {
    if (cid == null) return undefined

    return (
      conversations.find(c => c.id === cid) ||
      archivedConvs.find(c => c.id === cid)
    )
  }, [cid, conversations, archivedConvs])

  const counterpartUser = activeConv?.counterpart_username || ''

  const counterpartMember = useMemo(() => {
    if (cid == null || activeConv?.kind !== 'direct') return null

    return (
      (members[cid] || []).find(m =>
        counterpartUser ? m.user_name === counterpartUser : m.user_name !== viewer,
      ) || null
    )
  }, [cid, activeConv, members, viewer, counterpartUser])

  const counts = useMemo(
    () => ({
      all: conversations.length,
      unread: conversations.filter(isUnread).length,
      starred: starredMessages.length,
      groups: conversations.filter(c => c.kind === 'group').length,
      archived: archivedConvs.length,
    }),
    [conversations, archivedConvs, starredMessages],
  )

  const listRows = useMemo(() => {
    const q = query.trim().toLowerCase()

    let base: Conversation[]

    if (filter === 'archived') base = archivedConvs
    else if (filter === 'unread') base = conversations.filter(isUnread)
    else if (filter === 'groups') base = conversations.filter(c => c.kind === 'group')
    else base = conversations

    if (q) base = base.filter(c => convMatches(c, q))

    return base
  }, [filter, conversations, archivedConvs, query])

  const emptyText =
    filter === 'archived'
      ? 'Nothing archived.'
      : filter === 'unread'
        ? 'No unread chats.'
        : filter === 'starred'
          ? 'No starred messages.'
          : filter === 'groups'
            ? 'No group chats yet.'
            : 'No conversations yet.'

  const pinnedIds = useMemo(() => new Set(pinnedMessages.map(m => m.id)), [pinnedMessages])

  const closeMenu = useCallback(() => setActiveMenu(null), [])

  const toggleMenu = useCallback(
    (
      e: React.MouseEvent<HTMLElement>,
      kind: MenuKind,
      id?: number,
      alignOverride?: 'left' | 'right',
    ) => {
      e.preventDefault()
      e.stopPropagation()

      if (activeMenu && activeMenu.kind === kind && activeMenu.id === id) {
        closeMenu()
        return
      }

      const rect = e.currentTarget.getBoundingClientRect()

      const autoAlign: 'left' | 'right' =
        rect.left + rect.width / 2 > window.innerWidth / 2 ? 'right' : 'left'

      const align = alignOverride || autoAlign
      const vertical: 'up' | 'down' = rect.bottom > window.innerHeight - 300 ? 'up' : 'down'

      const estimatedWidth = kind === 'reaction' ? 230 : 220
      let x = rect.right

      if (align === 'right') {
        x = Math.max(estimatedWidth + 8, x)
      } else {
        x = Math.min(window.innerWidth - estimatedWidth - 8, x)
      }

      x = Math.max(8, Math.min(x, window.innerWidth - 8))

      setActiveMenu({
        kind,
        id,
        x,
        y: vertical === 'up' ? rect.top - 6 : rect.bottom + 6,
        align,
        vertical,
      })
    },
    [activeMenu, closeMenu],
  )

  const menuConversation = useMemo(() => {
    if (!activeMenu || activeMenu.kind !== 'conversation' || activeMenu.id == null) return null

    return (
      conversations.find(c => c.id === activeMenu.id) ||
      archivedConvs.find(c => c.id === activeMenu.id) ||
      null
    )
  }, [activeMenu, conversations, archivedConvs])

  const menuMessage = useMemo<ChatMessage | null>(() => {
    if (!activeMenu || (activeMenu.kind !== 'message' && activeMenu.kind !== 'reaction') || activeMenu.id == null) {
      return null
    }

    const found = activeThread.find(t => !isOptimistic(t) && (t as ChatMessage).id === activeMenu.id)
    return found ? (found as ChatMessage) : null
  }, [activeMenu, activeThread])

  const canRenderFloating =
    !!activeMenu &&
    (
      (activeMenu.kind === 'conversation' && !!menuConversation) ||
      (activeMenu.kind === 'thread' && !!activeConv) ||
      ((activeMenu.kind === 'message' || activeMenu.kind === 'reaction') && !!menuMessage)
    )

  useEffect(() => {
    if (activeMenu && !canRenderFloating) closeMenu()
  }, [activeMenu, canRenderFloating, closeMenu])

  useEffect(() => {
    if (!activeMenu) return

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [activeMenu, closeMenu])

  useEffect(() => {
    if (!localStorage.getItem('space_token')) navigate('/login', { replace: true })
  }, [navigate])

  useEffect(() => {
    if (!viewer) return

    let alive = true

    fetch(`${AUTH_API}/settings?viewer=${encodeURIComponent(viewer)}`)
      .then(r => r.json())
      .then(d => {
        if (alive && d.language) setLang(d.language)
      })
      .catch(() => {})

    return () => {
      alive = false
    }
  }, [viewer])

  const reloadArchived = useCallback(async () => {
    if (!viewer) return

    try {
      const all = await fetchConversations(viewer, true)
      setArchivedConvs(all.filter(c => c.archived))
    } catch {
      // ignore
    }
  }, [viewer])

  useEffect(() => {
    void reloadArchived()
  }, [reloadArchived])

  const refreshAll = useCallback(async () => {
    void refreshConversations()
    await reloadArchived()
  }, [refreshConversations, reloadArchived])

  const loadPinned = useCallback(
    async (conversationId: number) => {
      if (!viewer) return

      try {
        const rows = await fetchPinnedMessages(viewer, conversationId)
        setPinnedMessages(rows)
      } catch {
        setPinnedMessages([])
      }
    },
    [viewer],
  )

  const playPing = useCallback(() => {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

      if (!Ctx) return

      audioCtxRef.current = audioCtxRef.current || new Ctx()
      const ctx = audioCtxRef.current

      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {})
      }

      const osc = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, ctx.currentTime)

      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18)

      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.start()
      osc.stop(ctx.currentTime + 0.2)
    } catch {
      // audio blocked
    }
  }, [])

  useEffect(() => {
    return subscribe(e => {
      if (e.type !== 'recording') return

      setRemoteRecording(prev => {
        const forConv = { ...(prev[e.conversation_id] || {}) }

        if (e.active) {
          forConv[e.user_name] = Date.now()
        } else {
          delete forConv[e.user_name]
        }

        return { ...prev, [e.conversation_id]: forConv }
      })
    })
  }, [])

  useEffect(() => {
    return subscribe(e => {
      if (e.type !== 'message') return

      const m = e.message
      if (m.sender === viewer) return

      const conv =
        conversations.find(c => c.id === m.conversation_id) ||
        archivedConvs.find(c => c.id === m.conversation_id)

      if (conv?.muted) return

      const isInActiveChat = cid === m.conversation_id && document.hasFocus() && !document.hidden
      if (isInActiveChat) return

      playPing()
    })
  }, [archivedConvs, cid, conversations, playPing, viewer])

  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now()

      setRemoteRecording(prev => {
        let changed = false
        const next: Record<number, Record<string, number>> = {}

        for (const key of Object.keys(prev)) {
          const convId = Number(key)
          const users = prev[convId]
          const kept: Record<string, number> = {}

          for (const name of Object.keys(users)) {
            if (now - users[name] < RECORDING_TTL) {
              kept[name] = users[name]
            } else {
              changed = true
            }
          }

          if (Object.keys(kept).length > 0) {
            next[convId] = kept
          } else if (Object.keys(users).length > 0) {
            changed = true
          }
        }

        return changed ? next : prev
      })
    }, 5000)

    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (online && localRecordingCidRef.current != null) {
      wsSend({
        type: 'recording',
        conversation_id: localRecordingCidRef.current,
        active: true,
      })
    }
  }, [online])

  useEffect(() => {
    return () => {
      if (localRecordingCidRef.current != null) {
        wsSend({
          type: 'recording',
          conversation_id: localRecordingCidRef.current,
          active: false,
        })

        localRecordingCidRef.current = null
      }

      if (localRecordingTimerRef.current != null) {
        window.clearInterval(localRecordingTimerRef.current)
        localRecordingTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [cid, activeThread.length])

  useEffect(() => {
    if (draftTimer.current !== null) {
      window.clearTimeout(draftTimer.current)
      draftTimer.current = null
    }

    closeMenu()
    setInfoOpen(false)
    setThreadSearchOpen(false)
    setThreadQuery('')
    setThreadResults([])
    setShowPinned(true)

    if (cid == null) {
      setPinnedMessages([])
      return
    }

    void loadPinned(cid)

    const conv = conversations.find(c => c.id === cid) || archivedConvs.find(c => c.id === cid)
    const initialDraft = conv?.draft || ''

    setDraft(initialDraft)
    lastDraftSaved.current = initialDraft
    setReplyTo(null)
    setEditing(null)
    setForwardMessage(null)
    setForwardTargets([])
    setNote('')

    fetchConversationMembers(viewer, cid)
      .then(list => setMembers(prev => ({ ...prev, [cid]: list })))
      .catch(() => {})

    if (isDesktop()) requestAnimationFrame(() => inputRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid])

  useEffect(() => {
    return () => {
      if (draftTimer.current !== null) window.clearTimeout(draftTimer.current)
    }
  }, [])

  useEffect(() => {
    const q = query.trim()

    if (!viewer || q.length < 2 || filter === 'archived' || filter === 'starred') {
      setSearchResults([])
      setSearching(false)
      return
    }

    let alive = true
    setSearching(true)

    const timer = window.setTimeout(() => {
      searchMessages(viewer, q, 0, 30)
        .then(rows => {
          if (alive) setSearchResults(rows)
        })
        .catch(() => {
          if (alive) setSearchResults([])
        })
        .finally(() => {
          if (alive) setSearching(false)
        })
    }, 350)

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query, viewer, filter])

  useEffect(() => {
    if (filter !== 'starred' || !viewer) return

    setLoadingStarred(true)

    fetchStarredMessages(viewer, 100)
      .then(setStarredMessages)
      .catch(() => setStarredMessages([]))
      .finally(() => setLoadingStarred(false))
  }, [filter, viewer])

  useEffect(() => {
    if (!threadSearchOpen || cid == null || threadQuery.trim().length < 2) {
      setThreadResults([])
      setSearchingThread(false)
      return
    }

    let alive = true
    setSearchingThread(true)

    const timer = window.setTimeout(() => {
      searchMessages(viewer, threadQuery.trim(), cid, 50)
        .then(rows => {
          if (alive) setThreadResults(rows)
        })
        .catch(() => {
          if (alive) setThreadResults([])
        })
        .finally(() => {
          if (alive) setSearchingThread(false)
        })
    }, 250)

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [threadSearchOpen, threadQuery, cid, viewer])

  useEffect(() => {
    if (jumpToMessageId == null || !activeThread.length) return

    const id = jumpToMessageId

    const raf = requestAnimationFrame(() => {
      const el = document.querySelector(`[data-message-id="${id}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setJumpToMessageId(null)
    })

    return () => cancelAnimationFrame(raf)
  }, [jumpToMessageId, activeThread])

  const scheduleDraftSave = useCallback(
    (value: string) => {
      if (cid == null) return

      if (draftTimer.current !== null) window.clearTimeout(draftTimer.current)

      const capturedCid = cid

      draftTimer.current = window.setTimeout(async () => {
        draftTimer.current = null

        const trimmed = value.trim()

        if (!trimmed) {
          if (lastDraftSaved.current) {
            await deleteDraft(capturedCid)
            lastDraftSaved.current = ''
          }
          return
        }

        if (trimmed !== lastDraftSaved.current) {
          await saveDraft(capturedCid, trimmed)
          lastDraftSaved.current = trimmed
        }
      }, 700)
    },
    [cid, deleteDraft, saveDraft],
  )

  const openChat = useCallback(
    (conversationId: number) => {
      openConversation(conversationId)
      setShowThreadMobile(true)
    },
    [openConversation],
  )

  const openChatAndJump = useCallback(
    (conversationId: number, messageId?: number) => {
      openChat(conversationId)
      if (messageId != null) setJumpToMessageId(messageId)
    },
    [openChat],
  )

  const backToList = useCallback(() => {
    closeConversation()
    setShowThreadMobile(false)
    setInfoOpen(false)
    setThreadSearchOpen(false)
    closeMenu()
    setNote('')
  }, [closeConversation, closeMenu])

  useEffect(() => {
    const state = location.state as { openConversationId?: number } | null
    const id = state?.openConversationId

    if (id != null) {
      refreshConversations()
      void reloadArchived()
      openChat(Number(id))
      navigate(location.pathname, { replace: true, state: null })
    }
  }, [location.state, location.pathname, navigate, openChat, refreshConversations, reloadArchived])

  // Deep-link from Community "Start a group": open the create-group modal on
  // arrival. Uses router state (not a window event) because the target page is
  // mounting cold — an event dispatched during navigation would be lost before
  // the listener attaches. Mirrors the proven openConversationId pattern above.
  useEffect(() => {
    const state = location.state as { openCreateGroup?: boolean } | null

    if (state?.openCreateGroup) {
      setShowGroupModal(true)
      navigate(location.pathname, { replace: true, state: null })
    }
  }, [location.state, location.pathname, navigate])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<number>).detail

      if (detail != null) {
        refreshConversations()
        void reloadArchived()
        openChat(Number(detail))
      }
    }

    window.addEventListener('open-chat', handler as EventListener)

    return () => {
      window.removeEventListener('open-chat', handler as EventListener)
    }
  }, [openChat, refreshConversations, reloadArchived])

  // A group membership can change while the user is idle on Messenger (approved
  // elsewhere, added by an admin, removed). Surface it in the list without
  // interrupting whatever chat they're reading — the toast handles one-click open.
  useEffect(() => {
    const onNotif = (event: Event) => {
      const n = (event as CustomEvent<{ category?: string }>).detail
      if (!n || n.category !== 'groups') return

      refreshConversations()
      void reloadArchived()
    }

    window.addEventListener('space:notification', onNotif as EventListener)
    return () => window.removeEventListener('space:notification', onNotif as EventListener)
  }, [refreshConversations, reloadArchived])

  const createGroupChat = useCallback(async () => {
    const name = groupName.trim()

    if (!name) {
      setNote('Group needs a name.')
      return
    }

    const memberList = groupMemberText
      .split(/[\s,]+/)
      .map(s => s.trim().replace(/^@/, ''))
      .filter(Boolean)

    setNote('')
    setCreatingGroup(true)

    try {
      const d = await startGroup(name, memberList, undefined, groupDescription.trim() || undefined)

      if (d.error) {
        setNote(d.error)
        return
      }

      const cid = d.conversation_id
      const cat = groupCategory.trim()
      const scn = groupScene.trim()

      // Stamp community fields only when they differ from the create defaults
      // (join_mode defaults to 'request', category/scene default to null), so the
      // common "plain request group" path stays a single request.
      const needsMeta = groupJoinMode !== 'request' || !!cat || !!scn

      if (cid != null && needsMeta) {
        const m = await updateCommunityGroupMeta(viewer, cid, {
          category: cat || null,
          scene: scn || null,
          join_mode: groupJoinMode,
        })

        if (m.error) {
          setNote(`Group created, but community info didn’t save: ${m.error}`)
        }
      }

      setShowGroupModal(false)
      setGroupName('')
      setGroupMemberText('')
      setGroupDescription('')
      setGroupCategory('')
      setGroupScene('')
      setGroupJoinMode('request')
      setFilter('all')

      if (cid != null) openChat(cid)
    } finally {
      setCreatingGroup(false)
    }
  }, [
    groupCategory,
    groupDescription,
    groupName,
    groupJoinMode,
    groupMemberText,
    groupScene,
    openChat,
    startGroup,
    viewer,
  ])

  const openMediaCarousel = useCallback(
    (url: string) => {
      const items = activeThread
        .filter(t => t.kind === 'image')
        .map(t => t.body)

      const unique = Array.from(new Set(items))
      const idx = unique.indexOf(url)

      setLightbox({
        items: unique.length ? unique : [url],
        index: idx >= 0 ? idx : 0,
      })
    },
    [activeThread],
  )

  const downloadImage = useCallback(async (url: string) => {
    try {
      const res = await fetch(url, { mode: 'cors' })
      if (!res.ok) throw new Error('download failed')

      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)

      const a = document.createElement('a')
      a.href = objectUrl
      a.download = fileNameFromUrl(url)
      document.body.appendChild(a)
      a.click()
      a.remove()

      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer')
      setNote('Direct download was blocked. Opening image in a new tab instead.')
    }
  }, [])

  async function uploadFile(file: File): Promise<string | null> {
    setBusy(true)
    setNote('')

    const form = new FormData()
    form.append('file', file)

    try {
      const d = await fetch(`${API}/upload`, { method: 'POST', body: form }).then(r => r.json())

      if (!d.url) {
        setNote('Upload failed.')
        return null
      }

      return d.url as string
    } catch {
      setNote('Could not reach the server.')
      return null
    } finally {
      setBusy(false)
    }
  }

  async function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''

    if (!file || cid == null) return

    if (editing) {
      setNote('Finish editing before sending media.')
      return
    }

    const url = await uploadFile(file)
    if (url) send(cid, 'image', url, replyTo ? { reply_to_id: replyTo.id } : {})

    setReplyTo(null)
  }

  async function handleVoiceSend(blob: Blob) {
    if (cid == null) return

    if (editing) {
      setNote('Finish editing before sending voice.')
      return
    }

    const file = new File([blob], 'voice.webm', { type: blob.type || 'audio/webm' })
    const url = await uploadFile(file)

    if (url) send(cid, 'voice', url, replyTo ? { reply_to_id: replyTo.id } : {})

    setReplyTo(null)
  }

  const sendMessage = useCallback(
    async (e: React.FormEvent<HTMLFormElement> | React.KeyboardEvent<HTMLTextAreaElement>) => {
      e.preventDefault()

      const body = draft.trim()
      if (!body || cid == null) return

      if (draftTimer.current !== null) {
        window.clearTimeout(draftTimer.current)
        draftTimer.current = null
      }

      setNote('')

      if (editing) {
        const d = await editMessage(editing.id, body)

        if (d.error) {
          setNote(d.error)
          return
        }

        setEditing(null)
        setDraft('')
        lastDraftSaved.current = ''

        if (isDesktop()) requestAnimationFrame(() => inputRef.current?.focus())
        return
      }

      send(cid, 'text', body, replyTo ? { reply_to_id: replyTo.id } : {})

      setDraft('')
      setReplyTo(null)

      await deleteDraft(cid)
      lastDraftSaved.current = ''

      if (isDesktop()) requestAnimationFrame(() => inputRef.current?.focus())
    },
    [cid, deleteDraft, draft, editMessage, editing, replyTo, send],
  )

  const handleComposerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) {
        return
      }

      void sendMessage(e)
    },
    [sendMessage],
  )

  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value)

      if (editing) return

      if (cid != null && value.trim()) notifyTyping(cid)

      scheduleDraftSave(value)
    },
    [cid, editing, notifyTyping, scheduleDraftSave],
  )

  const startReply = useCallback(
    (msg: ChatMessage) => {
      setReplyTo(msg)
      setEditing(null)
      closeMenu()
      requestAnimationFrame(() => inputRef.current?.focus())
    },
    [closeMenu],
  )

  const startEdit = useCallback(
    (msg: ChatMessage) => {
      setEditing(msg)
      setReplyTo(null)
      setDraft(msg.body)
      closeMenu()
      requestAnimationFrame(() => inputRef.current?.focus())
    },
    [closeMenu],
  )

  const cancelEdit = useCallback(() => {
    setEditing(null)
    setDraft(activeConv?.draft || '')
    lastDraftSaved.current = activeConv?.draft || ''
  }, [activeConv?.draft])

  const toggleReaction = useCallback(
    async (msg: ChatMessage, emoji: string) => {
      const existing = msg.reactions?.find(r => r.emoji === emoji)

      if (existing?.viewer_reacted) await unreact(msg.id, emoji)
      else await react(msg.id, emoji)

      closeMenu()
    },
    [react, unreact, closeMenu],
  )

  const toggleStar = useCallback(
    async (msg: ChatMessage) => {
      if (msg.starred_by_viewer) await unstar(msg.id)
      else await star(msg.id)

      if (filter === 'starred') {
        setStarredMessages(prev => prev.filter(x => x.id !== msg.id))
      }

      closeMenu()
    },
    [star, unstar, closeMenu, filter],
  )

  const togglePin = useCallback(
    async (msg: ChatMessage) => {
      if (!viewer) return

      const pinned = pinnedIds.has(msg.id)
      const d = pinned ? await unpinMessage(viewer, msg.id) : await pinMessage(viewer, msg.id)

      if (d.error) {
        setNote(d.error)
        closeMenu()
        return
      }

      if (cid != null) void loadPinned(cid)
      closeMenu()
    },
    [cid, closeMenu, loadPinned, pinnedIds, viewer],
  )

  const openReactionDetail = useCallback(
    async (msg: ChatMessage) => {
      if (!viewer) return

      const d = await fetchMessageReactions(viewer, msg.id)

      if (d.error) {
        setNote(d.error)
        closeMenu()
        return
      }

      setReactionDetail({ messageId: msg.id, items: d.reactions || [] })
      closeMenu()
    },
    [closeMenu, viewer],
  )

  const handleDeleteForEveryone = useCallback(
    async (msg: ChatMessage) => {
      const d = await deleteMessageForEveryone(msg.id)
      if (d.error) setNote(d.error)
      closeMenu()
    },
    [deleteMessageForEveryone, closeMenu],
  )

  const handleHideForMe = useCallback(
    async (msg: ChatMessage) => {
      const d = await hideMessageForMe(msg.id)
      if (d.error) setNote(d.error)
      closeMenu()
    },
    [hideMessageForMe, closeMenu],
  )

  const copyMessage = useCallback(
    async (msg: ChatMessage) => {
      try {
        await navigator.clipboard.writeText(msg.body)
      } catch {
        // clipboard blocked
      }

      closeMenu()
    },
    [closeMenu],
  )

  const openForward = useCallback(
    (msg: ChatMessage) => {
      setForwardMessage(msg)
      setForwardTargets([])
      closeMenu()
    },
    [closeMenu],
  )

  const toggleForwardTarget = useCallback((conversationId: number) => {
    setForwardTargets(prev =>
      prev.includes(conversationId)
        ? prev.filter(id => id !== conversationId)
        : [...prev, conversationId],
    )
  }, [])

  const sendForward = useCallback(async () => {
    if (!forwardMessage || !forwardTargets.length) return

    const d = await forward(forwardMessage.id, forwardTargets)

    if (d.error) {
      setNote(d.error)
      return
    }

    setNote('Forwarded.')
    setForwardMessage(null)
    setForwardTargets([])
  }, [forward, forwardMessage, forwardTargets])

  const doMute = useCallback(
    async (conversationId: number, hours: number | null) => {
      const d = await muteConversation(viewer, conversationId, hours)

      if (d.error) {
        setNote(d.error)
        closeMenu()
        return
      }

      closeMenu()
      await refreshAll()
    },
    [closeMenu, refreshAll, viewer],
  )

  const clearChat = useCallback(
    async (conversationId: number) => {
      const d = await clearConversationForMe(viewer, conversationId)

      if (d.error) {
        setNote(d.error)
        closeMenu()
        return
      }

      closeMenu()
      openConversation(conversationId)
      setNote('Chat cleared for you.')
    },
    [closeMenu, openConversation, viewer],
  )

  const markAllChats = useCallback(async () => {
    const d = await markAllChatsRead(viewer)

    if (d.error) {
      setNote(d.error)
      return
    }

    await refreshAll()
    setNote('All chats marked read.')
  }, [refreshAll, viewer])

  const conversationAction = useCallback(
    async (conversationId: number, action: 'pin' | 'archive' | 'unread' | 'leave') => {
      const conv =
        conversations.find(c => c.id === conversationId) ||
        archivedConvs.find(c => c.id === conversationId)

      if (!conv) return

      const wasActive = cid === conversationId
      const isArchivingNow = action === 'archive' && !conv.archived

      if (action === 'pin') await updatePrefs(conversationId, { pinned: !conv.pinned })
      else if (action === 'archive') await updatePrefs(conversationId, { archived: !conv.archived })
      else if (action === 'unread') await updatePrefs(conversationId, { mark_unread: true })
      else if (action === 'leave') {
        const d = await leaveConversation(conversationId)

        if (d.error) {
          setNote(d.error)
          closeMenu()
          return
        }

        if (wasActive) {
          backToList()
        }
      }

      closeMenu()

      if (isArchivingNow && wasActive && !isDesktop()) {
        backToList()
      }

      await reloadArchived()
      refreshConversations()
    },
    [
      archivedConvs,
      backToList,
      cid,
      closeMenu,
      conversations,
      leaveConversation,
      refreshConversations,
      reloadArchived,
      updatePrefs,
    ],
  )

  const clearLocalRecordingTimer = useCallback(() => {
    if (localRecordingTimerRef.current != null) {
      window.clearInterval(localRecordingTimerRef.current)
      localRecordingTimerRef.current = null
    }
  }, [])

  const stopLocalRecording = useCallback(
    (conversationId?: number) => {
      const target = localRecordingCidRef.current ?? conversationId

      if (target != null) {
        wsSend({
          type: 'recording',
          conversation_id: target,
          active: false,
        })

        setRemoteRecording(prev => {
          const forConv = { ...(prev[target] || {}) }

          if (viewer in forConv) {
            delete forConv[viewer]
            return { ...prev, [target]: forConv }
          }

          return prev
        })
      }

      clearLocalRecordingTimer()
      localRecordingCidRef.current = null
    },
    [clearLocalRecordingTimer, viewer],
  )

  const startLocalRecording = useCallback(
    (conversationId: number) => {
      if (localRecordingCidRef.current != null && localRecordingCidRef.current !== conversationId) {
        stopLocalRecording(localRecordingCidRef.current)
      }

      localRecordingCidRef.current = conversationId

      wsSend({
        type: 'recording',
        conversation_id: conversationId,
        active: true,
      })

      clearLocalRecordingTimer()

      localRecordingTimerRef.current = window.setInterval(() => {
        const activeCid = localRecordingCidRef.current
        if (activeCid == null) return

        wsSend({
          type: 'recording',
          conversation_id: activeCid,
          active: true,
        })
      }, RECORDING_HEARTBEAT)
    },
    [clearLocalRecordingTimer, stopLocalRecording],
  )

  const handleRecorderStart = useCallback(() => {
    if (cid != null) startLocalRecording(cid)
  }, [cid, startLocalRecording])

  const handleRecorderStop = useCallback(() => {
    stopLocalRecording(cid ?? undefined)
  }, [cid, stopLocalRecording])

  const typing = cid != null ? typingNames(cid) : []

  const recordingNames = useCallback(
    (conversationId: number) => {
      const now = Date.now()

      return Object.entries(remoteRecording[conversationId] || {})
        .filter(([, ts]) => now - ts < RECORDING_TTL)
        .map(([name]) => name)
    },
    [remoteRecording],
  )

  const recording = cid != null ? recordingNames(cid) : []

  const counterpartRead =
    cid != null && counterpartUser ? readCursors[cid]?.[counterpartUser] || 0 : 0
  const counterpartDelivered =
    cid != null && counterpartUser ? deliveredCursors[cid]?.[counterpartUser] || 0 : 0

  const groupRead = useMemo(() => {
    if (cid == null || !activeConv || activeConv.kind !== 'group') return 0
    const map = readCursors[cid] || {}
    let m = 0
    for (const [name, v] of Object.entries(map)) if (name !== viewer && v > m) m = v
    return m
  }, [cid, activeConv, readCursors, viewer])

  const groupDelivered = useMemo(() => {
    if (cid == null || !activeConv || activeConv.kind !== 'group') return 0
    const map = deliveredCursors[cid] || {}
    let m = 0
    for (const [name, v] of Object.entries(map)) if (name !== viewer && v > m) m = v
    return m
  }, [cid, activeConv, deliveredCursors, viewer])

  const headerSub = (() => {
    if (recording.length) return `${recording.join(', ')} recording voice note…`
    if (typing.length) return `${typing.join(', ')} typing…`
    if (!activeConv) return online ? 'Connected' : 'Reconnecting…'

    if (activeConv.kind === 'group') {
      return `${activeConv.member_count || (cid != null ? members[cid]?.length : 0) || 2} members`
    }

    if (counterpartMember?.online || activeConv.counterpart_online) return 'online'

    const lastSeen = counterpartMember?.last_seen_at || activeConv.counterpart_last_seen_at
    if (lastSeen) return `last seen ${fromNow(lastSeen)}`

    return 'Direct message'
  })()

  const reactionGroups = useMemo(() => {
    const map = new Map<string, ReactionDetail[]>()

    for (const r of reactionDetail?.items || []) {
      const arr = map.get(r.emoji) || []
      arr.push(r)
      map.set(r.emoji, arr)
    }

    return Array.from(map.entries()).map(([emoji, users]) => ({ emoji, users }))
  }, [reactionDetail])

  const renderBody = (item: (typeof activeThread)[number]) => {
    const committed = isOptimistic(item) ? null : item

    if (item.kind === 'text') {
      const translation = committed ? textFor(committed.body) : ''
      const showTranslated = !!translation && translation !== item.body
      const links = getLinks(committed, item.body)

      return (
        <>
          {showTranslated && (
            <p className={styles.translated}>{renderTextWithMentions(translation)}</p>
          )}

          <p className={showTranslated ? styles.original : styles.text}>
            {renderTextWithMentions(item.body)}
          </p>

          {links.length > 0 && (
            <div className={styles.linkList}>
              {links.map(l => (
                <a
                  key={l.url}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.linkCard}
                >
                  <ExternalLink size={13} />
                  <span className={styles.linkDomain}>{l.domain}</span>
                </a>
              ))}
            </div>
          )}
        </>
      )
    }

    if (item.kind === 'image') {
      return (
        <div className={styles.imageWrap}>
          <button
            type="button"
            className={styles.imagePreviewBtn}
            onClick={() => openMediaCarousel(item.body)}
            aria-label="Preview image"
          >
            <img src={item.body} alt="attachment" className={styles.imageMsg} />
          </button>

          <div className={styles.imageActions}>
            <button
              type="button"
              className={styles.imageAction}
              onClick={e => {
                e.stopPropagation()
                openMediaCarousel(item.body)
              }}
              aria-label="Expand image"
              title="Preview"
            >
              <Maximize2 size={14} />
            </button>

            <button
              type="button"
              className={styles.imageAction}
              onClick={e => {
                e.stopPropagation()
                downloadImage(item.body)
              }}
              aria-label="Download image"
              title="Save image"
            >
              <Download size={14} />
            </button>
          </div>
        </div>
      )
    }

    if (item.kind === 'voice') {
      return <VoiceNote src={item.body} seed={isOptimistic(item) ? item.seq : item.id} />
    }

    if (item.kind === 'video') {
      return <video src={item.body} controls className={styles.videoMsg} />
    }

    if (item.kind === 'file') {
      const name = metaString(committed, 'file_name', 'File')
      const size = metaString(committed, 'file_size', '')

      return (
        <a href={item.body} download={name} target="_blank" rel="noreferrer" className={styles.fileMsg}>
          <span className={styles.fileIcon}>📎</span>
          <span className={styles.fileText}>
            <strong>{name}</strong>
            {size && <em>{size}</em>}
          </span>
        </a>
      )
    }

    if (item.kind === 'location') {
      const lat = metaString(committed, 'latitude')
      const lng = metaString(committed, 'longitude')

      const href =
        lat && lng
          ? `https://www.google.com/maps?q=${lat},${lng}`
          : item.body.startsWith('http')
            ? item.body
            : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.body)}`

      return (
        <a href={href} target="_blank" rel="noreferrer" className={styles.locationMsg}>
          📍 {item.body}
        </a>
      )
    }

    if (item.kind === 'contact') {
      return (
        <button type="button" className={styles.contactMsg} onClick={() => navigate(`/profile/${item.body}`)}>
          👤 {item.body}
        </button>
      )
    }

    if (item.kind === 'system') {
      return <p className={styles.systemText}>{item.body}</p>
    }

    return <p className={styles.text}>{item.body}</p>
  }

  return (
    <main className={styles.layout}>
      <Navbar />

      <div className={`${styles.shell} ${showThreadMobile ? styles.threadOpen : ''}`}>
        {/* LIST */}
        <aside className={styles.listWrap}>
          <div className={styles.listHead}>
            <div>
              <h1 className={styles.title}>Messenger</h1>
              <p className={styles.sub}>
                {online ? 'Connected' : 'Reconnecting…'} · {conversations.length} chats
              </p>
            </div>

            <div className={styles.listHeadActions}>
              <button
                className={styles.newGroupBtn}
                onClick={() => void markAllChats()}
                aria-label="Mark all chats read"
                title="Mark all chats read"
              >
                <CheckCheck size={16} />
              </button>

              <button
                className={styles.newGroupBtn}
                onClick={() => setShowGroupModal(true)}
                aria-label="Create group"
                title="Create group"
              >
                <Users size={16} />
              </button>
            </div>
          </div>

          <div className={styles.filterRow} role="tablist" aria-label="Chat filters">
            {FILTERS.map(f => {
              const n = counts[f.key]
              const on = filter === f.key

              return (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={on}
                  className={`${styles.filterChip} ${on ? styles.filterChipOn : ''}`}
                  onClick={() => {
                    setFilter(f.key)
                    closeMenu()
                  }}
                >
                  <span>{f.label}</span>
                  {n > 0 && <span className={styles.filterCount}>{n}</span>}
                </button>
              )
            })}
          </div>

          <div className={styles.searchWrap}>
            <Search size={15} className={styles.searchIcon} />
            <input
              className={styles.searchInput}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search chats and messages"
              aria-label="Search chats and messages"
              autoComplete="off"
            />
            {query && (
              <button className={styles.searchClear} onClick={() => setQuery('')} aria-label="Clear search">
                <X size={14} />
              </button>
            )}
          </div>

          {note && <p className={styles.note}>{note}</p>}

          <ErrorBoundary fallback={<p className={styles.rest}>Conversation list is resting.</p>}>
            <div className={styles.convList}>
              {filter === 'starred' ? (
                loadingStarred ? (
                  <p className={styles.empty}>Loading starred messages…</p>
                ) : starredMessages.length === 0 ? (
                  <p className={styles.empty}>No starred messages.</p>
                ) : (
                  starredMessages.map(m => (
                    <button
                      key={m.id}
                      className={styles.searchResult}
                      onClick={() => openChatAndJump(m.conversation_id, m.id)}
                    >
                      <Avatar
                        src={m.sender_avatar}
                        name={m.sender_display || m.sender}
                        className={styles.searchResultAvatar}
                      />
                      <span className={styles.searchResultBody}>
                        <strong>{m.sender_display || m.sender}</strong>
                        <span>{previewForKind(m.kind, m.body)}</span>
                        {m.created_at && <em>{shortTime(m.created_at)}</em>}
                      </span>
                    </button>
                  ))
                )
              ) : (
                <>
                  {listRows.length === 0 ? (
                    <p className={styles.empty}>{emptyText}</p>
                  ) : (
                    listRows.map(c => {
                      const title = c.kind === 'group' ? c.name || 'Group' : c.counterpart || 'Direct message'
                      const avatarSrc = c.kind === 'group' ? c.image_url : c.counterpart_avatar
                      const preview = previewForKind(c.last_kind, c.last_body || '')

                      return (
                        <div key={c.id} className={styles.convRowWrap}>
                          <button
                            className={`${styles.convRow} ${cid === c.id ? styles.convRowOn : ''}`}
                            onClick={() => openChat(c.id)}
                          >
                            <span className={styles.convAvatarWrap}>
                              <Avatar src={avatarSrc} name={title} className={styles.convAvatar} />
                              {c.kind === 'direct' && c.counterpart_online && (
                                <span className={styles.presenceDot} />
                              )}
                            </span>

                            <span className={styles.convMid}>
                              <span className={styles.convTop}>
                                <strong className={styles.convName}>{title}</strong>
                                {c.last_at && <span className={styles.convTime}>{shortTime(c.last_at)}</span>}
                              </span>

                              <span className={styles.convPreview}>{preview}</span>

                              {(c.pinned || c.muted || c.draft || c.archived) && (
                                <span className={styles.convBadges}>
                                  {c.pinned && <Pin size={12} />}
                                  {c.muted && <BellOff size={12} />}
                                  {c.archived && <Archive size={12} />}
                                  {c.draft && <em>Draft</em>}
                                </span>
                              )}
                            </span>

                            {c.unread > 0 && <span className={styles.unread}>{c.unread}</span>}
                          </button>

                          <button
                            className={styles.convRowMenuBtn}
                            onClick={e => toggleMenu(e, 'conversation', c.id, 'right')}
                            aria-label="Conversation options"
                          >
                            <MoreVertical size={16} />
                          </button>
                        </div>
                      )
                    })
                  )}

                  {filter === 'all' && (searching || searchResults.length > 0) && (
                    <div className={styles.searchSection}>
                      <p className={styles.searchTitle}>{searching ? 'Searching messages…' : 'Message results'}</p>

                      {searchResults.map(m => (
                        <button
                          key={m.id}
                          className={styles.searchResult}
                          onClick={() => openChatAndJump(m.conversation_id, m.id)}
                        >
                          <Avatar
                            src={m.sender_avatar}
                            name={m.sender_display || m.sender}
                            className={styles.searchResultAvatar}
                          />
                          <span className={styles.searchResultBody}>
                            <strong>{m.sender_display || m.sender}</strong>
                            <span>{previewForKind(m.kind, m.body)}</span>
                            {m.created_at && <em>{shortTime(m.created_at)}</em>}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </ErrorBoundary>
        </aside>

        {/* THREAD */}
        <section className={styles.threadWrap}>
          {cid != null && (
            <header className={styles.threadHead}>
              <button className={styles.backBtn} onClick={backToList} aria-label="Back to conversations">
                <ArrowLeft size={18} />
              </button>

              {activeConv ? (
                <>
                  <Avatar
                    src={activeConv.kind === 'group' ? activeConv.image_url : counterpartMember?.avatar_url}
                    name={activeConv.kind === 'group' ? activeConv.name || 'Group' : activeConv.counterpart || 'Chat'}
                    className={styles.threadAvatar}
                  />

                  <button
                    className={styles.threadIdentityBtn}
                    onClick={() => {
                      closeMenu()
                      setInfoOpen(o => !o)
                    }}
                    aria-label="Chat info"
                    title="Chat info"
                  >
                    <div className={styles.threadTitleBlock}>
                      <h2 className={styles.threadTitle}>
                        {activeConv.kind === 'group' ? activeConv.name || 'Group' : activeConv.counterpart || 'Conversation'}
                      </h2>
                      <p className={styles.threadSub}>{headerSub}</p>
                    </div>
                    <Info size={16} className={styles.threadInfoIcon} />
                  </button>

                  <button
                    className={styles.threadSearchBtn}
                    onClick={() => {
                      closeMenu()
                      setThreadSearchOpen(o => !o)
                    }}
                    aria-label="Search in chat"
                    title="Search in chat"
                  >
                    <Search size={17} />
                  </button>

                  <button
                    className={styles.threadMenuBtn}
                    onClick={e => toggleMenu(e, 'thread', undefined, 'right')}
                    aria-label="Chat options"
                  >
                    <MoreVertical size={18} />
                  </button>
                </>
              ) : (
                <div className={styles.threadTitleBlock}>
                  <h2 className={styles.threadTitle}>Conversation unavailable</h2>
                  <p className={styles.threadSub}>
                    This chat may have been archived. Open the Archived tab to find it.
                  </p>
                </div>
              )}
            </header>
          )}

          {activeConv && cid != null && threadSearchOpen && (
            <div className={styles.threadSearchBar}>
              <Search size={15} className={styles.threadSearchIcon} />
              <input
                className={styles.threadSearchInput}
                value={threadQuery}
                onChange={e => setThreadQuery(e.target.value)}
                placeholder="Search in this chat"
                autoFocus
              />
              <button onClick={() => setThreadSearchOpen(false)} aria-label="Close chat search">
                <X size={15} />
              </button>

              {threadQuery.trim().length >= 2 && (
                <div className={styles.threadSearchPanel}>
                  {searchingThread ? (
                    <p className={styles.threadSearchEmpty}>Searching…</p>
                  ) : threadResults.length === 0 ? (
                    <p className={styles.threadSearchEmpty}>No matches in this chat.</p>
                  ) : (
                    threadResults.map(m => (
                      <button
                        key={m.id}
                        className={styles.threadSearchResult}
                        onClick={() => {
                          setJumpToMessageId(m.id)
                          setThreadSearchOpen(false)
                          setThreadQuery('')
                        }}
                      >
                        <strong>{m.sender_display || m.sender}</strong>
                        <span>{previewForKind(m.kind, m.body)}</span>
                        <em>{shortTime(m.created_at)}</em>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {activeConv && cid != null && pinnedMessages.length > 0 && showPinned && (
            <div className={styles.pinnedBar}>
              <Pin size={14} />
              <button
                className={styles.pinnedText}
                onClick={() => setJumpToMessageId(pinnedMessages[0].id)}
              >
                <strong>Pinned message</strong>
                <span>
                  {previewForKind(pinnedMessages[0].kind, pinnedMessages[0].body)}
                  {pinnedMessages.length > 1 ? ` +${pinnedMessages.length - 1}` : ''}
                </span>
              </button>
              <button onClick={() => setShowPinned(false)} aria-label="Hide pinned message bar">
                <X size={14} />
              </button>
            </div>
          )}

          <div className={styles.threadBody}>
            <ChatBackground />

            {cid == null ? (
              <div className={styles.threadEmpty}>
                <MessageCircle size={38} />
                <p>Select a conversation to start messaging.</p>
              </div>
            ) : !activeConv ? (
              <div className={styles.threadEmpty}>
                <Archive size={38} />
                <p>This conversation is archived or unavailable.</p>
                <button className={styles.loadOlderBtn} onClick={backToList}>
                  Back to chats
                </button>
              </div>
            ) : (
              <ErrorBoundary fallback={<p className={styles.rest}>This thread is resting.</p>}>
                <div className={styles.messages}>
                  {hasMoreOlder[cid] && (
                    <button className={styles.loadOlderBtn} onClick={() => loadOlder(cid)}>
                      Load older messages
                    </button>
                  )}

                  {activeThread.length === 0 ? (
                    <p className={styles.emptyThread}>No messages yet. Say hello.</p>
                  ) : (
                    (() => {
                      let lastDayKey = ''

                      return activeThread.map(t => {
                        const opt = isOptimistic(t) ? t : null
                        const msg = opt ? null : (t as ChatMessage)

                        const date = parseDate(t.created_at)
                        const dayKey = isNaN(date.getTime()) ? '' : date.toDateString()
                        const showDay = dayKey !== '' && dayKey !== lastDayKey

                        if (dayKey) lastDayKey = dayKey

                        const mine = opt ? true : msg!.sender === viewer
                        const key = opt ? opt.temp_id : String(msg!.id)

                        if (msg?.kind === 'system') {
                          return (
                            <Fragment key={key}>
                              {showDay && (
                                <div className={styles.daySep}>
                                  <span>{dayLabel(date)}</span>
                                </div>
                              )}

                              <div className={styles.systemRow}>
                                <span>{msg.body}</span>
                              </div>
                            </Fragment>
                          )
                        }

                        let status: 'sending' | 'failed' | 'sent' | 'delivered' | 'read' = 'sent'

                        if (opt) {
                          status = opt.status
                        } else if (mine) {
                          const r = counterpartUser ? counterpartRead : groupRead
                          const d = counterpartUser ? counterpartDelivered : groupDelivered
                          if (r >= msg!.id) status = 'read'
                          else if (d >= msg!.id) status = 'delivered'
                          else status = 'sent'
                        }

                        return (
                          <Fragment key={key}>
                            {showDay && (
                              <div className={styles.daySep}>
                                <span>{dayLabel(date)}</span>
                              </div>
                            )}

                            <div
                              className={`${styles.msgRow} ${mine ? styles.mine : styles.other}`}
                              data-message-id={msg?.id}
                            >
                              {!mine && (
                                <Avatar
                                  src={msg?.sender_avatar}
                                  name={msg?.sender_display || msg?.sender}
                                  className={styles.msgAvatar}
                                />
                              )}

                              <div className={styles.msgCol}>
                                <div className={`${styles.bubble} ${t.kind === 'image' ? styles.bubbleImage : ''}`}>
                                  {msg && activeConv.kind === 'group' && !mine && (
                                    <p className={styles.senderName}>{msg.sender_display || msg.sender}</p>
                                  )}

                                  {msg?.reply_to_body && (
                                    <div
                                      className={styles.replyPreview}
                                      onClick={() => setJumpToMessageId(msg.reply_to_id ?? null)}
                                      role="button"
                                      tabIndex={0}
                                    >
                                      <strong>
                                        {msg.reply_to_sender_display || msg.reply_to_sender || 'Message'}
                                      </strong>
                                      <span>
                                        {previewForKind(msg.reply_to_kind || 'text', msg.reply_to_body)}
                                      </span>
                                    </div>
                                  )}

                                  {renderBody(t)}

                                  {msg?.edited_at && <span className={styles.editedTag}>edited</span>}

                                  {msg && pinnedIds.has(msg.id) && (
                                    <span className={styles.pinnedTag}>
                                      <Pin size={11} />
                                    </span>
                                  )}

                                  {msg?.starred_by_viewer && (
                                    <span className={styles.starredTag}>
                                      <Star size={12} fill="currentColor" />
                                    </span>
                                  )}
                                </div>

                                {msg && msg.reactions && msg.reactions.length > 0 && (
                                  <div className={styles.reactionBar}>
                                    {msg.reactions.map(r => (
                                      <button
                                        key={r.emoji}
                                        className={`${styles.reactionChip} ${r.viewer_reacted ? styles.reactionChipOn : ''}`}
                                        onClick={() => toggleReaction(msg, r.emoji)}
                                        onDoubleClick={() => void openReactionDetail(msg)}
                                        title={r.viewer_reacted ? 'Remove reaction' : 'React'}
                                      >
                                        <span>{r.emoji}</span>
                                        <em>{r.count}</em>
                                      </button>
                                    ))}
                                  </div>
                                )}

                                <div className={styles.msgMeta}>
                                  <span>{shortTime(t.created_at)}</span>

                                  {mine && (
                                    <span className={styles.status}>
                                      {status === 'sending' && <Clock size={12} />}
                                      {status === 'failed' && <AlertCircle size={12} />}
                                      {status === 'sent' && <Check size={12} />}

                                      {status === 'delivered' && (
                                        <span className={styles.ticks}>
                                          <Check size={12} />
                                          <Check size={12} />
                                        </span>
                                      )}

                                      {status === 'read' && (
                                        <span className={`${styles.ticks} ${styles.ticksRead}`}>
                                          <Check size={12} />
                                          <Check size={12} />
                                        </span>
                                      )}
                                    </span>
                                  )}

                                  {msg && (
                                    <span className={styles.msgActions}>
                                      <button
                                        className={styles.msgActionBtn}
                                        onClick={e => toggleMenu(e, 'reaction', msg.id)}
                                        aria-label="React"
                                        title="React"
                                      >
                                        <Smile size={14} />
                                      </button>

                                      <button
                                        className={styles.msgActionBtn}
                                        onClick={() => startReply(msg)}
                                        aria-label="Reply"
                                        title="Reply"
                                      >
                                        <Reply size={14} />
                                      </button>

                                      <button
                                        className={styles.msgActionBtn}
                                        onClick={e => toggleMenu(e, 'message', msg.id)}
                                        aria-label="Message options"
                                        title="More"
                                      >
                                        <MoreVertical size={14} />
                                      </button>
                                    </span>
                                  )}

                                  {opt && opt.status === 'failed' && (
                                    <span className={styles.failedActions}>
                                      <button
                                        className={styles.iconMini}
                                        onClick={() => retrySend(cid, opt.temp_id)}
                                        aria-label="Retry message"
                                      >
                                        <RotateCcw size={12} />
                                      </button>

                                      <button
                                        className={styles.iconMini}
                                        onClick={() => dismissFailed(cid, opt.temp_id)}
                                        aria-label="Dismiss failed message"
                                      >
                                        <X size={12} />
                                      </button>
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </Fragment>
                        )
                      })
                    })()
                  )}

                  <div ref={endRef} />
                </div>
              </ErrorBoundary>
            )}
          </div>

          {activeConv && cid != null && (
            <>
              {replyTo && (
                <div className={styles.banner}>
                  <span className={styles.bannerLabel}>Replying to {replyTo.sender_display || replyTo.sender}</span>
                  <span className={styles.bannerText}>{previewForKind(replyTo.kind, replyTo.body)}</span>
                  <button onClick={() => setReplyTo(null)} aria-label="Cancel reply">
                    <X size={16} />
                  </button>
                </div>
              )}

              {editing && (
                <div className={styles.banner}>
                  <span className={styles.bannerLabel}>Editing message</span>
                  <span className={styles.bannerText}>{editing.body}</span>
                  <button onClick={cancelEdit} aria-label="Cancel edit">
                    <X size={16} />
                  </button>
                </div>
              )}

              <form className={styles.composer} onSubmit={sendMessage}>
                <button
                  type="button"
                  className={styles.composerBtn}
                  onClick={() => fileRef.current?.click()}
                  aria-label="Send image"
                >
                  <ImageIcon size={18} />
                </button>

                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className={styles.hiddenInput}
                  onChange={handleImagePick}
                />

                <textarea
                  ref={inputRef}
                  className={styles.composerInput}
                  value={draft}
                  onChange={e => onDraftChange(e.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  rows={1}
                  placeholder={editing ? 'Edit message…' : 'Type a message'}
                  aria-label="Message"
                  autoComplete="off"
                  spellCheck
                />

                <VoiceRecorder
                  key={cid}
                  onSend={handleVoiceSend}
                  onStart={handleRecorderStart}
                  onStop={handleRecorderStop}
                />

                <button
                  className={styles.sendBtn}
                  type="submit"
                  disabled={busy || !draft.trim()}
                  aria-label={editing ? 'Save edit' : 'Send message'}
                >
                  {editing ? <Check size={18} /> : <Send size={18} />}
                </button>
              </form>
            </>
          )}
        </section>
      </div>

      {/* FLOATING MENUS */}
      {activeMenu && canRenderFloating && (
        <>
          <div className={styles.floatingBackdrop} onClick={closeMenu} />

          <div
            className={[
              styles.floatingMenu,
              activeMenu.align === 'right' ? styles.floatingAlignRight : '',
              activeMenu.vertical === 'up' ? styles.floatingUp : '',
              activeMenu.kind === 'reaction' ? styles.floatingReaction : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ left: activeMenu.x, top: activeMenu.y }}
          >
            {activeMenu.kind === 'conversation' && menuConversation && (
              <>
                <button onClick={() => conversationAction(menuConversation.id, 'pin')}>
                  <Pin size={14} /> {menuConversation.pinned ? 'Unpin chat' : 'Pin chat'}
                </button>

                <button onClick={() => void doMute(menuConversation.id, 1)}>
                  <BellOff size={14} /> Mute 1h
                </button>

                <button onClick={() => void doMute(menuConversation.id, 8)}>
                  <BellOff size={14} /> Mute 8h
                </button>

                <button onClick={() => void doMute(menuConversation.id, null)}>
                  <BellOff size={14} /> Mute always
                </button>

                {menuConversation.muted && (
                  <button onClick={() => void doMute(menuConversation.id, 0)}>
                    <Check size={14} /> Unmute chat
                  </button>
                )}

                <button onClick={() => conversationAction(menuConversation.id, 'unread')}>
                  <Undo size={14} /> Mark as unread
                </button>

                <button onClick={() => void clearChat(menuConversation.id)}>
                  <Eraser size={14} /> Clear chat
                </button>

                <button onClick={() => conversationAction(menuConversation.id, 'archive')}>
                  <Archive size={14} /> {menuConversation.archived ? 'Unarchive chat' : 'Archive chat'}
                </button>

                {menuConversation.kind === 'group' && (
                  <button onClick={() => conversationAction(menuConversation.id, 'leave')}>
                    <Trash2 size={14} /> Leave group
                  </button>
                )}
              </>
            )}

            {activeMenu.kind === 'thread' && activeConv && (
              <>
                <button onClick={() => conversationAction(activeConv.id, 'pin')}>
                  <Pin size={14} /> {activeConv.pinned ? 'Unpin chat' : 'Pin chat'}
                </button>

                <button onClick={() => void doMute(activeConv.id, 1)}>
                  <BellOff size={14} /> Mute 1h
                </button>

                <button onClick={() => void doMute(activeConv.id, 8)}>
                  <BellOff size={14} /> Mute 8h
                </button>

                <button onClick={() => void doMute(activeConv.id, null)}>
                  <BellOff size={14} /> Mute always
                </button>

                {activeConv.muted && (
                  <button onClick={() => void doMute(activeConv.id, 0)}>
                    <Check size={14} /> Unmute chat
                  </button>
                )}

                <button onClick={() => conversationAction(activeConv.id, 'unread')}>
                  <Undo size={14} /> Mark as unread
                </button>

                <button onClick={() => void clearChat(activeConv.id)}>
                  <Eraser size={14} /> Clear chat
                </button>

                <button onClick={() => conversationAction(activeConv.id, 'archive')}>
                  <Archive size={14} /> {activeConv.archived ? 'Unarchive chat' : 'Archive chat'}
                </button>

                {activeConv.kind === 'group' && (
                  <button onClick={() => conversationAction(activeConv.id, 'leave')}>
                    <Trash2 size={14} /> Leave group
                  </button>
                )}
              </>
            )}

            {activeMenu.kind === 'message' && menuMessage && (
              <>
                <button onClick={() => startReply(menuMessage)}>
                  <Reply size={14} /> Reply
                </button>

                {menuMessage.sender === viewer && menuMessage.kind === 'text' && (
                  <button onClick={() => startEdit(menuMessage)}>
                    <Pencil size={14} /> Edit
                  </button>
                )}

                <button onClick={() => void togglePin(menuMessage)}>
                  {pinnedIds.has(menuMessage.id) ? <PinOff size={14} /> : <Pin size={14} />}
                  {pinnedIds.has(menuMessage.id) ? 'Unpin message' : 'Pin message'}
                </button>

                <button onClick={() => toggleStar(menuMessage)}>
                  <Star size={14} /> {menuMessage.starred_by_viewer ? 'Unstar' : 'Star'}
                </button>

                <button onClick={() => openForward(menuMessage)}>
                  <Forward size={14} /> Forward
                </button>

                {menuMessage.kind === 'text' && (
                  <button onClick={() => copyMessage(menuMessage)}>
                    <Copy size={14} /> Copy
                  </button>
                )}

                {menuMessage.reactions && menuMessage.reactions.length > 0 && (
                  <button onClick={() => void openReactionDetail(menuMessage)}>
                    <Smile size={14} /> See reactions
                  </button>
                )}

                {menuMessage.sender === viewer && (
                  <button onClick={() => handleDeleteForEveryone(menuMessage)}>
                    <Trash2 size={14} /> Delete for everyone
                  </button>
                )}

                <button onClick={() => handleHideForMe(menuMessage)}>
                  <Trash2 size={14} /> Delete for me
                </button>
              </>
            )}

            {activeMenu.kind === 'reaction' && menuMessage && (
              <>
                {QUICK_EMOJIS.map(emoji => (
                  <button key={emoji} onClick={() => toggleReaction(menuMessage, emoji)} aria-label={`React ${emoji}`}>
                    {emoji}
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}

      {infoOpen && activeConv && cid != null && (
        <ChatInfoPanel
          viewer={viewer}
          conversation={activeConv}
          onClose={() => setInfoOpen(false)}
          onOpenImage={openMediaCarousel}
          onRefresh={refreshAll}
          onArchived={archived => {
            if (archived && !isDesktop()) {
              setInfoOpen(false)
              backToList()
            }
          }}
          onConversationGone={() => {
            setInfoOpen(false)
            backToList()
          }}
        />
      )}

      {reactionDetail && (
        <div className={styles.modalOverlay} onClick={() => setReactionDetail(null)}>
          <div className={styles.reactionDetailCard} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHead}>
              <h3>Reactions</h3>
              <button onClick={() => setReactionDetail(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            {reactionGroups.length === 0 ? (
              <p className={styles.threadSearchEmpty}>No reactions.</p>
            ) : (
              reactionGroups.map(g => (
                <div key={g.emoji} className={styles.reactionGroup}>
                  <div className={styles.reactionGroupEmoji}>{g.emoji}</div>

                  <div className={styles.reactionUsers}>
                    {g.users.map(u => (
                      <div key={`${g.emoji}-${u.user_name}`} className={styles.reactionUser}>
                        <Avatar
                          src={u.avatar_url}
                          name={u.display_name || u.user_name}
                          className={styles.reactionUserAvatar}
                        />
                        <span>{u.display_name || u.user_name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {forwardMessage && (
        <div className={styles.modalOverlay} onClick={() => setForwardMessage(null)}>
          <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHead}>
              <h3>Forward message</h3>
              <button onClick={() => setForwardMessage(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <p className={styles.modalPreview}>{previewForKind(forwardMessage.kind, forwardMessage.body)}</p>

            <div className={styles.forwardList}>
              {conversations
                .filter(c => c.id !== cid)
                .map(c => {
                  const title = c.kind === 'group' ? c.name || 'Group' : c.counterpart || 'Direct message'
                  const avatarSrc = c.kind === 'group' ? c.image_url : c.counterpart_avatar

                  return (
                    <button
                      key={c.id}
                      className={`${styles.forwardRow} ${forwardTargets.includes(c.id) ? styles.forwardRowOn : ''}`}
                      onClick={() => toggleForwardTarget(c.id)}
                    >
                      <Avatar src={avatarSrc} name={title} className={styles.forwardAvatar} />
                      <span className={styles.forwardName}>{title}</span>
                      <span className={styles.forwardCheck}>{forwardTargets.includes(c.id) && <Check size={16} />}</span>
                    </button>
                  )
                })}
            </div>

            <div className={styles.modalActions}>
              <button className={styles.secondaryBtn} onClick={() => setForwardMessage(null)}>
                Cancel
              </button>

              <button className={styles.primaryBtn} onClick={sendForward} disabled={!forwardTargets.length}>
                Send {forwardTargets.length > 0 && `(${forwardTargets.length})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {showGroupModal && (
        <div className={styles.modalOverlay} onClick={() => setShowGroupModal(false)}>
          <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHead}>
              <h3>Create group</h3>
              <button onClick={() => setShowGroupModal(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>

            <label className={styles.modalLabel}>Group name</label>
            <input
              className={styles.modalInput}
              value={groupName}
              onChange={e => setGroupName(e.target.value)}
              placeholder="Studio Crew"
            />

            <label className={styles.modalLabel}>Members</label>
            <input
              className={styles.modalInput}
              value={groupMemberText}
              onChange={e => setGroupMemberText(e.target.value)}
              placeholder="usernames separated by commas"
            />

            <label className={styles.modalLabel}>Description</label>
            <textarea
              className={styles.modalTextarea}
              rows={3}
              value={groupDescription}
              onChange={e => setGroupDescription(e.target.value)}
              placeholder="What is this group for?"
            />

            <div className={styles.modalRow2}>
              <div className={styles.modalField}>
                <label className={styles.modalLabel} htmlFor="grp-cat">
                  Category
                </label>
                <input
                  id="grp-cat"
                  className={styles.modalInput}
                  value={groupCategory}
                  onChange={e => setGroupCategory(e.target.value)}
                  placeholder="Critique Circle, Collective…"
                  maxLength={40}
                />
              </div>

              <div className={styles.modalField}>
                <label className={styles.modalLabel} htmlFor="grp-scene">
                  Scene / city
                </label>
                <input
                  id="grp-scene"
                  className={styles.modalInput}
                  value={groupScene}
                  onChange={e => setGroupScene(e.target.value)}
                  placeholder="Lagos, Port Harcourt…"
                  maxLength={40}
                />
              </div>
            </div>

            <label className={styles.modalLabel} htmlFor="grp-join">
              Join access
            </label>
            <select
              id="grp-join"
              className={styles.modalSelect}
              value={groupJoinMode}
              onChange={e => setGroupJoinMode(e.target.value)}
            >
              <option value="request">Approval required (default)</option>
              <option value="open">Open — anyone can join</option>
              <option value="invite">Invite only</option>
              <option value="private">Private</option>
            </select>

            <p className={styles.modalHint}>
              Category and scene make this group appear in Community discovery. You can change
              these later from the group info panel.
            </p>

            <div className={styles.modalActions}>
              <button className={styles.secondaryBtn} onClick={() => setShowGroupModal(false)}>
                Cancel
              </button>

              <button
                className={styles.primaryBtn}
                onClick={() => void createGroupChat()}
                disabled={creatingGroup}
              >
                {creatingGroup ? 'Creating…' : 'Create group'}
              </button>
            </div>
          </div>
        </div>
      )}

      {lightbox && <Lightbox items={lightbox.items} index={lightbox.index} onClose={() => setLightbox(null)} />}
    </main>
  )
}