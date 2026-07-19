import { Suspense, type CSSProperties } from 'react'
import { Canvas } from '@react-three/fiber'
import { Bounds, useGLTF } from '@react-three/drei'
import { Bust } from './Bust'
import type { BustMaterialId } from './materials'

const defaultModelUrl = new URL('./bust1.glb', import.meta.url).href

export type BustViewerProps = {
  /** Start/stop Y rotation — wire to an app event later */
  rotating?: boolean
  speed?: number
  materialId?: BustMaterialId
  /** Override model URL if the host app serves the GLB elsewhere */
  modelUrl?: string
  className?: string
  style?: CSSProperties
}

/**
 * Drop-in bust viewer for Electron / React hosts.
 * Designed to read clearly at ≤300×300px.
 *
 * @example
 * <div style={{ width: 220, height: 220 }}>
 *   <BustViewer rotating={isActive} />
 * </div>
 */
export function BustViewer({
  rotating = true,
  speed = 0.35,
  materialId = 'bone',
  modelUrl = defaultModelUrl,
  className,
  style,
}: BustViewerProps) {
  return (
    <div
      className={className}
      style={{
        width: '100%',
        height: '100%',
        maxWidth: 300,
        maxHeight: 300,
        aspectRatio: '1 / 1',
        background: '#041300',
        overflow: 'hidden',
        ...style,
      }}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0, 0.35, 2.6], fov: 32, near: 0.01, far: 50 }}
        // Transparent GL so CSS #041300 shows through — WebGL clear colors
        // read darker than the same hex in CSS on wide-gamut displays.
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        style={{ width: '100%', height: '100%', display: 'block', background: 'transparent' }}
      >
        <ambientLight intensity={0.1} />
        <hemisphereLight color="#d4c8b0" groundColor="#041300" intensity={0.16} />

        <spotLight
          position={[0.15, 5.2, 2.55]}
          intensity={75}
          angle={0.5}
          penumbra={0.75}
          decay={2}
          distance={18}
          color="#fff4e8"
        />

        <directionalLight position={[-2.5, 0.4, -1]} intensity={0.25} color="#6a7a9a" />

        <Suspense fallback={null}>
          <Bounds fit clip margin={1.2}>
            <Bust
              url={modelUrl}
              rotating={rotating}
              speed={speed}
              materialId={materialId}
            />
          </Bounds>
        </Suspense>
      </Canvas>
    </div>
  )
}

useGLTF.preload(defaultModelUrl)

export { Bust }
export { BUST_MATERIALS, createBustMaterial } from './materials'
export type { BustMaterialId } from './materials'
