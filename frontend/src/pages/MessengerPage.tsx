import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  BellOff,
  Check,
  Clock,
  Copy,
  Download,
  Forward,
  Image as ImageIcon,
  Maximize2,
  MessageCircle,
  MoreVertical,
  Pencil,
  Pin,
  Plus,
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
import { useChat, isOptimistic } from '../hooks/useChat'
import { API } from '../lib/sales'
import {
  searchMessages,
  fetchConversationMembers,
  fetchConversations,
  type ChatMessage,
  type Conversation,
  type GroupMember,
} from '../lib/chat'
import styles from './MessengerPage.module.css'

const AUTH_API = 'http://localhost:8000'
const QUICK_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🙏']

type Filter = 'all' | 'unread' | 'groups' | 'archived'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'groups', label: 'Groups' },
  { key: 'archived', label: 'Archived' },
]

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
  const value = (msg.meta as Record<string, unknown> | undefined)?.[key]
  return value == null ? fallback : String(value)
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

function Avatar({ src, name, className }: { src?: string | null; name?: string | null; className: string }) {
  return (
    <span className={className}>
      {src ? <img src={src} alt="" className={styles.avatarImg} /> : firstLetter(name)}
    </span>
  )
}

export function MessengerPage() {
  const navigate = useNavigate()
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
    startDirect,
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
  const [messageMenuId, setMessageMenuId] = useState<number | null>(null)
  const [reactionPickerId, setReactionPickerId] = useState<number | null>(null)
  const [convMenuId, setConvMenuId] = useState<number | null>(null)
  const [threadMenuOpen, setThreadMenuOpen] = useState(false)

  const [forwardMessage, setForwardMessage] = useState<ChatMessage | null>(null)
  const [forwardTargets, setForwardTargets] = useState<number[]>([])

  const [showGroupModal, setShowGroupModal] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupMemberText, setGroupMemberText] = useState('')
  const [groupDescription, setGroupDescription] = useState('')

  const [searchResults, setSearchResults] = useState<ChatMessage[]>([])
  const [searching, setSearching] = useState(false)

  // ---- filter tabs + archived side-list ----
  const [filter, setFilter] = useState<Filter>('all')
  const [archivedConvs, setArchivedConvs] = useState<Conversation[]>([])
  const [members, setMembers] = useState<Record<number, GroupMember[]>>({})

  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const draftTimer = useRef<number | null>(null)
  const lastDraftSaved = useRef<string>('')

  const activeConv = useMemo(
    () => (cid != null ? conversations.find(c => c.id === cid) : undefined),
    [cid, conversations],
  )

  const counterpartUser = activeConv?.counterpart_username || ''

  const counterpartMember = useMemo(() => {
    if (cid == null || activeConv?.kind !== 'direct') return null
    return (
      (members[cid] || []).find(m =>
        counterpartUser ? m.user_name === counterpartUser : m.user_name !== viewer,
      ) || null
    )
  }, [cid, activeConv, members, viewer, counterpartUser])

  const cleanTarget = query.trim().replace(/^@/, '')
  const canStartDirect =
    filter !== 'archived' &&
    !!cleanTarget &&
    !conversations.some(
      c =>
        (c.counterpart || '').toLowerCase() === cleanTarget.toLowerCase() ||
        (c.counterpart_username || '').toLowerCase() === cleanTarget.toLowerCase(),
    )

  const counts = useMemo(
    () => ({
      all: conversations.length,
      unread: conversations.filter(isUnread).length,
      groups: conversations.filter(c => c.kind === 'group').length,
      archived: archivedConvs.length,
    }),
    [conversations, archivedConvs],
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
        : filter === 'groups'
          ? 'No group chats yet.'
          : 'No conversations yet.'

  const anyMenuOpen =
    convMenuId != null || threadMenuOpen || messageMenuId != null || reactionPickerId != null
  const closeAllMenus = useCallback(() => {
    setConvMenuId(null)
    setThreadMenuOpen(false)
    setMessageMenuId(null)
    setReactionPickerId(null)
  }, [])

    useEffect(() => {
    if (!anyMenuOpen) return

    const onPointerDown = (event: PointerEvent) => {
      const el = event.target as HTMLElement | null
      if (!el) return

      // Do not close when clicking a menu trigger or inside a menu.
      if (el.closest('[data-chat-menu]')) return

      closeAllMenus()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAllMenus()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anyMenuOpen, closeAllMenus])

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

  // Load archived side-list once so the Archived chip + badge work immediately.
  const reloadArchived = useCallback(() => {
    if (!viewer) return
    fetchConversations(viewer, true)
      .then(all => setArchivedConvs(all.filter(c => c.archived)))
      .catch(() => {})
  }, [viewer])

  useEffect(() => {
    reloadArchived()
  }, [reloadArchived])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [cid, activeThread.length])

  useEffect(() => {
    if (draftTimer.current !== null) {
      window.clearTimeout(draftTimer.current)
      draftTimer.current = null
    }
    if (cid == null) return

    const conv = conversations.find(c => c.id === cid)
    const initialDraft = conv?.draft || ''
    setDraft(initialDraft)
    lastDraftSaved.current = initialDraft
    setReplyTo(null)
    setEditing(null)
    closeAllMenus()
    setForwardMessage(null)
    setForwardTargets([])
    setNote('')

    fetchConversationMembers(viewer, cid)
      .then(list => setMembers(prev => ({ ...prev, [cid]: list })))
      .catch(() => {})

    if (isDesktop()) requestAnimationFrame(() => inputRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid])

  useEffect(
    () => () => {
      if (draftTimer.current !== null) window.clearTimeout(draftTimer.current)
    },
    [],
  )

  useEffect(() => {
    const q = query.trim()
    if (!viewer || q.length < 2 || filter === 'archived') {
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

  const backToList = useCallback(() => {
    closeConversation()
    setShowThreadMobile(false)
    setNote('')
  }, [closeConversation])

  const startDirectWith = useCallback(async () => {
    const target = cleanTarget
    if (!target) return
    setNote('')
    const d = await startDirect(target)
    if (d.error) {
      setNote(d.error)
      return
    }
    setQuery('')
    setFilter('all')
    if (d.conversation_id != null) openChat(d.conversation_id)
  }, [cleanTarget, openChat, startDirect])

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
    const d = await startGroup(name, memberList, undefined, groupDescription.trim() || undefined)
    if (d.error) {
      setNote(d.error)
      return
    }
    setShowGroupModal(false)
    setGroupName('')
    setGroupMemberText('')
    setGroupDescription('')
    setFilter('all')
    if (d.conversation_id != null) openChat(d.conversation_id)
  }, [groupDescription, groupName, groupMemberText, openChat, startGroup])

  const openImagePreview = useCallback((url: string) => {
    setLightbox({ items: [url], index: 0 })
  }, [])

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
    async (e: React.FormEvent) => {
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

  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value)
      if (editing) return
      if (cid != null && value.trim()) notifyTyping(cid)
      scheduleDraftSave(value)
    },
    [cid, editing, notifyTyping, scheduleDraftSave],
  )

  const startReply = useCallback((msg: ChatMessage) => {
    setReplyTo(msg)
    setEditing(null)
    setMessageMenuId(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  const startEdit = useCallback((msg: ChatMessage) => {
    setEditing(msg)
    setReplyTo(null)
    setDraft(msg.body)
    setMessageMenuId(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

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
      setReactionPickerId(null)
    },
    [react, unreact],
  )

  const toggleStar = useCallback(
    async (msg: ChatMessage) => {
      if (msg.starred_by_viewer) await unstar(msg.id)
      else await star(msg.id)
      setMessageMenuId(null)
    },
    [star, unstar],
  )

  const handleDeleteForEveryone = useCallback(
    async (msg: ChatMessage) => {
      const d = await deleteMessageForEveryone(msg.id)
      if (d.error) setNote(d.error)
      setMessageMenuId(null)
    },
    [deleteMessageForEveryone],
  )

  const handleHideForMe = useCallback(
    async (msg: ChatMessage) => {
      const d = await hideMessageForMe(msg.id)
      if (d.error) setNote(d.error)
      setMessageMenuId(null)
    },
    [hideMessageForMe],
  )

  const copyMessage = useCallback(async (msg: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(msg.body)
    } catch {
      // clipboard blocked
    }
    setMessageMenuId(null)
  }, [])

  const openForward = useCallback((msg: ChatMessage) => {
    setForwardMessage(msg)
    setForwardTargets([])
    setMessageMenuId(null)
  }, [])

  const toggleForwardTarget = useCallback((conversationId: number) => {
    setForwardTargets(prev =>
      prev.includes(conversationId) ? prev.filter(id => id !== conversationId) : [...prev, conversationId],
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

  const conversationAction = useCallback(
    async (conversationId: number, action: 'pin' | 'mute' | 'archive' | 'unread' | 'leave') => {
      const conv =
        conversations.find(c => c.id === conversationId) ||
        archivedConvs.find(c => c.id === conversationId)
      if (!conv) return

      if (action === 'pin') await updatePrefs(conversationId, { pinned: !conv.pinned })
      else if (action === 'mute') await updatePrefs(conversationId, { muted: !conv.muted })
      else if (action === 'archive') await updatePrefs(conversationId, { archived: !conv.archived })
      else if (action === 'unread') await updatePrefs(conversationId, { mark_unread: true })
      else if (action === 'leave') {
        const d = await leaveConversation(conversationId)
        if (d.error) {
          setNote(d.error)
          closeAllMenus()
          return
        }
        if (cid === conversationId) backToList()
      }

      closeAllMenus()
      refreshConversations()
      reloadArchived() // keep the Archived chip + side-list in sync after any toggle
    },
    [backToList, cid, closeAllMenus, conversations, archivedConvs, leaveConversation, refreshConversations, reloadArchived, updatePrefs],
  )

  const typing = cid != null ? typingNames(cid) : []
  const readCursor = cid != null && counterpartUser ? readCursors[cid]?.[counterpartUser] || 0 : 0
  const deliveredCursor =
    cid != null && counterpartUser ? deliveredCursors[cid]?.[counterpartUser] || 0 : 0

  const headerSub = (() => {
    if (typing.length) return `${typing.join(', ')} typing…`
    if (!activeConv) return online ? 'Connected' : 'Reconnecting…'
    if (activeConv.kind === 'group') {
      return `${activeConv.member_count || (cid != null ? members[cid]?.length : 0) || 2} members`
    }
    if (counterpartMember?.online) return 'online'
    if (counterpartMember?.last_seen_at) return `last seen ${fromNow(counterpartMember.last_seen_at)}`
    return 'Direct message'
  })()

  const renderBody = (item: (typeof activeThread)[number]) => {
    const committed = isOptimistic(item) ? null : item

    if (item.kind === 'text') {
      const translation = committed ? textFor(committed.body) : ''
      const showTranslated = !!translation && translation !== item.body
      return (
        <>
          {showTranslated && <p className={styles.translated}>{translation}</p>}
          <p className={showTranslated ? styles.original : styles.text}>{item.body}</p>
        </>
      )
    }

    if (item.kind === 'image') {
      return (
        <div className={styles.imageWrap}>
          <button type="button" className={styles.imagePreviewBtn} onClick={() => openImagePreview(item.body)} aria-label="Preview image">
            <img src={item.body} alt="attachment" className={styles.imageMsg} />
          </button>
          <div className={styles.imageActions}>
            <button type="button" className={styles.imageAction} onClick={e => { e.stopPropagation(); openImagePreview(item.body) }} aria-label="Expand image" title="Preview">
              <Maximize2 size={14} />
            </button>
            <button type="button" className={styles.imageAction} onClick={e => { e.stopPropagation(); downloadImage(item.body) }} aria-label="Download image" title="Save image">
              <Download size={14} />
            </button>
          </div>
        </div>
      )
    }

    if (item.kind === 'voice') return <VoiceNote src={item.body} seed={isOptimistic(item) ? item.seq : item.id} />
    if (item.kind === 'video') return <video src={item.body} controls className={styles.videoMsg} />

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

    if (item.kind === 'system') return <p className={styles.systemText}>{item.body}</p>
    return <p className={styles.text}>{item.body}</p>
  }

  return (
    <main className={styles.layout}>
      <Navbar />


      <div className={`${styles.shell} ${showThreadMobile ? styles.threadOpen : ''}`}>
        {/* ------------------------------ LIST ------------------------------ */}
        <aside className={styles.listWrap}>
          <div className={styles.listHead}>
            <div>
              <h1 className={styles.title}>Messenger</h1>
              <p className={styles.sub}>
                {online ? 'Connected' : 'Reconnecting…'} · {conversations.length} chats
              </p>
            </div>

            <button
              className={styles.newGroupBtn}
              onClick={() => setShowGroupModal(true)}
              aria-label="Create group"
              title="Create group"
            >
              <Users size={16} />
            </button>
          </div>

          {/* ---- FILTER TABS: always visible, archive included ---- */}
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
                    closeAllMenus()
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
              placeholder="Search chats, messages, or start new chat"
              aria-label="Search chats, messages, or start new chat"
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
              {canStartDirect && (
                <button className={styles.startRow} onClick={startDirectWith}>
                  <span className={styles.startAvatar}>
                    <Plus size={18} />
                  </span>
                  <span className={styles.startText}>
                    Start chat with <strong>@{cleanTarget}</strong>
                  </span>
                </button>
              )}

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
                        <Avatar src={avatarSrc} name={title} className={styles.convAvatar} />

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
                        data-chat-menu
                        className={styles.convRowMenuBtn}
                        onClick={e => {
                          e.stopPropagation()
                          setConvMenuId(convMenuId === c.id ? null : c.id)
                          setThreadMenuOpen(false)
                          setMessageMenuId(null)
                          setReactionPickerId(null)
                        }}
                        aria-label="Conversation options"
                      >
                        <MoreVertical size={16} />
                      </button>

                      {convMenuId === c.id && (
                        <div data-chat-menu className={styles.convMenu}>
                          <button onClick={() => conversationAction(c.id, 'pin')}>
                            <Pin size={14} /> {c.pinned ? 'Unpin chat' : 'Pin chat'}
                          </button>
                          <button onClick={() => conversationAction(c.id, 'mute')}>
                            <BellOff size={14} /> {c.muted ? 'Unmute chat' : 'Mute chat'}
                          </button>
                          <button onClick={() => conversationAction(c.id, 'unread')}>
                            <Undo size={14} /> Mark as unread
                          </button>
                          <button onClick={() => conversationAction(c.id, 'archive')}>
                            <Archive size={14} /> {c.archived ? 'Unarchive chat' : 'Archive chat'}
                          </button>
                          {c.kind === 'group' && (
                            <button onClick={() => conversationAction(c.id, 'leave')}>
                              <Trash2 size={14} /> Leave group
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}

              {filter === 'all' && (searching || searchResults.length > 0) && (
                <div className={styles.searchSection}>
                  <p className={styles.searchTitle}>{searching ? 'Searching messages…' : 'Message results'}</p>
                  {searchResults.map(m => (
                    <button key={m.id} className={styles.searchResult} onClick={() => openChat(m.conversation_id)}>
                      <Avatar src={m.sender_avatar} name={m.sender_display || m.sender} className={styles.searchResultAvatar} />
                      <span className={styles.searchResultBody}>
                        <strong>{m.sender_display || m.sender}</strong>
                        <span>{previewForKind(m.kind, m.body)}</span>
                        {m.created_at && <em>{shortTime(m.created_at)}</em>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </ErrorBoundary>
        </aside>

        {/* ----------------------------- THREAD ----------------------------- */}
        <section className={styles.threadWrap}>
          {activeConv && cid != null && (
            <header className={styles.threadHead}>
              <button className={styles.backBtn} onClick={backToList} aria-label="Back to conversations">
                <ArrowLeft size={18} />
              </button>

              <Avatar
                src={activeConv.kind === 'group' ? activeConv.image_url : counterpartMember?.avatar_url}
                name={activeConv.kind === 'group' ? activeConv.name || 'Group' : activeConv.counterpart || 'Chat'}
                className={styles.threadAvatar}
              />

              <div className={styles.threadTitleBlock}>
                <h2 className={styles.threadTitle}>
                  {activeConv.kind === 'group' ? activeConv.name || 'Group' : activeConv.counterpart || 'Conversation'}
                </h2>
                <p className={styles.threadSub}>{headerSub}</p>
              </div>

              <button
                data-chat-menu
                className={styles.threadMenuBtn}
                onClick={() => {
                  setThreadMenuOpen(o => !o)
                  setConvMenuId(null)
                  setMessageMenuId(null)
                  setReactionPickerId(null)
                }}
                aria-label="Chat options"
              >
                <MoreVertical size={18} />
              </button>

              {threadMenuOpen && (
                <div data-chat-menu className={styles.threadConvMenu}>
                  <button onClick={() => conversationAction(cid, 'pin')}>
                    <Pin size={14} /> {activeConv.pinned ? 'Unpin chat' : 'Pin chat'}
                  </button>
                  <button onClick={() => conversationAction(cid, 'mute')}>
                    <BellOff size={14} /> {activeConv.muted ? 'Unmute chat' : 'Mute chat'}
                  </button>
                  <button onClick={() => conversationAction(cid, 'unread')}>
                    <Undo size={14} /> Mark as unread
                  </button>
                  <button onClick={() => conversationAction(cid, 'archive')}>
                    <Archive size={14} /> {activeConv.archived ? 'Unarchive chat' : 'Archive chat'}
                  </button>
                  {activeConv.kind === 'group' && (
                    <button onClick={() => conversationAction(cid, 'leave')}>
                      <Trash2 size={14} /> Leave group
                    </button>
                  )}
                </div>
              )}
            </header>
          )}

          <div className={styles.threadBody}>
            <ChatBackground />

            {cid == null || !activeConv ? (
              <div className={styles.threadEmpty}>
                <MessageCircle size={38} />
                <p>Select a conversation to start messaging.</p>
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
                        if (opt) status = opt.status
                        else if (mine && counterpartUser) {
                          if (readCursor >= msg!.id) status = 'read'
                          else if (deliveredCursor >= msg!.id) status = 'delivered'
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
                            >
                              {!mine && (
                                <Avatar src={msg?.sender_avatar} name={msg?.sender_display || msg?.sender} className={styles.msgAvatar} />
                              )}

                              <div className={styles.msgCol}>
                                <div className={`${styles.bubble} ${t.kind === 'image' ? styles.bubbleImage : ''}`}>
                                  {msg && activeConv.kind === 'group' && !mine && (
                                    <p className={styles.senderName}>{msg.sender_display || msg.sender}</p>
                                  )}

                                  {msg?.reply_to_body && (
                                    <div className={styles.replyPreview}>
                                      <strong>{msg.reply_to_sender_display || msg.reply_to_sender || 'Message'}</strong>
                                      <span>{previewForKind(msg.reply_to_kind || 'text', msg.reply_to_body)}</span>
                                    </div>
                                  )}

                                  {renderBody(t)}

                                  {msg?.edited_at && <span className={styles.editedTag}>edited</span>}
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
                                        data-chat-menu
                                        className={styles.msgActionBtn}
                                        onClick={() => setReactionPickerId(reactionPickerId === msg.id ? null : msg.id)}
                                        aria-label="React"
                                        title="React"
                                      >
                                        <Smile size={14} />
                                      </button>

                                      <button
                                        data-chat-menu
                                        className={styles.msgActionBtn}
                                        onClick={() => startReply(msg)}
                                        aria-label="Reply"
                                        title="Reply"
                                      >
                                        <Reply size={14} />
                                      </button>

                                      <button
                                        data-chat-menu
                                        className={styles.msgActionBtn}
                                        onClick={() => setMessageMenuId(messageMenuId === msg.id ? null : msg.id)}
                                        aria-label="Message options"
                                        title="More"
                                      >
                                        <MoreVertical size={14} />
                                      </button>
                                    </span>
                                  )}

                                  {opt && opt.status === 'failed' && (
                                    <span className={styles.failedActions}>
                                      <button className={styles.iconMini} onClick={() => retrySend(cid, opt.temp_id)} aria-label="Retry message">
                                        <RotateCcw size={12} />
                                      </button>
                                      <button className={styles.iconMini} onClick={() => dismissFailed(cid, opt.temp_id)} aria-label="Dismiss failed message">
                                        <X size={12} />
                                      </button>
                                    </span>
                                  )}
                                </div>

                                {msg && reactionPickerId === msg.id && (
                                  <div data-chat-menu className={styles.reactionPicker}>
                                    {QUICK_EMOJIS.map(emoji => (
                                      <button key={emoji} onClick={() => toggleReaction(msg, emoji)} aria-label={`React ${emoji}`}>
                                        {emoji}
                                      </button>
                                    ))}
                                  </div>
                                )}

                                {msg && messageMenuId === msg.id && (
                                  <div data-chat-menu className={styles.messageMenu}>
                                    <button onClick={() => startReply(msg)}>
                                      <Reply size={14} /> Reply
                                    </button>
                                    {mine && msg.kind === 'text' && (
                                      <button onClick={() => startEdit(msg)}>
                                        <Pencil size={14} /> Edit
                                      </button>
                                    )}
                                    <button onClick={() => toggleStar(msg)}>
                                      <Star size={14} /> {msg.starred_by_viewer ? 'Unstar' : 'Star'}
                                    </button>
                                    <button onClick={() => openForward(msg)}>
                                      <Forward size={14} /> Forward
                                    </button>
                                    {msg.kind === 'text' && (
                                      <button onClick={() => copyMessage(msg)}>
                                        <Copy size={14} /> Copy
                                      </button>
                                    )}
                                    {mine && msg.kind === 'text' && (
                                      <button onClick={() => handleDeleteForEveryone(msg)}>
                                        <Trash2 size={14} /> Delete for everyone
                                      </button>
                                    )}
                                    <button onClick={() => handleHideForMe(msg)}>
                                      <Trash2 size={14} /> Delete for me
                                    </button>
                                  </div>
                                )}
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
                <button type="button" className={styles.composerBtn} onClick={() => fileRef.current?.click()} aria-label="Send image">
                  <ImageIcon size={18} />
                </button>

                <input ref={fileRef} type="file" accept="image/*" className={styles.hiddenInput} onChange={handleImagePick} />

                <input
                  ref={inputRef}
                  className={styles.composerInput}
                  value={draft}
                  onChange={e => onDraftChange(e.target.value)}
                  placeholder={editing ? 'Edit message…' : 'Type a message'}
                  aria-label="Message"
                  autoComplete="off"
                  spellCheck
                />

                <VoiceRecorder onSend={handleVoiceSend} />

                <button className={styles.sendBtn} type="submit" disabled={busy || !draft.trim()} aria-label={editing ? 'Save edit' : 'Send message'}>
                  {editing ? <Check size={18} /> : <Send size={18} />}
                </button>
              </form>
            </>
          )}
        </section>
      </div>

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
            <input className={styles.modalInput} value={groupName} onChange={e => setGroupName(e.target.value)} placeholder="Studio Crew" />

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

            <div className={styles.modalActions}>
              <button className={styles.secondaryBtn} onClick={() => setShowGroupModal(false)}>
                Cancel
              </button>
              <button className={styles.primaryBtn} onClick={createGroupChat}>
                Create group
              </button>
            </div>
          </div>
        </div>
      )}

      {lightbox && <Lightbox items={lightbox.items} index={lightbox.index} onClose={() => setLightbox(null)} />}
    </main>
  )
}