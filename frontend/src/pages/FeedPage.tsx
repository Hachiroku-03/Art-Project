import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PostCard, type Post } from '../components/PostCard'
import { Navbar } from '../components/Navbar'
import { Preloader } from '../components/Preloader'
import { Composer } from '../components/Composer'
import { translateMany } from '../lib/translate'
import styles from './FeedPage.module.css'

const AUTH_API = 'http://localhost:8000'
const FEED_API = 'http://localhost:8001'

export function FeedPage() {
  const navigate = useNavigate()
  const [posts, setPosts] = useState<Post[]>([])
  const [descTranslations, setDescTranslations] = useState<Record<number, string>>({})
  const [loading, setLoading] = useState(true)
  const [lang, setLang] = useState('en')
  const viewer = localStorage.getItem('space_user') || ''
  const role = localStorage.getItem('space_role') || 'collector'

  async function loadPosts() {
    // Fetch user's language preference
    let language = 'en'
    try {
      const sRes = await fetch(`${AUTH_API}/settings?viewer=${encodeURIComponent(viewer)}`)
      const s = await sRes.json()
      language = s.language || 'en'
      setLang(language)
    } catch { /* settings unreachable: fall back to English */ }

    // Fetch feed
    try {
      const res = await fetch(`${FEED_API}/feed?viewer=${encodeURIComponent(viewer)}`)
      const data = await res.json()
      setPosts(data.feed)

      // Batch-translate all descriptions
      const withDesc = data.feed.filter((p: Post) => p.description)
      if (withDesc.length > 0) {
        try {
          const results = await translateMany(withDesc.map((p: Post) => p.description), language)
          const map: Record<number, string> = {}
          withDesc.forEach((p: Post, i: number) => { map[p.id] = results[i] })
          setDescTranslations(map)
        } catch { /* translator down: show originals */ }
      }
    } catch { /* feed unreachable */ }
    setLoading(false)
  }

  useEffect(() => {
    const token = localStorage.getItem('space_token')
    if (!token) {
      navigate('/login')
      return
    }
    loadPosts()
  }, [navigate, viewer])

  return (
    <main className={styles.layout}>
      <Preloader done={!loading} />
      <Navbar />

      <section className={styles.feedContainer}>
        {role !== 'collector' && <Composer viewer={viewer} onPosted={loadPosts} />}

        {posts.length === 0 ? (
          <p className={styles.emptyText}>The gallery is quiet. No posts yet.</p>
        ) : (
          posts.map(post => (
            <PostCard
              key={post.id}
              post={post}
              viewer={viewer}
              lang={lang}
              autoDesc={descTranslations[post.id]}
            />
          ))
        )}
      </section>
    </main>
  )
}