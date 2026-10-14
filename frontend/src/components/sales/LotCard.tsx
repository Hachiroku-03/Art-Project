import { formatMoney, type Lot } from '../../lib/sales'
import styles from './sales.module.css'

function statusClass(status: Lot['status']) {
  if (status === 'sealed') return styles.statusSealed
  if (status === 'on_block') return styles.statusOnBlock
  if (status === 'sold') return styles.statusSold
  return styles.statusPassed
}

function statusLabel(status: Lot['status']) {
  if (status === 'sealed') return 'Sealed'
  if (status === 'on_block') return 'On the block'
  if (status === 'sold') return 'Sold'
  return 'Passed'
}

export function LotCard({
  lot,
  isHost,
  canBid,
  onOpenRoom,
}: {
  lot: Lot
  isHost?: boolean
  canBid?: boolean
  onOpenRoom?: () => void
}) {
  if (lot.status === 'sealed') {
    return (
      <article className={`${styles.lotCard} ${styles.sealedCard}`}>
        <div className={styles.lotTitle}>Lot {lot.position}</div>
        <div className={styles.muted}>Sealed until reveal</div>
        <span className={`${styles.statusPill} ${styles.statusSealed}`}>Sealed</span>
      </article>
    )
  }

  const currency = lot.currency || 'NGN'

  return (
    <article className={styles.lotCard}>
      {lot.image_url ? (
        <img className={styles.lotImage} src={lot.image_url} alt={lot.title || `Lot ${lot.position}`} />
      ) : (
        <div className={styles.lotImage} />
      )}

      <div className={styles.lotBody}>
        <div className={styles.between}>
          <div className={styles.lotTitle}>{lot.title || `Lot ${lot.position}`}</div>
          <span className={`${styles.statusPill} ${statusClass(lot.status)}`}>
            {statusLabel(lot.status)}
          </span>
        </div>

        <div className={styles.small}>
          Starting: {formatMoney(lot.starting_price, currency)}
        </div>

        {(lot.estimate_low || lot.estimate_high) && (
          <div className={styles.small}>
            Estimate: {formatMoney(lot.estimate_low, currency)} – {formatMoney(lot.estimate_high, currency)}
          </div>
        )}

        {lot.status === 'on_block' && (
          <div className={styles.small}>
            Current bid: {formatMoney(lot.current_bid, currency)} · {lot.bid_count ?? 0} bids
          </div>
        )}

        {lot.status === 'sold' && (
          <div className={styles.small}>
            Sold: {formatMoney(lot.sold_price, currency)}
            {lot.winner_username ? ` · Winner: ${lot.winner_username}` : ''}
          </div>
        )}

        {isHost && lot.reserve ? (
          <div className={styles.small}>Reserve: {formatMoney(lot.reserve, currency)}</div>
        ) : null}

        {lot.status === 'on_block' && canBid && onOpenRoom ? (
          <button className={styles.button} onClick={onOpenRoom}>
            Bid in room
          </button>
        ) : null}
      </div>
    </article>
  )
}