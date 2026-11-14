// Texture health check for a chef: extracts base-colour textures (original vs compressed, both as PNG) and measures
// how tightly the UV islands are packed (island-to-island gaps in texels at 1024 px => mip bleeding risk).
// usage: node tools/texture_check.mjs <name> [orig.glb-as-png] [compressed.glb-as-png]
// (inputs are PNG-converted copies made with `gltf-transform png --formats "*"`; see render_shoulders.mjs)
import fs from 'node:fs'
import { loadGLB } from './skin_lib.mjs'
import { decodePNG, encodePNG } from './render_lib.mjs'

const name = process.argv[2] ?? 'chef_female'
const dbg = '../generated/debug/'
const origGlb = process.argv[3] ?? `${dbg}${name}_orig.glb`
const compGlb = process.argv[4] ?? `${dbg}${name}_1024.glb`
const src = name.replace('chef_', 'char_chef_')

function rawTexture(file) {
  const b = fs.readFileSync(file)
  const jl = b.readUInt32LE(12)
  const json = JSON.parse(b.toString('utf8', 20, 20 + jl))
  const bin = b.subarray(20 + jl + 8)
  const bv = json.bufferViews[json.images[0].bufferView]
  return bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
}
const po = rawTexture(origGlb)
const pc = rawTexture(compGlb)
fs.writeFileSync(`${dbg}${name}_tex_original.png`, po)
fs.writeFileSync(`${dbg}${name}_tex_1024.png`, pc)
const to = decodePNG(po)
const tc = decodePNG(pc)
console.log(`original ${to.w}x${to.h}  compressed ${tc.w}x${tc.h}`)

// PSNR of the compressed texture vs the original box-downsampled to the same size
const f = to.w / tc.w
let se = 0
let n = 0
let worst = 0
for (let y = 0; y < tc.h; y++) {
  for (let x = 0; x < tc.w; x++) {
    for (let c = 0; c < 3; c++) {
      let a = 0
      for (let j = 0; j < f * f; j++) a += to.data[(((y * f + ((j / f) | 0)) * to.w) + x * f + (j % f)) * 4 + c]
      const d = a / (f * f) - tc.data[(y * tc.w + x) * 4 + c]
      se += d * d
      n++
      worst = Math.max(worst, Math.abs(d))
    }
  }
}
console.log(`PSNR vs box-downsampled original: ${(10 * Math.log10((255 * 255) / (se / n))).toFixed(1)} dB, worst channel error ${worst.toFixed(0)}`)

// UV island packing: rasterise triangle UVs into an island-id map at 1024 and measure gaps.
const g = await loadGLB(`public/assets/models/${src}.glb`)
let mesh
g.scene.traverse((o) => { if (o.isSkinnedMesh || o.isMesh) mesh ??= o })
const uv = mesh.geometry.attributes.uv
const idx = mesh.geometry.index.array
const R = 1024
// islands = connected components of triangles over shared UV vertex ids (uv-split vertices stay separate)
const parent = Array.from({ length: uv.count }, (_, i) => i)
const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a }
for (let t = 0; t < idx.length; t += 3) { parent[find(idx[t])] = find(idx[t + 1]); parent[find(idx[t + 1])] = find(idx[t + 2]) }
const ids = new Map()
const map = new Int32Array(R * R).fill(-1)
for (let t = 0; t < idx.length; t += 3) {
  const id = ids.get(find(idx[t])) ?? ids.set(find(idx[t]), ids.size).get(find(idx[t]))
  const p = [0, 1, 2].map((k) => [uv.getX(idx[t + k]) * R, uv.getY(idx[t + k]) * R])
  const minx = Math.max(0, Math.floor(Math.min(...p.map((q) => q[0]))))
  const maxx = Math.min(R - 1, Math.ceil(Math.max(...p.map((q) => q[0]))))
  const miny = Math.max(0, Math.floor(Math.min(...p.map((q) => q[1]))))
  const maxy = Math.min(R - 1, Math.ceil(Math.max(...p.map((q) => q[1]))))
  const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])
  if (!area) continue
  for (let y = miny; y <= maxy; y++) {
    for (let x = minx; x <= maxx; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const w0 = ((p[1][0] - px) * (p[2][1] - py) - (p[2][0] - px) * (p[1][1] - py)) / area
      const w1 = ((p[2][0] - px) * (p[0][1] - py) - (p[0][0] - px) * (p[2][1] - py)) / area
      if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) map[y * R + x] = id
    }
  }
}
let covered = 0
for (const v of map) if (v >= 0) covered++
console.log(`islands ${ids.size}, UV coverage at 1024: ${((covered / (R * R)) * 100).toFixed(1)}%`)
// For each covered texel: smallest radius at which a texel of a DIFFERENT island appears (<= 8)
const hist = new Array(9).fill(0)
for (let y = 0; y < R; y++) {
  for (let x = 0; x < R; x++) {
    const id = map[y * R + x]
    if (id < 0) continue
    let found = 0
    for (let r = 1; r <= 8 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const X = x + dx
          const Y = y + dy
          if (X < 0 || Y < 0 || X >= R || Y >= R) continue
          const o = map[Y * R + X]
          if (o >= 0 && o !== id) { found = r; break }
        }
      }
    }
    hist[found]++
  }
}
console.log('texels whose nearest foreign island is within r texels (1024 px):')
let cum = 0
for (let r = 1; r <= 8; r++) {
  cum += hist[r]
  console.log(`  r<=${r} (mip ${Math.ceil(Math.log2(r + 1))}): ${cum} texels = ${((cum / covered) * 100).toFixed(2)}%`)
}
// Dilated-gutter check: texture colour agreement along island borders original vs compressed is covered by PSNR above.
const img = new Uint8Array(R * R * 4)
for (let i = 0; i < R * R; i++) img.set(map[i] < 0 ? [20, 20, 20, 255] : [(map[i] * 67) % 255, (map[i] * 131) % 255, (map[i] * 29) % 255, 255], i * 4)
fs.writeFileSync(`${dbg}${name}_uv_islands.png`, encodePNG(R, R, img))
