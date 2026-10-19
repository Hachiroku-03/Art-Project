import { normalizeAccessMode } from '../../lib/sales'
import styles from './FilterRail.module.css'

type StatusFilter = 'all' | 'live' | 'upcoming' | 'ended'

export type TierFilter =
  | 'all'
  | 'open'
  | 'vip'
  | 'invite'
  // backward compatibility aliases (accepted from old state, not rendered)
  | 'vip_only'
  | 'invite_only'

type Props = {
  status: StatusFilter
  setStatus: (s: StatusFilter) => void
  tier: TierFilter
  setTier: (t: TierFilter) => void
  counts: {
    live: number
    upcoming: number
    ended: number
  }
  /**
   * Optional. If omitted, the component derives it from the current
   * status/tier selection, so the parent cannot forget to keep it in sync.
   */
  active?: boolean
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
  { key: 'vip', label: 'VIP' },
  { key: 'invite', label: 'Invite' },
]

/**
 * Both sides are normalized so old stored values like "vip_only" still
 * light up the "VIP" chip, and new canonical values work directly.
 */
function isTierActive(current: TierFilter, candidate: TierFilter) {
  if (candidate === 'all') return current === 'all'

  return normalizeAccessMode(current) === normalizeAccessMode(candidate)
}

export function FilterRail({
  status,
  setStatus,
  tier,
  setTier,
  counts,
  active,
  onClear,
}: Props) {
  // Derive active state if the parent did not pass it explicitly.
  const isActive = active ?? (status !== 'all' || tier !== 'all')

  const countFor = (k: StatusFilter) =>
    k === 'all'
      ? (counts.live ?? 0) + (counts.upcoming ?? 0) + (counts.ended ?? 0)
      : counts[k] ?? 0

  return (
    <aside className={styles.rail}>
      <div className={styles.group}>
        <p className={styles.groupLabel}>Status</p>

        {STATUSES.map(s => {
          const on = status === s.key
          return (
            <button
              key={s.key}
              type="button"
              className={`${styles.chip} ${on ? styles.chipOn : ''}`}
              onClick={() => setStatus(s.key)}
              aria-pressed={on}
            >
              <span>{s.label}</span>
              <span className={styles.chipCount}>{countFor(s.key)}</span>
            </button>
          )
        })}
      </div>

      <div className={styles.group}>
        <p className={styles.groupLabel}>Access</p>

        {TIERS.map(t => {
          const on = isTierActive(tier, t.key)
          return (
            <button
              key={t.key}
              type="button"
              className={`${styles.chip} ${on ? styles.chipOn : ''}`}
              onClick={() => setTier(t.key)}
              aria-pressed={on}
            >
              <span>{t.label}</span>
            </button>
          )
        })}
      </div>

      {isActive && (
        <button type="button" className={styles.clear} onClick={onClear}>
          Clear filters
        </button>
      )}
    </aside>
  )
}

export type { StatusFilter }