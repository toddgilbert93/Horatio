import { Suspense, type CSSProperties } from 'react'
import { Canvas } from '@react-three/fiber'
import { ContactShadows, Bounds, useGLTF } from '@react-three/drei'
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
        shadows
        dpr={[1, 2]}
        camera={{ position: [0, 0.35, 2.6], fov: 32, near: 0.01, far: 50 }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        style={{ width: '100%', height: '100%', display: 'block' }}
      >
        <color attach="background" args={['#041300']} />

        <ambientLight intensity={0.1} />
        <hemisphereLight color="#d4c8b0" groundColor="#041300" intensity={0.16} />

        <spotLight
          castShadow
          position={[0.15, 5.2, 2.55]}
          intensity={75}
          angle={0.5}
          penumbra={0.75}
          decay={2}
          distance={18}
          color="#fff4e8"
          shadow-mapSize={[1024, 1024]}
          shadow-bias={-0.00015}
          shadow-normalBias={0.02}
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
          <ContactShadows
            position={[0, -1.05, 0]}
            opacity={0.45}
            scale={5}
            blur={2.2}
            far={2.5}
            color="#000000"
          />
        </Suspense>
      </Canvas>
    </div>
  )
}

useGLTF.preload(defaultModelUrl)

export { Bust }
export { BUST_MATERIALS, createBustMaterial } from './materials'
export type { BustMaterialId } from './materials'
