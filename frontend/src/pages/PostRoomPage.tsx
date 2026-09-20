import { useEffect, useState, useRef, type FormEvent, type ChangeEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Heart, Share2, Bookmark, Gavel, Image as ImageIcon, Send, ArrowLeft, X, ChevronDown } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { Preloader } from '../components/Preloader'
import { VoiceRecorder } from '../components/VoiceRecorder'
import { translateMany } from '../lib/translate'
import styles from './PostRoomPage.module.css'

const AUTH_API = 'http://localhost:8000'
const FEED_API = 'http://localhost:8001'

type PostData = {
  id: number; type: string; title: string; description: string; image_url: string;
  price?: string; current_bid?: string; created_at: string;
  username: string; role: string; tier: string; display_name: string;
  like_count: number; comment_count: number; liked_by_viewer: boolean; followed_by_viewer: boolean;
}
type CommentRow = {
  id: number; user_name: string; body: string; kind: string; parent_id: number | null; created_at: string;
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

export function PostRoomPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  const [post, setPost] = useState<PostData | null>(null)
  const [comments, setComments] = useState<CommentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [liked, setLiked] = useState(false)
  const [likeCount, setLikeCount] = useState(0)
  const [following, setFollowing] = useState(false)
  const [currentBid, setCurrentBid] = useState('')

  const [draft, setDraft] = useState('')
  const [replyingTo, setReplyingTo] = useState<CommentRow | null>(null)
  const [expandedThreads, setExpandedThreads] = useState<Record<number, boolean>>({})
  const [commentLikes, setCommentLikes] = useState<Record<number, { liked: boolean; count: number }>>({})

  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLInputElement>(null)

  const [lang, setLang] = useState('en')
  const [autoDesc, setAutoDesc] = useState('')
  const [threadTranslated, setThreadTranslated] = useState(true)
  const [commentTranslations, setCommentTranslations] = useState<Record<number, string>>({})

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
          setCurrentBid(data.post.current_bid || '')
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
        const textComments = list.filter(c => c.kind === 'text')
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

  async function toggleCommentLike(c: CommentRow) {
    const res = await fetch(`${FEED_API}/comments/${c.id}/like`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer }) })
    const data = await res.json()
    setCommentLikes(prev => ({ ...prev, [c.id]: { liked: data.liked, count: data.count } }))
  }

  async function toggleFollow() {
    if (!post) return
    const res = await fetch(`${FEED_API}/follow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, target: post.username }) })
    const data = await res.json()
    setFollowing(data.following)
  }

  async function placeBid() {
    if (!post) return
    const input = window.prompt(`Your bid for "${post.title}" (current: ${currentBid || post.price || 'none'}):`)
    if (!input) return
    const res = await fetch(`${FEED_API}/posts/${post.id}/bid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, amount: input }) })
    const data = await res.json()
    if (data.current_bid) setCurrentBid(String(data.current_bid))
    else window.alert(data.error || 'Bid failed.')
  }

  async function uploadFile(file: File): Promise<string | null> {
    const form = new FormData(); form.append('file', file)
    try {
      const res = await fetch(`${FEED_API}/upload`, { method: 'POST', body: form })
      const data = await res.json()
      return data.url ?? null
    } catch { return null }
  }

  async function postComment(body: string, kind: 'text' | 'image' | 'voice') {
    if (!post) return
    const res = await fetch(`${FEED_API}/posts/${post.id}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer, body, kind, parent_id: replyingTo?.id || null }),
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
    }
  }

  async function handleVoiceSend(blob: Blob) {
    const file = new File([blob], 'voice.webm', { type: blob.type || 'audio/webm' })
    const url = await uploadFile(file)
    if (url) await postComment(url, 'voice')
  }

  async function submitComment(e: FormEvent) {
    e.preventDefault()
    if (!draft.trim()) return
    const text = draft.trim(); setDraft('')
    await postComment(text, 'text')
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

  const hasAutoDesc = !!autoDesc && autoDesc.trim() !== (post.description || '').trim()
  const topLevelComments = comments.filter(c => !c.parent_id)
  const getReplies = (parentId: number) => comments.filter(c => c.parent_id === parentId)

  function renderComment(c: CommentRow) {
    const lk = commentLikes[c.id] || { liked: false, count: 0 }
    return (
      <div key={c.id} className={styles.commentRow}>
        <div className={styles.cAvatar}>{(c.user_name || '?')[0].toUpperCase()}</div>
        <div className={styles.cMain}>
          <p className={styles.cName}>{c.user_name}</p>
          {c.kind === 'image' && c.body ? (
            <img className={styles.commentImage} src={c.body} alt="attachment" />
          ) : c.kind === 'voice' && c.body ? (
            <audio className={styles.commentAudio} controls src={c.body} />
          ) : (
            <p className={styles.cBody}>{threadTranslated && commentTranslations[c.id] ? commentTranslations[c.id] : c.body}</p>
          )}
          <div className={styles.cMeta}>
            <span>{shortTime(c.created_at)}</span>
            <button className={styles.metaBtn} onClick={() => handleReplyClick(c)}>Reply</button>
          </div>
        </div>
        <button className={`${styles.cLike} ${lk.liked ? styles.cLiked : ''}`} onClick={() => toggleCommentLike(c)} aria-label="Like comment">
          <Heart size={16} fill={lk.liked ? 'currentColor' : 'none'} />
          <span className={styles.cLikeCount}>{lk.count > 0 ? lk.count : ''}</span>
        </button>
      </div>
    )
  }

  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.container}>

        <div className={styles.artSide}>
          {post.image_url ? (
            <img src={post.image_url} alt={post.title} className={styles.artImage} />
          ) : (
            <div className={styles.artPlaceholder}>canvas awaiting its first layer</div>
          )}
        </div>

        <div className={styles.detailSide}>
          <header className={styles.header}>
            <button className={styles.backBtn} onClick={() => navigate(-1)} aria-label="Back"><ArrowLeft size={18} /></button>
            <div className={styles.who}>
              <div className={`${styles.avatar} ${post.tier === 'vip' ? styles.vipRing : ''}`}>
                {(post.display_name || post.username)[0].toUpperCase()}
              </div>
              <div>
                <p className={styles.name}>{post.display_name || post.username}</p>
                <p className={styles.meta}>{post.type.toUpperCase()} · {exactTime(post.created_at)}</p>
              </div>
            </div>
            {viewer !== post.username && (
              <button className={`${styles.followBtn} ${following ? styles.following : ''}`} onClick={toggleFollow}>
                {following ? 'Following' : 'Follow'}
              </button>
            )}
          </header>

          <div className={styles.infoBlock}>
            <h1 className={styles.artTitle}>"{post.title}"</h1>
            <p className={styles.medium}>{hasAutoDesc ? autoDesc : post.description}</p>
            {post.type === 'drop' && (
              <div className={styles.priceRow}>
                <span className={styles.priceLabel}>
                  {currentBid ? `Current bid $${currentBid}` : post.price ? `Asking $${post.price}` : 'Open for bids'}
                </span>
                <button className={styles.bidBtn} onClick={placeBid}><Gavel size={14} /> Place Bid</button>
              </div>
            )}
          </div>

          <div className={styles.actions}>
            <button className={`${styles.actionBtn} ${liked ? styles.liked : ''}`} onClick={toggleLike}>
              <Heart size={20} fill={liked ? 'currentColor' : 'none'} /><span>{likeCount}</span>
            </button>
            <button className={styles.actionBtn}><Share2 size={20} /></button>
            <button className={`${styles.actionBtn} ${styles.right}`}><Bookmark size={20} /></button>
          </div>

          <div className={styles.commentsWrap}>
            <div className={styles.commentsHead}>
              <span className={styles.commentsTitle}>Comments · {comments.length}</span>
              {comments.length > 0 && (
                <button className={styles.translateBtn} onClick={() => setThreadTranslated(!threadTranslated)}>
                  {threadTranslated ? 'Show original' : 'Show translation'}
                </button>
              )}
            </div>

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
                        {replies.length > 1 && (
                          <button
                            className={`${styles.viewReplies} ${isExpanded ? styles.open : ''}`}
                            onClick={() => setExpandedThreads(p => ({ ...p, [c.id]: !isExpanded }))}
                          >
                            {isExpanded ? 'Hide replies' : `View ${replies.length} replies`}
                            <ChevronDown size={14} className={styles.chev} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>

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
    </main>
  )
}