import { useEffect, useState, useRef, useMemo, type FormEvent, type ChangeEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Heart, Share2, Bookmark, Image as ImageIcon, Send, ArrowLeft, X, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { Preloader } from '../components/Preloader'
import { VoiceRecorder } from '../components/VoiceRecorder'
import { VoiceNote } from '../components/VoiceNote'
import { Lightbox } from '../components/Lightbox'
import { translateMany } from '../lib/translate'
import { getViewer } from '../lib/session'
import styles from './PostRoomPage.module.css'

const AUTH_API = 'http://localhost:8000'
const FEED_API = 'http://localhost:8001'

const REPORT_REASONS = ['Spam or scam', 'Infringes my rights', 'Harassment or hate', 'Misleading / fake art', 'Other']

type PostData = {
  id: number; type: string; title: string; description: string; image_url: string;
  images?: string[] | string;            // backend may return a JSON string
  avatar_url?: string | null;            // author photo (room header)
  price?: string; current_bid?: string;
  created_at: string;
  username: string; role: string; tier: string; display_name: string;
  like_count: number; comment_count: number; liked_by_viewer: boolean; followed_by_viewer: boolean;
  bookmarked_by_viewer?: boolean; bookmark_count?: number;
}
type CommentRow = {
  id: number; user_name: string; body: string; kind: string; parent_id: number | null; created_at: string;
  avatar_url?: string | null;            // commenter photo (thread)
  deleted?: boolean;                     // soft-deleted -> render [removed], keep replies
  like_count?: number; liked_by_viewer?: boolean;
}

function exactTime(raw: string) {
  const d = new Date(raw.replace(' ', 'T'))
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function shortTime(raw: string) {
  const d = new Date(raw.replace(' ', 'T'))
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Accept array OR JSON string OR lone url -> always a clean string[].
function parseImages(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string' && !!x.trim())
  if (typeof raw === 'string' && raw.trim()) {
    const t = raw.trim()
    if (t.startsWith('[')) {
      try {
        const p = JSON.parse(t)
        if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string' && !!x.trim())
      } catch { /* not JSON -> fall through */ }
    }
    return [t]
  }
  return []
}

// Per-comment avatar with its OWN failure state: one broken/hotlink-blocked CDN URL
// must not hide every other avatar in the thread (a shared boolean would).
// Sized entirely by CSS (.cAvatar 36px, .repliesWrap .cAvatar 28px) — no inline size,
// so the replies override keeps working.
function CommentAvatar({ name, url }: { name: string; url?: string | null }) {
  const [failed, setFailed] = useState(false)
  const initial = (name || '?')[0]?.toUpperCase() || '?'
  return (
    <div className={styles.cAvatar}>
      {url && !failed ? (
        <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        initial
      )}
    </div>
  )
}

export function PostRoomPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  // identity resolved like the feed (getViewer first) so isOwn is correct on your own post
  const viewer = getViewer() || localStorage.getItem('space_user') || ''

  const [post, setPost] = useState<PostData | null>(null)
  const [comments, setComments] = useState<CommentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [liked, setLiked] = useState(false)
  const [likeCount, setLikeCount] = useState(0)
  const [following, setFollowing] = useState(false)

  // ---- top block, ABOVE every early return (Rules of Hooks) ----
  const [bookmarked, setBookmarked] = useState(false)
  const [bmCount, setBmCount] = useState(0)
  const [galleryIndex, setGalleryIndex] = useState(0)
  const [lightbox, setLightbox] = useState<{ items: string[]; index: number } | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  const [avatarFailed, setAvatarFailed] = useState(false)   // room header avatar only

  const [deleting, setDeleting] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportReason, setReportReason] = useState('')
  const [reportNote, setReportNote] = useState('')
  const [reporting, setReporting] = useState(false)
  const [reported, setReported] = useState(false)

  const [draft, setDraft] = useState('')
  const [replyingTo, setReplyingTo] = useState<CommentRow | null>(null)
  const [expandedThreads, setExpandedThreads] = useState<Record<number, boolean>>({})
  const [commentLikes, setCommentLikes] = useState<Record<number, { liked: boolean; count: number }>>({})
  const [sortBy, setSortBy] = useState<'top' | 'newest'>('top')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLInputElement>(null)

  const [lang, setLang] = useState('en')
  const [autoDesc, setAutoDesc] = useState('')
  const [threadTranslated, setThreadTranslated] = useState(true)
  const [commentTranslations, setCommentTranslations] = useState<Record<number, string>>({})

  const topLevelComments = useMemo(() => {
    if (!post) return []
    const base = comments.filter(c => !c.parent_id)
    if (sortBy === 'top') {
      return [...base].sort((a, b) => {
        const aLikes = commentLikes[a.id]?.count || 0
        const bLikes = commentLikes[b.id]?.count || 0
        return bLikes - aLikes
      })
    }
    // backend returns ASC; 'newest' must reverse it
    return [...base].sort(
      (a, b) => new Date(b.created_at.replace(' ', 'T')).getTime() - new Date(a.created_at.replace(' ', 'T')).getTime(),
    )
  }, [comments, sortBy, commentLikes, post])

  useEffect(() => {
    if (!id) return
    async function loadRoom() {
      let language = 'en'
      try {
        const sRes = await fetch(`${AUTH_API}/settings?viewer=${encodeURIComponent(viewer)}`)
        const s = await sRes.json()
        language = s.language || 'en'
        setLang(language)
      } catch { /* default */ }

      try {
        const res = await fetch(`${FEED_API}/posts/${id}?viewer=${encodeURIComponent(viewer)}`)
        const data = await res.json()
        if (data.post) {
          setPost(data.post)
          setLiked(data.post.liked_by_viewer)
          setLikeCount(data.post.like_count)
          setFollowing(data.post.followed_by_viewer)
          setBookmarked(!!data.post.bookmarked_by_viewer)
          setBmCount(data.post.bookmark_count ?? 0)
          setGalleryIndex(0)
          setAvatarFailed(false)
          if (data.post.description) {
            try {
              const t = (await translateMany([data.post.description], language))[0]
              setAutoDesc(t)
            } catch { /* keep original */ }
          }
        } else {
          setError(data.error || `server responded ${res.status}`)
        }
      } catch {
        setError('network error - is feed_server running?')
      }

      try {
        const cRes = await fetch(`${FEED_API}/posts/${id}/comments?viewer=${encodeURIComponent(viewer)}`)
        const cData = await cRes.json()
        const list: CommentRow[] = cData.comments || []
        setComments(list)
        const likeMap: Record<number, { liked: boolean; count: number }> = {}
        list.forEach(c => { likeMap[c.id] = { liked: !!c.liked_by_viewer, count: c.like_count || 0 } })
        setCommentLikes(likeMap)
        const textComments = list.filter(c => c.kind === 'text' && !c.deleted)
        if (textComments.length > 0) {
          const tResults = await translateMany(textComments.map(c => c.body), language)
          const map: Record<number, string> = {}
          textComments.forEach((c, i) => { map[c.id] = tResults[i] })
          setCommentTranslations(map)
        }
      } catch { /* error */ }
      setLoading(false)
    }
    loadRoom()
  }, [id, viewer])

  async function toggleLike() {
    if (!post) return
    const res = await fetch(`${FEED_API}/posts/${post.id}/like`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer }) })
    const data = await res.json()
    setLiked(data.liked); setLikeCount(data.count)
  }
  async function toggleBookmark() {
    if (!post) return
    const res = await fetch(`${FEED_API}/posts/${post.id}/bookmark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer }) })
    const data = await res.json()
    setBookmarked(!!data.bookmarked); setBmCount(data.count ?? 0)
  }
  async function toggleCommentLike(c: CommentRow) {
    const res = await fetch(`${FEED_API}/comments/${c.id}/like`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer }) })
    const data = await res.json()
    if (data.error) { setError(data.error); return }
    setCommentLikes(prev => ({ ...prev, [c.id]: { liked: data.liked, count: data.count } }))
  }
  async function toggleFollow() {
    if (!post) return
    const res = await fetch(`${FEED_API}/follow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, target: post.username }) })
    const data = await res.json()
    setFollowing(data.following)
  }

  // author deletes own post (soft). viewer via query (DELETE bodies get stripped).
  async function deletePost() {
    if (!post) return
    const ok = window.confirm(`Delete "${post.title}"? This cannot be undone.`)
    if (!ok) return
    setDeleting(true)
    try {
      const res = await fetch(`${FEED_API}/posts/${post.id}?viewer=${encodeURIComponent(viewer)}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && !data.error) {
        navigate('/feed', { replace: true })
        return
      }
      setError(data.error || 'Could not delete this post.')
    } catch {
      setError('Network error while deleting.')
    } finally {
      setDeleting(false)
    }
  }

  // comment-author soft-deletes own comment. Mark removed IN PLACE (do not splice)
  // so replies stay under the [removed] root.
  async function deleteComment(c: CommentRow) {
    if (!viewer) return
    const ok = window.confirm('Delete this comment?')
    if (!ok) return
    try {
      const res = await fetch(`${FEED_API}/comments/${c.id}?viewer=${encodeURIComponent(viewer)}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && !data.error) {
        setComments(prev => prev.map(x => (x.id === c.id ? { ...x, deleted: true } : x)))
      } else {
        setError(data.error || 'Could not delete this comment.')
      }
    } catch {
      setError('Network error while deleting comment.')
    }
  }

  // non-author reports the post. Self-reports rejected server-side (and never offered here).
  async function submitReport() {
    if (!post || reporting) return
    const reason = (reportReason || reportNote || 'Other').trim() || 'Other'
    setReporting(true)
    try {
      const res = await fetch(`${FEED_API}/posts/${post.id}/report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer, reason, note: reportNote.trim() || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && !data.error) {
        setReported(true); setReportOpen(false); setReportReason(''); setReportNote('')
        window.setTimeout(() => setReported(false), 4000)
      } else {
        setError(data.error || 'Could not send the report.')
      }
    } catch {
      setError('Network error while reporting.')
    } finally {
      setReporting(false)
    }
  }

  async function uploadFile(file: File): Promise<string | null> {
    const form = new FormData(); form.append('file', file)
    try {
      const res = await fetch(`${FEED_API}/upload`, { method: 'POST', body: form })
      const data = await res.json()
      return data.url ?? null
    } catch { return null }
  }

  // flatten replies to the top-level ancestor so a reply-to-a-reply isn't orphaned.
  async function postComment(body: string, kind: 'text' | 'image' | 'voice'): Promise<boolean> {
    if (!post) return false
    const parentId = replyingTo ? (replyingTo.parent_id ?? replyingTo.id) : null
    try {
      const res = await fetch(`${FEED_API}/posts/${post.id}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer, body, kind, parent_id: parentId }),
      })
      const data = await res.json()
      if (data.comment) {
        const newC = data.comment as CommentRow
        setComments(prev => [...prev, newC])
        setCommentLikes(prev => ({ ...prev, [newC.id]: { liked: false, count: 0 } }))
        setReplyingTo(null)
        if (kind === 'text') {
          try {
            const t = (await translateMany([newC.body], lang))[0]
            setCommentTranslations(prev => ({ ...prev, [newC.id]: t }))
          } catch { /* keep original */ }
        }
        return true
      }
      return false
    } catch {
      return false
    }
  }

  async function handleVoiceSend(blob: Blob) {
    // iOS emits audio/mp4 (some builds audio/mpeg); name by real subtype.
    const subtype = (blob.type || 'audio/webm').split('/')[1]?.split(';')[0].trim() || 'webm'
    const ext = subtype === 'mpeg' ? 'mp3' : subtype === 'mp4' ? 'm4a' : subtype
    const file = new File([blob], `voice.${ext}`, { type: blob.type || 'audio/webm' })
    const url = await uploadFile(file)
    if (url) await postComment(url, 'voice')
  }

  async function submitComment(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    // keep the draft until the server confirms (a failed post must not erase your text)
    const ok = await postComment(text, 'text')
    if (ok) setDraft('')
  }

  function handleImagePick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    uploadFile(file).then(url => { if (url) postComment(url, 'image') })
    e.target.value = ''
  }
  function handleReplyClick(comment: CommentRow) {
    setReplyingTo(comment)
    composerRef.current?.focus()
  }

  if (loading) return <main className={styles.layout}><Navbar /><Preloader done={false} /></main>

   if (!post) return (
    <main className={styles.layout}>
      <Navbar />
      <div style={{ padding: '140px 2rem', textAlign: 'center' }}>
        <p style={{ fontFamily: 'var(--font-label)', fontStyle: 'italic', fontSize: '1.3rem', color: 'var(--ink-soft)' }}>
          The post room is empty: {error || 'unknown reason'}
        </p>
        <button onClick={() => navigate('/feed')} style={{ marginTop: '1.5rem', padding: '0.6rem 1.3rem', border: '1px solid var(--ink)', background: 'transparent', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase' }}>
          Back to feed
        </button>
      </div>
    </main>
  )

  // ---- derived + plain handlers, AFTER the early returns (not hooks → legal) ----
  // case-insensitive, trimmed ownership check: author sees Delete ONLY (no Follow/Report)
  const isOwn = !!viewer && viewer.trim().toLowerCase() === (post.username || '').trim().toLowerCase()
  const hasAutoDesc = !!autoDesc && autoDesc.trim() !== (post.description || '').trim()
  const getReplies = (parentId: number) => comments.filter(c => c.parent_id === parentId)
  const parsedImages = parseImages(post.images)
  const gallery = parsedImages.length ? parsedImages : (post.image_url ? [post.image_url] : [])
  const multi = gallery.length > 1

  function scrollToIndex(i: number) {
    const el = trackRef.current; if (!el) return
    const n = Math.max(0, Math.min(gallery.length - 1, i))
    el.scrollTo({ left: n * el.clientWidth, behavior: 'smooth' })
    setGalleryIndex(n)
  }
  function onTrackScroll() {
    const el = trackRef.current; if (!el) return
    const i = Math.round(el.scrollLeft / el.clientWidth)
    if (i !== galleryIndex) setGalleryIndex(i)
  }
  function openLightbox(i: number) { if (gallery.length) setLightbox({ items: gallery, index: i }) }
  // snap the track to the lightbox's last index on close (no dot/count desync)
  function closeLightbox() {
    setLightbox(null)
    const el = trackRef.current
    if (el) el.scrollLeft = galleryIndex * el.clientWidth
  }

  function renderComment(c: CommentRow) {
    const lk = commentLikes[c.id] || { liked: false, count: 0 }
    const uname = (c.user_name || '').trim().toLowerCase()
    const isAuthor = uname === (post?.username || '').trim().toLowerCase()   // "Author" tag
    const isMine = uname === (viewer || '').trim().toLowerCase()             // can delete

    // REMOVED: keep avatar + name so the thread reads; blank the body; no like/reply/media.
    // This branch runs BEFORE the kind checks so a removed image/voice comment doesn't
    // still render its media.
    if (c.deleted) {
      return (
        <div key={c.id} className={styles.commentRow}>
          <CommentAvatar name={c.user_name} url={c.avatar_url} />
          <div className={styles.cMain}>
            <p className={styles.cName}>
              {c.user_name}
              {isAuthor && <span className={styles.authorTag}>Author</span>}
            </p>
            <p className={`${styles.cBody} ${styles.cRemoved}`}>[This comment was removed]</p>
          </div>
        </div>
      )
    }

    return (
      <div key={c.id} className={styles.commentRow}>
        <CommentAvatar name={c.user_name} url={c.avatar_url} />
        <div className={styles.cMain}>
          <p className={styles.cName}>
            {c.user_name}
            {isAuthor && <span className={styles.authorTag}>Author</span>}
          </p>
          {c.kind === 'image' && c.body ? (
            <img className={styles.commentImage} src={c.body} alt="attachment" onClick={() => setLightbox({ items: [c.body], index: 0 })} />
          ) : c.kind === 'voice' && c.body ? (
            <VoiceNote src={c.body} seed={c.id} />
          ) : (
            <p className={styles.cBody}>{threadTranslated && commentTranslations[c.id] ? commentTranslations[c.id] : c.body}</p>
          )}
          <div className={styles.cMeta}>
            <span>{shortTime(c.created_at)}</span>
            <button className={styles.metaBtn} onClick={() => handleReplyClick(c)}>Reply</button>
            {isMine && (
              <button className={`${styles.metaBtn} ${styles.metaDanger}`} onClick={() => void deleteComment(c)}>Delete</button>
            )}
          </div>
        </div>
        <button className={`${styles.cLike} ${lk.liked ? styles.cLiked : ''}`} onClick={() => toggleCommentLike(c)} aria-label="Like comment">
          <Heart size={18} fill={lk.liked ? 'currentColor' : 'none'} />
          <span className={styles.cLikeCount}>{lk.count > 0 ? lk.count : ''}</span>
        </button>
      </div>
    )
  }

  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.container}>

        <div className={styles.piece}>

          {/* 1. MEDIA STAGE */}
          <div className={styles.stage}>
            {gallery.length === 0 ? (
              <div className={styles.stagePlaceholder}>canvas awaiting its first layer</div>
            ) : (
              <>
                <div ref={trackRef} className={styles.track} onScroll={onTrackScroll}>
                  {gallery.map((u, i) => (
                    <img key={u + i} src={u} alt={post.title} className={styles.trackImg} onClick={() => openLightbox(i)} />
                  ))}
                </div>
                {multi && (
                  <>
                    <button className={`${styles.galArrow} ${styles.galPrev}`} onClick={() => scrollToIndex(galleryIndex - 1)} aria-label="Previous image" disabled={galleryIndex === 0}><ChevronLeft size={22} /></button>
                    <button className={`${styles.galArrow} ${styles.galNext}`} onClick={() => scrollToIndex(galleryIndex + 1)} aria-label="Next image" disabled={galleryIndex === gallery.length - 1}><ChevronRight size={22} /></button>
                    <span className={styles.galCount}>{galleryIndex + 1} / {gallery.length}</span>
                    <div className={styles.dots}>
                      {gallery.map((_, i) => (
                        <button key={i} className={`${styles.dot} ${i === galleryIndex ? styles.dotOn : ''}`} onClick={() => scrollToIndex(i)} aria-label={`Image ${i + 1}`} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            <button className={styles.backBtnFloat} onClick={() => navigate(-1)} aria-label="Back"><ArrowLeft size={20} /></button>
          </div>

          {/* 2. CONTENT INFO */}
          <div className={styles.contentBlock}>
            <header className={styles.header}>
              <div className={styles.who}>
                <div className={`${styles.avatar} ${post.tier === 'vip' ? styles.vipRing : ''}`}>
                  {post.avatar_url && !avatarFailed ? (
                    <img src={post.avatar_url} alt="" referrerPolicy="no-referrer" onError={() => setAvatarFailed(true)} />
                  ) : (
                    (post.display_name || post.username)[0]?.toUpperCase()
                  )}
                </div>
                <div>
                  <button className={styles.name} onClick={() => navigate(`/profile/${post.username}`)}>{post.display_name || post.username}</button>
                  <p className={styles.meta}>{post.type.toUpperCase()} · {exactTime(post.created_at)}</p>
                </div>
              </div>

              {/* author -> Delete ONLY ; stranger -> Follow + Report */}
              <div className={styles.headerRight}>
                {isOwn ? (
                  <button className={styles.dangerBtn} onClick={() => void deletePost()} disabled={deleting} aria-label="Delete post">
                    {deleting ? 'Deleting…' : 'Delete'}
                  </button>
                ) : (
                  <>
                    <button className={`${styles.followBtn} ${following ? styles.following : ''}`} onClick={toggleFollow}>
                      {following ? 'Following' : 'Follow'}
                    </button>
                    <button className={styles.followBtn} onClick={() => setReportOpen(o => !o)} aria-label="Report post" title="Report this post">
                      {reported ? 'Reported' : 'Report'}
                    </button>

                    {reportOpen && !reported && (
                      <div
                        role="dialog"
                        aria-label="Report post"
                        onClick={e => e.stopPropagation()}
                        style={{
                          position: 'absolute', right: 0, top: 'calc(100% + .4rem)', zIndex: 40,
                          width: 240, padding: '.6rem .65rem', borderRadius: 10,
                          background: 'var(--paper)', border: '1px solid var(--line)',
                          boxShadow: '0 16px 40px -8px rgba(20,18,15,0.18)',
                          display: 'flex', flexDirection: 'column', gap: '.45rem', textAlign: 'left',
                        }}
                      >
                        <span style={{ font: '600 .66rem var(--font-ui)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--ink-faint)' }}>
                          Report this post
                        </span>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.3rem' }}>
                          {REPORT_REASONS.map(r => (
                            <button
                              key={r}
                              type="button"
                              onClick={() => setReportReason(r)}
                              style={{
                                font: '500 .68rem var(--font-ui)', padding: '.28rem .5rem', borderRadius: 999, cursor: 'pointer',
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
                          placeholder="Add detail (optional)…"
                          rows={2}
                          style={{ font: '.8rem var(--font-ui)', padding: '.4rem .5rem', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--wall)', color: 'var(--ink)', resize: 'vertical' }}
                        />
                        <div style={{ display: 'flex', gap: '.4rem', justifyContent: 'flex-end' }}>
                          <button type="button" onClick={() => setReportOpen(false)} style={{ font: '600 .66rem var(--font-ui)', padding: '.32rem .6rem', borderRadius: 999, border: '1px solid var(--line)', background: 'none', color: 'var(--ink-soft)', cursor: 'pointer' }}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => void submitReport()}
                            disabled={reporting || (!reportReason && !reportNote.trim())}
                            style={{ font: '600 .66rem var(--font-ui)', padding: '.32rem .7rem', borderRadius: 999, border: '1px solid var(--ink)', background: 'var(--ink)', color: 'var(--paper)', cursor: (reporting || (!reportReason && !reportNote.trim())) ? 'progress' : 'pointer', opacity: (reporting || (!reportReason && !reportNote.trim())) ? 0.55 : 1 }}
                          >
                            {reporting ? 'Sending…' : 'Submit'}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </header>

            <div className={styles.infoBlock}>
              <h1 className={styles.artTitle}>"{post.title}"</h1>
              <p className={styles.medium}>{hasAutoDesc ? autoDesc : post.description}</p>
            </div>

            <div className={styles.actions}>
              <button className={`${styles.actionBtn} ${liked ? styles.liked : ''}`} onClick={toggleLike}>
                <Heart size={20} fill={liked ? 'currentColor' : 'none'} /><span>{likeCount}</span>
              </button>
              <button className={styles.actionBtn}><Share2 size={20} /></button>
              <button className={`${styles.actionBtn} ${styles.right} ${bookmarked ? styles.bookmarked : ''}`} onClick={toggleBookmark}>
                <Bookmark size={20} fill={bookmarked ? 'currentColor' : 'none'} /><span>{bmCount || ''}</span>
              </button>
            </div>
          </div>

          {/* 3. COMMENTS THREAD */}
          <div className={styles.commentsSection}>
            <div className={styles.commentsHead}>
              <span className={styles.commentsTitle}>Comments · {comments.filter(c => !c.deleted).length}</span>
              {comments.length > 0 && (
                <div className={styles.headActions}>
                  <button className={styles.sortBtn} onClick={() => setSortBy(s => s === 'top' ? 'newest' : 'top')}>
                    {sortBy === 'top' ? 'Top' : 'Newest'}
                  </button>
                  <button className={styles.translateBtn} onClick={() => setThreadTranslated(!threadTranslated)}>
                    {threadTranslated ? 'Original' : 'Translate'}
                  </button>
                </div>
              )}
            </div>

            {/* BOUNDED PANE: only the thread list scrolls internally; the head above stays pinned. */}
            <div className={styles.commentsScroll}>
              {topLevelComments.length === 0 ? (
                <p className={styles.noComments}>Be the first to comment on this piece.</p>
              ) : (
                topLevelComments.map(c => {
                  const replies = getReplies(c.id)
                  const isExpanded = expandedThreads[c.id]
                  return (
                    <div key={c.id} className={styles.threadContainer}>
                      {renderComment(c)}
                      {replies.length > 0 && (
                        <div className={styles.repliesWrap}>
                          {(isExpanded ? replies : replies.slice(0, 1)).map(r => renderComment(r))}
                          {replies.length > 1 && !isExpanded && (
                            <button className={styles.viewReplies} onClick={() => setExpandedThreads(p => ({ ...p, [c.id]: true }))}>
                              View {replies.length} replies
                              <ChevronDown size={14} />
                            </button>
                          )}
                          {isExpanded && replies.length > 1 && (
                            <button className={styles.hideReplies} onClick={() => setExpandedThreads(p => ({ ...p, [c.id]: false }))}>
                              Hide replies
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>

        </div>{/* /.piece */}

        {/* 4. COMPOSER (fixed, outside the card) */}
        <div className={styles.composerWrapper}>
          {replyingTo && (
            <div className={styles.replyingBanner}>
              <span>Replying to <strong>@{replyingTo.user_name}</strong></span>
              <button onClick={() => setReplyingTo(null)} aria-label="Cancel reply"><X size={14} /></button>
            </div>
          )}
          <form className={styles.composer} onSubmit={submitComment}>
            <input
              ref={composerRef}
              className={styles.commentInput}
              value={draft}
              placeholder={replyingTo ? `Reply to @${replyingTo.user_name}…` : 'Add a comment…'}
              onChange={e => setDraft(e.target.value)}
            />
            <button type="button" className={styles.mediaBtn} onClick={() => fileInputRef.current?.click()} aria-label="Add picture">
              <ImageIcon size={18} />
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" className={styles.hiddenInput} onChange={handleImagePick} />
            <VoiceRecorder onSend={handleVoiceSend} />
            {draft.trim() && (
              <button className={styles.sendBtn} type="submit" aria-label="Send comment">
                <Send size={18} />
              </button>
            )}
          </form>
        </div>

      </div>

      {lightbox && <Lightbox items={lightbox.items} index={lightbox.index} onClose={closeLightbox} onIndex={setGalleryIndex} />}
    </main>
  )
}