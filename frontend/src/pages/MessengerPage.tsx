import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Clock,
  Download,
  Image as ImageIcon,
  Maximize2,
  MessageCircle,
  Plus,
  RotateCcw,
  Search,
  Send,
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
import styles from './MessengerPage.module.css'

const AUTH_API = 'http://localhost:8000'

function parseDate(raw: string) {
  return new Date(raw.replace(' ', 'T'))
}

function shortTime(raw: string) {
  return parseDate(raw).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function firstLetter(name?: string | null) {
  return (name || '?')[0]?.toUpperCase() || '?'
}

function dayLabel(d: Date) {
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

export function MessengerPage() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  // ---- all hooks, top level ----
  const [lang, setLang] = useState('en')

  const {
    conversations,
    activeConvId: cid,
    activeThread,
    online,
    readCursors,
    deliveredCursors,
    openConversation,
    closeConversation,
    send,
    retrySend,
    dismissFailed,
    notifyTyping,
    typingNames,
    textFor,
    startDirect,
  } = useChat(viewer, lang)

  const [showThreadMobile, setShowThreadMobile] = useState(false)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [lightbox, setLightbox] = useState<{ items: string[]; index: number } | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const activeConv = useMemo(
    () => (cid != null ? conversations.find(c => c.id === cid) : undefined),
    [cid, conversations],
  )

  const cleanTarget = query.trim().replace(/^@/, '')

  const canStartDirect =
    !!cleanTarget &&
    !conversations.some(c => (c.counterpart || '').toLowerCase() === cleanTarget.toLowerCase())

  const filteredConversations = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations

    return conversations.filter(c => {
      const title =
        c.kind === 'group'
          ? (c.name || 'Group').toLowerCase()
          : (c.counterpart || 'Direct message').toLowerCase()

      const preview = (c.last_body || '').toLowerCase()

      return title.includes(q) || preview.includes(q)
    })
  }, [conversations, query])

  // Auth guard.
  useEffect(() => {
    if (!localStorage.getItem('space_token')) {
      navigate('/login', { replace: true })
    }
  }, [navigate])

  // Load viewer language.
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

  // Scroll to newest message.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [cid, activeThread.length])

  const openChat = useCallback(
    (conversationId: number) => {
      openConversation(conversationId)
      setShowThreadMobile(true)
      setNote('')
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

    if (d.conversation_id != null) {
      openChat(d.conversation_id)
    }
  }, [cleanTarget, startDirect, openChat])

  const openImagePreview = useCallback((url: string) => {
    setLightbox({ items: [url], index: 0 })
  }, [])

  const downloadImage = useCallback(
    async (url: string) => {
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
        // Fallback: open in a new tab so the user can still save manually.
        window.open(url, '_blank', 'noopener,noreferrer')
        setNote('Direct download was blocked. Opening image in a new tab instead.')
      }
    },
    [],
  )

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

    const url = await uploadFile(file)
    if (url) send(cid, 'image', url)
  }

  async function handleVoiceSend(blob: Blob) {
    if (cid == null) return

    const file = new File([blob], 'voice.webm', { type: blob.type || 'audio/webm' })
    const url = await uploadFile(file)

    if (url) send(cid, 'voice', url)
  }

  function sendMessage(e: React.FormEvent) {
    e.preventDefault()

    const body = draft.trim()
    if (!body || cid == null) return

    send(cid, 'text', body)
    setDraft('')

    if (isDesktop()) {
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }

  function onDraftChange(value: string) {
    setDraft(value)

    if (cid != null && value.trim()) {
      notifyTyping(cid)
    }
  }

  const counterpart = activeConv?.counterpart || ''
  const typing = cid != null ? typingNames(cid) : []

  const readCursor =
    cid != null && counterpart ? readCursors[cid]?.[counterpart] || 0 : 0

  const deliveredCursor =
    cid != null && counterpart ? deliveredCursors[cid]?.[counterpart] || 0 : 0

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
          </div>

          <div className={styles.searchWrap}>
            <Search size={15} className={styles.searchIcon} />
            <input
              className={styles.searchInput}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search or start new chat"
              aria-label="Search or start new chat"
              autoComplete="off"
            />
            {query && (
              <button
                className={styles.searchClear}
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
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

              {filteredConversations.length === 0 && !canStartDirect ? (
                <p className={styles.empty}>No conversations yet.</p>
              ) : (
                filteredConversations.map(c => {
                  const title =
                    c.kind === 'group'
                      ? c.name || 'Group'
                      : c.counterpart || 'Direct message'

                  const preview =
                    c.last_kind === 'image'
                      ? '📷 Photo'
                      : c.last_kind === 'voice'
                        ? '🎤 Voice note'
                        : c.last_body || 'No messages yet'

                  return (
                    <button
                      key={c.id}
                      className={`${styles.convRow} ${cid === c.id ? styles.convRowOn : ''}`}
                      onClick={() => openChat(c.id)}
                    >
                      <span className={styles.convAvatar}>{firstLetter(title)}</span>

                      <span className={styles.convMid}>
                        <span className={styles.convTop}>
                          <strong className={styles.convName}>{title}</strong>
                          {c.last_at && (
                            <span className={styles.convTime}>{shortTime(c.last_at)}</span>
                          )}
                        </span>

                        <span className={styles.convPreview}>{preview}</span>
                      </span>

                      {c.unread > 0 && <span className={styles.unread}>{c.unread}</span>}
                    </button>
                  )
                })
              )}
            </div>
          </ErrorBoundary>
        </aside>

        {/* ----------------------------- THREAD ----------------------------- */}
        <section className={styles.threadWrap}>
          <header className={styles.threadHead}>
            <button
              className={styles.backBtn}
              onClick={backToList}
              aria-label="Back to conversations"
            >
              <ArrowLeft size={18} />
            </button>

            <span className={styles.threadAvatar}>
              {firstLetter(
                activeConv
                  ? activeConv.kind === 'group'
                    ? activeConv.name || 'Group'
                    : activeConv.counterpart || 'Chat'
                  : 'C',
              )}
            </span>

            <div className={styles.threadTitleBlock}>
              <h2 className={styles.threadTitle}>
                {activeConv
                  ? activeConv.kind === 'group'
                    ? activeConv.name || 'Group'
                    : activeConv.counterpart || 'Conversation'
                  : 'Messenger'}
              </h2>

              <p className={styles.threadSub}>
                {typing.length > 0
                  ? `${typing.join(', ')} typing…`
                  : activeConv
                    ? activeConv.kind === 'group'
                      ? 'Group chat'
                      : 'Direct message'
                    : online
                      ? 'Connected'
                      : 'Reconnecting…'}
              </p>
            </div>
          </header>

          {/* Scrolling message area only */}
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
                  {activeThread.length === 0 ? (
                    <p className={styles.emptyThread}>No messages yet. Say hello.</p>
                  ) : (
                    (() => {
                      let lastDayKey = ''

                      return activeThread.map(t => {
                        const date = parseDate(t.created_at)
                        const dayKey = date.toDateString()
                        const showDay = dayKey !== lastDayKey
                        lastDayKey = dayKey

                        const mine = isOptimistic(t) ? true : t.sender === viewer
                        const key = isOptimistic(t) ? t.temp_id : String(t.id)

                        const translation = isOptimistic(t)
                          ? ''
                          : t.kind === 'text'
                            ? textFor(t.body)
                            : ''

                        const showTranslated = !!translation && translation !== t.body

                        let status:
                          | 'sending'
                          | 'failed'
                          | 'sent'
                          | 'delivered'
                          | 'read' = 'sent'

                        if (isOptimistic(t)) {
                          status = t.status
                        } else if (mine && counterpart) {
                          if (readCursor >= t.id) {
                            status = 'read'
                          } else if (deliveredCursor >= t.id) {
                            status = 'delivered'
                          } else {
                            status = 'sent'
                          }
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
                                <span className={styles.msgAvatar}>
                                  {isOptimistic(t)
                                    ? '?'
                                    : firstLetter(t.sender_display || t.sender)}
                                </span>
                              )}

                              <div className={styles.msgCol}>
                                <div
                                  className={`${styles.bubble} ${
                                    t.kind === 'image' ? styles.bubbleImage : ''
                                  }`}
                                >
                                  {!isOptimistic(t) && activeConv.kind === 'group' && (
                                    <p className={styles.senderName}>
                                      {t.sender_display || t.sender}
                                    </p>
                                  )}

                                  {t.kind === 'text' && (
                                    <>
                                      {showTranslated && (
                                        <p className={styles.translated}>{translation}</p>
                                      )}

                                      <p
                                        className={
                                          showTranslated ? styles.original : styles.text
                                        }
                                      >
                                        {t.body}
                                      </p>
                                    </>
                                  )}

                                  {t.kind === 'image' && (
                                    <div className={styles.imageWrap}>
                                      <button
                                        type="button"
                                        className={styles.imagePreviewBtn}
                                        onClick={() => openImagePreview(t.body)}
                                        aria-label="Preview image"
                                      >
                                        <img
                                          src={t.body}
                                          alt="attachment"
                                          className={styles.imageMsg}
                                        />
                                      </button>

                                      <div className={styles.imageActions}>
                                        <button
                                          type="button"
                                          className={styles.imageAction}
                                          onClick={e => {
                                            e.stopPropagation()
                                            openImagePreview(t.body)
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
                                            downloadImage(t.body)
                                          }}
                                          aria-label="Download image"
                                          title="Save image"
                                        >
                                          <Download size={14} />
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {t.kind === 'voice' && (
                                    <VoiceNote
                                      src={t.body}
                                      seed={isOptimistic(t) ? t.seq : t.id}
                                    />
                                  )}
                                </div>

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
                                        <span
                                          className={`${styles.ticks} ${styles.ticksRead}`}
                                        >
                                          <Check size={12} />
                                          <Check size={12} />
                                        </span>
                                      )}
                                    </span>
                                  )}

                                  {isOptimistic(t) && t.status === 'failed' && (
                                    <span className={styles.failedActions}>
                                      <button
                                        className={styles.iconMini}
                                        onClick={() => retrySend(cid, t.temp_id)}
                                        aria-label="Retry message"
                                      >
                                        <RotateCcw size={12} />
                                      </button>

                                      <button
                                        className={styles.iconMini}
                                        onClick={() => dismissFailed(cid, t.temp_id)}
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

          {/* Composer stays outside the scrolling area */}
          {activeConv && cid != null && (
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

              <input
                ref={inputRef}
                className={styles.composerInput}
                value={draft}
                onChange={e => onDraftChange(e.target.value)}
                placeholder="Type a message"
                aria-label="Message"
                autoComplete="off"
                spellCheck
              />

              <VoiceRecorder onSend={handleVoiceSend} />

              <button
                className={styles.sendBtn}
                type="submit"
                disabled={busy || !draft.trim()}
                aria-label="Send message"
              >
                <Send size={18} />
              </button>
            </form>
          )}
        </section>
      </div>

      {lightbox && (
        <Lightbox
          items={lightbox.items}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
    </main>
  )
}