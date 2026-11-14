// Seating geometry: where the chair seat really is (measured from the table model, which includes its
// chairs) and where a customer's pelvis sits in each seated clip (measured from the skinned mesh), so the
// pelvis can be centred over the cushion with the buttocks resting on it. Pure three.js, also runs in Node
// (see tools/verify_seating.mjs).
import * as THREE from 'three'

/** Extra clearance between the buttock bottom and the cushion top, metres (negative = sink in). */
export const SEAT_BOTTOM_PADDING = 0.003
/** Shift of the pelvis from the free-cushion centre towards the table, metres (keeps the back off the backrest). */
export const SEAT_FORWARD_BIAS = 0.015
/** Hips joint to buttock bottom when seated (measured on the six customers: 0.19-0.21 m); used if no mesh is available. */
export const SEAT_HIPS_TO_BOTTOM = 0.2
/** Buttock candidates: at most this far in front of the hips joint (local Z; the thighs slope down beyond it) ... */
const BUTT_FRONT = 0.03
/** ... within this lateral distance of the hips joint ... */
const BUTT_SIDE = 0.14
/** ... and no lower than this below it. */
const BUTT_DEPTH = 0.3
/** The buttock bottom is this quantile of the candidate heights (0 = lowest vertex; >0 ignores strays). */
const BUTT_QUANTILE = 0
/** Only vertices mainly skinned to these bones count (arms resting beside the hips must not). */
const PELVIS_BONES = /^(Hips|Spine|LeftUpLeg|RightUpLeg)$/

/** Pose samples across a looping clip. */
const LOOP_SAMPLES = 16
/** Raycast grid step for the coarse seat-height survey, metres. */
const COARSE_STEP = 0.04
/** Step of the fine scans, metres. */
const FINE_STEP = 0.01

const DOWN = new THREE.Vector3(0, -1, 0)
const AXIS_Y = new THREE.Vector3(0, 1, 0)

/** The chair seat on one side of a table, in world space. */
export interface SeatSpot {
  /** Centre of the free cushion (between the backrest and the front edge), world X/Z. */
  x: number
  z: number
  /** Cushion top surface, world Y. */
  y: number
  /** Whole cushion and the backrest, world space. */
  cushion: THREE.Box3
  backrest: THREE.Box3
}

/**
 * Probe a table holder (table + its two chairs) with downward rays on the side `side` (-1 = -X, +1 = +X)
 * of the table centre. The cushion is the most common first-hit height below the tabletop; its extents and
 * the backrest are found with fine 1D scans (a few hundred rays, a raycast against the table is not cheap).
 */
export function measureSeatSpot(holder: THREE.Object3D, cx: number, cz: number, side: -1 | 1): SeatSpot | null {
  holder.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(holder)
  const rc = new THREE.Raycaster()
  const origin = new THREE.Vector3()
  const hitY = (x: number, z: number, fromY: number): number | null => {
    rc.set(origin.set(x, fromY, z), DOWN)
    const h = rc.intersectObject(holder, true)[0]
    return h ? h.point.y : null
  }
  const topY = hitY(cx, cz, bounds.max.y + 0.1)
  if (topY === null) return null
  const sideEdge = side < 0 ? bounds.min.x : bounds.max.x
  const halfZ = (bounds.max.z - bounds.min.z) / 2
  const startY = topY * 0.75 // below the tabletop, above the cushion

  // 1. Coarse grid over the chair side: the biggest cluster of equal first-hit heights is the cushion top.
  const bins = new Map<number, number>()
  const samples: { x: number; z: number; y: number }[] = []
  for (let x = cx; (x - sideEdge) * side < 0; x += side * COARSE_STEP) {
    for (let z = cz - halfZ; z <= cz + halfZ; z += COARSE_STEP) {
      const y = hitY(x, z, startY)
      if (y === null || y < 0.2 * topY) continue
      samples.push({ x, z, y })
      const b = Math.round(y / 0.005)
      bins.set(b, (bins.get(b) ?? 0) + 1)
    }
  }
  let bestBin = 0
  let best = 0
  for (const [b, n] of bins) {
    const n3 = n + (bins.get(b - 1) ?? 0) + (bins.get(b + 1) ?? 0)
    if (n3 > best) {
      best = n3
      bestBin = b
    }
  }
  if (!best) return null
  const flat = samples.filter((p) => Math.abs(p.y - bestBin * 0.005) <= 0.012)
  const med = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)]
  const mx = med(flat.map((p) => p.x))
  const mz = med(flat.map((p) => p.z))
  const seatTop = med(flat.map((p) => p.y))
  const isCushion = (x: number, z: number) => {
    const y = hitY(x, z, startY)
    return y !== null && Math.abs(y - seatTop) <= 0.012
  }

  // 2. Fine scans through the median point: contiguous cushion range along X and along Z.
  const run = (along: 'x' | 'z'): [number, number] => {
    const at = (t: number) => (along === 'x' ? isCushion(t, mz) : isCushion(mx, t))
    const c = along === 'x' ? mx : mz
    let lo = c
    let hi = c
    while (at(lo - FINE_STEP) && c - lo < 0.6) lo -= FINE_STEP
    while (at(hi + FINE_STEP) && hi - c < 0.6) hi += FINE_STEP
    return [lo, hi]
  }
  const [x0, x1] = run('x')
  const [z0, z1] = run('z')
  const cushion = new THREE.Box3(new THREE.Vector3(x0, seatTop - 0.03, z0), new THREE.Vector3(x1, seatTop, z1))

  // 3. Backrest: along the cushion's Z middle, from beyond the outer edge to the middle (the front half is under
  // the tabletop), where a ray from above lands clearly above the cushion.
  const zMid = (z0 + z1) / 2
  const outer = side < 0 ? x0 : x1
  const mid = (x0 + x1) / 2
  const backrest = new THREE.Box3()
  for (let x = outer + side * 0.08; (x - mid) * side > 0; x -= side * FINE_STEP) {
    const y = hitY(x, zMid, bounds.max.y + 0.1)
    if (y === null || y < seatTop + 0.05 || Math.abs(y - topY) < 0.012) continue
    backrest.expandByPoint(new THREE.Vector3(x, y, zMid))
  }
  let innerX = outer
  if (!backrest.isEmpty()) {
    innerX = side < 0 ? backrest.max.x : backrest.min.x
    backrest.min.set(backrest.min.x, seatTop, z0)
    backrest.max.z = z1
  }
  const frontX = side < 0 ? x1 : x0
  return { x: (innerX + frontX) / 2, z: zMid, y: seatTop, cushion, backrest }
}

/** Pelvis of a customer in the root's local space (after the character's scale), for one pose. */
export interface SeatedPose {
  /** Hips joint position (m). */
  hips: THREE.Vector3
  /** Height of the lowest buttock vertex (m). */
  bottomY: number
}

export interface SeatedPoses {
  sitIdle: SeatedPose
  drink: SeatedPose
  /** Last frame of sitDown / first frame of standUp. */
  sitDownEnd: SeatedPose
  standUpStart: SeatedPose
}

/** The parts of a Character this module needs. */
export interface PoseSource {
  root: THREE.Object3D
  mixer: THREE.AnimationMixer
  actions: Partial<Record<string, THREE.AnimationAction>>
}

const cache = new WeakMap<object, SeatedPoses | null>()

/** Measured poses for a character (computed on first use, then cached on its root). */
export function seatedPoses(c: PoseSource): SeatedPoses | null {
  let p = cache.get(c.root)
  if (p === undefined) {
    p = measureSeatedPoses(c)
    cache.set(c.root, p)
  }
  return p
}

/** 1 for every vertex whose strongest bone is a pelvis/lower-spine/upper-leg bone. */
export function pelvisMask(mesh: THREE.SkinnedMesh): Uint8Array {
  const idx = mesh.geometry.getAttribute('skinIndex')
  const wgt = mesh.geometry.getAttribute('skinWeight')
  const ok = mesh.skeleton.bones.map((b) => PELVIS_BONES.test(b.name))
  const out = new Uint8Array(idx.count)
  for (let i = 0; i < idx.count; i++) {
    let best = 0
    let bone = -1
    for (let j = 0; j < 4; j++) {
      const w = wgt.getComponent(i, j)
      if (w > best) {
        best = w
        bone = idx.getComponent(i, j)
      }
    }
    out[i] = bone >= 0 && ok[bone] ? 1 : 0
  }
  return out
}

/** Lowest buttock height (root-local) from pelvis-skinned vertices in root-local space and the hips joint. */
export function buttockBottom(pelvisPts: THREE.Vector3[], hips: THREE.Vector3): number {
  const ys: number[] = []
  for (const p of pelvisPts)
    if (p.y < hips.y && p.y >= hips.y - BUTT_DEPTH && p.z <= hips.z + BUTT_FRONT && Math.abs(p.x - hips.x) <= BUTT_SIDE) ys.push(p.y)
  if (!ys.length) return hips.y - SEAT_HIPS_TO_BOTTOM
  ys.sort((a, b) => a - b)
  return ys[Math.floor(ys.length * BUTT_QUANTILE)]
}

/** Pose the skeleton at time `t` of clip `name` and return the pelvis data. Leaves the mixer with that clip stopped. */
function samplePose(c: PoseSource, name: string, t: number, meshes: THREE.SkinnedMesh[], masks: Uint8Array[], hipsBone: THREE.Object3D): SeatedPose | null {
  const a = c.actions[name]
  if (!a) return null
  c.mixer.stopAllAction()
  a.reset()
  a.play()
  a.time = t
  c.mixer.update(0)
  c.root.updateMatrixWorld(true)
  const hips = c.root.worldToLocal(hipsBone.getWorldPosition(new THREE.Vector3()))
  const v = new THREE.Vector3()
  const pts: THREE.Vector3[] = []
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi]
    m.skeleton.update()
    const n = m.geometry.getAttribute('position').count
    for (let i = 0; i < n; i++) {
      if (!masks[mi][i]) continue
      m.getVertexPosition(i, v)
      v.applyMatrix4(m.matrixWorld)
      pts.push(c.root.worldToLocal(v).clone())
    }
  }
  const bottomY = buttockBottom(pts, hips)
  return { hips, bottomY }
}

function averagePose(c: PoseSource, name: string, meshes: THREE.SkinnedMesh[], masks: Uint8Array[], hipsBone: THREE.Object3D): SeatedPose | null {
  const a = c.actions[name]
  if (!a) return null
  const dur = a.getClip().duration
  const acc: SeatedPose = { hips: new THREE.Vector3(), bottomY: 0 }
  for (let i = 0; i < LOOP_SAMPLES; i++) {
    const p = samplePose(c, name, (dur * i) / LOOP_SAMPLES, meshes, masks, hipsBone)
    if (!p) return null
    acc.hips.add(p.hips)
    // lowest buttock over the whole loop, so no phase of the clip sinks into the cushion
    acc.bottomY = i === 0 ? p.bottomY : Math.min(acc.bottomY, p.bottomY)
  }
  acc.hips.divideScalar(LOOP_SAMPLES)
  return acc
}

/**
 * Evaluate the seated clips on the character's own skeleton. All actions are left stopped: the caller must
 * start a clip afterwards (and reset its own notion of the current clip).
 */
export function measureSeatedPoses(c: PoseSource): SeatedPoses | null {
  let hipsBone: THREE.Object3D | undefined
  const meshes: THREE.SkinnedMesh[] = []
  c.root.traverse((o) => {
    if (o.name === 'Hips' && (o as THREE.Bone).isBone) hipsBone = o
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh)
  })
  if (!hipsBone || !meshes.length || !c.actions.sitIdle) return null
  const masks = meshes.map(pelvisMask)
  const dur = (n: string) => c.actions[n]?.getClip().duration ?? 0
  const sitIdle = averagePose(c, 'sitIdle', meshes, masks, hipsBone)
  if (!sitIdle) return null
  const drink = averagePose(c, 'drink', meshes, masks, hipsBone) ?? sitIdle
  // Single frames of the transition clips are not fully seated (feet can fall in the buttock window):
  // take the hips and reuse the pelvis-to-buttock distance of sitIdle.
  const drop = sitIdle.hips.y - sitIdle.bottomY
  const frame = (name: string, t: number): SeatedPose => {
    const p = samplePose(c, name, t, meshes, masks, hipsBone as THREE.Object3D)
    return p ? { hips: p.hips, bottomY: p.hips.y - drop } : sitIdle
  }
  const sitDownEnd = frame('sitDown', dur('sitDown'))
  const standUpStart = frame('standUp', 0)
  c.mixer.stopAllAction()
  return { sitIdle, drink, sitDownEnd, standUpStart }
}

/** World position of the customer root that puts `pose`'s pelvis over the seat centre, bottom on the cushion. */
export function seatedRoot(spot: Pick<SeatSpot, 'x' | 'y' | 'z'>, yawDeg: number, pose: SeatedPose, out = new THREE.Vector3()): THREE.Vector3 {
  const off = new THREE.Vector3(pose.hips.x, 0, pose.hips.z).applyAxisAngle(AXIS_Y, THREE.MathUtils.degToRad(yawDeg))
  const yaw = THREE.MathUtils.degToRad(yawDeg)
  return out.set(
    spot.x - off.x + Math.sin(yaw) * SEAT_FORWARD_BIAS,
    spot.y - pose.bottomY + SEAT_BOTTOM_PADDING,
    spot.z - off.z + Math.cos(yaw) * SEAT_FORWARD_BIAS,
  )
}
