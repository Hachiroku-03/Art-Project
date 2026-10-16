import { useEffect, useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Plus, Users, CalendarClock } from 'lucide-react'
import { Navbar } from '../components/Navbar'
import { Preloader } from '../components/Preloader'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { PostCard, type Post } from '../components/PostCard'
import { StoriesStrip } from '../components/feed/StoriesStrip'
import { StoryViewer } from '../components/feed/StoryViewer'
import { ComposerModal } from '../components/feed/ComposerModal'
import { SuggestionsRail } from '../components/feed/SuggestionsRail'
import { ProgrammeRail } from '../components/feed/ProgrammeRail'
import { PaddleCard } from '../components/feed/PaddleCard'
import {
  deleteStory,
  fetchFollowedStories,
  loadSeenStoryIds,
  saveSeenStoryIds,
  type StoryUser,
} from '../lib/feed'
import { translateMany } from '../lib/translate'
import { getViewer } from '../lib/session'
import styles from './FeedPage.module.css'

const AUTH_API = 'http://localhost:8000'
const FEED_API = 'http://localhost:8001'

export function FeedPage() {
  const navigate = useNavigate()
  const viewer = getViewer() || localStorage.getItem('space_user') || ''

  // ---- all hooks, top level, above any early return ----
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lang, setLang] = useState('en')
  const [translations, setTranslations] = useState<Record<number, string>>({})
  const [query, setQuery] = useState('')
  const [openRail, setOpenRail] = useState<'none' | 'left' | 'right'>('none')
  const [stories, setStories] = useState<StoryUser[]>([])
  const [seenStoryIds, setSeenStoryIds] = useState<Set<number>>(() => loadSeenStoryIds())
  const [openStory, setOpenStory] = useState<number | null>(null)
  const [composer, setComposer] = useState<null | 'work' | 'status'>(null)
  const [viewerAvatarUrl, setViewerAvatarUrl] = useState<string | null>(null)

  const reloadFeed = useCallback(async () => {
    try {
      const d = await fetch(`${FEED_API}/feed?viewer=${encodeURIComponent(viewer)}`).then(r => r.json())
      const list: Post[] = d.feed || []
      setPosts(list)
      setError(d.error || '')

      const texts = list.map(p => p.description).filter(Boolean) as string[]
      if (texts.length) {
        const t = await translateMany(texts, lang)
        const map: Record<number, string> = {}
        let i = 0
        list.forEach(p => {
          if (p.description) map[p.id] = t[i++]
        })
        setTranslations(map)
      }
    } catch {
      setError('network error — is the feed server running?')
    }
  }, [viewer, lang])

  const refreshStories = useCallback(async () => {
    const s = await fetchFollowedStories(viewer)
    setStories(s)
    return s
  }, [viewer])

  useEffect(() => {
    if (!localStorage.getItem('space_token')) {
      navigate('/login', { replace: true })
      return
    }

    let alive = true

    async function load() {
      let language = 'en'

      try {
        const s = await fetch(`${AUTH_API}/settings?viewer=${encodeURIComponent(viewer)}`).then(r => r.json())
        language = s.language || 'en'
        if (alive) setLang(language)
      } catch {
        /* default */
      }

      try {
        const me = await fetch(`${FEED_API}/me?viewer=${encodeURIComponent(viewer)}`).then(r => r.json())
        if (alive) setViewerAvatarUrl(me?.user?.avatar_url || null)
      } catch {
        /* ignore */
      }

      try {
        const d = await fetch(`${FEED_API}/feed?viewer=${encodeURIComponent(viewer)}`).then(r => r.json())
        if (!alive) return

        const list: Post[] = d.feed || []
        setPosts(list)
        setError(d.error || '')

        const texts = list.map(p => p.description).filter(Boolean) as string[]
        if (texts.length) {
          const t = await translateMany(texts, language)
          const map: Record<number, string> = {}
          let i = 0
          list.forEach(p => {
            if (p.description) map[p.id] = t[i++]
          })
          if (alive) setTranslations(map)
        }
      } catch {
        if (alive) setError('network error — is the feed server running?')
      }

      fetchFollowedStories(viewer).then(s => {
        if (alive) setStories(s)
      })

      if (alive) setLoading(false)
    }

    load()

    return () => {
      alive = false
    }
  }, [viewer, navigate])

  useEffect(() => {
    saveSeenStoryIds(seenStoryIds)
  }, [seenStoryIds])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return posts
    return posts.filter(p =>
      `${p.title} ${p.description} ${p.username} ${p.display_name || ''}`.toLowerCase().includes(q),
    )
  }, [posts, query])

  const markStorySeen = useCallback((storyId: number) => {
    setSeenStoryIds(prev => {
      if (prev.has(storyId)) return prev
      const next = new Set(prev)
      next.add(storyId)
      return next
    })
  }, [])

  const closeStory = useCallback(() => setOpenStory(null), [])

  const deleteStoryItem = useCallback(
    async (userId: string, storyId: number) => {
      const res = await deleteStory(storyId, viewer)

      if (res?.error) {
        setError(res.error)
        throw new Error(res.error)
      }

      setStories(prev =>
        prev
          .map(u =>
            u.username === userId
              ? {
                  ...u,
                  items: u.items.filter(item => item.id !== storyId),
                }
              : u,
          )
          .filter(u => u.items.length > 0),
      )

      setSeenStoryIds(prev => {
        const next = new Set(prev)
        next.delete(storyId)
        return next
      })
    },
    [viewer],
  )

  const openStoryIndex = useCallback(
    (i: number) => {
      if (i < 0) {
        setComposer('status')
        return
      }

      const user = stories[i]

      if (!user || !user.items.length) {
        setComposer('status')
        return
      }

      setOpenStory(i)
    },
    [stories],
  )

  const startStoryComposer = useCallback(() => {
    if (!viewer) {
      setError('No signed-in user detected. Log out and log back in.')
      return
    }

    setComposer('status')
  }, [viewer])

  const hasExistingStory = useMemo(
    () => stories.some(s => s.username === viewer && s.items.length > 0),
    [stories, viewer],
  )

  if (loading) {
    return (
      <main className={styles.layout}>
        <Navbar />
        <Preloader done={false} />
      </main>
    )
  }

  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.shell}>
        <div className={styles.topRow}>
          <div className={styles.searchWrap}>
            <Search size={15} className={styles.sIcon} />
            <input
              className={styles.sInput}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search…"
              aria-label="Search the feed"
            />
            {query && (
              <button className={styles.sClear} onClick={() => setQuery('')} aria-label="Clear">
                ×
              </button>
            )}
          </div>

          <button className={styles.hangBtn} onClick={() => setComposer('work')}>
            <Plus size={15} /> Hang something
          </button>
        </div>

        <ErrorBoundary fallback={null}>
          <StoriesStrip
            storyUsers={stories}
            viewer={viewer}
            viewerAvatarUrl={viewerAvatarUrl}
            seenStoryIds={seenStoryIds}
            onOpen={openStoryIndex}
            onAdd={startStoryComposer}
          />
        </ErrorBoundary>

        <div className={styles.mobileToggles}>
          <button
            className={`${styles.mToggle} ${openRail === 'left' ? styles.mOn : ''}`}
            onClick={() => setOpenRail(o => (o === 'left' ? 'none' : 'left'))}
          >
            <Users size={14} /> People
          </button>

          <button
            className={`${styles.mToggle} ${openRail === 'right' ? styles.mOn : ''}`}
            onClick={() => setOpenRail(o => (o === 'right' ? 'none' : 'right'))}
          >
            <CalendarClock size={14} /> Programme
          </button>
        </div>

        <div className={styles.cols}>
          <aside className={`${styles.left} ${openRail === 'left' ? styles.open : ''}`}>
            <ErrorBoundary fallback={<RailRest />}>
              <SuggestionsRail viewer={viewer} />
            </ErrorBoundary>
          </aside>

          <section className={styles.center}>
            {error && posts.length === 0 ? (
              <p className={styles.err}>{error}</p>
            ) : filtered.length === 0 ? (
              <p className={styles.empty}>
                {query ? 'Nothing matches that search.' : 'The feed is quiet — hang the first work.'}
              </p>
            ) : (
              <ErrorBoundary fallback={<ListRest />}>
                <div className={styles.list}>
                  {filtered.map(p => (
                    <PostCard
                      key={p.id}
                      post={p}
                      viewer={viewer}
                      lang={lang}
                      autoDesc={translations[p.id]}
                    />
                  ))}
                </div>
              </ErrorBoundary>
            )}
          </section>

          <aside className={`${styles.right} ${openRail === 'right' ? styles.open : ''}`}>
            <ErrorBoundary fallback={<RailRest />}>
              <ProgrammeRail viewer={viewer} />
            </ErrorBoundary>

            <ErrorBoundary fallback={<RailRest />}>
              <PaddleCard viewer={viewer} />
            </ErrorBoundary>
          </aside>
        </div>
      </div>

      {openStory !== null && stories[openStory] && (
        <ErrorBoundary
          fallback={
            <div
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1600,
                background: '#0b0a09',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                padding: '1rem',
                textAlign: 'center',
              }}
            >
              Story viewer failed to open. Check the browser console for the real error.
            </div>
          }
        >
          <StoryViewer
            key={openStory}
            users={stories}
            startIndex={openStory}
            onClose={closeStory}
            onSeenItem={markStorySeen}
            viewer={viewer}
            onAdd={() => {
              setOpenStory(null)
              setComposer('status')
            }}
            onDeleteItem={deleteStoryItem}
          />
        </ErrorBoundary>
      )}

      {composer && (
        <ComposerModal
          mode={composer}
          viewer={viewer}
          hasExistingStory={hasExistingStory}
          onClose={() => setComposer(null)}
          onDone={async () => {
            const wasStatus = composer === 'status'
            setComposer(null)

            if (wasStatus) {
              const s = await refreshStories()

              console.log('[stories] refreshed after post', {
                viewer,
                totalUsers: s.length,
                stories: s,
              })

              const idx = s.findIndex(u => u.username === viewer && u.items.length > 0)

              if (idx >= 0) {
                setOpenStory(idx)
              } else {
                setError('Story was posted, but it did not appear in your followed stories feed.')
              }
            } else {
              await reloadFeed()
            }
          }}
        />
      )}
    </main>
  )
}

function RailRest() {
  return <p className={styles.rest}>This rail is resting.</p>
}

function ListRest() {
  return <p className={styles.rest}>The feed hit a snag — refresh to try again.</p>
}