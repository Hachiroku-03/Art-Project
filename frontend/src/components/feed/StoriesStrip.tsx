import { Plus } from 'lucide-react'
import { hasUnseenStory, type StoryUser } from '../../lib/feed'
import styles from './StoriesStrip.module.css'

export function StoriesStrip({
  storyUsers,
  viewer,
  viewerAvatarUrl,
  seenStoryIds,
  onOpen,
  onAdd,
}: {
  storyUsers: StoryUser[]
  viewer: string
  viewerAvatarUrl?: string | null
  seenStoryIds: Set<number>
  onOpen: (i: number) => void
  onAdd: () => void
}) {
  const meIndex = storyUsers.findIndex(u => u.username === viewer)
  const me = meIndex >= 0 ? storyUsers[meIndex] : null
  const hasMine = !!me && me.items.length > 0
  const unseenMine = hasUnseenStory(me, seenStoryIds)

  const others = storyUsers.filter(u => u.username !== viewer && u.items.length > 0)
  const myAvatar = viewerAvatarUrl || me?.avatar_url || null

  function handleOwnClick() {
    if (hasMine && meIndex >= 0) {
      onOpen(meIndex)
    } else {
      onAdd()
    }
  }

  return (
    <div className={styles.strip}>
      <div className={styles.item}>
        <button
          className={styles.ringButton}
          onClick={handleOwnClick}
          aria-label={hasMine ? 'View your story' : 'Add to your story'}
        >
          <span
            className={`${styles.ring} ${
              hasMine
                ? unseenMine
                  ? styles.ringNew
                  : styles.ringSeen
                : styles.ringEmpty
            }`}
          >
            <span className={styles.ava}>
              {myAvatar ? (
                <img className={styles.avatarImg} src={myAvatar} alt="" />
              ) : (
                (viewer || '?')[0]?.toUpperCase()
              )}
            </span>
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

      {others.map(u => {
        const index = storyUsers.indexOf(u)
        const unseen = hasUnseenStory(u, seenStoryIds)

        return (
          <button
            key={u.username}
            className={styles.item}
            onClick={() => onOpen(index)}
          >
            <span
              className={`${styles.ring} ${
                unseen ? styles.ringNew : styles.ringSeen
              }`}
            >
              <span className={styles.ava}>
                {u.avatar_url ? (
                  <img className={styles.avatarImg} src={u.avatar_url} alt="" />
                ) : (
                  u.username[0]?.toUpperCase()
                )}
              </span>
            </span>

            <span className={styles.name}>{u.username}</span>
          </button>
        )
      })}
    </div>
  )
}