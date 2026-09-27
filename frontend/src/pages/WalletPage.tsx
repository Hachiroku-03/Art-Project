import { Navbar } from '../components/Navbar'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { WalletPanel } from '../components/WalletPanel'
import styles from './WalletPage.module.css'

export function WalletPage() {
  const viewer = localStorage.getItem('space_user') || ''
  // No hooks here at all — a pure shell. The panel owns its own (top-level) hooks,
  // and one boundary wraps the whole section (granularity rule: not per row).
  return (
    <main className={styles.layout}>
      <Navbar />
      <div className={styles.shell}>
        <ErrorBoundary fallback={<p className={styles.rest}>The wallet couldn’t be hung.</p>}>
          <WalletPanel viewer={viewer} />
        </ErrorBoundary>
      </div>
    </main>
  )
}