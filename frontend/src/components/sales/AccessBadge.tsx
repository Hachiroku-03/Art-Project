import type { AccessMode } from '../../lib/sales'
import styles from './sales.module.css'

export function AccessBadge({ mode }: { mode: AccessMode }) {
  if (mode === 'vip') {
    return <span className={`${styles.badge} ${styles.badgeVip}`}>VIP only</span>
  }

  if (mode === 'invite') {
    return <span className={`${styles.badge} ${styles.badgeInvite}`}>Invite only</span>
  }

  return <span className={`${styles.badge} ${styles.badgeOpen}`}>Open</span>
}