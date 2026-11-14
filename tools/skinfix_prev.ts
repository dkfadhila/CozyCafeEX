// Runtime skin-weight repairs for Meshy auto-rigs. Applied once after a model loads, so they survive
// re-running tools/compress_models.mjs (which never touches weights). No new assets are involved.
import * as THREE from 'three'

/** Named repairs; referenced from `CharacterAsset.skinFix` in the manifest. */
export type SkinFix = 'femaleChef'

export interface SkinFixReport {
  /** Hair vertices that were pulled by shoulder/arm bones and now follow only the head. */
  hairToHead: number
  /** Sleeve/shoulder vertices that were pulled by the head and now follow only the arm chain. */
  sleeveFromHead: number
  /** Triangles bridging a head-bound hair tip and an arm-bound sleeve (they would stretch across the cheer pose). */
  bridgesRemoved: number
}

const HEAD_BONES = new Set(['Head', 'headfront', 'head_end'])
const LIMB_BONE = /^(Left|Right)(Shoulder|Arm|ForeArm|Hand)$/
/** Vertices closer to the neck axis than this (fraction of body height) are neck/collar skin: left alone. */
const NECK_HALF_WIDTH = 0.085
/** Weights below this are treated as noise when deciding whether a vertex mixes head and limb bones. */
const MIN_WEIGHT = 0.05

/**
 * The female chef's bob haircut hangs onto her puffy jacket shoulders, and Meshy's proximity skinning
 * blended hair vertices with the forearm bones (and sleeve vertices with the head). The hair then tears
 * and the shoulders look broken whenever the arms move. Fix: for every vertex outside the neck column that
 * mixes head and limb bones, keep whichever group dominates and drop the other, then renormalise.
 * Dark hair is always head-dominant in this model, so no texture lookup is needed.
 */
function femaleChef(mesh: THREE.SkinnedMesh): SkinFixReport {
  const geo = mesh.geometry
  const index = geo.getAttribute('skinIndex')
  const weight = geo.getAttribute('skinWeight')
  const pos = geo.getAttribute('position')
  const names = mesh.skeleton.bones.map((b) => b.name)
  const isHead = names.map((n) => HEAD_BONES.has(n))
  const isLimb = names.map((n) => LIMB_BONE.test(n))

  // Rest pose in mesh space (the loader may have quantized the raw attributes, so go through the skeleton).
  mesh.skeleton.update()
  const v = new THREE.Vector3()
  let minY = Infinity
  let maxY = -Infinity
  const xs = new Float32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, v)
    xs[i] = v.x
    minY = Math.min(minY, v.y)
    maxY = Math.max(maxY, v.y)
  }
  const neck = mesh.skeleton.bones.find((b) => b.name === 'neck')
  const neckX = neck ? mesh.worldToLocal(neck.getWorldPosition(new THREE.Vector3())).x : 0
  const halfWidth = NECK_HALF_WIDTH * (maxY - minY)

  // 1 = head-bound, 2 = limb-bound (outside the neck column only), 0 = neither.
  const side = new Uint8Array(pos.count)
  const report: SkinFixReport = { hairToHead: 0, sleeveFromHead: 0, bridgesRemoved: 0 }
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(xs[i] - neckX) <= halfWidth) continue
    let head = 0
    let limb = 0
    for (let k = 0; k < 4; k++) {
      const b = index.getComponent(i, k)
      const w = weight.getComponent(i, k)
      if (isHead[b]) head += w
      else if (isLimb[b]) limb += w
    }
    if (head <= MIN_WEIGHT || limb <= MIN_WEIGHT) {
      side[i] = head >= 0.5 ? 1 : limb >= 0.5 ? 2 : 0
      continue
    }
    const keepHead = head >= limb
    let sum = 0
    for (let k = 0; k < 4; k++) {
      const b = index.getComponent(i, k)
      const drop = keepHead ? isLimb[b] : isHead[b]
      if (drop) weight.setComponent(i, k, 0)
      sum += weight.getComponent(i, k)
    }
    if (sum > 1e-6) for (let k = 0; k < 4; k++) weight.setComponent(i, k, weight.getComponent(i, k) / sum)
    side[i] = keepHead ? 1 : 2
    if (keepHead) report.hairToHead++
    else report.sleeveFromHead++
  }

  // The hair tips rest on the jacket shoulders and the mesh has a few triangles joining the two. With the
  // arms raised those triangles span the gap between head and hand, so drop them (a sub-centimetre crack
  // at rest, hidden behind the hair).
  const tris = geo.getIndex()
  if (tris) {
    const src = tris.array
    const kept: number[] = []
    for (let t = 0; t < src.length; t += 3) {
      const a = side[src[t]]
      const b = side[src[t + 1]]
      const c = side[src[t + 2]]
      const bridge = (a === 1 || b === 1 || c === 1) && (a === 2 || b === 2 || c === 2)
      if (bridge) report.bridgesRemoved++
      else kept.push(src[t], src[t + 1], src[t + 2])
    }
    if (report.bridgesRemoved > 0) geo.setIndex(new THREE.BufferAttribute(new (src.constructor as Uint16ArrayConstructor)(kept), 1))
  }
  mesh.normalizeSkinWeights()
  weight.needsUpdate = true
  return report
}

const FIXES: Record<SkinFix, (mesh: THREE.SkinnedMesh) => SkinFixReport> = { femaleChef }

/** Apply a named repair to the first skinned mesh under `root`. Returns the report, or null if none found. */
export function applySkinFix(fix: SkinFix, root: THREE.Object3D): SkinFixReport | null {
  let mesh: THREE.SkinnedMesh | null = null
  root.updateMatrixWorld(true) // bones are siblings of the mesh, so they need the whole tree refreshed
  root.traverse((o) => {
    if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh
  })
  return mesh ? FIXES[fix](mesh) : null
}
