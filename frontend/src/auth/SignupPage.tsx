import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './SignupPage.module.css'
import { ThreeBackground } from './ThreeBackground'

const API = 'http://localhost:8000'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function SignupPage() {
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [discipline, setDiscipline] = useState('painting')

  const [toast, setToast] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setToast('')

    if (!email || !fullName || !username || !password) {
      setToast('All fields are required.')
      return
    }
    if (!EMAIL_REGEX.test(email)) {
      setToast('Please enter a valid email address.')
      return
    }
    if (password.length < 8) {
      setToast('Password must be at least 8 characters.')
      return
    }
    if (username.length < 3) {
      setToast('Username must be at least 3 characters.')
      return
    }

    setLoading(true)

    // Capture browser language for real-time translation
    const language = (navigator.language || 'en').slice(0, 2)
    const extra = { discipline }  // no role, no license — those moved to the house application

    try {
      const res = await fetch(`${API}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, fullName, username, password, extra, language }),
      })
      const data = await res.json()

      if (res.ok) {
        navigate('/login')
      } else {
        setToast(data.error || 'Signup failed.')
      }
    } catch {
      setToast('Server unreachable.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className={styles.shell}>
      <ThreeBackground />

      <section className={styles.card}>
        <h1 className={styles.wordmark}>Join The Space</h1>
        <p className={styles.tagline}>Every member hangs work. Earn the rostrum later.</p>

        <form onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label className={styles.label}>Email</label>
            <div className={styles.inputBox}>
              <input className={styles.input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Full Name</label>
            <div className={styles.inputBox}>
              <input className={styles.input} type="text" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Your real name" />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Username</label>
            <div className={styles.inputBox}>
              <input className={styles.input} type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="your_handle" />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Password</label>
            <div className={styles.inputBox}>
              <input className={styles.input} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="min 8 characters" />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Primary Discipline</label>
            <div className={styles.inputBox}>
              <select className={styles.input} value={discipline} onChange={e => setDiscipline(e.target.value)}>
                <option value="painting">Painting</option>
                <option value="sculpture">Sculpture</option>
                <option value="digital">Digital</option>
                <option value="photography">Photography</option>
              </select>
            </div>
          </div>

          <button className={styles.submitBtn} type="submit" disabled={loading}>
            {loading ? 'Creating Account...' : 'Create Account'}
          </button>
        </form>

        <p className={styles.footerLine}>
          Already have an account?{' '}
          <a className={styles.loginLink} href="/login">Log in</a>
        </p>

        {toast && <p className={`${styles.toast} ${styles.errorText}`}>{toast}</p>}
      </section>
    </main>
  )
}