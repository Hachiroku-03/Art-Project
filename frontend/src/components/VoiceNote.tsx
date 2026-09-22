import { useState, useRef, useMemo } from 'react'
import { Play, Pause } from 'lucide-react'
import styles from './VoiceNote.module.css'

const BAR_COUNT = 26

// Deterministic bars from the comment id → every note looks unique but stable across renders.
function makeBars(seed: number, count: number) {
  const out: number[] = []
  let x = (seed * 2654435761) >>> 0
  for (let i = 0; i < count; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    const r = (x >>> 8) / 16777216
    out.push(0.22 + r * 0.78)
  }
  return out
}

function fmt(s: number) {
  if (!isFinite(s) || s < 0) return '–:––'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60).toString().padStart(2, '0')
  return `${m}:${sec}`
}

type Props = { src: string; seed?: number }

export function VoiceNote({ src, seed = 1 }: Props) {
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)

  const bars = useMemo(() => makeBars(seed, BAR_COUNT), [seed])
  const progress = duration > 0 && isFinite(duration) ? current / duration : 0

  function togglePlay() {
    const a = audioRef.current
    if (!a) return
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }

  function handleSeek(e: React.MouseEvent<HTMLDivElement>) {
    const a = audioRef.current
    if (!a || !(duration > 0) || !isFinite(duration)) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    a.currentTime = frac * duration
  }

  // Some webm recordings report duration = Infinity until forced; resolve it once, quietly.
  function onLoadedMetadata() {
    const a = audioRef.current
    if (!a) return
    const d = a.duration
    if (!isFinite(d) || Number.isNaN(d)) {
      const fix = () => {
        a.removeEventListener('timeupdate', fix)
        a.currentTime = 0
        setDuration(a.duration)
      }
      a.addEventListener('timeupdate', fix)
      a.currentTime = 1e101
    } else {
      setDuration(d)
    }
  }

  return (
    <div className={styles.bubble}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={e => setCurrent((e.target as HTMLAudioElement).currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrent(0) }}
      />

      <button type="button" className={styles.playBtn} onClick={togglePlay} aria-label={playing ? 'Pause voice note' : 'Play voice note'}>
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>

      <div className={styles.wave} onClick={handleSeek} role="slider" aria-label="Seek" aria-valuenow={Math.round(progress * 100)}>
        {bars.map((h, i) => (
          <span
            key={i}
            className={`${styles.bar} ${i / bars.length <= progress ? styles.barPlayed : ''}`}
            style={{ height: `${h * 100}%` }}
          />
        ))}
      </div>

      <span className={styles.time}>{progress > 0 ? fmt(current) : fmt(duration)}</span>
    </div>
  )
}