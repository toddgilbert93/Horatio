import { useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Center, useGLTF } from '@react-three/drei'
import type { Group, Mesh, Object3D } from 'three'
import { createBustMaterial, type BustMaterialId } from './materials'

type BustProps = {
  url: string
  rotating?: boolean
  speed?: number
  glitch?: boolean
  materialId?: BustMaterialId
}

function applyMaterial(root: Object3D, materialId: BustMaterialId) {
  const material = createBustMaterial(materialId)

  root.traverse((child) => {
    if (!(child as Mesh).isMesh) return
    const mesh = child as Mesh
    mesh.material = material
    mesh.castShadow = false
    mesh.receiveShadow = false
  })

  return material
}

export function Bust({
  url,
  rotating = true,
  speed = 0.35,
  glitch = true,
  materialId = 'bone',
}: BustProps) {
  const groupRef = useRef<Group>(null)
  const angleRef = useRef(0)
  const { scene } = useGLTF(url)
  const bustScene = useMemo(() => scene.clone(true), [scene])

  useLayoutEffect(() => {
    const material = applyMaterial(bustScene, materialId)
    return () => {
      material.dispose()
    }
  }, [bustScene, materialId])

  useFrame(({ clock }, delta) => {
    const group = groupRef.current
    if (!group) return

    if (rotating) angleRef.current += delta * speed

    // A brief, infrequent digital hitch: small enough to read as signal noise
    // without interrupting the bust's slow rotation.
    const glitchTime = (clock.elapsedTime + 2.1) % 14
    const glitchSlice = glitch && glitchTime < 0.11 ? Math.floor(glitchTime / 0.028) : -1
    const offset = glitchSlice >= 0 ? (glitchSlice % 2 === 0 ? 1 : -1) : 0

    group.position.x = offset * 0.008
    group.rotation.y = angleRef.current + offset * 0.012
    group.rotation.z = offset * 0.006
  })

  return (
    <group ref={groupRef}>
      <Center>
        <primitive object={bustScene} />
      </Center>
    </group>
  )
}
