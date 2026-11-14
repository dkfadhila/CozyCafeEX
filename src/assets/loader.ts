import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

/** Shared GLTFLoader factory: models are meshopt-compressed (see tools/compress_models.mjs). */
export function createGLTFLoader(): GLTFLoader {
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  return loader
}

const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'] as const

/** Max anisotropy of the GPU, set once by the scene's renderer (defaults to 16, which is what desktop GPUs report). */
let maxAnisotropy = 16
export function setMaxAnisotropy(n: number) {
  maxAnisotropy = Math.max(1, n)
}

/**
 * Anisotropic filtering for every texture slot of every material under `root`. GLTFLoader leaves anisotropy at 1,
 * which blurs anything seen obliquely (the isometric camera looks at the floor and tabletops at a grazing angle).
 */
export function sharpenTextures(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const mat = m as unknown as Record<string, THREE.Texture | null | undefined>
      for (const slot of TEXTURE_SLOTS) {
        const t = mat[slot]
        if (t && t.anisotropy !== maxAnisotropy) {
          t.anisotropy = maxAnisotropy
          t.needsUpdate = true
        }
      }
    }
  })
}
