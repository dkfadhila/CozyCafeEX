// UV error (in texels of the atlas) between original and compressed GLB. Meshopt reorders vertices, so each original
// vertex is matched to the compressed vertex at the same position (within tolerance) with the closest UV.
// usage: node tools/uv_error.mjs <name> ...  [--dst dir]
import path from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
const di = process.argv.indexOf('--dst')
const dst = di >= 0 ? process.argv[di + 1] : 'public/assets/models'
const names = process.argv.slice(2).filter((a, i, arr) => a !== '--dst' && arr[i - 1] !== '--dst')
// [primitive, world matrix] pairs (meshopt quantization moves the dequantize scale/offset into the node transform)
const prims = (d) => d.getRoot().listNodes().filter((n) => n.getMesh()).flatMap((n) => n.getMesh().listPrimitives().map((p) => ({ p, m: n.getWorldMatrix() })))
const xf = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]]
for (const name of names) {
  const a = await io.read(path.join('../generated/models_original', name + '.glb'))
  const b = await io.read(path.join(dst, name + '.glb'))
  const W = a.getRoot().listTextures()[0].getSize()[0]
  let max = 0, sum = 0, n = 0, unmatched = 0
  const pa = prims(a), pb = prims(b)
  pa.forEach(({ p, m: ma }, k) => {
    const Pa = p.getAttribute('POSITION'), ua = p.getAttribute('TEXCOORD_0')
    const mb = pb[k].m, Pb = pb[k].p.getAttribute('POSITION'), ub = pb[k].p.getAttribute('TEXCOORD_0')
    const cell = 1e-3
    const grid = new Map()
    let v = [0, 0, 0]; const t = [0, 0]
    for (let i = 0; i < Pb.getCount(); i++) {
      Pb.getElement(i, v); v = xf(mb, v)
      const key = v.map((x) => Math.round(x / cell)).join(',')
      ;(grid.get(key) ?? grid.set(key, []).get(key)).push(i)
    }
    const u = [0, 0]
    for (let i = 0; i < Pa.getCount(); i++) {
      Pa.getElement(i, v); v = xf(ma, v); ua.getElement(i, u)
      const c = v.map((x) => Math.round(x / cell))
      let best = Infinity
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const j of grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? []) {
          ub.getElement(j, t)
          best = Math.min(best, Math.hypot(u[0] - t[0], u[1] - t[1]) * W)
        }
      }
      if (best === Infinity) { unmatched++; continue }
      max = Math.max(max, best); sum += best; n++
    }
  })
  console.log(name.padEnd(30), 'uvErr texels max', max.toFixed(3), 'mean', (sum / n).toFixed(3), 'unmatched', unmatched)
}
