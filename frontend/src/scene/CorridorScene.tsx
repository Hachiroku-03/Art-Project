import { Suspense, useMemo, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Preload, Sparkles } from '@react-three/drei'
import { Painting } from './Painting'
import { WORKS, X, LAST_X } from './works'
import { damp, lerp, reducedMotion } from '../lib/motion'

function Rig({ prog }: { prog: MutableRefObject<{ p: number }> }) {
  const { camera, size } = useThree()
  const look = useMemo(() => new THREE.Vector3(), [])
  const cur = useRef({ x: 0, z: 5.4 })
  const rm = reducedMotion()
  useFrame((_, dt) => {
    const wide = size.width > 760
    const p = prog.current.p
    const bow = Math.sin(p * Math.PI)
    const tx = lerp(0, LAST_X, p)
    const tz = (wide ? 1 : 1.7) * lerp(5.8, 7.0, bow)
    const L = rm ? 30 : 7
    const c = cur.current
    c.x = damp(c.x, tx, L, dt)
    c.z = damp(c.z, tz, L, dt)
    camera.position.set(c.x, 0.1, c.z)
    look.set(c.x + lerp(0, 1.2, bow), 0.1, 0)
    camera.lookAt(look)
  })
  return null
}

function Room({ prog }: { prog: MutableRefObject<{ p: number }> }) {
  const len = LAST_X + 16
  return (
    <>
      <color attach="background" args={['#0a0a0a']} />
      <fog attach="fog" args={['#0a0a0a', 9, 20]} />
      <ambientLight intensity={0.2} />
      <hemisphereLight args={['#2a2420', '#050505', 0.25]} />
      <mesh position={[len / 2 - 8, 0, -0.01]}>
        <planeGeometry args={[len + 16, 12]} />
        <meshStandardMaterial color="#141210" roughness={0.98} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[len / 2 - 8, -2.4, 4]}>
        <planeGeometry args={[len + 16, 14]} />
        <meshStandardMaterial color="#0c0b0a" roughness={0.45} metalness={0.15} />
      </mesh>
      <mesh position={[len / 2 - 8, -2.32, 0.03]}>
        <boxGeometry args={[len + 16, 0.16, 0.06]} />
        <meshStandardMaterial color="#1c1916" roughness={0.7} />
      </mesh>
      {WORKS.map((w, i) => <Painting key={w.src} work={w} position={[X[i], 0, 0]} spot={16} />)}
      {!reducedMotion() && (
        <Sparkles count={140} scale={[len + 8, 6, 6]} position={[len / 2 - 8, 0, 2.5]} size={1.6} speed={0.25} opacity={0.3} color="#ffe6c4" />
      )}
      <Rig prog={prog} />
      <Preload all />
    </>
  )
}

/** Seven works on one long wall. `prog.current.p` (0..1) walks the camera left→right. */
export function CorridorScene({ prog }: { prog: MutableRefObject<{ p: number }> }) {
  const mobile = typeof window !== 'undefined' && window.innerWidth < 760
  return (
    <Canvas
      dpr={mobile ? [1, 1.5] : [1, 1.75]}
      camera={{ fov: 42, near: 0.1, far: 60, position: [0, 0.1, 5.4] }}
      gl={{ antialias: true, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <Suspense fallback={null}>
        <Room prog={prog} />
      </Suspense>
    </Canvas>
  )
}
