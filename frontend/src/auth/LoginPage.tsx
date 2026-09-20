import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, ScanFace, ArrowRight } from 'lucide-react'
import styles from './LoginPage.module.css'
import { ThreeBackground } from './ThreeBackground'

const API = 'http://localhost:8000'

type FieldErrors = { identifier?: string; password?: string }
type Toast = { kind: 'ok' | 'err' | 'note'; message: string }

function GoogleIcon() {
  return (
    <svg className={styles.googleIcon} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.17 3.57-8.81Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28V6.63H1.29a11.99 11.99 0 0 0 0 10.74l3.98-3.09Z" />
      <path fill="#EA4335" d="M12 4.76c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A11.99 11.99 0 0 0 1.29 6.63l3.98 3.09C6.22 6.87 8.87 4.76 12 4.76Z" />
    </svg>
  )
}

export function LoginPage() {
  const navigate = useNavigate()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [toast, setToast] = useState<Toast>({ kind: 'note', message: '' })
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()

    const nextErrors: FieldErrors = {}
    if (identifier.trim().length < 3) nextErrors.identifier = 'Enter your username or email.'
    if (password.length < 8) nextErrors.password = 'At least 8 characters.'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    setLoading(true)
    try {
      const response = await fetch(`${API}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: identifier, password }),
      })
      const data = await response.json()
      if (response.ok && data.token) {
        localStorage.setItem('space_token', data.token)
        localStorage.setItem('space_user', data.username)
        localStorage.setItem('space_role', data.role)
        localStorage.setItem('space_tier', data.tier)
        setToast({ kind: 'ok', message: `Welcome back, ${data.username}.` })
        
        // Redirect to feed after successful login
        setTimeout(() => navigate('/feed'), 1500)
      } else {
        setToast({ kind: 'err', message: data.error ?? 'Login failed.' })
      }
    } catch {
      setToast({ kind: 'err', message: 'The server is unreachable.' })
    } finally {
      setLoading(false)
    }
  }

  const toastClass =
    toast.kind === 'ok' ? styles.toastOk : toast.kind === 'err' ? styles.toastErr : styles.toastNote

  return (
    <main className={styles.shell}>
      <ThreeBackground />

      <section className={styles.formCard}>
        <h1 className={styles.wordmark}>The Space</h1>
        <p className={styles.tagline}>Contemporary Art Auctions</p>

        <form onSubmit={handleSubmit} noValidate>
          <div className={styles.field}>
            <span className={styles.label}>Username or Email</span>
            <div className={`${styles.inputBox} ${errors.identifier ? styles.inputBoxInvalid : ''}`}>
              <input
                className={styles.input}
                type="text"
                value={identifier}
                autoComplete="username"
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="handle or email@example.com"
              />
            </div>
            {errors.identifier && <span className={styles.errorText}>{errors.identifier}</span>}
          </div>

          <div className={styles.field}>
            <div className={styles.labelRow}>
              <span className={styles.label}>Password</span>
              <a className={styles.miniLink} href="/forgot">Forgot password?</a>
            </div>
            <div className={`${styles.inputBox} ${errors.password ? styles.inputBoxInvalid : ''}`}>
              <input
                className={styles.input}
                type={showPassword ? 'text' : 'password'}
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
              <button
                type="button"
                className={styles.eyeBtn}
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {errors.password && <span className={styles.errorText}>{errors.password}</span>}
          </div>

          <button className={styles.submitBtn} type="submit" disabled={loading}>
            {loading ? 'Entering…' : 'Enter the Space'}
            {!loading && <ArrowRight size={18} />}
          </button>
        </form>

        <div className={styles.divider}><span>or</span></div>

        <button
          className={styles.googleBtn}
          type="button"
          onClick={() => setToast({ kind: 'note', message: 'Google sign-in arrives after OAuth setup.' })}
        >
          <GoogleIcon />
          Continue with Google
        </button>

        <button
          className={styles.faceBtn}
          type="button"
          onClick={() => setToast({ kind: 'note', message: 'Face login arrives with the camera module.' })}
        >
          <ScanFace size={18} />
          Scan Face to Enter
        </button>

        <p className={styles.footerLine}>
          New to The Space?{' '}
          <a className={styles.createLink} href="/signup">Create an account</a>
        </p>

        <p className={`${styles.toast} ${toastClass}`} role="status">{toast.message}</p>
      </section>
    </main>
  )
}