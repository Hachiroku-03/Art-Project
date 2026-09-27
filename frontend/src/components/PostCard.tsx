import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Heart, MessageCircle, Share2, Bookmark, Images, Check } from 'lucide-react'
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
}

type PostCardProps = {
  post: Post
  viewer: string
  lang: string
  autoDesc?: string
}

function exactTime(raw: string) {
  const d = new Date(raw.replace(' ', 'T'))
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function PostCard({ post, viewer, autoDesc }: PostCardProps) {
  const navigate = useNavigate()

  const [liked, setLiked] = useState(post.liked_by_viewer)
  const [likeCount, setLikeCount] = useState(post.like_count)
  const [following, setFollowing] = useState(post.followed_by_viewer)
  const [bookmarked, setBookmarked] = useState(post.bookmarked_by_viewer)
  const [bmCount, setBmCount] = useState(post.bookmark_count)
  const [shared, setShared] = useState(false)

  const hasAutoDesc = !!autoDesc && autoDesc.trim() !== (post.description || '').trim()
  const photoCount = post.images?.length ?? 0
  const initial = (post.display_name || post.username)[0]?.toUpperCase() || '?'

  async function toggleLike(e: React.MouseEvent) {
    e.stopPropagation()

    const res = await fetch(`${API}/posts/${post.id}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer }),
    })

    const data = await res.json()
    setLiked(data.liked)
    setLikeCount(data.count)
  }

  async function toggleFollow(e: React.MouseEvent) {
    e.stopPropagation()

    const res = await fetch(`${API}/follow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer, target: post.username }),
    })

    const data = await res.json()
    setFollowing(data.following)
  }

  async function toggleBookmark(e: React.MouseEvent) {
    e.stopPropagation()

    const res = await fetch(`${API}/posts/${post.id}/bookmark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer }),
    })

    const data = await res.json()
    setBookmarked(data.bookmarked)
    setBmCount(data.count)
  }

  async function share(e: React.MouseEvent) {
    e.stopPropagation()

    const url = `${window.location.origin}/post/${post.id}`

    try {
      if (navigator.share) {
        await navigator.share({ title: post.title, url })
      } else {
        await navigator.clipboard.writeText(url)
        setShared(true)
        window.setTimeout(() => setShared(false), 2000)
      }
    } catch {
      // user cancelled share sheet or clipboard blocked
    }
  }

  function openAuthor(e: React.MouseEvent) {
    e.stopPropagation()
    navigate(`/profile/${post.username}`)
  }

  return (
    <article className={styles.card} onClick={() => navigate(`/post/${post.id}`)}>
      <header className={styles.header}>
        <div className={styles.who}>
          <button
            className={`${styles.avatarWrap} ${post.has_active_story ? styles.hasStory : ''}`}
            onClick={openAuthor}
            aria-label="View profile"
          >
            <div className={`${styles.avatar} ${post.tier === 'vip' ? styles.vipRing : ''}`}>
              {post.avatar_url ? (
                <img src={post.avatar_url} alt="" className={styles.avatarImg} />
              ) : (
                initial
              )}
            </div>
          </button>

          <div>
            <button className={styles.name} onClick={openAuthor}>
              {post.display_name || post.username}
            </button>

            <p className={styles.meta}>
              {exactTime(post.created_at)}
            </p>
          </div>
        </div>

        {viewer !== post.username && (
          <button
            className={`${styles.followBtn} ${following ? styles.following : ''}`}
            onClick={toggleFollow}
          >
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

        {photoCount > 1 && (
          <span className={styles.imgCount}>
            <Images size={12} /> {photoCount}
          </span>
        )}
      </div>

      <div className={styles.labelBlock}>
        <h2 className={styles.artTitle}>"{post.title}"</h2>
        <p className={styles.medium}>{hasAutoDesc ? autoDesc : post.description}</p>
      </div>

      <div className={styles.actions}>
        <button
          className={`${styles.actionBtn} ${liked ? styles.liked : ''}`}
          onClick={toggleLike}
        >
          <Heart size={19} fill={liked ? 'currentColor' : 'none'} />
          <span>{likeCount}</span>
        </button>

        <button
          className={styles.actionBtn}
          onClick={e => {
            e.stopPropagation()
            navigate(`/post/${post.id}`)
          }}
        >
          <MessageCircle size={19} />
          <span>{post.comment_count}</span>
        </button>

        <button
          className={`${styles.actionBtn} ${shared ? styles.shared : ''}`}
          onClick={share}
        >
          {shared ? <Check size={19} /> : <Share2 size={19} />}
          {shared && <span>Copied</span>}
        </button>

        <button
          className={`${styles.actionBtn} ${styles.right} ${bookmarked ? styles.bookmarked : ''}`}
          onClick={toggleBookmark}
        >
          <Bookmark size={19} fill={bookmarked ? 'currentColor' : 'none'} />
          <span>{bmCount || ''}</span>
        </button>
      </div>
    </article>
  )
}