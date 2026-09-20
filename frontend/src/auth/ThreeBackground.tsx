import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Sparkles } from '@react-three/drei'
import type { Mesh } from 'three'

function DriftingKnot() {
  const ref = useRef<Mesh>(null)

  useFrame((_, delta) => {
    if (!ref.current) return
    ref.current.rotation.x += delta * 0.12
    ref.current.rotation.y += delta * 0.18
  })

  return (
    <mesh ref={ref}>
      <torusKnotGeometry args={[2.8, 0.6, 220, 32]} />
      <meshStandardMaterial color="#0E0E0E" wireframe transparent opacity={0.16} />
    </mesh>
  )
}

export function ThreeBackground() {
  return (
    <Canvas
      camera={{ position: [0, 0, 8], fov: 45 }}
      style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[4, 6, 5]} intensity={0.8} />
      <DriftingKnot />
      <Sparkles count={140} scale={[16, 9, 8]} size={1.6} speed={0.35} opacity={0.45} color="#0E0E0E" />
    </Canvas>
  )
}