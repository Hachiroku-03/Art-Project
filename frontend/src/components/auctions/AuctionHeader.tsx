import { useEffect, useState } from 'react'
import type { Lot, Sale } from '../../lib/sales'
import styles from '../../pages/AuctionRoomPage.module.css'

type Props = { sale: Sale; totalLots: number; activeLot: Lot | null }

export function AuctionHeader({ sale, totalLots, activeLot }: Props) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  function countdown(target: string | null) {
    if (!target) return ''
    const diff = new Date(target.replace(' ', 'T')).getTime() - now
    if (diff <= 0) return '0h 00m 00s'
    const h = Math.floor(diff / 3600000)
    const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0')
    const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0')
    return `${h}h ${m}m ${s}s`
  }

  return (
    <header className={styles.titleRow}>
      <div className={styles.titleLeft}>
        <h1 className={styles.roomTitle}>{sale.title}</h1>
        <p className={styles.roomMeta}>
          <span className={styles.metaHost}>@{sale.host_username}</span>
          {sale.status === 'live' && <span className={styles.livePill}><i /> LIVE · hammer in {countdown(sale.ends_at)}</span>}
          {sale.status === 'ended' && <span className={styles.endedPill}>Hammer fell</span>}
          <span className={styles.metaLots}>{totalLots} lots</span>
        </p>
      </div>
      {activeLot && <div className={styles.lotPlate}>On the block · Lot {activeLot.position}</div>}
    </header>
  )
}