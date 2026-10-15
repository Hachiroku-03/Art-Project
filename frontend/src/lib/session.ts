// frontend/src/lib/session.ts

const TOKEN_KEYS = [
  'space_token',
  'token',
  'auth_token',
  'accessToken',
  'access_token',
]

const USERNAME_KEYS = [
  'username',
  'viewer',
  'user_name',
  'userName',
  'space_username',
  'space_user',
  'current_username',
  'currentUser',
  'user',
]

const ROLE_KEYS = [
  'role',
  'user_role',
  'space_role',
  'current_role',
]

const TIER_KEYS = [
  'tier',
  'user_tier',
  'space_tier',
  'current_tier',
  'subscription_tier',
]

const USERNAME_SCAN_RE = /user|username|handle|viewer|account/i
const ROLE_SCAN_RE = /role/i
const TIER_SCAN_RE = /tier|subscription/i

const COMMON_IGNORE_SOURCE =
  'token|password|passwd|auth|jwt|refresh|csrf|secret|key|email|avatar|banner|language|settings|theme|storage'

const USERNAME_IGNORE_RE = new RegExp(
  `${COMMON_IGNORE_SOURCE}|role|tier|permission|scope`,
  'i',
)

const ROLE_IGNORE_RE = new RegExp(
  `${COMMON_IGNORE_SOURCE}|username|viewer|handle|account`,
  'i',
)

const TIER_IGNORE_RE = new RegExp(
  `${COMMON_IGNORE_SOURCE}|username|viewer|handle|account|role`,
  'i',
)

export type SessionData = {
  token?: string
  username?: string
  role?: string
  tier?: string
}

function cleanString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}

function usernameFromJson(text: string): string {
  try {
    const parsed = JSON.parse(text)

    if (typeof parsed === 'string') return parsed.trim()

    if (Array.isArray(parsed)) {
      return cleanString(parsed[0])
    }

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      return cleanString(
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

function readValue(raw: string | null, allowCredential = false): string {
  if (!raw) return ''

  const trimmed = raw.trim()
  if (!trimmed) return ''

  // If the stored value is JSON, try to extract a username from it.
  // Do not fall back to returning the raw JSON string, because that can
  // accidentally turn an object like { role: "house" } into a fake username.
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
    return usernameFromJson(trimmed)
  }

  const direct = cleanString(trimmed)
  if (!direct) return ''

  // For username/role/tier reads, reject values that look like tokens.
  // For token reads, allowCredential=true.
  if (!allowCredential && looksLikeCredential(direct)) return ''

  return direct
}

function safeStores(): Storage[] {
  const out: Storage[] = []

  try {
    out.push(localStorage)
  } catch {
    // ignore
  }

  try {
    out.push(sessionStorage)
  } catch {
    // ignore
  }

  return out
}

function readKeys(keys: string[], allowCredential = false): string {
  for (const store of safeStores()) {
    for (const key of keys) {
      try {
        const value = readValue(store.getItem(key), allowCredential)
        if (value) return value
      } catch {
        // ignore
      }
    }
  }

  return ''
}

function scanStores(matcher: RegExp, ignore: RegExp): string {
  for (const store of safeStores()) {
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)
        if (!key) continue
        if (ignore.test(key)) continue
        if (!matcher.test(key)) continue

        const value = readValue(store.getItem(key), false)
        if (value) return value
      }
    } catch {
      // ignore
    }
  }

  return ''
}

function getUserObject(): Record<string, unknown> {
  for (const store of safeStores()) {
    try {
      const raw = store.getItem('user')
      if (!raw) continue

      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // ignore
    }
  }

  return {}
}

function setUserObject(patch: Record<string, unknown>): void {
  try {
    const current = getUserObject()
    const next = { ...current, ...patch }
    localStorage.setItem('user', JSON.stringify(next))
  } catch {
    // ignore
  }
}

function setKeys(keys: string[], value: string): void {
  if (!value) return

  try {
    for (const key of keys) {
      localStorage.setItem(key, value)
    }
  } catch {
    // ignore
  }
}

function removeKeys(keys: string[]): void {
  for (const store of safeStores()) {
    try {
      for (const key of keys) {
        store.removeItem(key)
      }
    } catch {
      // ignore
    }
  }
}

export function setViewer(username: string): void {
  const value = cleanString(username)
  if (!value || typeof window === 'undefined') return

  setKeys(USERNAME_KEYS, value)

  try {
    localStorage.setItem('space_user', value)
  } catch {
    // ignore
  }

  setUserObject({ username: value })
}

export function setRole(role: string): void {
  const value = cleanString(role)
  if (!value || typeof window === 'undefined') return

  setKeys(ROLE_KEYS, value)

  try {
    localStorage.setItem('space_role', value)
  } catch {
    // ignore
  }

  setUserObject({ role: value })
}

export function setTier(tier: string): void {
  const value = cleanString(tier)
  if (!value || typeof window === 'undefined') return

  setKeys(TIER_KEYS, value)

  try {
    localStorage.setItem('space_tier', value)
  } catch {
    // ignore
  }

  setUserObject({ tier: value })
}

export function setSession(data: SessionData): void {
  if (typeof window === 'undefined') return

  const token = cleanString(data.token)
  const username = cleanString(data.username)
  const role = cleanString(data.role)
  const tier = cleanString(data.tier)

  if (token) setKeys(TOKEN_KEYS, token)
  if (username) setViewer(username)
  if (role) setRole(role)
  if (tier) setTier(tier)
}

export function getToken(): string {
  if (typeof window === 'undefined') return ''
  return readKeys(TOKEN_KEYS, true)
}

export function getViewer(): string {
  if (typeof window === 'undefined') return ''

  const explicit = readKeys(USERNAME_KEYS, false)
  if (explicit) return explicit

  const user = getUserObject()
  const fromUser = cleanString(
    user.username ??
      user.user_name ??
      user.userName ??
      user.handle ??
      user.name ??
      user.viewer ??
      '',
  )

  if (fromUser && !looksLikeCredential(fromUser)) return fromUser

  return scanStores(USERNAME_SCAN_RE, USERNAME_IGNORE_RE)
}

export function getRole(): string {
  if (typeof window === 'undefined') return ''

  const explicit = readKeys(ROLE_KEYS, false)
  if (explicit) return explicit

  const user = getUserObject()
  const fromUser = cleanString(user.role ?? '')
  if (fromUser) return fromUser

  return scanStores(ROLE_SCAN_RE, ROLE_IGNORE_RE)
}

export function getTier(): string {
  if (typeof window === 'undefined') return ''

  const explicit = readKeys(TIER_KEYS, false)
  if (explicit) return explicit

  const user = getUserObject()
  const fromUser = cleanString(user.tier ?? user.subscription_tier ?? '')
  if (fromUser) return fromUser

  return scanStores(TIER_SCAN_RE, TIER_IGNORE_RE)
}

export function isHouse(): boolean {
  return getRole().trim().toLowerCase() === 'house'
}

export function isVip(): boolean {
  return getTier().trim().toLowerCase() === 'vip'
}

export function isLoggedIn(): boolean {
  return Boolean(getToken() && getViewer())
}

export function clearViewer(): void {
  if (typeof window === 'undefined') return
  removeKeys(USERNAME_KEYS)
  removeKeys(['user', 'space_user'])
}

export function clearSession(): void {
  if (typeof window === 'undefined') return

  removeKeys([
    ...TOKEN_KEYS,
    ...USERNAME_KEYS,
    ...ROLE_KEYS,
    ...TIER_KEYS,
    'user',
    'space_user',
    'space_role',
    'space_tier',
  ])
}

export function logout(): void {
  clearSession()
}