import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { X, ChevronLeft, ChevronRight, Heart, MessageCircle, Send } from 'lucide-react'
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
  onSeen,
  viewer,
}: {
  users: StoryUser[]
  startIndex: number
  onClose: () => void
  onSeen: (username: string) => void
  viewer: string
}) {
  // ---- all hooks, top level ----
  const [ui, setUi] = useState(startIndex)
  const [ii, setIi] = useState(0)
  const [prog, setProg] = useState(0)
  const [paused, setPaused] = useState(false)

  const [liked, setLiked] = useState(false)
  const [likeCount, setLikeCount] = useState(0)
  const [comments, setComments] = useState<StoryComment[]>([])
  const [commentText, setCommentText] = useState('')
  const [showComments, setShowComments] = useState(false)

  const holdRef = useRef<{ time: number; x: number; y: number; id: number } | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  const user = users[ui]
  const total = user?.items.length ?? 0
  const item = user?.items[ii]
  const itemId = item?.id

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

  // Mark current user's stories as seen.
  useEffect(() => {
    const u = users[ui]
    if (u) onSeen(u.username)
  }, [ui, users, onSeen])

  // Load likes + comments for current story item.
  useEffect(() => {
    if (!itemId) return

    let alive = true
    setShowComments(false)

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

  // Auto-advance timer. Pauses on hold or when comments panel is open.
  useEffect(() => {
    if (!itemId || paused || showComments) return

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
  }, [itemId, paused, showComments, advance])

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

  async function handleLike() {
    if (!itemId) return

    const res = await toggleStoryLike(itemId, viewer)
    if (!res.error) {
      setLiked(!!res.liked)
      setLikeCount(Number(res.count || 0))
    }
  }

  async function handleComment(e: FormEvent) {
    e.preventDefault()
    if (!itemId || !commentText.trim()) return

    const res = await addStoryComment(itemId, viewer, commentText.trim())
    if (res.comment) {
      setComments(prev => [...prev, res.comment])
      setCommentText('')
      setShowComments(true)
    }
  }

  // ---- early return AFTER all hooks ----
  if (!user || !item) return null

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
        <div className={styles.head}>
          <span className={styles.ava}>{user.username[0]?.toUpperCase()}</span>
          <span className={styles.un}>@{user.username}</span>
          <button className={styles.x} onClick={onClose} aria-label="Close">
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
            <img src={item.body} alt="" className={styles.img} />
          ) : (
            <div className={styles.textCard}>
              <p>{item.body}</p>
            </div>
          )}

          {paused && <span className={styles.pauseBadge}>Hold</span>}
        </div>

        {/* comments panel */}
        {showComments && comments.length > 0 && (
          <div className={styles.commentsPanel}>
            {comments.slice(-30).map(c => (
              <div key={c.id} className={styles.commentRow}>
                <strong>{c.user_name}</strong>
                <span>{c.body}</span>
              </div>
            ))}
          </div>
        )}

        {/* interactions */}
        <div className={styles.interactions}>
          <button
            className={`${styles.likeBtn} ${liked ? styles.liked : ''}`}
            onClick={handleLike}
            aria-label="Like story"
          >
            <Heart size={22} fill={liked ? 'currentColor' : 'none'} />
            <span>{likeCount > 0 ? likeCount : ''}</span>
          </button>

          <button
            className={`${styles.commentBtn} ${showComments ? styles.commentBtnOn : ''}`}
            onClick={() => setShowComments(s => !s)}
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
              placeholder="Reply…"
              aria-label="Reply to story"
            />
            <button
              className={styles.sendBtn}
              type="submit"
              disabled={!commentText.trim()}
              aria-label="Send reply"
            >
              <Send size={16} />
            </button>
          </form>
        </div>

        {/* explicit nav buttons */}
        <button className={`${styles.nav} ${styles.navL}`} onClick={back} aria-label="Previous">
          <ChevronLeft size={26} />
        </button>
        <button className={`${styles.nav} ${styles.navR}`} onClick={advance} aria-label="Next">
          <ChevronRight size={26} />
        </button>
      </div>
    </div>
  )
}