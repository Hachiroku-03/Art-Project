import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import styles from './ChatBackground.module.css'

type Layer = {
  points: THREE.Points
  geometry: THREE.BufferGeometry
  material: THREE.PointsMaterial
  speeds: Float32Array
  phases: Float32Array
}

function createLayer(count: number, color: number, size: number, opacity: number): Layer {
  const geometry = new THREE.BufferGeometry()

  const positions = new Float32Array(count * 3)
  const speeds = new Float32Array(count)
  const phases = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 32
    positions[i * 3 + 1] = (Math.random() - 0.5) * 24
    positions[i * 3 + 2] = (Math.random() - 0.5) * 12

    speeds[i] = 0.004 + Math.random() * 0.014
    phases[i] = Math.random() * Math.PI * 2
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

  const material = new THREE.PointsMaterial({
    color,
    size,
    transparent: true,
    opacity,
    depthWrite: false,
    sizeAttenuation: true,
  })

  const points = new THREE.Points(geometry, material)

  return { points, geometry, material, speeds, phases }
}

export function ChatBackground() {
  const mountRef = useRef<HTMLDivElement>(null)

  // ---- all hooks top level ----
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const width = mount.clientWidth || 1
    const height = mount.clientHeight || 1

    let renderer: THREE.WebGLRenderer

    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false,
        powerPreference: 'low-power',
      })
    } catch {
      // WebGL unavailable — CSS fallback remains visible.
      return
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(width, height)
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100)
    camera.position.z = 14

    const baseCount = width < 760 ? 55 : 110

    const layers: Layer[] = [
      createLayer(baseCount, 0x5b3a8e, 0.13, 0.20),       // VIP purple
      createLayer(Math.floor(baseCount * 0.7), 0xd98c5f, 0.09, 0.16), // warm terracotta
      createLayer(Math.floor(baseCount * 0.45), 0x0e0e0e, 0.07, 0.10), // ink dust
    ]

    layers.forEach(layer => scene.add(layer.points))

    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let raf = 0
    let t = 0

    const renderStatic = () => {
      renderer.render(scene, camera)
    }

    const animate = () => {
      t += 0.008

      layers.forEach(layer => {
        const attr = layer.geometry.getAttribute('position') as THREE.BufferAttribute
        const arr = attr.array as Float32Array

        for (let i = 0; i < layer.speeds.length; i++) {
          arr[i * 3 + 1] += layer.speeds[i]
          arr[i * 3] += Math.sin(t + layer.phases[i]) * 0.004

          if (arr[i * 3 + 1] > 13) {
            arr[i * 3 + 1] = -13
            arr[i * 3] = (Math.random() - 0.5) * 32
          }
        }

        attr.needsUpdate = true
        layer.points.rotation.z = Math.sin(t * 0.12) * 0.035
      })

      renderer.render(scene, camera)
      raf = requestAnimationFrame(animate)
    }

    if (reducedMotion) {
      renderStatic()
    } else {
      animate()
    }

    const resize = () => {
      const w = mount.clientWidth || 1
      const h = mount.clientHeight || 1

      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()

      if (reducedMotion) renderStatic()
    }

    let ro: ResizeObserver | null = null

    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(resize)
      ro.observe(mount)
    } else {
      window.addEventListener('resize', resize)
    }

    return () => {
      cancelAnimationFrame(raf)

      if (ro) ro.disconnect()
      else window.removeEventListener('resize', resize)

      layers.forEach(layer => {
        layer.geometry.dispose()
        layer.material.dispose()
      })

      renderer.dispose()

      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [])

  return <div ref={mountRef} className={styles.bg} aria-hidden="true" />
}