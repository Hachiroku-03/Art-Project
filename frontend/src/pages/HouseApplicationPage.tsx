import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Landmark, ArrowLeft, CheckCircle2, Clock, AlertTriangle } from 'lucide-react'
import styles from './HouseApplicationPage.module.css'

const AUTH = 'http://localhost:8000'
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Standing = 'loading' | 'none' | 'pending' | 'approved' | 'rejected'

export function HouseApplicationPage() {
  const navigate = useNavigate()
  const viewer = localStorage.getItem('space_user') || ''

  // ---- all hooks, top level, before any conditional render ----
  const [standing, setStanding] = useState<Standing>('loading')
  const [lastNote, setLastNote] = useState('')
  const [submittedName, setSubmittedName] = useState('')
  const [submittedAt, setSubmittedAt] = useState('')

  const [houseName, setHouseName] = useState('')
  const [statement, setStatement] = useState('')
  const [license, setLicense] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [errors, setErrors] = useState<{ houseName?: string; contactEmail?: string }>({})
  const [toast, setToast] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Auth guard + read current standing so the page is correct even if opened by direct URL.
  useEffect(() => {
    if (!localStorage.getItem('space_token')) { navigate('/login', { replace: true }); return }
    if (localStorage.getItem('space_role') === 'house') { setStanding('approved'); return }
    fetch(`${AUTH}/house/application?viewer=${encodeURIComponent(viewer)}`)
      .then(r => r.json())
      .then(d => {
        const s = d.status
        if (s === 'approved' || s === 'pending' || s === 'rejected') {
          setStanding(s)
          setSubmittedName(d.house_name || '')
          setSubmittedAt(d.created_at || '')
          setLastNote(d.admin_note || '')
        } else {
          setStanding('none')
        }
      })
      .catch(() => setStanding('none'))
  }, [viewer, navigate])

  async function refreshStanding() {
    const d = await fetch(`${AUTH}/house/application?viewer=${encodeURIComponent(viewer)}`).then(r => r.json()).catch(() => ({}))
    const s = d.status
    if (s === 'approved' || s === 'pending' || s === 'rejected') {
      setStanding(s); setSubmittedName(d.house_name || ''); setSubmittedAt(d.created_at || ''); setLastNote(d.admin_note || '')
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setToast('')
    const next: { houseName?: string; contactEmail?: string } = {}
    if (houseName.trim().length < 2) next.houseName = 'Give your house a name.'
    if (contactEmail.trim() && !EMAIL_REGEX.test(contactEmail.trim())) next.contactEmail = 'That email doesn’t look right.'
    setErrors(next)
    if (Object.keys(next).length > 0) return

    setSubmitting(true)
    try {
      const res = await fetch(`${AUTH}/house/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer, houseName: houseName.trim(), statement: statement.trim(), license: license.trim(), contactEmail: contactEmail.trim() }),
      })
      const data = await res.json()
      if (data.error) {
        setToast(data.error)
        // If the server says "already a house" or "already in review", flip the page to the truth.
        if (/already/i.test(data.error)) await refreshStanding()
      } else {
        await refreshStanding() // now pending → the pending card renders
      }
    } catch {
      setToast('The server is unreachable.')
    } finally {
      setSubmitting(false)
    }
  }

  const shortDate = submittedAt ? new Date(submittedAt.replace(' ', 'T')).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''

  return (
    <main className={styles.layout}>
      <div className={styles.shell}>
        <button className={styles.back} onClick={() => navigate('/auctions')}><ArrowLeft size={15} /> Back to the floor</button>

        {standing === 'loading' && (
          <p className={styles.quiet}>Checking your standing…</p>
        )}

        {standing === 'approved' && (
          <section className={styles.card}>
            <div className={`${styles.seal} ${styles.sealOk}`}><CheckCircle2 size={22} /></div>
            <h1 className={styles.title}>You hold the rostrum.</h1>
            <p className={styles.body}>
              <strong>{submittedName || 'Your house'}</strong> is accredited. The control room is where you open a sale, hang lots, and drop the hammer.
            </p>
            <button className={styles.primary} onClick={() => navigate('/sales/control')}><Landmark size={15} /> Enter the control room</button>
          </section>
        )}

        {standing === 'pending' && (
          <section className={styles.card}>
            <div className={`${styles.seal} ${styles.sealWait}`}><Clock size={22} /></div>
            <h1 className={styles.title}>Your application is in review.</h1>
            <p className={styles.body}>
              We’ve received <strong>{submittedName || 'your house'}</strong>{shortDate && <> · submitted {shortDate}</>}. A curator will read it, and you’ll see the rostrum button on the floor change the moment you’re cleared.
            </p>
            <p className={styles.fine}>Nothing to do now — the door opens from the inside.</p>
          </section>
        )}

        {(standing === 'none' || standing === 'rejected') && (
          <section className={styles.card}>
            <div className={`${styles.seal} ${standing === 'rejected' ? styles.sealNo : ''}`}>
              {standing === 'rejected' ? <AlertTriangle size={22} /> : <Landmark size={22} />}
            </div>
            <h1 className={styles.title}>{standing === 'rejected' ? 'Request the rostrum again.' : 'Request the rostrum.'}</h1>
            <p className={styles.body}>
              {standing === 'rejected'
                ? <>Your last application was declined{lastNote && <> — “{lastNote}”</>}. You may submit a new one below.</>
                : 'Any member can hang work. Hosting a live room is a separate trust: tell us who you are, and a curator reviews it.'}
            </p>

            <form onSubmit={handleSubmit} noValidate className={styles.form}>
              <div className={styles.field}>
                <label className={styles.label}>House name</label>
                <input className={`${styles.input} ${errors.houseName ? styles.inputBad : ''}`} value={houseName} onChange={e => setHouseName(e.target.value)} placeholder="Voss & Co." />
                {errors.houseName && <span className={styles.err}>{errors.houseName}</span>}
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Statement &amp; credentials</label>
                <textarea className={styles.textarea} rows={4} value={statement} onChange={e => setStatement(e.target.value)} placeholder="Who you are, what you’ve sold, why you should hold a floor." />
              </div>

              <div className={styles.row}>
                <div className={styles.field}>
                  <label className={styles.label}>License / Reg ID <span className={styles.opt}>optional</span></label>
                  <input className={styles.input} value={license} onChange={e => setLicense(e.target.value)} placeholder="Business licence #" />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Contact email <span className={styles.opt}>optional</span></label>
                  <input className={`${styles.input} ${errors.contactEmail ? styles.inputBad : ''}`} type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="desk@yourhouse.com" />
                  {errors.contactEmail && <span className={styles.err}>{errors.contactEmail}</span>}
                </div>
              </div>

              <button className={styles.primary} type="submit" disabled={submitting}>
                {submitting ? 'Sending…' : 'Send for review'}
              </button>
              {toast && <p className={styles.toast}>{toast}</p>}
            </form>
          </section>
        )}
      </div>
    </main>
  )
}