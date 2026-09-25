import { Component, type ReactNode } from 'react'

type Props = { children: ReactNode; fallback?: ReactNode }
type State = { hasError: boolean }

// Class component by necessity: the React docs are explicit that Hooks
// are not supported inside classes. getDerivedStateFromError + componentDidCatch
// is the canonical Error-Boundary pair.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown, info: { componentStack?: string }) {
    console.error('A section failed to render:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'var(--font-label)', fontStyle: 'italic', color: 'var(--ink-soft)' }}>
          This section couldn’t be hung.
        </div>
      )
    }
    return this.props.children
  }
}