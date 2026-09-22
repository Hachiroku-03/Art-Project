import { type Sale } from '../../lib/sales'
import styles from './FilterRail.module.css'

type StatusFilter = 'all' | 'live' | 'upcoming' | 'ended'
type TierFilter = 'all' | 'open' | 'vip_only' | 'invite_only'

type Props = {
  status: StatusFilter; setStatus: (s: StatusFilter) => void
  tier: TierFilter; setTier: (t: TierFilter) => void
  counts: { live: number; upcoming: number; ended: number }
  active: boolean
  onClear: () => void
}

const STATUSES: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All rooms' },
  { key: 'live', label: 'Live now' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'ended', label: 'Ended' },
]
const TIERS: { key: TierFilter; label: string }[] = [
  { key: 'all', label: 'Everyone' },
  { key: 'open', label: 'Open floor' },
  { key: 'vip_only', label: 'VIP' },
  { key: 'invite_only', label: 'Invite' },
]

export function FilterRail({ status, setStatus, tier, setTier, counts, active, onClear }: Props) {
  const countFor = (k: StatusFilter) => k === 'all' ? counts.live + counts.upcoming + counts.ended : counts[k]
  return (
    <aside className={styles.rail}>
      <div className={styles.group}>
        <p className={styles.groupLabel}>Status</p>
        {STATUSES.map(s => (
          <button key={s.key}
            className={`${styles.chip} ${status === s.key ? styles.chipOn : ''}`}
            onClick={() => setStatus(s.key)}>
            <span>{s.label}</span>
            <span className={styles.chipCount}>{countFor(s.key)}</span>
          </button>
        ))}
      </div>
      <div className={styles.group}>
        <p className={styles.groupLabel}>Access</p>
        {TIERS.map(t => (
          <button key={t.key}
            className={`${styles.chip} ${tier === t.key ? styles.chipOn : ''}`}
            onClick={() => setTier(t.key)}>
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      {active && (
        <button className={styles.clear} onClick={onClear}>Clear filters</button>
      )}
    </aside>
  )
}

export type { StatusFilter, TierFilter }