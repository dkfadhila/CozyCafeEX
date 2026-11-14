// Zoomed crops at UV-island borders: original atlas vs the shipped (padded + WebP q95) atlas.
// usage: node tools/texture_compare.mjs <name> ...   (e.g. char_chef_female prop_kitchen_stove)
// Needs PNG-converted copies of both GLBs in ../generated/debug (made here with the glTF-Transform CLI).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { loadGLB } from './skin_lib.mjs'
import { blit, decodePNG, drawText, encodePNG, newImage } from './render_lib.mjs'

const dbg = '../generated/debug/'
const cli = (...a) => execFileSync('npx', ['--yes', '@gltf-transform/cli@4', ...a], { stdio: 'pipe', shell: true })
function tex(file) {
  const b = fs.readFileSync(file)
  const jl = b.readUInt32LE(12)
  const json = JSON.parse(b.toString('utf8', 20, 20 + jl))
  const bin = b.subarray(28 + jl)
  const bv = json.bufferViews[json.images[0].bufferView]
  return decodePNG(bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength))
}

for (const name of process.argv.slice(2)) {
  const o = `${dbg}${name}_o.glb`
  const n = `${dbg}${name}_n.glb`
  if (!fs.existsSync(o)) cli('png', `../generated/models_original/${name}.glb`, o, '--formats', '"*"')
  cli('png', `public/assets/models/${name}.glb`, n, '--formats', '"*"')
  const to = tex(o)
  const tn = tex(n)
  const W = to.w
  const H = to.h
  if (tn.w !== W) throw new Error(`size differs ${W} vs ${tn.w}`)
  // island id map from the original model's UVs (all meshes)
  const g = await loadGLB(`../generated/models_original/${name}.glb`)
  const map = new Int32Array(W * H).fill(-1)
  let nextId = 0
  g.scene.traverse((m) => {
    if (!m.isMesh) return
    const uv = m.geometry.attributes.uv
    const idx = m.geometry.index.array
    const parent = Array.from({ length: uv.count }, (_, i) => i)
    const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a }
    for (let t = 0; t < idx.length; t += 3) { parent[find(idx[t])] = find(idx[t + 1]); parent[find(idx[t + 1])] = find(idx[t + 2]) }
    const ids = new Map()
    for (let t = 0; t < idx.length; t += 3) {
      const root = find(idx[t])
      if (!ids.has(root)) ids.set(root, nextId++)
      const id = ids.get(root)
      const p = [0, 1, 2].map((k) => [uv.getX(idx[t + k]) * W, uv.getY(idx[t + k]) * H])
      const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])
      if (!area) continue
      for (let y = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1]))); y <= Math.min(H - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1]))); y++) {
        for (let x = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0]))); x <= Math.min(W - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0]))); x++) {
          const px = x + 0.5
          const py = y + 0.5
          const w0 = ((p[1][0] - px) * (p[2][1] - py) - (p[2][0] - px) * (p[1][1] - py)) / area
          const w1 = ((p[2][0] - px) * (p[0][1] - py) - (p[0][0] - px) * (p[2][1] - py)) / area
          if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) map[y * W + x] = id
        }
      }
    }
  })
  // block scores (B x B): texels next to a foreign island, and mean colour difference over covered texels
  const B = 64
  const blocks = []
  let covered = 0
  for (let by = 0; by + B <= H; by += B) {
    for (let bx = 0; bx + B <= W; bx += B) {
      let border = 0
      let diff = 0
      let cov = 0
      for (let y = by; y < by + B; y++) {
        for (let x = bx; x < bx + B; x++) {
          const id = map[y * W + x]
          if (id < 0) continue
          cov++
          for (let c = 0; c < 3; c++) diff += Math.abs(to.data[(y * W + x) * 4 + c] - tn.data[(y * W + x) * 4 + c])
          let near = false
          for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
            const X = x + dx
            const Y = y + dy
            if (X >= 0 && Y >= 0 && X < W && Y < H && map[Y * W + X] >= 0 && map[Y * W + X] !== id) { near = true; break }
          }
          if (near) border++
        }
      }
      covered += cov
      blocks.push({ bx, by, border, diff: cov ? diff / (cov * 3) : 0, cov })
    }
  }
  const crowded = blocks.filter((b) => b.cov > B * B * 0.4).sort((a, b) => b.border - a.border)[0]
  const worst = blocks.filter((b) => b.cov > B * B * 0.3).sort((a, b) => b.diff - a.diff)[0]
  const meanDiff = blocks.reduce((a, b) => a + b.diff * b.cov, 0) / (covered || 1)
  const Z = 6
  const picks = [['most borders', crowded], ['largest colour change', worst]].filter((p) => p[1])
  const sheet = newImage(2 * B * Z + 30, picks.length * (B * Z + 22) + 24, [40, 44, 52])
  drawText(sheet, `${name} ${W}px  left original  right shipped`, 8, 6, 2, [255, 255, 255])
  picks.forEach(([label, b], r) => {
    for (let side = 0; side < 2; side++) {
      const t = side ? tn : to
      const crop = { w: B * Z, h: B * Z, data: new Uint8Array(B * Z * B * Z * 4) }
      for (let y = 0; y < B * Z; y++) for (let x = 0; x < B * Z; x++) crop.data.set(t.data.subarray(((b.by + ((y / Z) | 0)) * W + b.bx + ((x / Z) | 0)) * 4, ((b.by + ((y / Z) | 0)) * W + b.bx + ((x / Z) | 0)) * 4 + 4), (y * B * Z + x) * 4)
      blit(sheet, crop, 10 + side * (B * Z + 10), 24 + r * (B * Z + 22) + 14)
    }
    drawText(sheet, `${label} at ${b.bx},${b.by}  mean err ${b.diff.toFixed(1)}`, 10, 24 + r * (B * Z + 22), 1, [255, 255, 160])
  })
  const out = `${dbg}texcmp_${name}.png`
  fs.writeFileSync(out, encodePNG(sheet.w, sheet.h, sheet.data))
  console.log(`${name}: ${W}px, covered mean abs error ${meanDiff.toFixed(2)}/255, worst block ${worst?.diff.toFixed(1)} -> ${out}`)
}
