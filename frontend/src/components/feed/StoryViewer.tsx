import { useState, useEffect, useCallback } from 'react'   // useMemo dropped: it was unused
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import type { StoryUser } from '../../lib/feed'
import styles from './StoryViewer.module.css'

const DUR = 5000

export function StoryViewer({ users, startIndex, onClose, onSeen }: {
  users: StoryUser[]; startIndex: number; onClose: () => void; onSeen: (u: string) => void
}) {
  // ---- every hook, top level, above the early return (Rules of Hooks) ----
  const [ui, setUi] = useState(startIndex)
  const [ii, setIi] = useState(0)
  const [prog, setProg] = useState(0)

  const user = users[ui]
  const total = user?.items.length ?? 0
  const item = user?.items[ii]

  // Stable per position: with onClose/onSeen stabilized in FeedPage, this only
  // changes when ui/ii/total change — so the timer below never resets mid-story.
  const advance = useCallback(() => {
    if (ii < total - 1) setIi(ii + 1)
    else if (ui < users.length - 1) { setUi(ui + 1); setIi(0) }
    else onClose()
  }, [ui, ii, total, users, onClose])

  const back = useCallback(() => {
    if (ii > 0) setIi(ii - 1)
    else if (ui > 0) { const p = users[ui - 1]; setUi(ui - 1); setIi(p.items.length - 1) }
  }, [ui, ii, users])

  useEffect(() => {
    const u = users[ui]
    if (u) onSeen(u.username)
  }, [ui, users, onSeen])

  useEffect(() => {
    if (ii >= total) return
    setProg(0)
    const started = Date.now()
    const id = window.setInterval(() => {
      const p = (Date.now() - started) / DUR
      if (p >= 1) { setProg(1); advance() } else setProg(p)
    }, 50)
    return () => window.clearInterval(id)
  }, [ui, ii, total, advance])

  if (!user || !item) return null   // hooks are all above this line

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.frame} onClick={e => e.stopPropagation()}>
        <div className={styles.bars}>
          {user.items.map((_, k) => (
            <span key={k} className={styles.bar}>
              <span className={styles.fill} style={{ width: k < ii ? '100%' : k === ii ? `${prog * 100}%` : '0%' }} />
            </span>
          ))}
        </div>
        <div className={styles.head}>
          <span className={styles.ava}>{user.username[0]?.toUpperCase()}</span>
          <span className={styles.un}>@{user.username}</span>
          <button className={styles.x} onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <div className={styles.stage}>
          {item.kind === 'image'
            ? <img src={item.body} alt="" className={styles.img} />
            : <div className={styles.textCard}><p>{item.body}</p></div>}
        </div>
        <button className={`${styles.nav} ${styles.navL}`} onClick={back} aria-label="Previous"><ChevronLeft size={26} /></button>
        <button className={`${styles.nav} ${styles.navR}`} onClick={advance} aria-label="Next"><ChevronRight size={26} /></button>
      </div>
    </div>
  )
}