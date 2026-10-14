import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { buyPaddle, getSaleView, type Lot, type Sale } from '../lib/sales'
import { getViewer } from '../lib/session'
import { CatalogueGrid } from '../components/sales/CatalogueGrid'
import { EnterRoomModal } from '../components/sales/EnterRoomModal'
import { SaleHero } from '../components/sales/SaleHero'
import { TicketPanel } from '../components/sales/TicketPanel'
import styles from '../components/sales/sales.module.css'

export function SaleDetailPage() {
  const { saleId } = useParams<{ saleId: string }>()
  const id = Number(saleId)
  const viewer = getViewer()
  const navigate = useNavigate()

  const [sale, setSale] = useState<Sale | null>(null)
  const [lots, setLots] = useState<Lot[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [paddleCode, setPaddleCode] = useState<string | null>(null)
  const [codeModalOpen, setCodeModalOpen] = useState(false)

  const load = useCallback(async () => {
    if (!Number.isFinite(id)) {
      setError('Invalid sale id.')
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')

    const d = await getSaleView(id, viewer)

    if (d.error) {
      setError(d.error)
      setSale(null)
      setLots([])
    } else {
      setSale(d.sale || null)
      setLots(d.lots || [])
    }

    setLoading(false)
  }, [id, viewer])

  useEffect(() => {
    void load()
  }, [load])

  const handleBuy = async () => {
    if (!sale) return

    setBusy(true)
    setError('')

    const r = await buyPaddle(sale.id, viewer)

    if (r.error) {
      setError(r.error)
      setBusy(false)
      return
    }

    setPaddleCode(r.code || null)
    await load()
    setBusy(false)
  }

  const handleEnter = () => {
    if (!sale) return

    if (sale.has_ticket || sale.is_host) {
      navigate(`/sales/${sale.id}/room`)
      return
    }

    setCodeModalOpen(true)
  }

  if (loading) {
    return (
      <main className={styles.page}>
        <div className={styles.narrow}>
          <p className={styles.loading}>Loading sale…</p>
        </div>
      </main>
    )
  }

  if (!sale) {
    return (
      <main className={styles.page}>
        <div className={styles.narrow}>
          <div className={styles.error}>{error || 'Sale not found.'}</div>
          <Link className={styles.back} to="/auctions">
            Back to auctions
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <div className={styles.narrow}>
        <Link className={styles.back} to="/auctions">
          ← Back to auctions
        </Link>

        <SaleHero sale={sale} />

        <TicketPanel
          sale={sale}
          paddleCode={paddleCode}
          busy={busy}
          error={error}
          onBuy={() => void handleBuy()}
          onEnter={handleEnter}
          onUseCode={() => setCodeModalOpen(true)}
        />

        <CatalogueGrid
          lots={lots}
          isHost={sale.is_host}
          canBid={sale.can_bid}
          locked={sale.locked}
          onOpenRoom={() => navigate(`/sales/${sale.id}/room`)}
        />
      </div>

      <EnterRoomModal
        open={codeModalOpen}
        saleId={sale.id}
        viewer={viewer}
        onClose={() => setCodeModalOpen(false)}
        onEntered={() => {
          setCodeModalOpen(false)
          navigate(`/sales/${sale.id}/room`)
        }}
      />
    </main>
  )
}