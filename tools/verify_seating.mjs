// Node check of customer seating: all six customer models on all six seats, old placement vs new.
// usage: node tools/verify_seating.mjs [--poses]   (run from the game folder)
import * as THREE from 'three'
import { loadGLB } from './skin_lib.mjs'
import { buttockBottom, pelvisMask, measureSeatSpot, seatedPoses, seatedRoot, SEAT_BOTTOM_PADDING } from '../src/systems/seating.ts'
import { SEATS } from '../src/data/service.ts'

const OLD = { chairOffset: 0.39, seatY: 0.31, hipPadding: 0.1 }
const M = 'public/assets/models/'
const HEIGHT = 1.05

// --- tables, as CafeScene.loadEnvironment builds them (fit y to 0.74, bottom-centre on the placement)
const tableGlb = await loadGLB(M + 'prop_table_dining.glb')
const tbox = new THREE.Box3().setFromObject(tableGlb.scene)
const tsize = tbox.getSize(new THREE.Vector3())
const tcentre = tbox.getCenter(new THREE.Vector3())
const tscale = 0.74 / tsize.y
const scene = new THREE.Scene()
const tables = [
  [-2.3, 0.9],
  [-2.3, 2.9],
  [0.7, 1.9],
].map(([x, z]) => {
  const model = tableGlb.scene.clone()
  model.scale.setScalar(tscale)
  model.position.set(-tcentre.x * tscale, -tbox.min.y * tscale, -tcentre.z * tscale)
  const holder = new THREE.Group()
  holder.name = 'prop_table_dining'
  holder.add(model)
  holder.position.set(x, 0, z)
  scene.add(holder)
  holder.updateMatrixWorld(true)
  return holder
})

// --- measured seats
const spots = SEATS.map((s, i) => {
  const holder = tables[Math.floor(i / 2)]
  const side = i % 2 === 0 ? -1 : 1
  const spot = measureSeatSpot(holder, s.table[0], s.table[2], side)
  if (!spot) throw new Error('no seat spot ' + i)
  return spot
})
const f3 = (n) => n.toFixed(3)
console.log('SEAT SPOTS (x/z relative to the table centre; y = cushion top)')
spots.forEach((p, i) => {
  const s = SEATS[i]
  const dx = (v) => f3(v - s.table[0])
  const dz = (v) => f3(v - s.table[2])
  console.log(
    `seat ${i}: centre dx=${dx(p.x)} dz=${dz(p.z)} y=${f3(p.y)} | cushion x[${dx(p.cushion.min.x)},${dx(p.cushion.max.x)}] z[${dz(p.cushion.min.z)},${dz(p.cushion.max.z)}] | backrest x[${dx(p.backrest.min.x)},${dx(p.backrest.max.x)}] z[${dz(p.backrest.min.z)},${dz(p.backrest.max.z)}] ytop=${f3(p.backrest.max.y)} | static pos=[${s.pos.join(', ')}]`,
  )
})

// --- customers, loaded like CafeScene.loadCharacter
function makeInPlace(clip) {
  const track = clip.tracks.find((t) => t.name.endsWith('Hips.position'))
  if (!track || track.values.length < 3) return
  const v = track.values
  const x0 = v[0]
  const z0 = v[2]
  for (let i = 0; i < v.length; i += 3) {
    v[i] = x0
    v[i + 2] = z0
  }
}
async function loadNpc(n) {
  const g = await loadGLB(`${M}npc_customer_0${n}.glb`)
  const model = g.scene
  const box = new THREE.Box3().setFromObject(model)
  const scale = HEIGHT / (box.max.y - box.min.y)
  model.scale.setScalar(scale)
  model.position.y = -box.min.y * scale
  const root = new THREE.Group()
  root.add(model)
  const mixer = new THREE.AnimationMixer(model)
  const actions = {}
  const walk = await loadGLB(`${M}anim_npc_0${n}_walk.glb`)
  const clips = await loadGLB(`${M}anim_npc_0${n}_clips.glb`)
  const add = (name, clip) => {
    makeInPlace(clip)
    actions[name] = mixer.clipAction(clip)
  }
  add('walk', walk.animations[0])
  for (const c of clips.animations) add(c.name.split('|').pop(), c)
  const meshes = []
  model.traverse((o) => {
    if (o.isSkinnedMesh) meshes.push(o)
  })
  let hipsBone
  model.traverse((o) => {
    if (o.isBone && o.name === 'Hips') hipsBone = o
  })
  // standing hip height (idle t=0), like loadCharacter
  actions.idle.play()
  mixer.update(0)
  root.updateMatrixWorld(true)
  const hipHeight = hipsBone.getWorldPosition(new THREE.Vector3()).y
  const first = (a) => a.getClip().tracks.find((t) => t.name.endsWith('Hips.position')).values[1]
  const seatedHipHeight = hipHeight * (first(actions.sitIdle) / first(actions.idle))
  return { root, mixer, actions, meshes, masks: meshes.map(pelvisMask), hipsBone, hipHeight, seatedHipHeight }
}

function evaluate(c, spot, rootPos, yawDeg, clip = 'sitIdle') {
  const dur = c.actions[clip].getClip().duration
  let w = null
  for (let k = 0; k < 16; k++) {
    const e = evalAt(c, spot, rootPos, yawDeg, (dur * k) / 16, clip)
    if (!w) w = { ...e, lo: e.gapMin, hi: e.gapMin }
    else {
      w.lo = Math.min(w.lo, e.gapMin)
      w.hi = Math.max(w.hi, e.gapMin)
      w.hd = Math.max(w.hd, e.hd)
      for (const key of ['gapMin', 'gapQ']) if (Math.abs(e[key]) > Math.abs(w[key])) w[key] = e[key]
      for (const key of ['inBack', 'belowFloor', 'inCushion']) w[key] = Math.max(w[key], e[key])
    }
  }
  return w
}
function evalAt(c, spot, rootPos, yawDeg, t, clip) {
  c.mixer.stopAllAction()
  const a = c.actions[clip]
  a.reset()
  a.play()
  a.time = t
  c.mixer.update(0)
  c.root.position.copy(rootPos)
  c.root.rotation.y = THREE.MathUtils.degToRad(yawDeg)
  c.root.updateMatrixWorld(true)
  const hips = c.hipsBone.getWorldPosition(new THREE.Vector3())
  const hipsLocal = c.root.worldToLocal(hips.clone())
  const v = new THREE.Vector3()
  const pts = []
  let inBack = 0
  let belowFloor = 0
  let inCushion = 0
    const cb = spot.cushion
  for (const [mi, m] of c.meshes.entries()) {
    m.skeleton.update()
    const n = m.geometry.attributes.position.count
    for (let i = 0; i < n; i++) {
      m.getVertexPosition(i, v)
      v.applyMatrix4(m.matrixWorld)
      if (v.y < 0) belowFloor++
      if (spot.backrest.containsPoint(v)) inBack++
      if (v.x >= cb.min.x && v.x <= cb.max.x && v.z >= cb.min.z && v.z <= cb.max.z && v.y < spot.y - 0.003 && v.y > spot.y - 0.027) inCushion++
      if (c.masks[mi][i]) pts.push(c.root.worldToLocal(v.clone()))
    }
  }
  const bottom = buttockBottom(pts, hipsLocal) + c.root.position.y
  const lowest = Math.min(...pts.filter((p) => p.y < hipsLocal.y && p.y > hipsLocal.y - 0.3 && p.z < hipsLocal.z + 0.03).map((p) => p.y)) + c.root.position.y
  const hd = Math.hypot(hips.x - spot.x, hips.z - spot.z)
  return { hd, gapMin: lowest - spot.y, gapQ: bottom - spot.y, inBack, belowFloor, inCushion }
}

const cm = (m) => (m * 100).toFixed(1).padStart(6)
const rows = []
for (let n = 1; n <= 6; n++) {
  const c = await loadNpc(n)
  const poses = seatedPoses(c)
  {
    const f = (p) => `hips(${cm(p.hips.x)},${cm(p.hips.y)},${cm(p.hips.z)}) bottom ${cm(p.bottomY)} drop ${cm(p.hips.y - p.bottomY)}`
    console.log(`npc ${n} poses (cm, root-local): sitIdle ${f(poses.sitIdle)} | drink ${f(poses.drink)} | sitDownEnd ${f(poses.sitDownEnd)} | standUpStart ${f(poses.standUpStart)}`)
  }
  for (let i = 0; i < SEATS.length; i++) {
    const s = SEATS[i]
    const side = i % 2 === 0 ? -1 : 1
    // old: root at the static seat x/z (table +- 0.39), y = 0.31 + 0.1 - seatedHipHeight; judged against the measured chair
    const oldRoot = new THREE.Vector3(s.table[0] + side * OLD.chairOffset, OLD.seatY + OLD.hipPadding - c.seatedHipHeight, s.table[2])
    const before = evaluate(c, spots[i], oldRoot, s.yaw)
    const after = evaluate(c, spots[i], seatedRoot(spots[i], s.yaw, poses.sitIdle), s.yaw)
    const drink = evaluate(c, spots[i], seatedRoot(spots[i], s.yaw, poses.drink), s.yaw, 'drink')
    rows.push({ n, i, before, after, drink })
  }
  for (const k of ['drink', 'sitDownEnd', 'standUpStart']) {
    const r1 = seatedRoot(spots[0], 90, poses.sitIdle)
    const r2 = seatedRoot(spots[0], 90, poses[k])
    console.log(`  npc ${n} root shift sitIdle -> ${k}: dx ${cm(r2.x - r1.x)} dy ${cm(r2.y - r1.y)} dz ${cm(r2.z - r1.z)} cm`)
  }
}
console.log(`\nSEAT_BOTTOM_PADDING=${SEAT_BOTTOM_PADDING}`)
console.log('(worst case over 8 samples of the sitIdle loop) cols: hips-to-seat-centre horizontal cm | buttock-bottom minus cushion cm (lowest rear-lower vertex, buttockBottom() = what the placement uses) | skinned verts in backrest | below floor | inside cushion')
console.log('npc seat |  BEFORE (old placement)                 ||  AFTER')
const fmt = (e) => `${cm(e.hd)} | ${cm(e.gapMin)} ${cm(e.gapQ)} | ${String(e.inBack).padStart(4)} ${String(e.belowFloor).padStart(4)} ${String(e.inCushion).padStart(4)}`
for (const r of rows) console.log(`${r.n}   ${r.i}    | ${fmt(r.before)}  ||  ${fmt(r.after)}`)
const worst = (k, sel) => Math.max(...rows.map((r) => Math.abs(sel(r[k]))))
for (const r of rows) if (r.i === 0) console.log(`drink npc ${r.n} seat0: bottom gap ${cm(r.drink.gapMin)} cm (min) ${cm(r.drink.gapQ)} (q)`)
for (const r of rows) if (r.i === 0) console.log(`npc ${r.n} lowest-vertex gap over clip cm: sitIdle [${cm(r.after.lo)},${cm(r.after.hi)}] drink [${cm(r.drink.lo)},${cm(r.drink.hi)}]`)
console.log(`drink worst min-gap ${cm(Math.min(...rows.map((r) => r.drink.gapMin)))} cm`)
console.log(`AFTER worst: hips ${cm(worst('after', (e) => e.hd))} cm, bottom gap ${cm(worst('after', (e) => e.gapMin))} cm (min) ${cm(worst('after', (e) => e.gapQ))} cm (q)`)
