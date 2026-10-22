import { useState, type CSSProperties } from 'react'
import { formatMoney, requestWonLotPayment, type WonLot } from '../../lib/sales'

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.45rem',
  alignItems: 'flex-start',
}

const btnStyle: CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(20, 18, 15, 0.18)',
  background: '#15121a',
  color: '#f6f4ef',
  borderRadius: 999,
  padding: '0.55rem 0.9rem',
  fontFamily: 'var(--font-ui, system-ui, sans-serif)',
  fontSize: '0.78rem',
  fontWeight: 850,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  cursor: 'pointer',
}

const paidStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 999,
  padding: '0.35rem 0.7rem',
  fontSize: '0.72rem',
  fontWeight: 850,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#14532d',
  background: 'rgba(20, 83, 45, 0.08)',
  border: '1px solid rgba(20, 83, 45, 0.16)',
}

const pendingStyle: CSSProperties = {
  ...paidStyle,
  color: '#92400e',
  background: 'rgba(146, 64, 14, 0.08)',
  borderColor: 'rgba(146, 64, 14, 0.16)',
}

const failStyle: CSSProperties = {
  ...paidStyle,
  color: '#8b1f2f',
  background: 'rgba(139, 31, 47, 0.08)',
  borderColor: 'rgba(139, 31, 47, 0.16)',
}

const errorStyle: CSSProperties = {
  fontSize: '0.78rem',
  color: '#8b1f2f',
}

const hintTextStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: 'var(--ink-soft, #666)',
}

export function WonLotPayButton({
  lot,
  viewer,
  onOpened,
}: {
  lot: WonLot
  viewer: string
  onOpened?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const status = String(lot.payment_status || 'unpaid').toLowerCase()
  const currency = lot.currency || 'NGN'
  const amount = lot.collected || lot.hammer

  if (status === 'paid') {
    return <span style={paidStyle}>Paid</span>
  }

  const pay = async () => {
    if (!viewer) {
      setError('No signed-in buyer detected.')
      return
    }

    setBusy(true)
    setError('')

    try {
      const d = await requestWonLotPayment(lot.lot_id, viewer)

      if (d.error) {
        setError(d.error)
        return
      }

      if (d.checkout_url) {
        // This opens the Paystack-hosted checkout URL returned by YOUR backend.
        // It is not a direct browser call to api.paystack.co.
        window.open(d.checkout_url, '_blank', 'noopener,noreferrer')
        onOpened?.()
        return
      }

      if (d.status === 'paid') {
        setError('This lot is already paid.')
        return
      }

      setError('No payment link was returned.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start payment.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={wrapStyle}>
      {status === 'pending' ? (
        <span style={pendingStyle}>Payment pending</span>
      ) : status === 'failed' ? (
        <span style={failStyle}>Payment failed</span>
      ) : null}

      <button
        type="button"
        style={btnStyle}
        onClick={() => void pay()}
        disabled={busy || !viewer}
      >
        {busy
          ? 'Preparing…'
          : status === 'failed'
            ? 'Try payment again'
            : status === 'pending'
              ? 'Open payment link'
              : `Pay ${formatMoney(amount, currency)}`}
      </button>

      {error ? <p style={errorStyle}>{error}</p> : null}

      <p style={hintTextStyle}>
        Payment is processed on Paystack’s secure hosted page. This app never calls Paystack directly from the browser.
      </p>
    </div>
  )
}

export default WonLotPayButton