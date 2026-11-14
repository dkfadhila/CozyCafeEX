// CPU-skinning stretch analysis of a chef: poses every clip at sampled times and reports the worst
// triangle edge stretch against the bind pose, plus which bones the offending vertices use.
// usage: node tools/analyze_skin.mjs <male|female> [--fix]   (--fix applies the femaleChef runtime fix first) [--dir public/assets/models]
import * as THREE from 'three'
import { loadGLB, measure } from './skin_lib.mjs'
let applySkinFix = () => null
if (process.argv.includes('--fix')) ({ applySkinFix } = await import('../src/assets/skinFixes.ts'))

const who = process.argv[2] ?? 'female'
const useFix = process.argv.includes('--fix')
const di = process.argv.indexOf('--dir')
const dir = (di >= 0 ? process.argv[di + 1] : 'public/assets/models') + '/'
const g = await loadGLB(dir + `char_chef_${who}.glb`)
const mesh = (() => { let m; g.scene.traverse((o) => { if (o.isSkinnedMesh) m = o }); return m })()
if (useFix) console.log('fix report', JSON.stringify(applySkinFix('femaleChef', g.scene)))
const names = mesh.skeleton.bones.map((b) => b.name)
const geo = mesh.geometry
const pos = geo.attributes.position
const si = geo.attributes.skinIndex
const sw = geo.attributes.skinWeight
const idx = geo.index.array
// Reference pose: the skinned vertex positions in the rest pose (before any clip). Reading raw
// attribute values would be wrong: meshopt may have quantized them (normalised, with the scale on the node).
g.scene.updateMatrixWorld(true)
mesh.skeleton.update()
const bind = new Float32Array(pos.count * 3)
{
  const v = new THREE.Vector3()
  const box = new THREE.Box3()
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, v)
    box.expandByPoint(v)
    bind[i * 3] = v.x
    bind[i * 3 + 1] = v.y
    bind[i * 3 + 2] = v.z
  }
  console.log('rest bbox', box.min.toArray().map((n) => +n.toFixed(3)), box.max.toArray().map((n) => +n.toFixed(3)))
}
// Unique edges
const set = new Set()
const edges = []
for (let t = 0; t < idx.length; t += 3) {
  for (let k = 0; k < 3; k++) {
    const a = idx[t + k], b = idx[t + (k + 1) % 3]
    const key = a < b ? a * 1e6 + b : b * 1e6 + a
    if (!set.has(key)) { set.add(key); edges.push(Math.min(a, b), Math.max(a, b)) }
  }
}
const E = Uint32Array.from(edges)

const clips = []
for (const f of ['walk', 'clips', 'cook', 'pickup']) {
  const a = await loadGLB(dir + `anim_chef_${who}_${f}.glb`)
  for (const c of a.animations) clips.push([c.name.split('|').pop(), c])
}
const mixer = new THREE.AnimationMixer(g.scene)
const bind0 = bind
const summary = {}
const vertWorst = new Float32Array(pos.count) // worst incident-edge stretch per vertex over all samples
for (const [name, clip] of clips) {
  const act = mixer.clipAction(clip)
  act.play()
  let worst = 1, worstT = 0, wEdge = -1, wStretch
  const N = 48
  for (let s = 0; s < N; s++) {
    const t = (s / N) * clip.duration
    act.time = t
    mixer.update(0)
    g.scene.updateMatrixWorld(true)
    mesh.skeleton.update()
    const r = measure(mesh, bind0, E, 1)
    for (let e = 0; e < E.length; e += 2) {
      const x = r.stretch[e / 2]
      if (x > vertWorst[E[e]]) vertWorst[E[e]] = x
      if (x > vertWorst[E[e + 1]]) vertWorst[E[e + 1]] = x
    }
    if (r.worst > worst) { worst = r.worst; worstT = t; wEdge = r.worstEdge; wStretch = r.stretch }
  }
  act.stop()
  // which bones does the worst edge use?
  const desc = (v) => {
    const o = []
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(v, k); if (w > 0.01) o.push(`${names[si.getComponent(v, k)]}:${w.toFixed(2)}`) }
    return `v${v}@(${[0, 1, 2].map((c) => bind0[v * 3 + c].toFixed(2))}) [${o.join(' ')}]`
  }
  summary[name] = worst
  console.log(`${name.padEnd(8)} worst edge stretch x${worst.toFixed(2)} at t=${worstT.toFixed(2)}`)
  if (wEdge >= 0) console.log('   ', desc(E[wEdge * 2]), '\n   ', desc(E[wEdge * 2 + 1]))
  // count of edges with stretch > 2 and > 3
  let c2 = 0, c3 = 0
  const st = wStretch
  if (st) for (const x of st) { if (x > 2) c2++; if (x > 3) c3++ }
  console.log(`    edges>2x: ${c2}  >3x: ${c3} (at worst sample)`)
}
// Offending vertices (stretch > 2.5x in any clip): group by their dominant bone set.
const groups = new Map()
let bad = 0
for (let v = 0; v < pos.count; v++) {
  if (vertWorst[v] <= 2.5) continue
  bad++
  const bs = []
  for (let k = 0; k < 4; k++) if (sw.getComponent(v, k) > 0.05) bs.push(names[si.getComponent(v, k)])
  const key = bs.sort().join('+')
  const e = groups.get(key) ?? { n: 0, max: 0, y: 0 }
  e.n++
  e.max = Math.max(e.max, vertWorst[v])
  e.y += bind[v * 3 + 1]
  groups.set(key, e)
}
console.log(`vertices with an incident edge stretched >2.5x in some clip: ${bad}`)
for (const [k, e] of [...groups].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) console.log(`   ${String(e.n).padStart(4)}  max x${e.max.toFixed(1)}  meanY ${(e.y / e.n).toFixed(0)}cm  ${k}`)
console.log('SUMMARY', JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, +v.toFixed(2)]))))
