import {
  Color,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Material,
} from 'three'

export type BustMaterialId = 'plaster' | 'bone' | 'bronze'

export const BUST_MATERIALS: { id: BustMaterialId; label: string }[] = [
  { id: 'plaster', label: 'Plaster' },
  { id: 'bone', label: 'Bone' },
  { id: 'bronze', label: 'Bronze' },
]

export function createBustMaterial(id: BustMaterialId): Material {
  switch (id) {
    case 'plaster':
      return new MeshStandardMaterial({
        color: new Color('#ebe6de'),
        roughness: 0.92,
        metalness: 0,
        envMapIntensity: 0.2,
      })

    case 'bone':
      return new MeshPhysicalMaterial({
        color: new Color('#E3D7C5'),
        roughness: 0.55,
        metalness: 0.02,
        clearcoat: 0.12,
        clearcoatRoughness: 0.5,
        sheen: 0.35,
        sheenRoughness: 0.6,
        sheenColor: new Color('#d4c4a8'),
        envMapIntensity: 0.35,
      })

    case 'bronze':
      return new MeshStandardMaterial({
        color: new Color('#6b4a2e'),
        roughness: 0.38,
        metalness: 0.85,
        envMapIntensity: 0.9,
      })
  }
}
