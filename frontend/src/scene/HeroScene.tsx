import { Suspense, useMemo, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Preload } from '@react-three/drei'
import { Painting } from './Painting'
import { WORKS } from './works'
import { damp, lerp, smooth, reducedMotion } from '../lib/motion'

export type Progress = { p: number; mx: number; my: number }

const HERO = WORKS[0]

function Rig({ prog }: { prog: MutableRefObject<Progress> }) {
  const { camera, size } = useThree()
  const look = useMemo(() => new THREE.Vector3(), [])
  const cur = useRef({ x: 0, z: 5.6, tx: 0, ty: 0 })
  const rm = reducedMotion()

  useFrame((_, dt) => {
    const wide = size.width > 760
    const { p, mx, my } = prog.current
    const k = smooth(p)
    const OFF = wide ? -1.35 : 0                 // work right of centre on desktop
    const c = cur.current
    const L = rm ? 30 : 6
    c.x = damp(c.x, OFF, L, dt)
    c.z = damp(c.z, lerp(wide ? 5.8 : 9.6, wide ? 5.0 : 8.2, k), L, dt)
    const cy = wide ? 0.1 : -1.15                // phones: the work sits above the copy
    camera.position.set(c.x, cy, c.z)
    look.set(OFF, cy, 0)
    camera.lookAt(look)
    // cursor tilt
    c.tx = damp(c.tx, rm ? 0 : -my * 0.05, 5, dt)
    c.ty = damp(c.ty, rm ? 0 : mx * 0.08, 5, dt)
    const g = (camera.parent?.getObjectByName('hero') as THREE.Group | undefined)
    if (g) g.rotation.set(c.tx, c.ty, 0)
  })
  return null
}

function Room({ prog }: { prog: MutableRefObject<Progress> }) {
  const hero = useRef<THREE.Group>(null!)
  return (
    <>
      <color attach="background" args={['#0a0a0a']} />
      <fog attach="fog" args={['#0a0a0a', 8, 18]} />
      <ambientLight intensity={0.2} />
      <hemisphereLight args={['#2a2420', '#050505', 0.25]} />
      <mesh position={[0, 0, -0.01]}>
        <planeGeometry args={[40, 12]} />
        <meshStandardMaterial color="#141210" roughness={0.98} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2.4, 4]}>
        <planeGeometry args={[40, 14]} />
        <meshStandardMaterial color="#0c0b0a" roughness={0.45} metalness={0.15} />
      </mesh>
      <mesh position={[0, -2.32, 0.03]}>
        <boxGeometry args={[40, 0.16, 0.06]} />
        <meshStandardMaterial color="#1c1916" roughness={0.7} />
      </mesh>
      <group name="hero" ref={hero}>
        <Painting work={HERO} position={[0, 0, 0]} spot={24} placard={false} />
      </group>
      <Rig prog={prog} />
      <Preload all />
    </>
  )
}

/** One lit work on a dark wall. `prog.current.p` (0..1) dollies the camera in. */
export function HeroScene({ prog }: { prog: MutableRefObject<Progress> }) {
  const mobile = typeof window !== 'undefined' && window.innerWidth < 760
  return (
    <Canvas
      dpr={mobile ? [1, 1.5] : [1, 1.75]}
      camera={{ fov: 42, near: 0.1, far: 60, position: [0, 0.1, 5.6] }}
      gl={{ antialias: true, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <Suspense fallback={null}>
        <Room prog={prog} />
      </Suspense>
    </Canvas>
  )
}
