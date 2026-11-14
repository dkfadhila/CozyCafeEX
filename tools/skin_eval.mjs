// Compares skin-weight variants of the female chef: worst triangle-edge stretch per clip, over the whole
// mesh and inside the hair/shoulder region only (bind pose y >= 60 cm and |x| <= 30 cm, both edge ends).
// usage: node tools/skin_eval.mjs [original prev new ...]
import * as THREE from 'three'
import { loadGLB } from './skin_lib.mjs'

const VARIANTS = {
  original: async () => () => null,
  prev: async () => (await import('./skinfix_prev.ts')).applySkinFix,
  new: async () => (await import('../src/assets/skinFixes.ts')).applySkinFix,
}
const dir = 'public/assets/models/'
const SAMPLES = 48
const REGION = (x, y) => y >= 60 && Math.abs(x) <= 30

const clipFiles = { walk: 'walk', idle: 'clips', cheer: 'clips', cook: 'cook', pickup: 'pickup' }
const clips = {}
for (const f of new Set(Object.values(clipFiles))) {
  const a = await loadGLB(dir + `anim_chef_female_${f}.glb`)
  for (const c of a.animations) clips[f === 'walk' ? 'walk' : c.name.split('|').pop()] = c
}

export async function evaluate(name) {
  const apply = await VARIANTS[name]()
  const g = await loadGLB(dir + 'char_chef_female.glb')
  let mesh
  g.scene.traverse((o) => { if (o.isSkinnedMesh) mesh = o })
  g.scene.updateMatrixWorld(true)
  mesh.skeleton.update()
  const bindPos = new Float32Array(mesh.geometry.attributes.position.count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < bindPos.length / 3; i++) { mesh.getVertexPosition(i, v); bindPos.set([v.x, v.y, v.z], i * 3) }
  const report = apply('femaleChef', g.scene)
  const idx = mesh.geometry.index.array
  const tris = idx.length / 3
  const set = new Set()
  const E = []
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k]
      const b = idx[t + ((k + 1) % 3)]
      const key = a < b ? a * 1e6 + b : b * 1e6 + a
      if (!set.has(key)) { set.add(key); E.push(Math.min(a, b), Math.max(a, b)) }
    }
  }
  const inReg = (i) => REGION(bindPos[i * 3], bindPos[i * 3 + 1])
  const mixer = new THREE.AnimationMixer(g.scene)
  const res = { tris, report, clips: {} }
  for (const [cname, clip] of Object.entries(clips)) {
    const act = mixer.clipAction(clip)
    act.play()
    let worst = 1
    let worstReg = 1
    for (let s = 0; s < SAMPLES; s++) {
      act.time = (s / SAMPLES) * clip.duration
      mixer.update(0)
      g.scene.updateMatrixWorld(true)
      mesh.skeleton.update()
      const cur = new Float32Array(bindPos.length)
      for (let i = 0; i < bindPos.length / 3; i++) { mesh.getVertexPosition(i, v); cur.set([v.x, v.y, v.z], i * 3) }
      for (let e = 0; e < E.length; e += 2) {
        const a = E[e]
        const b = E[e + 1]
        const l0 = Math.hypot(bindPos[a * 3] - bindPos[b * 3], bindPos[a * 3 + 1] - bindPos[b * 3 + 1], bindPos[a * 3 + 2] - bindPos[b * 3 + 2])
        if (l0 <= 0.3) continue
        const r = Math.hypot(cur[a * 3] - cur[b * 3], cur[a * 3 + 1] - cur[b * 3 + 1], cur[a * 3 + 2] - cur[b * 3 + 2]) / l0
        if (r > worst) worst = r
        if (r > worstReg && inReg(a) && inReg(b)) worstReg = r
      }
    }
    act.stop()
    res.clips[cname] = { all: +worst.toFixed(2), region: +worstReg.toFixed(2) }
  }
  return res
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : ['original', 'prev', 'new']
for (const n of names) {
  const r = await evaluate(n)
  console.log(`== ${n}: triangles ${r.tris}  report ${JSON.stringify(r.report)}`)
  console.log('   clip     whole  region')
  for (const [c, x] of Object.entries(r.clips)) console.log(`   ${c.padEnd(8)} ${String(x.all).padStart(5)}  ${String(x.region).padStart(5)}`)
}
