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

const errorStyle: CSSProperties = { fontSize: '0.78rem', color: '#8b1f2f' }
const okStyle: CSSProperties = { fontSize: '0.78rem', color: '#14532d' }
const linkStyle: CSSProperties = {
  fontSize: '0.78rem',
  color: '#1d4ed8',
  textDecoration: 'underline',
  cursor: 'pointer',
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
  const [notice, setNotice] = useState('')
  // Fallback URL rendered as a real <a> the user can click (a genuine gesture),
  // used only when the automatic open was blocked by the popup blocker.
  const [manualUrl, setManualUrl] = useState('')

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
    setNotice('')
    setManualUrl('')

    // CRITICAL: open the blank tab SYNCHRONOUSLY, while the click gesture is
    // still active. window.open() called AFTER an await is treated as a popup
    // and silently blocked, which is why "nothing happened" before.
    const win = window.open('', '_blank')

    try {
      // browser -> YOUR backend -> Paystack initialize.
      // The browser must never call https://api.paystack.co directly.
      const d = await requestWonLotPayment(lot.lot_id, viewer)

      if (d.error) {
        if (win) win.close()
        setError(d.error)
        return
      }

      // Reconcile case: backend found the stored reference already completed
      // on Paystack and applied it. No checkout_url, status === 'paid'.
      if (d.status === 'paid') {
        if (win) win.close()
        setNotice('Payment already confirmed. Refreshing…')
        onOpened?.()
        return
      }

      if (d.checkout_url) {
        if (win) {
          // Gesture-preserving path: point the already-open tab at checkout.
          // This opens checkout.paystack.com/... (hosted page), NOT api.paystack.co,
          // so it does not hit the Cloudflare "Why have I been blocked?" page.
          win.location.href = d.checkout_url
        } else {
          // Popup blocker killed even the synchronous open. Surface a real link
          // the user can click themselves (their click is a fresh gesture).
          setManualUrl(d.checkout_url)
          setError('Pop-up was blocked. Use the link below to continue securely.')
        }
        onOpened?.()
        return
      }

      if (win) win.close()
      setError('No payment link was returned.')
    } catch (e) {
      if (win) win.close()
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
      {notice && !error ? <p style={okStyle}>{notice}</p> : null}

      {manualUrl ? (
        <a
          style={linkStyle}
          href={manualUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setManualUrl('')}
        >
          Continue to secure payment ↗
        </a>
      ) : null}

      <p style={hintTextStyle}>
        Payment is processed on Paystack’s secure hosted page. This app never calls Paystack directly from the browser.
      </p>
    </div>
  )
}

export default WonLotPayButton