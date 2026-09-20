import { useState, useRef, useEffect } from 'react'
import { Mic, Pause, Play, Trash2, Lock, LockOpen, Send, Square } from 'lucide-react'
import styles from './VoiceRecorder.module.css'

type Phase = 'idle' | 'recording' | 'paused' | 'preview'

const BAR_COUNT = 28

export function VoiceRecorder({ onSend }: { onSend: (audioBlob: Blob) => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [locked, setLocked] = useState(false)
  const [duration, setDuration] = useState(0)
  const [bars, setBars] = useState<number[]>(Array(BAR_COUNT).fill(4))
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewPlaying, setPreviewPlaying] = useState(false)

  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef(0)
  const timerRef = useRef<number | undefined>(undefined)
  const barsRef = useRef<number[]>(Array(BAR_COUNT).fill(4))
  const startYRef = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const blobRef = useRef<Blob | null>(null)

  useEffect(() => () => {
    if (timerRef.current) window.clearInterval(timerRef.current)
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    ctxRef.current?.close()
  }, [])

  function startTimer() {
    timerRef.current = window.setInterval(() => setDuration(d => d + 1), 1000)
  }
  function stopTimer() {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = undefined }
  }

  // Live waveform: read mic amplitude every frame
  function drawLoop() {
    const an = analyserRef.current
    if (an) {
      const data = new Uint8Array(an.fftSize)
      an.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v }
      const rms = Math.sqrt(sum / data.length)
      const h = Math.min(28, 4 + rms * 110)
      barsRef.current = [...barsRef.current.slice(1), h]
      setBars(barsRef.current)
    }
    rafRef.current = requestAnimationFrame(drawLoop)
  }

  async function startRecording(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault()
    startYRef.current = 'touches' in e ? e.touches[0].clientY : e.clientY
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const ctx = new AudioContext()
      ctxRef.current = ctx
      const an = ctx.createAnalyser()
      an.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(an)
      analyserRef.current = an

      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = ev => { if (ev.data.size > 0) chunksRef.current.push(ev.data) }
      rec.onstop = () => {
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = null
        cancelAnimationFrame(rafRef.current)
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        blobRef.current = blob
        if (blob.size > 0) {
          setPreviewUrl(URL.createObjectURL(blob))
          setPhase('preview')
        } else {
          resetAll()
        }
      }
      rec.start()
      recRef.current = rec
      barsRef.current = Array(BAR_COUNT).fill(4)
      setBars(barsRef.current)
      setDuration(0)
      setLocked(false)
      setPhase('recording')
      startTimer()
      rafRef.current = requestAnimationFrame(drawLoop)
    } catch { /* mic denied */ }
  }

  function pauseRec() {
    recRef.current?.pause()
    stopTimer()
    cancelAnimationFrame(rafRef.current)
    setPhase('paused')
  }

  function resumeRec() {
    recRef.current?.resume()
    startTimer()
    rafRef.current = requestAnimationFrame(drawLoop)
    setPhase('recording')
  }

  function stopToPreview() {
    stopTimer()
    const rec = recRef.current
    if (rec && rec.state !== 'inactive') rec.stop() // onstop opens the preview
    else resetAll()
  }

  function trashIt() {
    stopTimer()
    cancelAnimationFrame(rafRef.current)
    const rec = recRef.current
    if (rec && rec.state !== 'inactive') {
      rec.onstop = () => {
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
      rec.stop()
    } else {
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    resetAll()
  }

  function resetAll() {
    setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    setPreviewPlaying(false)
    setPhase('idle')
    setLocked(false)
    setDuration(0)
    barsRef.current = Array(BAR_COUNT).fill(4)
    setBars(barsRef.current)
    blobRef.current = null
  }

  function sendIt() {
    if (blobRef.current) onSend(blobRef.current)
    resetAll()
  }

  // Release (unlocked) goes to PREVIEW — never auto-sends
  useEffect(() => {
    if (phase !== 'recording' || locked) return
    const up = () => stopToPreview()
    window.addEventListener('mouseup', up)
    window.addEventListener('touchend', up)
    return () => { window.removeEventListener('mouseup', up); window.removeEventListener('touchend', up) }
  }, [phase, locked])

  // Slide up 80px to lock hands-free
  useEffect(() => {
    if (phase !== 'recording' || locked) return
    const move = (e: MouseEvent | TouchEvent) => {
      const y = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY
      if (startYRef.current - y > 80) setLocked(true)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('touchmove', move)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('touchmove', move) }
  }, [phase, locked])

  function togglePreview() {
    const el = audioRef.current
    if (!el) return
    if (previewPlaying) { el.pause(); setPreviewPlaying(false) }
    else { el.play(); setPreviewPlaying(true) }
  }

  function fmt(s: number) { return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}` }

  if (phase === 'idle') {
    return (
      <button type="button" className={styles.recordBtn} onMouseDown={startRecording} onTouchStart={startRecording} aria-label="Record voice comment">
        <Mic size={18} />
      </button>
    )
  }

  if (phase === 'preview') {
    return (
      <div className={styles.panel}>
        <audio ref={audioRef} src={previewUrl ?? undefined} onEnded={() => setPreviewPlaying(false)} />
        <button type="button" className={styles.ctrlBtn} onClick={togglePreview} aria-label="Play or pause preview">
          {previewPlaying ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <div className={`${styles.wave} ${styles.wavePreview}`}>
          {bars.map((h, i) => <span key={i} style={{ height: `${h}px` }} />)}
        </div>
        <span className={styles.timer}>{fmt(duration)}</span>
        <button type="button" className={`${styles.ctrlBtn} ${styles.danger}`} onClick={trashIt} aria-label="Discard recording">
          <Trash2 size={15} />
        </button>
        <button type="button" className={styles.sendBtn} onClick={sendIt} aria-label="Send voice comment">
          <Send size={15} />
        </button>
      </div>
    )
  }

  // recording / paused
  return (
    <div className={styles.panel}>
      <span className={styles.pulse} />
      <span className={styles.timer}>{fmt(duration)}</span>
      <div className={styles.wave}>
        {bars.map((h, i) => <span key={i} style={{ height: `${h}px` }} />)}
      </div>
      <button type="button" className={styles.ctrlBtn} onClick={() => setLocked(l => !l)} aria-label="Lock recording">
        {locked ? <Lock size={15} /> : <LockOpen size={15} />}
      </button>
      <button type="button" className={styles.ctrlBtn} onClick={phase === 'recording' ? pauseRec : resumeRec} aria-label="Pause or resume">
        {phase === 'recording' ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <button type="button" className={`${styles.ctrlBtn} ${styles.danger}`} onClick={trashIt} aria-label="Discard recording">
        <Trash2 size={15} />
      </button>
      <button type="button" className={styles.ctrlBtn} onClick={stopToPreview} aria-label="Stop and preview">
        <Square size={15} />
      </button>
      {!locked && <p className={styles.hint}>release to preview · slide up to lock</p>}
    </div>
  )
}