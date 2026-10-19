import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchPaddles,
  formatMoney,
  invitePaddle,
  type MySale,
  type Paddle,
} from '../../lib/sales'
import styles from './control.module.css'

function sourceClass(source: string) {
  const s = source.trim().toLowerCase()

  if (s === 'invited') return styles.sourceInvited
  if (s === 'complimentary') return styles.sourceComplimentary
  if (s === 'void') return styles.sourceVoid

  return styles.sourcePurchased
}

function sourceLabel(source: string) {
  const s = source.trim().toLowerCase()

  if (s === 'invited') return 'Invited'
  if (s === 'complimentary') return 'Complimentary'
  if (s === 'void') return 'Void'

  return 'Purchased'
}

function formatJoined(value?: string | null) {
  if (!value) return '—'
  return value.replace('T', ' ').slice(0, 16)
}

function memberInitial(user: Paddle) {
  const name = user.display_name || user.user_name || '?'
  return name.trim()[0]?.toUpperCase() || '?'
}

export function EntryTab({
  sales,
  selectedSaleId,
  viewer,
  reload,
}: {
  sales: MySale[]
  selectedSaleId: number | null
  viewer: string
  reload: () => void
}) {
  const [saleId, setSaleId] = useState<number | null>(selectedSaleId)
  const [paddles, setPaddles] = useState<Paddle[]>([])
  const [capacity, setCapacity] = useState<number | null>(null)
  const [sold, setSold] = useState(0)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [inviteName, setInviteName] = useState('')
  const [inviting, setInviting] = useState(false)

  useEffect(() => {
    if (selectedSaleId) setSaleId(selectedSaleId)
  }, [selectedSaleId])

  useEffect(() => {
    if (!saleId && sales.length) {
      setSaleId(sales[0].id)
    }
  }, [saleId, sales])

  const selectedSale = useMemo(
    () => sales.find(s => s.id === saleId) || null,
    [sales, saleId],
  )

  const load = useCallback(async () => {
    if (!saleId) {
      setPaddles([])
      setCapacity(null)
      setSold(0)
      setStatus('')
      return
    }

    if (!viewer) {
      setError('No signed-in house detected.')
      setPaddles([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')

    const d = await fetchPaddles(saleId, viewer)

    if (d.error) {
      setError(d.error)
      setPaddles([])
      setCapacity(null)
      setSold(0)
      setStatus('')
    } else {
      setPaddles(d.paddles || [])
      setCapacity(d.capacity ?? null)
      setSold(d.sold || 0)
      setStatus(d.status || '')
    }

    setLoading(false)
  }, [saleId, viewer])

  useEffect(() => {
    void load()
  }, [load])

  const ended = status === 'ended'

  const submitInvite = async () => {
    setNotice('')
    setError('')

    if (!viewer) {
      setError('No signed-in house detected.')
      return
    }

    if (!saleId) {
      setError('Select a sale first.')
      return
    }

    const name = inviteName.trim()
    if (!name) {
      setError('Enter a username to invite.')
      return
    }

    setInviting(true)

    const res = await invitePaddle(saleId, viewer, name)

    setInviting(false)

    if (res.error) {
      setError(res.error)
      return
    }

    setInviteName('')
    setNotice(
      `Paddle issued to ${res.user_name || name}. Code ${res.code || ''}. ` +
        'Share this code securely; the list only shows the masked code afterward.',
    )

    await load()
    reload()
  }

  return (
    <div className={styles.panel}>
      <div className={styles.entryTop}>
        <div>
          <h2 className={styles.panelTitle} style={{ margin: 0 }}>
            Entry / Paddles
          </h2>

          {selectedSale ? (
            <>
              <div className={styles.muted}>
                {selectedSale.title} · Sale #{selectedSale.id}
              </div>

              <div className={styles.entrySummary}>
                <span>Status: {status || selectedSale.status}</span>
                <span>Paddles: {sold}</span>
                <span>
                  Capacity: {capacity == null ? 'Unlimited' : `${sold} / ${capacity}`}
                </span>
              </div>
            </>
          ) : (
            <div className={styles.muted}>Select a sale to manage paddle entry.</div>
          )}
        </div>

        <div className={styles.actions}>
          <select
            className={`${styles.select} ${styles.salePicker}`}
            value={saleId ?? ''}
            onChange={e => {
              const value = e.target.value
              setSaleId(value ? Number(value) : null)
              setNotice('')
              setError('')
            }}
          >
            <option value="">Select a sale…</option>
            {sales.map(s => (
              <option key={s.id} value={s.id}>
                {s.title} · #{s.id}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!viewer ? (
        <div className={styles.error}>
          No signed-in house detected. Sign in again, or make login call `setSession(...)`.
        </div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}
      {notice ? <p className={styles.noticeOk}>{notice}</p> : null}

      <div className={styles.inviteBar}>
        <label className={styles.inviteField}>
          <span className={styles.label}>Invite username</span>
          <input
            className={styles.inviteInput}
            value={inviteName}
            onChange={e => setInviteName(e.target.value)}
            placeholder="e.g. collector_one"
            disabled={!saleId || ended || inviting || !viewer}
          />
        </label>

        <button
          className={`${styles.linkButton} ${styles.primaryLink}`}
          onClick={() => void submitInvite()}
          disabled={!saleId || ended || inviting || !viewer}
        >
          {inviting ? 'Issuing…' : 'Issue paddle'}
        </button>

        {ended ? (
          <span className={styles.hint}>This sale has ended. Paddles cannot be issued.</span>
        ) : null}
      </div>

      {!sales.length ? (
        <div className={styles.empty}>
          No sales yet. Create a sale first in the <strong>Sales / Auctions</strong> tab.
        </div>
      ) : loading ? (
        <p className={styles.muted}>Loading paddles…</p>
      ) : !saleId ? (
        <p className={styles.muted}>Select a sale.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Member</th>
                <th>Source</th>
                <th>Code</th>
                <th>Joined</th>
                <th>Role</th>
                <th>Tier</th>
                <th>Won lots</th>
                <th>Won total</th>
              </tr>
            </thead>

            <tbody>
              {paddles.length ? (
                paddles.map(p => (
                  <tr key={p.id}>
                    <td>
                      <div className={styles.memberCell}>
                        <span className={styles.memberAvatar}>
                          {p.avatar_url ? (
                            <img
                              src={p.avatar_url}
                              alt=""
                              style={{
                                width: '100%',
                                height: '100%',
                                objectFit: 'cover',
                                display: 'block',
                              }}
                            />
                          ) : (
                            memberInitial(p)
                          )}
                        </span>

                        <span className={styles.memberText}>
                          <span className={styles.memberName}>
                            {p.display_name || p.user_name}
                          </span>
                          <span className={styles.memberHandle}>@{p.user_name}</span>
                        </span>
                      </div>
                    </td>

                    <td>
                      <span className={`${styles.sourcePill} ${sourceClass(p.source)}`}>
                        {sourceLabel(p.source)}
                      </span>
                    </td>

                    <td>
                      <span className={styles.codeText}>{p.code_masked || '—'}</span>
                    </td>

                    <td className={styles.nowrap}>{formatJoined(p.purchased_at)}</td>

                    <td>{p.role || '—'}</td>
                    <td>{p.tier || '—'}</td>

                    <td className={styles.nowrap}>{p.won_lots ?? 0}</td>

                    <td className={styles.moneyText}>
                      {formatMoney(p.won_total || 0, selectedSale?.currency || 'NGN')}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8}>
                    <div className={styles.empty}>
                      No paddles yet. Invite a collector above, or wait for buyers to claim paddles
                      from the ticket page.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}