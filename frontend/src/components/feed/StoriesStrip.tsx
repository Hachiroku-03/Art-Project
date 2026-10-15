import { Plus } from 'lucide-react'
import type { StoryUser } from '../../lib/feed'
import styles from './StoriesStrip.module.css'

export function StoriesStrip({
  storyUsers,
  viewer,
  seen,
  onOpen,
  onAdd,
}: {
  storyUsers: StoryUser[]
  viewer: string
  seen: Set<string>
  onOpen: (i: number) => void
  onAdd: () => void
}) {
  const meIndex = storyUsers.findIndex(u => u.username === viewer)
  const me = meIndex >= 0 ? storyUsers[meIndex] : null
  const hasMine = !!me && me.items.length > 0

  const others = storyUsers.filter(u => u.username !== viewer)

  return (
    <div className={styles.strip}>
      <div className={styles.item}>
        <button
          className={styles.ringButton}
          onClick={() => (hasMine ? onOpen(meIndex) : onAdd())}
          aria-label={hasMine ? 'View your story' : 'Add to your story'}
        >
          <span
            className={`${styles.ring} ${
              hasMine
                ? seen.has(viewer)
                  ? styles.ringSeen
                  : styles.ringNew
                : styles.ringEmpty
            }`}
          >
            <span className={styles.ava}>{(viewer || '?')[0]?.toUpperCase()}</span>
          </span>

          <span className={styles.name}>Your status</span>
        </button>

        <button
          className={styles.addAction}
          onClick={onAdd}
          aria-label="Add to your story"
        >
          <Plus size={12} />
          <span>{hasMine ? 'Add' : 'New'}</span>
        </button>
      </div>

      {others.map(u => (
        <button
          key={u.username}
          className={styles.item}
          onClick={() => onOpen(storyUsers.indexOf(u))}
        >
          <span
            className={`${styles.ring} ${
              seen.has(u.username) ? styles.ringSeen : styles.ringNew
            }`}
          >
            <span className={styles.ava}>{u.username[0]?.toUpperCase()}</span>
          </span>

          <span className={styles.name}>{u.username}</span>
        </button>
      ))}
    </div>
  )
}