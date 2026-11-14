// Per-model stats: texture slots/sizes, and normal discrepancy between coincident (same-position) vertices.
// usage: node tools/seam_stats.mjs [dir] [regex]
import fs from 'node:fs'
import path from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'

const dir = process.argv[2] ?? '../generated/models_original'
const only = process.argv[3] ? new RegExp(process.argv[3]) : /^(char|npc|prop|env|food)_/
await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.glb') && only.test(n) && !n.endsWith('_old.glb') && !n.endsWith('_meshy_original.glb'))) {
  const doc = await io.read(path.join(dir, f))
  const root = doc.getRoot()
  const imgs = root.listTextures().map((t) => `${t.getSize()?.join('x')}`)
  let verts = 0, groups = 0, creased = 0, sumAng = 0, maxAng = 0
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
    const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL')
    if (!P || !N) continue
    const n = P.getCount(); verts += n
    const m = new Map()
    const p = [0, 0, 0], q = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      P.getElement(i, p)
      const k = `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`
      ;(m.get(k) ?? m.set(k, []).get(k)).push(i)
    }
    for (const g of m.values()) {
      if (g.length < 2) continue
      groups++
      let mx = 0
      for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) {
        N.getElement(g[a], p); N.getElement(g[b], q)
        const d = Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]))
        mx = Math.max(mx, Math.acos(d) * 180 / Math.PI)
      }
      sumAng += mx; maxAng = Math.max(maxAng, mx)
      if (mx > 5) creased++
    }
  }
  console.log(f.padEnd(34), 'tex', imgs.join(','), 'verts', verts, 'splitGroups', groups, '>5deg', creased, 'meanMax', (sumAng / Math.max(1, groups)).toFixed(2), 'max', maxAng.toFixed(1))
}
