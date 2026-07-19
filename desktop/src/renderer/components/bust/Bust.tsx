import { useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Center, useGLTF } from '@react-three/drei'
import type { Group, Mesh, Object3D } from 'three'
import { createBustMaterial, type BustMaterialId } from './materials'

type BustProps = {
  url: string
  rotating?: boolean
  speed?: number
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
  materialId = 'bone',
}: BustProps) {
  const groupRef = useRef<Group>(null)
  const { scene } = useGLTF(url)
  const bustScene = useMemo(() => scene.clone(true), [scene])

  useLayoutEffect(() => {
    const material = applyMaterial(bustScene, materialId)
    return () => {
      material.dispose()
    }
  }, [bustScene, materialId])

  useFrame((_, delta) => {
    if (!rotating || !groupRef.current) return
    groupRef.current.rotation.y += delta * speed
  })

  return (
    <group ref={groupRef}>
      <Center>
        <primitive object={bustScene} />
      </Center>
    </group>
  )
}
