import { useEffect, useRef, useState, type RefObject } from 'react'

const GSI_SRC = 'https://accounts.google.com/gsi/client'
const GSI_ID = 'gsi-client-script'

export type GoogleAuthResult = {
  token?: string
  username?: string
  role?: string
  tier?: string
  message?: string
  created?: boolean
  error?: string
}

// Minimal ambient shape for the slice of Google Identity Services we use.
type GsiIdApi = {
  initialize: (cfg: {
    client_id: string
    callback: (resp: { credential: string; select_by?: string }) => void
    ux_mode?: 'popup' | 'redirect'
    auto_select?: boolean
    cancel_on_tap_outside?: boolean
  }) => void
  renderButton: (
    parent: HTMLElement,
    opts?: {
      theme?: 'outline' | 'filled_blue' | 'filled_black'
      size?: 'large' | 'medium' | 'small'
      shape?: 'rectangular' | 'square' | 'pill' | 'circle'
      text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin'
      logo_alignment?: 'left' | 'center'
      width?: number | string
    },
  ) => void
  prompt: (listener?: (n: { isNotDisplayed?: boolean; isSkippedOrFinished?: boolean }) => void) => void
  cancel: () => void
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GsiIdApi } }
  }
}

let gsiLoad: Promise<void> | null = null

function loadGsi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  if (window.google?.accounts?.id) return Promise.resolve()
  if (gsiLoad) return gsiLoad

  gsiLoad = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(GSI_ID) as HTMLScriptElement | null
    if (existing) {
      // Tag present (e.g. pre-added in index.html) but global not ready yet.
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Google script failed to load')))
      return
    }
    const s = document.createElement('script')
    s.id = GSI_ID
    s.src = GSI_SRC
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => {
      gsiLoad = null
      reject(new Error('Google script failed to load'))
    }
    document.head.appendChild(s)
  })
  return gsiLoad
}

export function useGoogleAuth(opts: {
  apiBase: string
  onResult: (data: GoogleAuthResult, error: string | null) => void
}): {
  configured: boolean
  ready: boolean
  error: string | null
  btnRef: RefObject<HTMLDivElement | null>
  promptOneTap: () => void
} {
  const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() || ''
  const configured = !!clientId

  const btnRef = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Latest callbacks without re-running the init effect.
  const onResultRef = useRef(opts.onResult)
  onResultRef.current = opts.onResult
  const apiBaseRef = useRef(opts.apiBase)
  apiBaseRef.current = opts.apiBase

  useEffect(() => {
    if (!configured) return
    let cancelled = false

    async function postCredential(credential: string) {
      try {
        const res = await fetch(`${apiBaseRef.current}/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential }),
        })
        let data: GoogleAuthResult = {}
        try {
          data = await res.json()
        } catch {
          data = { error: 'The server returned an invalid response.' }
        }
        const err = res.ok && data.token ? null : data.error || 'Google sign-in failed.'
        onResultRef.current(data, err)
      } catch {
        onResultRef.current({}, 'The server is unreachable.')
      }
    }

    void loadGsi()
      .then(() => {
        if (cancelled) return
        const gsi = window.google?.accounts?.id
        if (!gsi) {
          setError('Google Identity Services unavailable')
          return
        }
        try {
          gsi.initialize({
            client_id: clientId,
            ux_mode: 'popup',
            auto_select: false,
            cancel_on_tap_outside: true,
            callback: (resp) => {
              void postCredential(resp.credential)
            },
          })
          if (btnRef.current) {
            btnRef.current.innerHTML = '' // StrictMode / re-init safe
            gsi.renderButton(btnRef.current, {
              theme: 'outline',
              size: 'large',
              shape: 'pill',
              text: 'continue_with',
              logo_alignment: 'left',
            })
          }
          setReady(true)
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Google init failed')
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Google script failed to load')
      })

    return () => {
      cancelled = true
    }
  }, [configured, clientId])

  // Optional: drive One Tap from a custom button (may be suppressed by the
  // browser / eligibility). The reliable path is the rendered slot above.
  function promptOneTap() {
    if (!ready) return
    try {
      window.google?.accounts?.id?.prompt()
    } catch {
      /* One Tap unavailable or suppressed */
    }
  }

  return { configured, ready, error, btnRef, promptOneTap }
}