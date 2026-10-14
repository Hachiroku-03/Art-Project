import type { Lot } from '../../lib/sales'
import { LotCard } from './LotCard'
import styles from './sales.module.css'

export function CatalogueGrid({
  lots,
  isHost,
  canBid,
  locked,
  onOpenRoom,
}: {
  lots: Lot[]
  isHost?: boolean
  canBid?: boolean
  locked?: boolean
  onOpenRoom?: () => void
}) {
  if (locked) {
    return (
      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Catalogue</h2>
        <p className={styles.muted}>
          Claim a paddle to preview the catalogue. Lots remain sealed until the house reveals them.
        </p>
      </section>
    )
  }

  if (!lots.length) {
    return (
      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>Catalogue</h2>
        <p className={styles.muted}>No lots have been added yet.</p>
      </section>
    )
  }

  return (
    <section>
      <h2 className={styles.panelTitle}>Catalogue</h2>
      <div className={styles.lotGrid}>
        {lots.map(lot => (
          <LotCard
            key={lot.id}
            lot={lot}
            isHost={isHost}
            canBid={canBid}
            onOpenRoom={onOpenRoom}
          />
        ))}
      </div>
    </section>
  )
}