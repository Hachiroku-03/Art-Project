import { useEffect, useState } from 'react'
import styles from './Preloader.module.css'

type PreloaderProps = { done: boolean }

export function Preloader({ done }: PreloaderProps) {
  const [minTimePassed, setMinTimePassed] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    // REDUCED: Changed from 1400ms to 600ms for a snappier feel
    const t = setTimeout(() => setMinTimePassed(true), 600) 
    return () => clearTimeout(t)
  }, [])

  const ready = done && minTimePassed

  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => setGone(true), 900)
    return () => clearTimeout(t)
  }, [ready])

  if (gone) return null

  return (
    <div className={`${styles.veil} ${ready ? styles.veilLift : ''}`} aria-hidden="true">
      <div className={styles.mark}>
        <span className={styles.line} />
        <h1 className={styles.word}>THE SPACE</h1>
        <span className={`${styles.line} ${styles.lineBottom}`} />
      </div>
    </div>
  )
}