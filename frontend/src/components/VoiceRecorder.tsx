import { useState, useRef, useEffect } from 'react'
import { Mic, Pause, Play, Trash2, Send, Square } from 'lucide-react'
import styles from './VoiceRecorder.module.css'

type Phase = 'idle' | 'recording' | 'paused' | 'preview'

const BAR_COUNT = 48 // clipped gracefully on narrow screens via overflow

export function VoiceRecorder({ onSend }: { onSend: (audioBlob: Blob) => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [duration, setDuration] = useState(0)
  const [bars, setBars] = useState<number[]>(Array(BAR_COUNT).fill(3))
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewPlaying, setPreviewPlaying] = useState(false)

  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef(0)
  const timerRef = useRef<number | undefined>(undefined)
  const barsRef = useRef<number[]>(Array(BAR_COUNT).fill(3))
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const blobRef = useRef<Blob | null>(null)

  // One central teardown — EVERY exit path calls this so the mic never leaks.
  function teardown() {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = undefined }
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (ctxRef.current && ctxRef.current.state !== 'closed') ctxRef.current.close().catch(() => {})
    ctxRef.current = null
    analyserRef.current = null
  }

  // Safety net: if the component unmounts mid-recording, kill the mic.
  useEffect(() => teardown, [])

  function startTimer() {
    timerRef.current = window.setInterval(() => setDuration(d => d + 1), 1000)
  }
  function stopTimer() {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = undefined }
  }

  function drawLoop() {
    const an = analyserRef.current
    if (an) {
      const data = new Uint8Array(an.fftSize)
      an.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v }
      const rms = Math.sqrt(sum / data.length)
      const h = Math.min(34, 3 + rms * 130)
      barsRef.current = [...barsRef.current.slice(1), h]
      setBars(barsRef.current)
    }
    rafRef.current = requestAnimationFrame(drawLoop)
  }

  async function startRecording() {
    if (phase !== 'idle') return
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
      // The handler that builds the preview the moment we stop.
      rec.onstop = () => {
        teardown()
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        chunksRef.current = []
        if (blob.size > 0) {
          blobRef.current = blob
          setPreviewUrl(URL.createObjectURL(blob))
          setPhase('preview')
        } else {
          resetAll()
        }
      }
      rec.start()
      recRef.current = rec
      barsRef.current = Array(BAR_COUNT).fill(3)
      setBars(barsRef.current)
      setDuration(0)
      setPhase('recording')
      startTimer()
      rafRef.current = requestAnimationFrame(drawLoop)
    } catch {
      teardown()
      resetAll()
    }
  }

  function pauseRec() {
    const rec = recRef.current
    if (rec && rec.state === 'recording') { try { rec.pause() } catch { /* unsupported (Safari) */ } }
    stopTimer()
    cancelAnimationFrame(rafRef.current)
    setPhase('paused')
  }

  function resumeRec() {
    const rec = recRef.current
    if (rec && rec.state === 'paused') { try { rec.resume() } catch { /* unsupported */ } }
    startTimer()
    rafRef.current = requestAnimationFrame(drawLoop)
    setPhase('recording')
  }

  function stopToPreview() {
    stopTimer()
    const rec = recRef.current
    if (rec && rec.state !== 'inactive') rec.stop() // onstop → preview
    else resetAll()
  }

  function trashIt() {
    stopTimer()
    const rec = recRef.current
    if (rec && rec.state !== 'inactive') {
      rec.onstop = () => teardown() // discard: don't build a preview
      rec.stop()
    } else {
      teardown()
    }
    resetAll()
  }

  function resetAll() {
    setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    setPreviewPlaying(false)
    setPhase('idle')
    setDuration(0)
    barsRef.current = Array(BAR_COUNT).fill(3)
    setBars(barsRef.current)
    blobRef.current = null
  }

  function sendIt() {
    const blob = blobRef.current
    teardown()
    resetAll()
    if (blob) onSend(blob)
  }

  function togglePreview() {
    const el = audioRef.current
    if (!el) return
    if (previewPlaying) { el.pause(); setPreviewPlaying(false) }
    else { el.play(); setPreviewPlaying(true) }
  }

  function fmt(s: number) { return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}` }

  if (phase === 'idle') {
    return (
      <button type="button" className={styles.recordBtn} onClick={startRecording} aria-label="Record voice comment">
        <Mic size={18} />
      </button>
    )
  }

  if (phase === 'preview') {
    return (
      <div className={styles.panel}>
        <audio ref={audioRef} src={previewUrl ?? undefined} onEnded={() => setPreviewPlaying(false)} />
        <button type="button" className={styles.playBtn} onClick={togglePreview} aria-label="Play or pause preview">
          {previewPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <div className={styles.wave}>
          {bars.map((h, i) => <span key={i} style={{ height: `${h}px` }} />)}
        </div>
        <span className={styles.timer}>{fmt(duration)}</span>
        <button type="button" className={`${styles.ctrlBtn} ${styles.danger}`} onClick={trashIt} aria-label="Discard recording">
          <Trash2 size={16} />
        </button>
        <button type="button" className={styles.sendBtn} onClick={sendIt} aria-label="Send voice comment">
          <Send size={16} />
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
      <button type="button" className={styles.ctrlBtn} onClick={phase === 'recording' ? pauseRec : resumeRec} aria-label="Pause or resume">
        {phase === 'recording' ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <button type="button" className={`${styles.ctrlBtn} ${styles.danger}`} onClick={trashIt} aria-label="Discard recording">
        <Trash2 size={16} />
      </button>
      <button type="button" className={styles.stopBtn} onClick={stopToPreview} aria-label="Stop and preview">
        <Square size={16} />
      </button>
    </div>
  )
}