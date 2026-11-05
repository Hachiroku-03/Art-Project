/**
 * Single source of truth for backend origins.
 *
 * Local dev (no env set) -> localhost, so `npm run dev` works unchanged.
 * Render / prod          -> the VITE_* build env vars, inlined by Vite at BUILD time.
 *
 * Why the guard in pickEnv: an unset import.meta.env.VITE_X is `undefined`, and
 * `undefined.trim()` is a TypeError that would white-screen the whole static build
 * the moment this module is imported. So we type-check before touching it. The
 * trailing-slash strip is so `${AUTH_API}/login` can never become `http://x//login`
 * (your routes are /login, not //login — a double slash is a 404 waiting to happen).
 */
function pickEnv(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim().replace(/\/$/, '')
  }
  return fallback
}

export const AUTH_API = pickEnv(import.meta.env.VITE_AUTH_API, 'http://localhost:8000')
export const FEED_API = pickEnv(import.meta.env.VITE_FEED_API, 'http://localhost:8001')
export const TRANSLATE_API = pickEnv(import.meta.env.VITE_TRANSLATE_API, 'http://localhost:8002')