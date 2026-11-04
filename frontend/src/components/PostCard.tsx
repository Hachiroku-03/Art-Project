import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Heart, MessageCircle, Share2, Bookmark, Images, Check, Flag, Trash2, Loader2 } from 'lucide-react'
import { API } from '../lib/sales'
import styles from './PostCard.module.css'

export type Post = {
  id: number
  title: string
  description: string
  image_url: string
  images?: string[]
  username: string
  role: string
  tier: string
  display_name: string
  avatar_url?: string | null
  has_active_story?: boolean
  created_at: string
  like_count: number
  comment_count: number
  liked_by_viewer: boolean
  followed_by_viewer: boolean
  bookmarked_by_viewer: boolean
  bookmark_count: number
  year?: string | number | null
  medium?: string | null
  dimensions?: string | null
  location?: string | null
}

type PostCardProps = {
  post: Post
  viewer: string
  lang: string
  autoDesc?: string
  /** Called after a successful delete so the parent list can drop the card.
   *  FeedPage MUST pass this (or reload); otherwise the deleted post lingers
   *  until refresh. Optional so existing call sites keep compiling. */
  onDeleted?: (postId: number) => void
}

const REPORT_REASONS = ['Spam or scam', 'Infringes my rights', 'Harassment or hate', 'Misleading / fake art', 'Other']

function exactTime(raw: string) {
  const d = new Date(raw.replace(' ', 'T'))
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function PostCard({ post, viewer, autoDesc, onDeleted }: PostCardProps) {
  const navigate = useNavigate()

  const [liked, setLiked] = useState(post.liked_by_viewer)
  const [likeCount, setLikeCount] = useState(post.like_count)
  const [following, setFollowing] = useState(post.followed_by_viewer)
  const [bookmarked, setBookmarked] = useState(post.bookmarked_by_viewer)
  const [bmCount, setBmCount] = useState(post.bookmark_count)
  const [shared, setShared] = useState(false)

  // delete / report local state
  const [deleting, setDeleting] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportReason, setReportReason] = useState('')
  const [reportNote, setReportNote] = useState('')
  const [reporting, setReporting] = useState(false)
  const [reported, setReported] = useState(false)

  // !!viewer guard: an empty/undefined viewer must NOT throw (viewer.trim() on
  // undefined crashes the whole card render) and must NOT be treated as "own".
  const isOwn = !!viewer && viewer.trim().toLowerCase() === post.username.trim().toLowerCase()
  const hasAutoDesc = !!autoDesc && autoDesc.trim() !== (post.description || '').trim()
  const note = hasAutoDesc ? autoDesc : post.description
  const photoCount = post.images?.length ?? 0
  const initial = (post.display_name || post.username)[0]?.toUpperCase() || '?'

  const specParts = [post.dimensions, post.location].filter(Boolean) as string[]
  const hasSpec = !!post.medium || specParts.length > 0

  async function toggleLike(e: React.MouseEvent) {
    e.stopPropagation()
    const res = await fetch(`${API}/posts/${post.id}/like`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer }),
    })
    const data = await res.json()
    setLiked(data.liked)
    setLikeCount(data.count)
  }

  async function toggleFollow(e: React.MouseEvent) {
    e.stopPropagation()
    if (!viewer) { navigate('/login'); return }
    const res = await fetch(`${API}/follow`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, target: post.username }),
    })
    const data = await res.json()
    setFollowing(!!data.following)
  }

  async function toggleBookmark(e: React.MouseEvent) {
    e.stopPropagation()
    const res = await fetch(`${API}/posts/${post.id}/bookmark`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer }),
    })
    const data = await res.json()
    setBookmarked(data.bookmarked)
    setBmCount(data.count)
  }

  async function share(e: React.MouseEvent) {
    e.stopPropagation()
    const url = `${window.location.origin}/post/${post.id}`
    try {
      if (navigator.share) await navigator.share({ title: post.title, url })
      else { await navigator.clipboard.writeText(url); setShared(true); window.setTimeout(() => setShared(false), 2000) }
    } catch { /* cancelled / clipboard blocked */ }
  }

  async function removePost(e: React.MouseEvent) {
    e.stopPropagation()
    if (!isOwn || deleting) return
    const ok = window.confirm(`Delete “${post.title}”? This cannot be undone.`)
    if (!ok) return
    setDeleting(true)
    try {
      // RESTful delete. If your feed router instead exposes POST /posts/{id}/delete,
      // change the method+path here (one line) — see the contract note below.
      const res = await fetch(`${API}/posts/${post.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && !data.error) {
        onDeleted?.(post.id)        // let FeedPage drop the card immediately
      } else {
        window.alert(data.error || 'Could not delete this post.')
      }
    } catch {
      window.alert('Network error while deleting.')
    } finally {
      setDeleting(false)
    }
  }

  async function submitReport(e: React.MouseEvent) {
    e.stopPropagation()
    if (reporting) return
    const reason = (reportReason || reportNote || 'Other').trim() || 'Other'
    setReporting(true)
    try {
      const res = await fetch(`${API}/posts/${post.id}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer, reason, note: reportNote.trim() || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && !data.error) {
        setReported(true)
        setReportOpen(false)
        setReportReason('')
        setReportNote('')
        window.setTimeout(() => setReported(false), 4000)
      } else {
        window.alert(data.error || 'Could not send the report.')
      }
    } catch {
      window.alert('Network error while reporting.')
    } finally {
      setReporting(false)
    }
  }

  function openAuthor(e: React.MouseEvent) {
    e.stopPropagation()
    navigate(`/profile/${post.username}`)
  }

  return (
    <article className={styles.card} onClick={() => navigate(`/post/${post.id}`)}>
      <div className={styles.frame}>
        {post.image_url ? (
          <img className={styles.art} src={post.image_url} alt={post.title} loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <div className={styles.placeholder}>No image</div>
        )}
        {photoCount > 1 && (<span className={styles.count}><Images size={12} /> {photoCount}</span>)}
      </div>

      <div className={styles.label}>
        <div className={styles.labelMain}>
          <div className={styles.artistRow}>
            <button className={`${styles.avatarWrap} ${post.has_active_story ? styles.hasStory : ''}`} onClick={openAuthor} aria-label="View profile">
              <span className={`${styles.avatar} ${post.tier === 'vip' ? styles.vip : ''}`}>
                {post.avatar_url ? <img src={post.avatar_url} alt="" referrerPolicy="no-referrer" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} /> : initial}
              </span>
            </button>
            <button className={styles.artist} onClick={openAuthor}>{post.display_name || post.username}</button>
          </div>

          <h2 className={styles.title}>{post.title}{post.year && <small className={styles.year}>{post.year}</small>}</h2>

          {hasSpec && (
            <p className={styles.spec}>
              {post.medium && <i>{post.medium}</i>}
              {post.medium && specParts.length > 0 && <span className={styles.dot}>·</span>}
              {specParts.join(' · ')}
            </p>
          )}

          {note && (<p className={styles.note}>{note}{hasAutoDesc && <span className={styles.translated}>translated</span>}</p>)}
        </div>

        <div className={styles.labelSide}>
          <time className={styles.time} dateTime={post.created_at}>{exactTime(post.created_at)}</time>
          {isOwn ? (
            <span className={styles.own}>Your work</span>
          ) : (
            <button className={`${styles.follow} ${following ? styles.following : ''}`} onClick={toggleFollow}>
              {following ? 'Following' : 'Follow'}
            </button>
          )}
        </div>
      </div>

      <div className={styles.actions}>
        <button className={`${styles.act} ${liked ? styles.on : ''}`} onClick={toggleLike} aria-label="Like">
          <Heart size={18} fill={liked ? 'currentColor' : 'none'} /><span>{likeCount}</span>
        </button>

        <button className={styles.act} onClick={e => { e.stopPropagation(); navigate(`/post/${post.id}`) }} aria-label="Comments">
          <MessageCircle size={18} /><span>{post.comment_count}</span>
        </button>

        <button className={`${styles.act} ${shared ? styles.on : ''}`} onClick={share} aria-label="Share">
          {shared ? <Check size={18} /> : <Share2 size={18} />}{shared && <span>Copied</span>}
        </button>

        {/* owner -> Delete ; others -> Report */}
        {isOwn ? (
          <button
            className={`${styles.act} ${styles.keep}`}
            onClick={removePost}
            disabled={deleting}
            aria-label="Delete post"
            title="Delete this post"
            style={deleting ? { opacity: 0.6, cursor: 'progress' } : undefined}
          >
            {deleting ? <Loader2 size={18} className={styles.spin} /> : <Trash2 size={18} />}
            <span>{deleting ? 'Deleting…' : 'Delete'}</span>
          </button>
        ) : (
          <div className={styles.keep} style={{ position: 'relative' }}>
            <button
              className={`${styles.act} ${reported ? styles.on : ''}`}
              onClick={e => { e.stopPropagation(); setReportOpen(o => !o) }}
              aria-label="Report post"
              title="Report this post"
            >
              {reported ? <Check size={18} /> : <Flag size={18} />}
              <span>{reported ? 'Reported' : 'Report'}</span>
            </button>

            {reportOpen && !reported && (
              <div
                role="dialog"
                aria-label="Report post"
                onClick={e => e.stopPropagation()}
                style={{
                  position: 'absolute', right: 0, top: 'calc(100% + .4rem)', zIndex: 30,
                  width: 248, padding: '.7rem .75rem', borderRadius: 6,
                  background: 'var(--paper)', border: '1px solid var(--line)',
                  boxShadow: '0 18px 44px rgba(20,18,15,0.16)', display: 'flex',
                  flexDirection: 'column', gap: '.5rem', textAlign: 'left', cursor: 'default',
                }}
              >
                <span style={{ font: '600 .72rem var(--font-ui)', letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ink-soft)' }}>
                  Report “{post.title}”
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.35rem' }}>
                  {REPORT_REASONS.map(r => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setReportReason(r)}
                      style={{
                        font: '500 .72rem var(--font-ui)', padding: '.3rem .5rem', borderRadius: 4,
                        cursor: 'pointer',
                        border: `1px solid ${reportReason === r ? 'var(--ink)' : 'var(--line)'}`,
                        background: reportReason === r ? 'var(--ink)' : 'transparent',
                        color: reportReason === r ? 'var(--paper)' : 'var(--ink-soft)',
                      }}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <textarea
                  value={reportNote}
                  onChange={e => setReportNote(e.target.value)}
                  placeholder={reportReason === 'Other' ? 'Tell us what’s wrong…' : 'Add detail (optional)…'}
                  rows={2}
                  style={{ font: '.8rem var(--font-ui)', padding: '.4rem .5rem', borderRadius: 4, border: '1px solid var(--line)', background: 'var(--wall)', color: 'var(--ink)', resize: 'vertical' }}
                />
                <div style={{ display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
                  <button type="button" onClick={() => setReportOpen(false)} style={{ font: '600 .7rem var(--font-ui)', padding: '.35rem .6rem', borderRadius: 4, border: '1px solid var(--line)', background: 'none', color: 'var(--ink-soft)', cursor: 'pointer' }}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submitReport}
                    disabled={reporting || (!reportReason && !reportNote.trim())}
                    style={{ font: '600 .7rem var(--font-ui)', padding: '.35rem .7rem', borderRadius: 4, border: '1px solid var(--ink)', background: 'var(--ink)', color: 'var(--paper)', cursor: reporting || (!reportReason && !reportNote.trim()) ? 'progress' : 'pointer', opacity: reporting || (!reportReason && !reportNote.trim()) ? 0.55 : 1 }}
                  >
                    {reporting ? 'Sending…' : 'Submit report'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <button className={`${styles.act} ${bookmarked ? styles.on : ''}`} onClick={toggleBookmark} aria-label={bookmarked ? 'Remove from your wall' : 'Keep'} style={isOwn ? undefined : { marginLeft: 0 }}>
          <Bookmark size={18} fill={bookmarked ? 'currentColor' : 'none'} />
          <span>{bookmarked ? 'Kept' : 'Keep'}{bmCount ? ` · ${bmCount}` : ''}</span>
        </button>
      </div>
    </article>
  )
}