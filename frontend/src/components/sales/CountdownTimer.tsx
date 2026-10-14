import { useEffect, useState } from 'react'
import { formatRemaining, parseTs, type SaleStatus } from '../../lib/sales'
import styles from './sales.module.css'

export function CountdownTimer({
  target,
  label,
  status,
}: {
  target?: string | null
  label: string
  status?: SaleStatus
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  if (status === 'ended') {
    return <span className={styles.muted}>Ended</span>
  }

  const d = parseTs(target)

  if (!d) {
    return <span className={styles.muted}>{label}</span>
  }

  const diff = d.getTime() - now

  if (diff <= 0) {
    return <span className={styles.badge}>Now</span>
  }

  return (
    <span className={styles.small}>
      {label} {formatRemaining(diff)}
    </span>
  )
}