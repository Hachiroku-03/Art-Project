import { useState, useEffect } from 'react'

// One interval, cleaned up in the effect's return so Strict Mode's
// mount → unmount → mount can never leave a doubled timer running.
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}