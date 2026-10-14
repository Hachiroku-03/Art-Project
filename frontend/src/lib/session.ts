// frontend/src/lib/session.ts

const EXPLICIT_USERNAME_KEYS = [
  'username',
  'viewer',
  'user_name',
  'userName',
  'space_username',
  'current_username',
  'currentUser',
  'user',
]

const IGNORE_KEY_RE =
  /token|password|passwd|auth|jwt|refresh|csrf|email|avatar|banner|language|settings|theme|storage/i

const USERNAME_KEY_RE = /user|username|handle|viewer|account/i

function cleanUsername(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}

function usernameFromJson(text: string): string {
  try {
    const parsed = JSON.parse(text)

    if (typeof parsed === 'string') return parsed.trim()

    if (Array.isArray(parsed)) {
      return cleanUsername(parsed[0])
    }

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      return cleanUsername(
        obj.username ??
          obj.user_name ??
          obj.userName ??
          obj.handle ??
          obj.name ??
          obj.viewer ??
          '',
      )
    }
  } catch {
    // not JSON
  }

  return ''
}

function looksLikeCredential(value: string): boolean {
  if (value.length < 32) return false

  // Common token shapes: hex, base64-ish, JWT segments.
  return (
    /^[a-f0-9]{32,}$/i.test(value) ||
    /^[a-zA-Z0-9._~+/-]+=*$/.test(value) ||
    value.split('.').length >= 3
  )
}

function readValue(raw: string | null): string {
  if (!raw) return ''

  const trimmed = raw.trim()
  if (!trimmed) return ''

  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
    const fromJson = usernameFromJson(trimmed)
    if (fromJson) return fromJson
  }

  const direct = cleanUsername(trimmed)
  if (direct && !looksLikeCredential(direct)) return direct

  return ''
}

function readStore(store: Storage): string {
  // 1. Explicit known keys.
  for (const key of EXPLICIT_USERNAME_KEYS) {
    const value = readValue(store.getItem(key))
    if (value) return value
  }

  // 2. Scan likely username-looking keys.
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i)
    if (!key) continue
    if (IGNORE_KEY_RE.test(key)) continue
    if (!USERNAME_KEY_RE.test(key)) continue

    const value = readValue(store.getItem(key))
    if (value) return value
  }

  return ''
}

export function getViewer(): string {
  if (typeof window === 'undefined') return ''

  try {
    return readStore(localStorage) || readStore(sessionStorage) || ''
  } catch {
    return ''
  }
}

export function setViewer(username: string): void {
  const value = cleanUsername(username)
  if (!value || typeof window === 'undefined') return

  try {
    localStorage.setItem('username', value)
    localStorage.setItem('viewer', value)
    localStorage.setItem('space_username', value)
  } catch {
    // storage may be blocked
  }
}

export function clearViewer(): void {
  if (typeof window === 'undefined') return

  try {
    localStorage.removeItem('username')
    localStorage.removeItem('viewer')
    localStorage.removeItem('space_username')
  } catch {
    // ignore
  }
}