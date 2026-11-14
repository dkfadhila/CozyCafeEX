import * as THREE from 'three'
import { loadGLB } from './skin_lib.mjs'
const which = process.argv[2] ?? 'new'
const apply = which === 'new' ? (await import('../src/assets/skinFixes.ts')).applySkinFix : which === 'prev' ? (await import('./skinfix_prev.ts')).applySkinFix : () => null
const g = await loadGLB('public/assets/models/char_chef_female.glb')
let mesh
g.scene.traverse((o) => { if (o.isSkinnedMesh) mesh = o })
g.scene.updateMatrixWorld(true)
mesh.skeleton.update()
const names = mesh.skeleton.bones.map((b) => b.name)
const geo = mesh.geometry
const n = geo.attributes.position.count
const v = new THREE.Vector3()
const bind = new Float32Array(n * 3)
for (let i = 0; i < n; i++) { mesh.getVertexPosition(i, v); bind.set([v.x, v.y, v.z], i * 3) }
apply('femaleChef', g.scene)
const a = await loadGLB('public/assets/models/anim_chef_female_clips.glb')
const clip = a.animations.find((c) => c.name === (process.argv[3] ?? 'cheer'))
const mixer = new THREE.AnimationMixer(g.scene)
const act = mixer.clipAction(clip)
act.play()
const idx = geo.index.array
const worst = new Map()
for (let s = 0; s < 48; s++) {
  act.time = (s / 48) * clip.duration
  mixer.update(0)
  g.scene.updateMatrixWorld(true)
  mesh.skeleton.update()
  const cur = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { mesh.getVertexPosition(i, v); cur.set([v.x, v.y, v.z], i * 3) }
  for (let t = 0; t < idx.length; t += 3) for (let e = 0; e < 3; e++) {
    const p = idx[t + e], q = idx[t + (e + 1) % 3]
    const l0 = Math.hypot(bind[p * 3] - bind[q * 3], bind[p * 3 + 1] - bind[q * 3 + 1], bind[p * 3 + 2] - bind[q * 3 + 2])
    if (l0 <= 0.3) continue
    const r = Math.hypot(cur[p * 3] - cur[q * 3], cur[p * 3 + 1] - cur[q * 3 + 1], cur[p * 3 + 2] - cur[q * 3 + 2]) / l0
    const key = Math.min(p, q) * 100000 + Math.max(p, q)
    if (r > (worst.get(key) ?? 0)) worst.set(key, r)
  }
}
const desc = (i) => {
  const o = []
  for (let k = 0; k < 4; k++) { const w = geo.attributes.skinWeight.getComponent(i, k); if (w > 0.01) o.push(`${names[geo.attributes.skinIndex.getComponent(i, k)]}:${w.toFixed(2)}`) }
  return `v${i}(${[0, 1, 2].map((c) => bind[i * 3 + c].toFixed(1))}) [${o.join(' ')}]`
}
for (const [key, r] of [...worst].sort((x, y) => y[1] - x[1]).slice(0, 8)) {
  const p = Math.floor(key / 100000), q = key % 100000
  console.log(r.toFixed(2), desc(p), '|', desc(q))
}
