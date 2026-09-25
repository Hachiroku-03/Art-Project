import { Plus } from 'lucide-react'
import type { StoryUser } from '../../lib/feed'
import styles from './StoriesStrip.module.css'

export function StoriesStrip({ storyUsers, viewer, seen, onOpen, onAdd }: { storyUsers: StoryUser[]; viewer: string; seen: Set<string>; onOpen: (i: number) => void; onAdd: () => void }) {
  const me = storyUsers.find(u => u.username === viewer)
  const others = storyUsers.filter(u => u.username !== viewer)

  return (
    <div className={styles.strip}>
      <button className={styles.item} onClick={() => me ? onOpen(storyUsers.indexOf(me)) : onAdd()}>
        <span className={`${styles.ring} ${me ? (seen.has(viewer) ? styles.ringSeen : styles.ringNew) : styles.ringEmpty}`}>
          <span className={styles.ava}>{(viewer || '?')[0]?.toUpperCase()}</span>
          <span className={styles.plus}><Plus size={13} /></span>
        </span>
        <span className={styles.name}>Your status</span>
      </button>

      {others.map(u => (
        <button key={u.username} className={styles.item} onClick={() => onOpen(storyUsers.indexOf(u))}>
          <span className={`${styles.ring} ${seen.has(u.username) ? styles.ringSeen : styles.ringNew}`}>
            <span className={styles.ava}>{u.username[0]?.toUpperCase()}</span>
          </span>
          <span className={styles.name}>{u.username}</span>
        </button>
      ))}
    </div>
  )
}