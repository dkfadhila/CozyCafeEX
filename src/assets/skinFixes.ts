// Runtime skin-weight repairs for Meshy auto-rigs. Applied once after a model loads, so they survive
// re-running tools/compress_models.mjs (which never touches weights). No new assets are involved.
import * as THREE from 'three'

/** Named repairs; referenced from `CharacterAsset.skinFix` in the manifest. */
export type SkinFix = 'femaleChef'

export interface SkinFixReport {
  /** Mixed head/arm vertices whose head-vs-arm share was re-decided by height. */
  remapped: number
  /** Vertices whose weights were relaxed over the mesh adjacency to blend the junction. */
  smoothed: number
}

const HEAD_BONES = new Set(['Head', 'headfront', 'head_end'])
const FOREARM = /^(Left|Right)(ForeArm|Hand)$/
const UPPER_ARM = /^(Left|Right)Arm$/
/** Weights below this on the head are treated as noise when deciding whether a vertex mixes head and limb. */
const MIN_WEIGHT = 0.05
const SMOOTH_ITERATIONS = 10
const SMOOTH_RINGS = 6
const SMOOTH_BLEND = 0.5

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * The female chef's bob haircut ends on her puffy jacket shoulders, and Meshy's proximity skinning gave the hair
 * tips ~50% forearm weight and the sleeve-top rim ~25% head weight, so the hair was dragged by the swinging arm and
 * the sleeve rim was pulled into long spikes. Topology is left untouched (every triangle stays; deleting the
 * hair-to-sleeve triangles left holes). The head-vs-arm share of such mixed vertices is re-decided by rest height
 * (hair above the sleeve line goes fully to Head, the sleeve rim fully to the arm chain), then the weights are relaxed
 * over the welded mesh adjacency a few rings out so the junction bends over a band instead of tearing at one edge.
 */
function femaleChef(mesh: THREE.SkinnedMesh): SkinFixReport {
  const geo = mesh.geometry
  const index = geo.getAttribute('skinIndex')
  const weight = geo.getAttribute('skinWeight')
  const pos = geo.getAttribute('position')
  const tris = geo.getIndex()
  const bones = mesh.skeleton.bones
  const names = bones.map((b) => b.name)
  const boneId = (n: string) => names.indexOf(n)
  const report: SkinFixReport = { remapped: 0, smoothed: 0 }
  const neckBone = boneId('neck')
  const headBone = boneId('Head')
  const chestBone = boneId('Spine') // top of the spine chain: parent of neck and both shoulders
  const shoulder = [boneId('RightShoulder'), boneId('LeftShoulder')] // [x<0, x>0]
  if (!tris || neckBone < 0 || headBone < 0 || chestBone < 0 || shoulder.some((s) => s < 0)) return report

  // Rest pose in mesh space (the loader may have quantized the raw attributes, so go through the skeleton).
  mesh.skeleton.update()
  const v = new THREE.Vector3()
  const px = new Float32Array(pos.count)
  const py = new Float32Array(pos.count)
  const pz = new Float32Array(pos.count)
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, v)
    px[i] = v.x
    py[i] = v.y
    pz[i] = v.z
    minY = Math.min(minY, v.y)
    maxY = Math.max(maxY, v.y)
  }
  const joint = (n: string) => mesh.worldToLocal(bones[boneId(n)].getWorldPosition(new THREE.Vector3()))
  const k = (maxY - minY) / 110 // the heights below were tuned on a 110-unit-tall rest pose
  const shoulderY = (joint('LeftShoulder').y + joint('RightShoulder').y) / 2
  // Hair tips (y >= ~65.5 on the 110-tall rest pose) sit 1-2 cm above the sleeve top (y <= ~64.4): that thin
  // band is where mixed vertices are re-assigned, hair-side to the head, cloth-side to the arm chain.
  const hairLo = shoulderY + 0.6 * k
  const hairHi = shoulderY + 1.7 * k
  const collarReach = 10 * k // inside this the vertex is collar/shoulder cap, not sleeve
  const headReach = 30 * k // only touch vertices within this distance of the body axis (hands stay out)

  const slots = (i: number) => {
    const m = new Map<number, number>()
    for (let s = 0; s < 4; s++) {
      const w = weight.getComponent(i, s)
      if (w > 0) m.set(index.getComponent(i, s), (m.get(index.getComponent(i, s)) ?? 0) + w)
    }
    return m
  }
  const store = (i: number, m: Map<number, number>) => {
    const top = [...m].filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4)
    const sum = top.reduce((a, [, w]) => a + w, 0) || 1
    for (let s = 0; s < 4; s++) {
      index.setComponent(i, s, top[s]?.[0] ?? 0)
      weight.setComponent(i, s, top[s] ? top[s][1] / sum : 0)
    }
  }

  // 1) Mixed head/arm-chain vertices: the head-vs-arm share is decided by height instead of by Meshy's ~50/50
  // proximity blend. Hair side: all of it on Head. Cloth side: all of it on the arm chain (proportional to the
  // existing arm/forearm/hand weights). Other bones (shoulder, spine) are untouched.
  const dense: Array<Map<number, number> | null> = new Array(pos.count).fill(null)
  const mixed = new Uint8Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const m = slots(i)
    let head = 0
    let limb = 0
    for (const [b, w] of m) {
      if (HEAD_BONES.has(names[b])) head += w
      else if (FOREARM.test(names[b]) || UPPER_ARM.test(names[b])) limb += w
    }
    dense[i] = m
    if (head <= MIN_WEIGHT || limb <= MIN_WEIGHT || Math.abs(px[i]) > headReach) continue
    if (Math.abs(px[i]) < collarReach) continue // collar/neck column: leave as authored
    const hair = smoothstep(hairLo, hairHi, py[i]) // 1 = hair, 0 = sleeve
    const total = head + limb
    for (const [b, w] of [...m]) {
      if (HEAD_BONES.has(names[b])) m.delete(b)
      else if (FOREARM.test(names[b]) || UPPER_ARM.test(names[b])) m.set(b, (w / limb) * (1 - hair) * total)
    }
    m.set(headBone, hair * total)
    mixed[i] = 1
    report.remapped++
  }

  // 2) Relax weights over the welded adjacency (vertices split at UV seams count as one node), a few rings
  // around the vertices touched above, so there is a gradient instead of a step.
  const key = (i: number) => `${Math.round(px[i] * 200)},${Math.round(py[i] * 200)},${Math.round(pz[i] * 200)}`
  const nodeOf = new Int32Array(pos.count)
  const nodeIds = new Map<string, number>()
  const members: number[][] = []
  for (let i = 0; i < pos.count; i++) {
    const kk = key(i)
    let n = nodeIds.get(kk)
    if (n === undefined) {
      n = members.length
      nodeIds.set(kk, n)
      members.push([])
    }
    nodeOf[i] = n
    members[n].push(i)
  }
  const nbr: Array<Set<number>> = members.map(() => new Set<number>())
  const arr = tris.array
  for (let t = 0; t < arr.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = nodeOf[arr[t + e]]
      const b = nodeOf[arr[t + ((e + 1) % 3)]]
      if (a !== b) {
        nbr[a].add(b)
        nbr[b].add(a)
      }
    }
  }
  // Nodes to relax: rings around the remapped vertices, never below the sleeve rim (real sleeve stays on the arm).
  const free = new Uint8Array(members.length)
  let frontier: number[] = []
  for (let i = 0; i < pos.count; i++) {
    if (mixed[i] && !free[nodeOf[i]]) {
      free[nodeOf[i]] = 1
      frontier.push(nodeOf[i])
    }
  }
  for (let r = 0; r < SMOOTH_RINGS; r++) {
    const next: number[] = []
    for (const n of frontier) {
      for (const m of nbr[n]) {
        if (free[m] || py[members[m][0]] < hairLo - 1.2 * k || Math.abs(px[members[m][0]]) < collarReach) continue
        free[m] = 1
        next.push(m)
      }
    }
    frontier = next
  }
  let nodeW: Array<Map<number, number>> = members.map((ms) => {
    const avg = new Map<number, number>()
    for (const i of ms) for (const [b, w] of dense[i]!) avg.set(b, (avg.get(b) ?? 0) + w / ms.length)
    return avg
  })
  for (let it = 0; it < SMOOTH_ITERATIONS; it++) {
    const next = nodeW.map((m) => new Map(m))
    for (let n = 0; n < members.length; n++) {
      if (!free[n] || nbr[n].size === 0) continue
      const avg = new Map<number, number>()
      for (const m of nbr[n]) for (const [b, w] of nodeW[m]) avg.set(b, (avg.get(b) ?? 0) + w / nbr[n].size)
      const out = new Map<number, number>()
      for (const b of new Set([...nodeW[n].keys(), ...avg.keys()])) {
        out.set(b, (1 - SMOOTH_BLEND) * (nodeW[n].get(b) ?? 0) + SMOOTH_BLEND * (avg.get(b) ?? 0))
      }
      next[n] = out
    }
    nodeW = next
  }
  for (let n = 0; n < members.length; n++) {
    for (const i of members[n]) {
      if (free[n]) {
        store(i, nodeW[n])
        report.smoothed++
      } else if (mixed[i]) store(i, dense[i]!)
    }
  }
  weight.needsUpdate = true
  index.needsUpdate = true
  return report
}

const FIXES: Record<SkinFix, (mesh: THREE.SkinnedMesh) => SkinFixReport> = { femaleChef }

/** Apply a named repair to the first skinned mesh under `root`. Returns the report, or null if none found. */
export function applySkinFix(fix: SkinFix, root: THREE.Object3D): SkinFixReport | null {
  let mesh: THREE.SkinnedMesh | null = null
  root.updateMatrixWorld(true) // bones are siblings of the mesh, so they need the whole tree refreshed
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as THREE.SkinnedMesh
  })
  return mesh ? FIXES[fix](mesh) : null
}
