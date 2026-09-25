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
import { fetchStories, type StoryUser } from '../lib/feed'
import { translateMany } from '../lib/translate'
import styles from './FeedPage.module.css'

const AUTH_API = 'http://localhost:8000'
const FEED_API = 'http://localhost:8001'

export function FeedPage() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  // ---- all hooks, top level, above any early return ----
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lang, setLang] = useState('en')
  const [translations, setTranslations] = useState<Record<number, string>>({})
  const [query, setQuery] = useState('')
  const [openRail, setOpenRail] = useState<'none' | 'left' | 'right'>('none')
  const [stories, setStories] = useState<StoryUser[]>([])
  const [seen, setSeen] = useState<Set<string>>(new Set())
  const [openStory, setOpenStory] = useState<number | null>(null)
  const [composer, setComposer] = useState<null | 'work' | 'status'>(null)

  useEffect(() => {
    if (!localStorage.getItem('space_token')) { navigate('/login', { replace: true }); return }
    let alive = true
    async function load() {
      let language = 'en'
      try { const s = await fetch(`${AUTH_API}/settings?viewer=${encodeURIComponent(viewer)}`).then(r => r.json()); language = s.language || 'en'; if (alive) setLang(language) } catch { /* default */ }
      try {
        const d = await fetch(`${FEED_API}/feed?viewer=${encodeURIComponent(viewer)}`).then(r => r.json())
        if (!alive) return
        const list: Post[] = d.feed || []
        setPosts(list); setError(d.error || '')
        const texts = list.map(p => p.description).filter(Boolean) as string[]
        if (texts.length) {
          const t = await translateMany(texts, language)
          const map: Record<number, string> = {}; let i = 0
          list.forEach(p => { if (p.description) map[p.id] = t[i++] })
          if (alive) setTranslations(map)
        }
      } catch { if (alive) setError('network error — is the feed server running?') }
      if (alive) setLoading(false)
    }
    load()
    fetchStories().then(s => { if (alive) setStories(s) })
    return () => { alive = false }
  }, [viewer, navigate])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return posts
    return posts.filter(p => `${p.title} ${p.description} ${p.username} ${p.display_name || ''}`.toLowerCase().includes(q))
  }, [posts, query])

  // Stable identities so StoryViewer's deps don't churn on every re-render.
  const markSeen = useCallback((u: string) => setSeen(prev => prev.has(u) ? prev : new Set(prev).add(u)), [])
  const closeStory = useCallback(() => setOpenStory(null), [])
  function refreshStories() { fetchStories().then(setStories) }

  if (loading) return <main className={styles.layout}><Navbar /><Preloader done={false} /></main>

  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.shell}>

        <div className={styles.topRow}>
          <div className={styles.searchWrap}>
            <Search size={15} className={styles.sIcon} />
            <input className={styles.sInput} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search…" aria-label="Search the feed" />
            {query && <button className={styles.sClear} onClick={() => setQuery('')} aria-label="Clear">×</button>}
          </div>
          <button className={styles.hangBtn} onClick={() => setComposer('work')}><Plus size={15} /> Hang something</button>
        </div>

        <ErrorBoundary fallback={null}>
          <StoriesStrip storyUsers={stories} viewer={viewer} seen={seen} onOpen={i => setOpenStory(i)} onAdd={() => setComposer('status')} />
        </ErrorBoundary>

        <div className={styles.mobileToggles}>
          <button className={`${styles.mToggle} ${openRail === 'left' ? styles.mOn : ''}`} onClick={() => setOpenRail(o => o === 'left' ? 'none' : 'left')}><Users size={14} /> People</button>
          <button className={`${styles.mToggle} ${openRail === 'right' ? styles.mOn : ''}`} onClick={() => setOpenRail(o => o === 'right' ? 'none' : 'right')}><CalendarClock size={14} /> Programme</button>
        </div>

        <div className={styles.cols}>
          <aside className={`${styles.left} ${openRail === 'left' ? styles.open : ''}`}>
            <ErrorBoundary fallback={<RailRest />}><SuggestionsRail viewer={viewer} /></ErrorBoundary>
          </aside>

          <section className={styles.center}>
            {error && posts.length === 0 ? (
              <p className={styles.err}>{error}</p>
            ) : filtered.length === 0 ? (
              <p className={styles.empty}>{query ? 'Nothing matches that search.' : 'The feed is quiet — hang the first work.'}</p>
            ) : (
              <ErrorBoundary fallback={<ListRest />}>
                <div className={styles.list}>
                  {filtered.map(p => <PostCard key={p.id} post={p} viewer={viewer} lang={lang} autoDesc={translations[p.id]} />)}
                </div>
              </ErrorBoundary>
            )}
          </section>

          <aside className={`${styles.right} ${openRail === 'right' ? styles.open : ''}`}>
            <ErrorBoundary fallback={<RailRest />}><ProgrammeRail viewer={viewer} /></ErrorBoundary>
            <ErrorBoundary fallback={<RailRest />}><PaddleCard viewer={viewer} /></ErrorBoundary>
          </aside>
        </div>
      </div>

      {openStory !== null && stories[openStory] && (
        <ErrorBoundary fallback={null}>
          <StoryViewer key={openStory} users={stories} startIndex={openStory} onClose={closeStory} onSeen={markSeen} />
        </ErrorBoundary>
      )}
      {composer && (
        <ComposerModal mode={composer} viewer={viewer} onClose={() => setComposer(null)} onDone={() => { const wasStatus = composer === 'status'; setComposer(null); if (wasStatus) refreshStories(); else { fetch(`${FEED_API}/feed?viewer=${encodeURIComponent(viewer)}`).then(r => r.json()).then(d => setPosts(d.feed || [])).catch(() => {}) } }} />
      )}
    </main>
  )
}

function RailRest() { return <p className={styles.rest}>This rail is resting.</p> }
function ListRest() { return <p className={styles.rest}>The feed hit a snag — refresh to try again.</p> }