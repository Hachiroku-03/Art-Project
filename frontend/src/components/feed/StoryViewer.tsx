import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  X,
  Plus,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Heart,
  MessageCircle,
  Send,
} from 'lucide-react'
import {
  fetchStoryInteractions,
  toggleStoryLike,
  addStoryComment,
  type StoryUser,
  type StoryComment,
} from '../../lib/feed'
import styles from './StoryViewer.module.css'

const DUR = 5000

export function StoryViewer({
  users,
  startIndex,
  onClose,
  onSeenItem,
  viewer,
  onAdd,
  onDeleteItem,
}: {
  users: StoryUser[]
  startIndex: number
  onClose: () => void
  onSeenItem: (storyId: number) => void
  viewer: string
  onAdd?: () => void
  onDeleteItem?: (userId: string, storyId: number) => Promise<void> | void
}) {
  // ---- all hooks, top level ----
  const [ui, setUi] = useState(startIndex)
  const [ii, setIi] = useState(0)
  const [prog, setProg] = useState(0)
  const [paused, setPaused] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [liked, setLiked] = useState(false)
  const [likeCount, setLikeCount] = useState(0)
  const [comments, setComments] = useState<StoryComment[]>([])
  const [commentText, setCommentText] = useState('')
  const [showComments, setShowComments] = useState(false)
  const [commenting, setCommenting] = useState(false)

  const holdRef = useRef<{ time: number; x: number; y: number; id: number } | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  const user = users[ui]
  const total = user?.items.length ?? 0
  const item = user?.items[ii]
  const itemId = item?.id

  const isOwnStory =
    !!user &&
    !!viewer &&
    user.username.trim().toLowerCase() === viewer.trim().toLowerCase()

  const isPaused = paused || showComments || commenting

  // If items are deleted while viewing, keep index valid.
  useEffect(() => {
    if (total > 0 && ii >= total) {
      setIi(total - 1)
    }
  }, [total, ii])

  const advance = useCallback(() => {
    if (ii < total - 1) {
      setIi(ii + 1)
    } else if (ui < users.length - 1) {
      setUi(ui + 1)
      setIi(0)
    } else {
      onClose()
    }
  }, [ii, total, ui, users.length, onClose])

  const back = useCallback(() => {
    if (ii > 0) {
      setIi(ii - 1)
    } else if (ui > 0) {
      const prev = users[ui - 1]
      setUi(ui - 1)
      setIi(Math.max(0, prev.items.length - 1))
    }
  }, [ii, ui, users])

  // Mark only the CURRENT story item as seen after a short delay.
  useEffect(() => {
    if (!itemId) return

    const t = window.setTimeout(() => {
      onSeenItem(itemId)
    }, 700)

    return () => window.clearTimeout(t)
  }, [itemId, onSeenItem])

  // Load likes + comments for current story item.
  useEffect(() => {
    if (!itemId) return

    let alive = true
    setShowComments(false)
    setCommenting(false)

    fetchStoryInteractions(itemId, viewer).then(d => {
      if (!alive) return
      setLiked(d.liked)
      setLikeCount(d.likes)
      setComments(d.comments)
    })

    return () => {
      alive = false
    }
  }, [itemId, viewer])

  // Auto-advance timer. Pauses on hold, comments panel, or reply input focus.
  useEffect(() => {
    if (!itemId || isPaused) return

    setProg(0)
    const started = Date.now()

    const timer = window.setInterval(() => {
      const p = (Date.now() - started) / DUR
      if (p >= 1) {
        setProg(1)
        advance()
      } else {
        setProg(p)
      }
    }, 50)

    return () => window.clearInterval(timer)
  }, [itemId, isPaused, advance])

  // Keyboard controls.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') advance()
      else if (e.key === 'ArrowLeft') back()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, advance, back])

  function stop(e: ReactMouseEvent | ReactPointerEvent) {
    e.stopPropagation()
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    holdRef.current = {
      time: Date.now(),
      x: e.clientX,
      y: e.clientY,
      id: e.pointerId,
    }
    setPaused(true)
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    setPaused(false)

    const h = holdRef.current
    holdRef.current = null

    if (!h || e.pointerId !== h.id) return

    const dt = Date.now() - h.time
    const dx = Math.abs(e.clientX - h.x)
    const dy = Math.abs(e.clientY - h.y)

    // Quick tap = navigate. Hold = pause only.
    if (dt < 250 && dx < 10 && dy < 10) {
      const rect = frameRef.current?.getBoundingClientRect()
      if (!rect) return

      const rel = (e.clientX - rect.left) / rect.width

      if (rel < 0.32) back()
      else if (rel > 0.68) advance()
    }
  }

  function handlePointerCancel() {
    setPaused(false)
    holdRef.current = null
  }

  async function handleLike(e: ReactMouseEvent) {
    e.stopPropagation()
    if (!itemId || isOwnStory) return

    const res = await toggleStoryLike(itemId, viewer)
    if (!res.error) {
      setLiked(!!res.liked)
      setLikeCount(Number(res.count || 0))
    }
  }

  async function handleComment(e: FormEvent) {
    e.preventDefault()
    e.stopPropagation()

    if (!itemId || isOwnStory || !commentText.trim()) return

    const res = await addStoryComment(itemId, viewer, commentText.trim())
    if (res.comment) {
      setComments(prev => [...prev, res.comment])
      setCommentText('')
      setShowComments(true)
    }
  }

  async function handleDelete(e: ReactMouseEvent) {
    e.stopPropagation()

    if (!user || !itemId || !onDeleteItem) return

    const ok = window.confirm('Delete this story item?')
    if (!ok) return

    setDeleting(true)

    try {
      await onDeleteItem(user.username, itemId)

      if (total <= 1) {
        onClose()
      }
    } catch {
      // Parent handles error display.
    } finally {
      setDeleting(false)
    }
  }

  // ---- early return AFTER all hooks ----
  if (!user) {
    return (
      <div className={styles.overlay} onClick={onClose}>
        <div className={styles.frame}>
          <div className={styles.textCard}>
            <p>Story user not found.</p>
          </div>
        </div>
      </div>
    )
  }

  if (!item) {
    return (
      <div className={styles.overlay} onClick={onClose}>
        <div className={styles.frame}>
          <div className={styles.textCard}>
            <p>This story has no items yet.</p>
          </div>
        </div>
      </div>
    )
  }

  const imageUrl = item.kind === 'image' ? item.url || item.body : null

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div ref={frameRef} className={styles.frame} onClick={e => e.stopPropagation()}>
        {/* progress bars */}
        <div className={styles.bars}>
          {user.items.map((_, k) => (
            <span key={k} className={styles.bar}>
              <span
                className={styles.fill}
                style={{
                  width: k < ii ? '100%' : k === ii ? `${prog * 100}%` : '0%',
                }}
              />
            </span>
          ))}
        </div>

        {/* header */}
        <div className={styles.head} onClick={stop} onMouseDown={stop}>
          <span className={styles.ava}>
            {user.avatar_url ? (
              <img className={styles.userAvatarImg} src={user.avatar_url} alt="" />
            ) : (
              user.username[0]?.toUpperCase()
            )}
          </span>

          <span className={styles.un}>@{user.username}</span>

          {user.username === viewer && onAdd ? (
            <button
              type="button"
              className={styles.addBtn}
              onClick={e => {
                e.stopPropagation()
                onAdd()
              }}
              aria-label="Add to your story"
              title="Add to your story"
            >
              <Plus size={18} />
            </button>
          ) : null}

          {user.username === viewer && onDeleteItem ? (
            <button
              type="button"
              className={styles.deleteBtn}
              onClick={handleDelete}
              disabled={deleting}
              aria-label="Delete this story item"
              title="Delete this story item"
            >
              <Trash2 size={18} />
            </button>
          ) : null}

          <button
            type="button"
            className={styles.x}
            onClick={e => {
              e.stopPropagation()
              onClose()
            }}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* media stage: hold to pause, tap left/right to navigate */}
        <div
          className={styles.stage}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={handlePointerCancel}
        >
          {item.kind === 'image' ? (
            <>
              <img src={imageUrl || ''} alt="" className={styles.img} />

              {item.caption ? (
                <div className={styles.caption}>
                  <p className={styles.captionText}>{item.caption}</p>
                </div>
              ) : null}
            </>
          ) : (
            <div className={styles.textCard}>
              <p>{item.body}</p>
            </div>
          )}

          {paused && !showComments && !commenting ? (
            <span className={styles.pauseBadge}>Hold</span>
          ) : null}
        </div>

        {/* comments panel */}
        {showComments && (
          <div
            className={styles.commentsPanel}
            onClick={stop}
            onMouseDown={stop}
            onPointerDown={stop}
            onPointerUp={stop}
          >
            {comments.length > 0 ? (
              comments.slice(-30).map(c => (
                <div key={c.id} className={styles.commentRow}>
                  <strong>{c.user_name}</strong>
                  <span>{c.body}</span>
                </div>
              ))
            ) : (
              <div className={styles.commentRow}>
                <strong>No replies yet.</strong>
                <span>
                  {isOwnStory
                    ? 'Replies from other members will appear here.'
                    : 'Be the first to reply.'}
                </span>
              </div>
            )}
          </div>
        )}

        {/* interactions */}
        <div
          className={styles.interactions}
          onClick={stop}
          onMouseDown={stop}
          onPointerDown={stop}
          onPointerUp={stop}
        >
          {isOwnStory ? (
            <>
              <span
                className={`${styles.countPill} ${styles.countPillStatic}`}
                aria-label={`${likeCount} likes`}
                title="Likes"
              >
                <Heart size={18} fill="currentColor" />
                <span>{likeCount}</span>
              </span>

              <button
                type="button"
                className={`${styles.countPill} ${styles.countPillButton} ${showComments ? styles.countPillOn : ''}`}
                onClick={e => {
                  e.stopPropagation()
                  setShowComments(s => {
                    const next = !s
                    if (!next) setCommenting(false)
                    return next
                  })
                }}
                aria-label={`Show replies, ${comments.length} total`}
                aria-expanded={showComments}
                title="Replies"
              >
                <MessageCircle size={18} />
                <span>{comments.length}</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`${styles.likeBtn} ${liked ? styles.liked : ''}`}
                onClick={handleLike}
                aria-label="Like story"
              >
                <Heart size={22} fill={liked ? 'currentColor' : 'none'} />
                <span>{likeCount > 0 ? likeCount : ''}</span>
              </button>

              <button
                type="button"
                className={`${styles.commentBtn} ${showComments ? styles.commentBtnOn : ''}`}
                onClick={e => {
                  e.stopPropagation()
                  setShowComments(s => {
                    const next = !s
                    if (!next) setCommenting(false)
                    return next
                  })
                }}
                aria-label="Show comments"
              >
                <MessageCircle size={22} />
                <span>{comments.length > 0 ? comments.length : ''}</span>
              </button>

              <form className={styles.commentForm} onSubmit={handleComment}>
                <input
                  className={styles.commentInput}
                  value={commentText}
                  onChange={e => setCommentText(e.target.value)}
                  onFocus={() => setCommenting(true)}
                  onBlur={() => setCommenting(false)}
                  onClick={stop}
                  onMouseDown={stop}
                  onPointerDown={stop}
                  placeholder="Reply…"
                  aria-label="Reply to story"
                />
                <button
                  type="submit"
                  className={styles.sendBtn}
                  disabled={!commentText.trim()}
                  aria-label="Send reply"
                >
                  <Send size={16} />
                </button>
              </form>
            </>
          )}
        </div>

        {/* explicit nav buttons */}
        <button
          type="button"
          className={`${styles.nav} ${styles.navL}`}
          onClick={e => {
            e.stopPropagation()
            back()
          }}
          aria-label="Previous"
        >
          <ChevronLeft size={26} />
        </button>

        <button
          type="button"
          className={`${styles.nav} ${styles.navR}`}
          onClick={e => {
            e.stopPropagation()
            advance()
          }}
          aria-label="Next"
        >
          <ChevronRight size={26} />
        </button>
      </div>
    </div>
  )
}