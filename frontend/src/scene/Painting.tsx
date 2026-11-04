import { useMemo, useRef, forwardRef, type ReactNode } from 'react'
import * as THREE from 'three'
import { useTexture } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import type { Work } from './works'

/* Lit standard material with canvas grain + vignette injected via onBeforeCompile,
   so the work reacts to the spotlight and never reads as a flat JPEG. */
function useCanvasMaterial(map: THREE.Texture) {
  const timeRef = useRef({ value: 0 })
  const mat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ map, roughness: 0.78, metalness: 0 })
    m.onBeforeCompile = shader => {
      shader.uniforms.uTime = timeRef.current
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uTime;
          float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }`)
        .replace('#include <map_fragment>', `
          vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          float weave = (sin(vMapUv.x * 1400.0) * sin(vMapUv.y * 1400.0)) * 0.018;
          float g = (hash(floor(vMapUv * 900.0) + floor(uTime * 2.0) * 0.37) - 0.5) * 0.045;
          vec2 d = abs(vMapUv - 0.5) * 2.0;
          float vig = 1.0 - smoothstep(0.75, 1.02, max(d.x, d.y)) * 0.28;
          sampledDiffuseColor.rgb = (sampledDiffuseColor.rgb + weave + g) * vig;
          diffuseColor *= sampledDiffuseColor;`)
    }
    return m
  }, [map])
  useFrame((_, dt) => { timeRef.current.value += dt })
  return mat
}

type Props = {
  work: Work
  position: [number, number, number]
  spot?: number
  placard?: boolean
  children?: ReactNode
}

export const Painting = forwardRef<THREE.Group, Props>(function Painting({ work, position, spot = 18, placard = true, children }, ref) {
  const tex = useTexture(work.src)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  const material = useCanvasMaterial(tex)
  const { w, h } = work
  const frameW = w + 0.14, frameH = h + 0.14, depth = 0.09
  const target = useMemo(() => new THREE.Object3D(), [])

  return (
    <group ref={ref} position={position}>
      {/* floater frame — dark walnut */}
      <mesh position={[0, 0, depth / 2]}>
        <boxGeometry args={[frameW, frameH, depth]} />
        <meshStandardMaterial color="#17110c" roughness={0.55} metalness={0.05} />
      </mesh>
      {/* linen mat */}
      <mesh position={[0, 0, depth + 0.001]}>
        <planeGeometry args={[w + 0.06, h + 0.06]} />
        <meshStandardMaterial color="#cfc7b8" roughness={0.95} />
      </mesh>
      {/* the canvas, slightly proud */}
      <mesh position={[0, 0, depth + 0.02]} material={material}>
        <planeGeometry args={[w, h]} />
      </mesh>
      {/* placard */}
      {placard && <mesh position={[frameW / 2 + 0.42, -frameH / 2 + 0.16, 0.01]}>
        <planeGeometry args={[0.6, 0.2]} />
        <meshStandardMaterial color="#f6f6f4" roughness={0.9} />
      </mesh>}
      <primitive object={target} />
      <spotLight
        position={[0, 3.6, 2.6]} target={target} angle={0.55} penumbra={0.75}
        intensity={spot} distance={12} decay={1.6} color="#fff1dc"
      />
      {children}
    </group>
  )
})
