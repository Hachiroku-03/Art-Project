import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchHousePayout,
  fetchSalePayout,
  formatMoney,
  markPayoutPaid,
  saveHousePayout,
  type HousePayoutProfile,
  type MySale,
  type SalePayoutView,
} from '../../lib/sales'
import styles from './control.module.css'

type PayoutForm = {
  business_name: string
  bank_code: string
  account_number: string
  account_name: string
  currency: string
  paystack_subaccount_code: string
  paystack_recipient_code: string
}

const BLANK_FORM: PayoutForm = {
  business_name: '',
  bank_code: '',
  account_number: '',
  account_name: '',
  currency: 'NGN',
  paystack_subaccount_code: '',
  paystack_recipient_code: '',
}

function fromProfile(profile: HousePayoutProfile | null | undefined): PayoutForm {
  if (!profile) return { ...BLANK_FORM }

  return {
    business_name: profile.business_name || '',
    bank_code: profile.bank_code || '',
    account_number: profile.account_number || '',
    account_name: profile.account_name || '',
    currency: profile.currency || 'NGN',
    paystack_subaccount_code: profile.paystack_subaccount_code || '',
    paystack_recipient_code: profile.paystack_recipient_code || '',
  }
}

function payoutStatusClass(status?: string | null) {
  const s = String(status || '').trim().toLowerCase()

  if (s === 'paid') return styles.payoutPaid
  if (s === 'pending') return styles.payoutPending

  return styles.payoutNone
}

function payoutStatusLabel(status?: string | null) {
  const s = String(status || '').trim().toLowerCase()

  if (s === 'paid') return 'Paid'
  if (s === 'pending') return 'Pending'
  if (s === 'failed') return 'Failed'
  if (s === 'none') return 'None'

  return status || 'None'
}

function profileStatusClass(status?: string | null) {
  const s = String(status || '').trim().toLowerCase()

  if (s === 'ready' || s === 'active') return styles.payoutReady

  return styles.payoutDraft
}

function profileStatusLabel(status?: string | null) {
  const s = String(status || '').trim().toLowerCase()

  if (s === 'ready') return 'Ready'
  if (s === 'active') return 'Active'
  if (s === 'disabled') return 'Disabled'

  return 'Draft'
}

function collectionLabel(state?: string | null) {
  const s = String(state || '').trim().toLowerCase()

  if (s === 'not_settled') return 'Not settled'
  if (s === 'awaiting_collection') return 'Awaiting collection'
  if (s === 'pending') return 'Payment pending'
  if (s === 'collected') return 'Collected'
  if (s === 'none') return 'None'

  return state || '—'
}

function saleStatusLabel(status?: string | null) {
  const s = String(status || '').trim().toLowerCase()

  if (s === 'live') return 'Live'
  if (s === 'upcoming') return 'Upcoming'
  if (s === 'ended') return 'Ended'

  return status || '—'
}

function formatDateTime(value?: string | null) {
  if (!value) return '—'

  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const d = new Date(normalized)

  if (Number.isNaN(d.getTime())) return value

  return d.toLocaleString()
}

function maskAccount(value?: string | null) {
  const s = String(value || '').trim()
  if (!s) return '—'
  if (s.length <= 4) return `••••${s}`
  return `••••${s.slice(-4)}`
}

export function PayoutTab({
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
  // ---- payout profile ----
  const [form, setForm] = useState<PayoutForm>(BLANK_FORM)
  const [profile, setProfile] = useState<HousePayoutProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileNotice, setProfileNotice] = useState('')

  // ---- sale payout ----
  const [saleId, setSaleId] = useState<number | null>(selectedSaleId)
  const [payout, setPayout] = useState<SalePayoutView | null>(null)
  const [payoutLoading, setPayoutLoading] = useState(false)
  const [payoutError, setPayoutError] = useState('')
  const [payoutNotice, setPayoutNotice] = useState('')
  const [marking, setMarking] = useState(false)

  useEffect(() => {
    if (selectedSaleId) setSaleId(selectedSaleId)
  }, [selectedSaleId])

  useEffect(() => {
    if (!saleId && sales.length) {
      setSaleId(sales[0].id)
    }
  }, [saleId, sales])

  useEffect(() => {
    setPayoutNotice('')
    setPayoutError('')
  }, [saleId])

  const selectedSale = useMemo(
    () => sales.find(s => s.id === saleId) || null,
    [sales, saleId],
  )

  const loadProfile = useCallback(async () => {
    if (!viewer) {
      setProfile(null)
      setForm(BLANK_FORM)
      return
    }

    setProfileLoading(true)
    setProfileError('')

    const d = await fetchHousePayout(viewer)

    if (d.error) {
      setProfileError(d.error)
      setProfile(null)
      setForm(BLANK_FORM)
    } else {
      setProfile(d.profile || null)
      setForm(fromProfile(d.profile))
    }

    setProfileLoading(false)
  }, [viewer])

  useEffect(() => {
    void loadProfile()
  }, [loadProfile])

  const loadPayout = useCallback(async () => {
    if (!saleId) {
      setPayout(null)
      return
    }

    if (!viewer) {
      setPayoutError('No signed-in house detected.')
      setPayout(null)
      setPayoutLoading(false)
      return
    }

    setPayoutLoading(true)
    setPayoutError('')

    const d = await fetchSalePayout(saleId, viewer)

    if (d.error) {
      setPayoutError(d.error)
      setPayout(null)
    } else {
      setPayout(d)
    }

    setPayoutLoading(false)
  }, [saleId, viewer])

  useEffect(() => {
    void loadPayout()
  }, [loadPayout])

  const setField = <K extends keyof PayoutForm>(key: K, value: PayoutForm[K]) =>
    setForm(prev => ({ ...prev, [key]: value }))

  const validateProfile = (): string => {
    if (!form.business_name.trim()) return 'Business name is required.'
    if (form.business_name.trim().length > 160) return 'Business name is too long.'

    const bank = form.bank_code.trim().toUpperCase()
    if (!bank) return 'Bank code is required.'
    if (bank.length < 3 || bank.length > 12 || !/^[A-Z0-9]+$/.test(bank)) {
      return 'Bank code must be 3-12 letters/numbers.'
    }

    const acct = form.account_number.trim()
    if (!acct) return 'Account number is required.'
    if (!/^\d{7,20}$/.test(acct)) return 'Account number must be 7-20 digits.'

    if (!form.account_name.trim()) return 'Account name is required.'
    if (form.account_name.trim().length > 160) return 'Account name is too long.'

    const ccy = form.currency.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(ccy)) return 'Currency must be a 3-letter ISO code.'

    const sub = form.paystack_subaccount_code.trim()
    if (sub && !sub.toUpperCase().startsWith('SUB_')) {
      return 'Paystack subaccount code should start with SUB_.'
    }

    const rec = form.paystack_recipient_code.trim()
    if (rec && !rec.toUpperCase().startsWith('BT_')) {
      return 'Paystack recipient code should start with BT_.'
    }

    return ''
  }

  const saveProfile = async () => {
    setProfileNotice('')
    setProfileError('')

    if (!viewer) {
      setProfileError('No signed-in house detected.')
      return
    }

    const v = validateProfile()
    if (v) {
      setProfileError(v)
      return
    }

    setProfileSaving(true)

    const res = await saveHousePayout(viewer, {
      business_name: form.business_name.trim(),
      bank_code: form.bank_code.trim().toUpperCase(),
      account_number: form.account_number.trim(),
      account_name: form.account_name.trim(),
      currency: form.currency.trim().toUpperCase(),
      paystack_subaccount_code: form.paystack_subaccount_code.trim() || null,
      paystack_recipient_code: form.paystack_recipient_code.trim() || null,
    })

    setProfileSaving(false)

    if (res.error) {
      setProfileError(res.error)
      return
    }

    setProfile(res.profile || null)
    setForm(fromProfile(res.profile))
    setProfileNotice('Payout profile saved.')
  }

  const counts = payout?.counts || { paid: 0, pending: 0, unpaid: 0, failed: 0 }
  const dueCount = counts.unpaid + counts.failed
  const currency =
    payout?.totals?.currency ||
    payout?.sale?.currency ||
    selectedSale?.currency ||
    form.currency ||
    'NGN'

  const canMarkPaid =
    !!payout &&
    !!payout.settled &&
    payout.sale?.status === 'ended' &&
    dueCount === 0 &&
    payout.sale?.payout_status !== 'paid' &&
    !!viewer &&
    !payoutLoading &&
    !marking

  const handleMarkPaid = async () => {
    if (!saleId) return

    const ok = window.confirm(
      'Mark this payout as paid? Use this only after you have physically/electronically paid the house net amount.',
    )
    if (!ok) return

    setMarking(true)
    setPayoutError('')
    setPayoutNotice('')

    const res = await markPayoutPaid(saleId, viewer)

    setMarking(false)

    if (res.error) {
      setPayoutError(res.error)
      return
    }

    setPayoutNotice(
      `${res.message || 'Payout marked paid.'} Reference: ${res.payout_reference || '—'}`,
    )

    await loadPayout()
    reload()
  }

  return (
    <div className={styles.panel}>
      <div className={styles.payoutGrid}>
        {/* ---------------- Payout profile ---------------- */}
        <section className={styles.payoutCard}>
          <div className={styles.payoutCardHead}>
            <div>
              <div className={styles.payoutCardTitle}>House payout profile</div>
              <div className={styles.payoutCardSub}>
                Where the platform should pay your net auction proceeds.
              </div>
            </div>

            <span className={`${styles.payoutBadge} ${profileStatusClass(profile?.status)}`}>
              {profileStatusLabel(profile?.status)}
            </span>
          </div>

          {!viewer ? (
            <div className={styles.error}>
              No signed-in house detected. Sign in again, or make login call `setSession(...)`.
            </div>
          ) : null}

          {profileLoading ? (
            <p className={styles.muted}>Loading payout profile…</p>
          ) : null}

          {profileError ? <div className={styles.error}>{profileError}</div> : null}
          {profileNotice ? <p className={styles.payoutNotice}>{profileNotice}</p> : null}

          <div className={styles.payoutFormGrid}>
            <label className={styles.payoutField}>
              <span className={styles.label}>Business name</span>
              <input
                className={styles.payoutInput}
                value={form.business_name}
                onChange={e => setField('business_name', e.target.value)}
                placeholder="Amanai Arts Ltd"
                maxLength={160}
                disabled={!viewer || profileSaving}
              />
            </label>

            <label className={styles.payoutField}>
              <span className={styles.label}>Bank code</span>
              <input
                className={styles.payoutInput}
                value={form.bank_code}
                onChange={e => setField('bank_code', e.target.value.toUpperCase())}
                placeholder="058"
                maxLength={12}
                disabled={!viewer || profileSaving}
              />
              <span className={styles.payoutHint}>
                Bank code / sort code / routing code, depending on country.
              </span>
            </label>

            <label className={styles.payoutField}>
              <span className={styles.label}>Account number</span>
              <input
                className={styles.payoutInput}
                value={form.account_number}
                onChange={e => setField('account_number', e.target.value.replace(/\D/g, ''))}
                placeholder="0123456789"
                maxLength={20}
                inputMode="numeric"
                disabled={!viewer || profileSaving}
              />
              <span className={styles.payoutHint}>
                Stored as text to preserve leading zeros. Local dev only — production should encrypt/tokenize.
              </span>
            </label>

            <label className={styles.payoutField}>
              <span className={styles.label}>Account name</span>
              <input
                className={styles.payoutInput}
                value={form.account_name}
                onChange={e => setField('account_name', e.target.value)}
                placeholder="Amanai Arts"
                maxLength={160}
                disabled={!viewer || profileSaving}
              />
            </label>

            <label className={styles.payoutField}>
              <span className={styles.label}>Currency</span>
              <input
                className={styles.payoutInput}
                value={form.currency}
                onChange={e => setField('currency', e.target.value.toUpperCase())}
                placeholder="NGN"
                maxLength={3}
                disabled={!viewer || profileSaving}
              />
            </label>

            <label className={styles.payoutField}>
              <span className={styles.label}>Paystack subaccount code</span>
              <input
                className={styles.payoutInput}
                value={form.paystack_subaccount_code}
                onChange={e => setField('paystack_subaccount_code', e.target.value.toUpperCase())}
                placeholder="SUB_xxxxxxxxxx"
                disabled={!viewer || profileSaving}
              />
              <span className={styles.payoutHint}>
                Optional. Used later for split-at-charge payouts.
              </span>
            </label>

            <label className={styles.payoutField}>
              <span className={styles.label}>Paystack recipient code</span>
              <input
                className={styles.payoutInput}
                value={form.paystack_recipient_code}
                onChange={e => setField('paystack_recipient_code', e.target.value.toUpperCase())}
                placeholder="BT_xxxxxxxxxx"
                disabled={!viewer || profileSaving}
              />
              <span className={styles.payoutHint}>
                Optional. Used later for direct transfer payouts.
              </span>
            </label>
          </div>

          <div className={styles.payoutActions}>
            <button
              className={`${styles.linkButton} ${styles.primaryLink}`}
              onClick={() => void saveProfile()}
              disabled={!viewer || profileSaving || profileLoading}
            >
              {profileSaving ? 'Saving…' : 'Save payout profile'}
            </button>

            <button
              className={styles.linkButton}
              onClick={() => void loadProfile()}
              disabled={!viewer || profileLoading || profileSaving}
            >
              Reload
            </button>
          </div>

          <p className={styles.payoutWarn}>
            Do not call <span className={styles.payoutCode}>https://api.paystack.co</span> from the
            browser. Paystack API calls stay server-side in <span className={styles.payoutCode}>backend/paystack.py</span>.
            The browser may only open hosted checkout URLs returned by your backend.
          </p>
        </section>

        {/* ---------------- Sale payout ---------------- */}
        <section className={styles.payoutCard}>
          <div className={styles.payoutCardHead}>
            <div>
              <div className={styles.payoutCardTitle}>Sale payout ledger</div>
              <div className={styles.payoutCardSub}>
                Collection and payout status for a selected sale.
              </div>
            </div>

            <select
              className={`${styles.select} ${styles.salePicker}`}
              value={saleId ?? ''}
              onChange={e => {
                const value = e.target.value
                setSaleId(value ? Number(value) : null)
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

          {!sales.length ? (
            <div className={styles.empty}>
              No sales yet. Create and run a sale first.
            </div>
          ) : payoutLoading ? (
            <p className={styles.muted}>Loading payout…</p>
          ) : payoutError ? (
            <div className={styles.error}>{payoutError}</div>
          ) : !payout ? (
            <p className={styles.muted}>Select a sale.</p>
          ) : (
            <>
              <div className={styles.payoutMeta}>
                <span>{payout.sale?.title || selectedSale?.title || 'Sale'}</span>
                <span>Status: {saleStatusLabel(payout.sale?.status)}</span>
                <span>Settled: {payout.settled ? 'Yes' : 'No'}</span>
                <span>Collection: {collectionLabel(payout.collection_state)}</span>
                <span>
                  Payout: {payoutStatusLabel(payout.sale?.payout_status)}
                </span>
              </div>

              {payoutNotice ? <p className={styles.payoutNotice}>{payoutNotice}</p> : null}

              <div className={styles.payoutStats}>
                <div className={styles.payoutStat}>
                  <span className={styles.payoutStatLabel}>Net to house</span>
                  <span className={styles.payoutStatValue}>
                    {formatMoney(payout.totals?.net_to_house, currency)}
                  </span>
                </div>

                <div className={styles.payoutStat}>
                  <span className={styles.payoutStatLabel}>Collected total</span>
                  <span className={styles.payoutStatValue}>
                    {formatMoney(payout.totals?.collected_total, currency)}
                  </span>
                </div>

                <div className={styles.payoutStat}>
                  <span className={styles.payoutStatLabel}>Commission</span>
                  <span className={styles.payoutStatValue}>
                    {formatMoney(payout.totals?.commission_total, currency)}
                  </span>
                </div>

                <div className={styles.payoutStat}>
                  <span className={styles.payoutStatLabel}>Paid lots</span>
                  <span className={styles.payoutStatValue}>{counts.paid}</span>
                </div>

                <div className={styles.payoutStat}>
                  <span className={styles.payoutStatLabel}>Pending lots</span>
                  <span className={styles.payoutStatValue}>{counts.pending}</span>
                </div>

                <div className={styles.payoutStat}>
                  <span className={styles.payoutStatLabel}>Unpaid / failed</span>
                  <span className={styles.payoutStatValue}>{dueCount}</span>
                </div>

                <div className={styles.payoutStat}>
                  <span className={styles.payoutStatLabel}>Settled at</span>
                  <span className={styles.payoutStatValue}>
                    {formatDateTime(payout.sale?.settled_at)}
                  </span>
                </div>

                <div className={styles.payoutStat}>
                  <span className={styles.payoutStatLabel}>Payout reference</span>
                  <span className={styles.payoutStatValue}>
                    {payout.sale?.payout_reference || '—'}
                  </span>
                </div>
              </div>

              <div className={styles.payoutActions}>
                <span className={`${styles.payoutBadge} ${payoutStatusClass(payout.sale?.payout_status)}`}>
                  {payoutStatusLabel(payout.sale?.payout_status)}
                </span>

                <button
                  className={`${styles.linkButton} ${styles.primaryLink}`}
                  onClick={() => void handleMarkPaid()}
                  disabled={!canMarkPaid}
                >
                  {marking ? 'Marking…' : 'Mark payout paid'}
                </button>

                <button
                  className={styles.linkButton}
                  onClick={() => void loadPayout()}
                  disabled={payoutLoading || marking}
                >
                  Refresh
                </button>
              </div>

              {!payout.settled ? (
                <p className={styles.payoutWarn}>
                  This sale is not settled yet. Settle it from the Settlement tab first.
                </p>
              ) : dueCount > 0 ? (
                <p className={styles.payoutWarn}>
                  {dueCount} won lot(s) are still unpaid/failed. Payout cannot be marked paid until collection is complete.
                </p>
              ) : payout.sale?.payout_status === 'paid' ? (
                <p className={styles.payoutNotice}>
                  Payout already marked paid. Reference: {payout.sale?.payout_reference || '—'}
                </p>
              ) : null}

              <div className={styles.tableWrap} style={{ marginTop: '0.9rem' }}>
                <div className={styles.panelTitleSmall}>Payout destination on file</div>

                {payout.payout_profile ? (
                  <table className={styles.table}>
                    <tbody>
                      <tr>
                        <td>Business</td>
                        <td>{payout.payout_profile.business_name || '—'}</td>
                      </tr>
                      <tr>
                        <td>Bank code</td>
                        <td>{payout.payout_profile.bank_code || '—'}</td>
                      </tr>
                      <tr>
                        <td>Account</td>
                        <td>{maskAccount(payout.payout_profile.account_number)}</td>
                      </tr>
                      <tr>
                        <td>Account name</td>
                        <td>{payout.payout_profile.account_name || '—'}</td>
                      </tr>
                      <tr>
                        <td>Currency</td>
                        <td>{payout.payout_profile.currency || '—'}</td>
                      </tr>
                      <tr>
                        <td>Subaccount</td>
                        <td className={styles.payoutCode}>
                          {payout.payout_profile.paystack_subaccount_code || '—'}
                        </td>
                      </tr>
                      <tr>
                        <td>Recipient</td>
                        <td className={styles.payoutCode}>
                          {payout.payout_profile.paystack_recipient_code || '—'}
                        </td>
                      </tr>
                      <tr>
                        <td>Status</td>
                        <td>
                          <span className={`${styles.payoutBadge} ${profileStatusClass(payout.payout_profile.status)}`}>
                            {profileStatusLabel(payout.payout_profile.status)}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                ) : (
                  <div className={styles.empty}>
                    No payout profile saved yet. Save one above before processing real payouts.
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}