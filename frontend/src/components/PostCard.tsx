import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Heart, MessageCircle, Share2, Bookmark, Gavel } from 'lucide-react'
import styles from './PostCard.module.css'

const API = 'http://localhost:8001'

export type Post = {
  id: number
  type: string
  title: string
  description: string
  image_url: string
  username: string
  role: string
  tier: string
  display_name: string
  created_at: string
  price?: string
  current_bid?: string
  like_count: number
  comment_count: number
  liked_by_viewer: boolean
  followed_by_viewer: boolean
}

type PostCardProps = { post: Post; viewer: string; lang: string; autoDesc?: string }

function exactTime(raw: string) {
  const d = new Date(raw.replace(' ', 'T'))
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function PostCard({ post, viewer, autoDesc }: PostCardProps) {
  const navigate = useNavigate()
  const [liked, setLiked] = useState(post.liked_by_viewer)
  const [likeCount, setLikeCount] = useState(post.like_count)
  const [following, setFollowing] = useState(post.followed_by_viewer)
  const [currentBid, setCurrentBid] = useState(post.current_bid || '')

  const hasAutoDesc = !!autoDesc && autoDesc.trim() !== (post.description || '').trim()

  async function toggleLike(e: React.MouseEvent) {
    e.stopPropagation() // Prevents the card from opening when clicking like
    const res = await fetch(`${API}/posts/${post.id}/like`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer }),
    })
    const data = await res.json()
    setLiked(data.liked)
    setLikeCount(data.count)
  }

  async function toggleFollow(e: React.MouseEvent) {
    e.stopPropagation() // Prevents the card from opening when clicking follow
    const res = await fetch(`${API}/follow`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer, target: post.username }),
    })
    const data = await res.json()
    setFollowing(data.following)
  }

  async function placeBid(e: React.MouseEvent) {
    e.stopPropagation() // Prevents the card from opening when clicking bid
    const input = window.prompt(`Your bid for "${post.title}" (current: ${currentBid || post.price || 'none'}):`)
    if (!input) return
    const res = await fetch(`${API}/posts/${post.id}/bid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer, amount: input }),
    })
    const data = await res.json()
    if (data.current_bid) setCurrentBid(String(data.current_bid))
    else window.alert(data.error || 'Bid failed.')
  }

  return (
    // THE MAGIC LINE: The entire card is now a clickable button
    <article className={styles.card} onClick={() => navigate(`/post/${post.id}`)}>
      <header className={styles.header}>
        <div className={styles.who}>
          <div className={`${styles.avatar} ${post.tier === 'vip' ? styles.vipRing : ''}`}>
            {(post.display_name || post.username)[0].toUpperCase()}
          </div>
          <div>
            <p className={styles.name}>{post.display_name || post.username}</p>
            <p className={styles.meta}>
              <span className={styles.typeBadge}>{post.type.toUpperCase()}</span>
              {' · '}{exactTime(post.created_at)}
            </p>
          </div>
        </div>
        {viewer !== post.username && (
          <button className={`${styles.followBtn} ${following ? styles.following : ''}`} onClick={toggleFollow}>
            {following ? 'Following' : 'Follow'}
          </button>
        )}
      </header>

      <div className={styles.imageWrap}>
        {post.image_url ? (
          <img className={styles.artImage} src={post.image_url} alt={post.title} />
        ) : (
          <div className={styles.artPlaceholder}>No image</div>
        )}
      </div>

      <div className={styles.labelBlock}>
        <h2 className={styles.artTitle}>"{post.title}"</h2>
        <p className={styles.medium}>{hasAutoDesc ? autoDesc : post.description}</p>
        
        {post.type === 'drop' && (
          <div className={styles.priceRow}>
            <span className={styles.priceLabel}>
              {currentBid ? `Current bid $${currentBid}` : post.price ? `Asking $${post.price}` : 'Open for bids'}
            </span>
            <button className={styles.bidBtn} onClick={placeBid}>
              <Gavel size={14} /> Place Bid
            </button>
          </div>
        )}
      </div>

      <div className={styles.actions}>
        <button className={`${styles.actionBtn} ${liked ? styles.liked : ''}`} onClick={toggleLike}>
          <Heart size={19} fill={liked ? 'currentColor' : 'none'} />
          <span>{likeCount}</span>
        </button>
        <button className={styles.actionBtn} onClick={(e) => { e.stopPropagation(); navigate(`/post/${post.id}`) }}>
          <MessageCircle size={19} />
          <span>{post.comment_count}</span>
        </button>
        <button className={styles.actionBtn} onClick={(e) => e.stopPropagation()}>
          <Share2 size={19} />
        </button>
        <button className={`${styles.actionBtn} ${styles.right}`} onClick={(e) => e.stopPropagation()}>
          <Bookmark size={19} />
        </button>
      </div>
    </article>
  )
}