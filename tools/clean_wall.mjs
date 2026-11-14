// Cleans the Meshy cafe wall panel (env_cafe_wall_plain): the cream upper part had a slightly bumpy mesh (+-2.5 mm on a
// 1 m panel, which the game's 14.5x depth stretch turned into 4 cm creases) and a patchy/streaky painted texture.
//  1. geometry: vertices with y >= CUT are snapped onto two flat planes (front/back), normals onto the dominant axis.
//  2. texture: every UV triangle lying entirely in that region is repainted with the dominant cream (+-1 % noise).
// usage: node tools/clean_wall.mjs <in.glb (PNG texture)> <out.glb> [--debug-png <file>]
import fs from 'node:fs'
import { decodePNG, encodePNG } from './render_lib.mjs'

const CUT = 0.36 // normalised panel height (0 = floor edge .. 1 = top) above which the surface is plain cream wall
const [src, dst] = process.argv.slice(2)
const b = fs.readFileSync(src)
const jl = b.readUInt32LE(12)
const json = JSON.parse(b.toString('utf8', 20, 20 + jl))
const bin = Buffer.from(b.subarray(28 + jl, 28 + jl + b.readUInt32LE(20 + jl)))
const prim = json.meshes[0].primitives[0]
const acc = (i) => {
  const a = json.accessors[i]
  const v = json.bufferViews[a.bufferView]
  const off = (v.byteOffset ?? 0) + (a.byteOffset ?? 0)
  return { a, off, n: a.count, comp: { SCALAR: 1, VEC2: 2, VEC3: 3 }[a.type], stride: (v.byteStride ?? 0) / 4 }
}
// Strided float view: get(i, c) / set(i, c, v) (the Meshy export interleaves position/uv/normal at stride 32)
const attr = (x) => {
  const base = (bin.byteOffset + x.off) / 4
  const all = new Float32Array(bin.buffer)
  const st = x.stride || x.comp
  return { get: (i, c) => all[base + i * st + c], set: (i, c, v) => { all[base + i * st + c] = v } }
}
const P = acc(prim.attributes.POSITION)
const N = acc(prim.attributes.NORMAL)
const UVa = acc(prim.attributes.TEXCOORD_0)
const I = acc(prim.indices)
const pa = attr(P), na = attr(N), ua = attr(UVa)
const idx = I.a.componentType === 5125 ? new Uint32Array(bin.buffer, bin.byteOffset + I.off, I.n) : new Uint16Array(bin.buffer, bin.byteOffset + I.off, I.n)
const ymin = P.a.min[1], ymax = P.a.max[1]
const hy = (i) => (pa.get(i, 1) - ymin) / (ymax - ymin)

// ---- geometry
const front = [], back = []
for (let i = 0; i < P.n; i++) if (hy(i) >= CUT) (na.get(i, 2) > 0 ? front : back).push(pa.get(i, 2))
const med = (a) => a.sort((x, y) => x - y)[a.length >> 1]
const zF = med(front), zB = med(back)
for (let i = 0; i < P.n; i++) {
  if (hy(i) < CUT) continue
  const nz = na.get(i, 2)
  pa.set(i, 2, Math.abs(nz) > 0.5 ? (nz > 0 ? zF : zB) : pa.get(i, 2) > (zF + zB) / 2 ? zF : zB) // x/y faces: nearest plane
  const n = [na.get(i, 0), na.get(i, 1), na.get(i, 2)]
  const d = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)))
  for (let c = 0; c < 3; c++) na.set(i, c, c === d ? Math.sign(n[d]) : 0)
}
console.log('planes', zF, zB)

// ---- texture
const imgIdx = json.textures[json.materials[0].pbrMetallicRoughness.baseColorTexture.index].source
const view = json.bufferViews[json.images[imgIdx].bufferView]
const tex = decodePNG(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength))
const W = tex.w, H = tex.h
const kind = new Uint8Array(W * H) // 1 = cream-only texel, 2 = touched by another triangle
const tris = []
for (let t = 0; t < idx.length; t += 3) {
  const cream = [0, 1, 2].every((k) => hy(idx[t + k]) >= CUT)
  tris.push(cream)
}
const raster = (t, cons, fn) => {
  const p = [0, 1, 2].map((k) => [ua.get(idx[t + k], 0) * W, ua.get(idx[t + k], 1) * H])
  const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])
  if (!area) return
  const e = cons / Math.sqrt(Math.abs(area) + 1e-9) // conservative slack in barycentric units, ~cons px on large tris
  const minx = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0]) - cons))
  const maxx = Math.min(W - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0]) + cons))
  const miny = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1]) - cons))
  const maxy = Math.min(H - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1]) + cons))
  for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
    const px = x + 0.5, py = y + 0.5
    const w0 = ((p[1][0] - px) * (p[2][1] - py) - (p[2][0] - px) * (p[1][1] - py)) / area
    const w1 = ((p[2][0] - px) * (p[0][1] - py) - (p[0][0] - px) * (p[2][1] - py)) / area
    if (w0 >= -e && w1 >= -e && w0 + w1 <= 1 + e) fn(y * W + x)
  }
}
// other triangles claim their texels exactly (no slack), cream triangles paint with 1.5 px slack where unclaimed
for (let q = 0; q < tris.length; q++) if (!tris[q]) raster(q * 3, 0, (i) => { kind[i] = 2 })
const mask = new Uint8Array(W * H)
for (let q = 0; q < tris.length; q++) if (tris[q]) raster(q * 3, 1.5, (i) => { if (kind[i] !== 2) mask[i] = 1 })
// dominant cream: median of the mask texels that already are cream-ish (bright, warm)
const samples = [[], [], []]
for (let i = 0; i < W * H; i += 7) {
  if (!mask[i]) continue
  const r = tex.data[i * 4], g = tex.data[i * 4 + 1], bl = tex.data[i * 4 + 2]
  if (r > 215 && r - bl > 40) { samples[0].push(r); samples[1].push(g); samples[2].push(bl) }
}
const cream = samples.map(med)
console.log('cream', cream, 'samples', samples[0].length)
let s = 12345
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5)
let painted = 0
for (let i = 0; i < W * H; i++) {
  if (!mask[i]) continue
  const k = 1 + rnd() * 0.02 // +-1 %
  for (let c = 0; c < 3; c++) tex.data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(cream[c] * k)))
  tex.data[i * 4 + 3] = 255
  painted++
}
console.log('painted texels', painted)
// ---- UV remap: every cream triangle samples one small flat-cream patch (1 m = S px), so no thin chart / chart border can show
const PATCH = 100, S = 36
let cx = -1, cy = -1
search: for (let y = 0; y < H - PATCH; y += 8) for (let x = 0; x < W - PATCH; x += 8) {
  let ok = true
  for (let j = 0; j < PATCH && ok; j += 4) for (let i = 0; i < PATCH; i += 4) if (!mask[(y + j) * W + x + i]) { ok = false; break }
  if (ok) { cx = x + PATCH / 2; cy = y + PATCH / 2; break search }
}
if (cx < 0) throw new Error('no free cream block for the patch')
console.log('patch centre', cx, cy)
const usedByOther = new Set()
tris.forEach((c, q) => { if (!c) for (let k = 0; k < 3; k++) usedByOther.add(idx[q * 3 + k]) })
const stride = (json.bufferViews[P.a.bufferView].byteStride)
const vview = json.bufferViews[P.a.bufferView]
const vbase = vview.byteOffset ?? 0
const extra = []
const dup = new Map()
const setUv = (rec) => {
  // rec: Buffer record; position at record offsets from accessor offsets
  const px = rec.readFloatLE(P.a.byteOffset ?? 0), py = rec.readFloatLE((P.a.byteOffset ?? 0) + 4)
  rec.writeFloatLE((cx + px * S) / W, UVa.a.byteOffset ?? 0)
  rec.writeFloatLE((cy + (py + 0.5) * S) / H, (UVa.a.byteOffset ?? 0) + 4)
}
for (let q = 0; q < tris.length; q++) {
  if (!tris[q]) continue
  for (let k = 0; k < 3; k++) {
    const i = idx[q * 3 + k]
    if (!usedByOther.has(i)) { const o = vbase + i * stride; setUv(bin.subarray(o, o + stride)); continue }
    if (!dup.has(i)) {
      const rec = Buffer.from(bin.subarray(vbase + i * stride, vbase + (i + 1) * stride))
      setUv(rec)
      dup.set(i, P.n + extra.length)
      extra.push(rec)
    }
    idx[q * 3 + k] = dup.get(i)
  }
}
console.log('duplicated verts', extra.length)
// winding fix: a flat-region triangle whose geometric normal opposes its vertex normal renders as a dark hairline
let flipped = 0
const vpos = (i, c) => (i < P.n ? pa.get(i, c) : extra[i - P.n].readFloatLE((P.a.byteOffset ?? 0) + c * 4))
const vnor = (i, c) => (i < P.n ? na.get(i, c) : extra[i - P.n].readFloatLE((N.a.byteOffset ?? 0) + c * 4))
for (let q = 0; q < tris.length; q++) {
  if (!tris[q]) continue
  const [a, b, c] = [0, 1, 2].map((k) => idx[q * 3 + k])
  const e1 = [0, 1, 2].map((d) => vpos(b, d) - vpos(a, d)), e2 = [0, 1, 2].map((d) => vpos(c, d) - vpos(a, d))
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  if (n[0] * vnor(a, 0) + n[1] * vnor(a, 1) + n[2] * vnor(a, 2) < 0) { idx[q * 3 + 1] = c; idx[q * 3 + 2] = b; flipped++ }
}
console.log('flipped triangles', flipped)
// patch texels: flat cream with +-1 % noise
for (let y = cy - PATCH / 2; y < cy + PATCH / 2; y++) for (let x = cx - PATCH / 2; x < cx + PATCH / 2; x++) {
  const k = 1 + rnd() * 0.02
  for (let c = 0; c < 3; c++) tex.data[(y * W + x) * 4 + c] = Math.min(255, Math.round(cream[c] * k))
}

// ---- write: keep every bufferView, replace the image's bytes (re-pack, 4-byte aligned)
const png = encodePNG(W, H, tex.data)
const order = json.bufferViews.map((v, i) => ({ i, off: v.byteOffset ?? 0 })).sort((a, c) => a.off - c.off)
const parts = []
let at = 0
const old = json.bufferViews.map((v) => bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength))
for (const { i } of order) {
  const data = i === json.images[imgIdx].bufferView ? png : i === P.a.bufferView ? Buffer.concat([old[i], ...extra]) : old[i]
  const pad = (4 - (at % 4)) % 4
  if (pad) { parts.push(Buffer.alloc(pad)); at += pad }
  json.bufferViews[i].byteOffset = at
  json.bufferViews[i].byteLength = data.length
  parts.push(Buffer.from(data)); at += data.length
}
json.buffers[0].byteLength = at
// position accessor bounds changed
const mn = [9, 9, 9], mx = [-9, -9, -9]
for (let i = 0; i < P.n; i++) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], pa.get(i, c)); mx[c] = Math.max(mx[c], pa.get(i, c)) }
P.a.min = mn; P.a.max = mx
for (const x of [P, N, UVa]) x.a.count += extra.length
// positions/normals were edited in place in `bin` BEFORE re-pack, so `old` views (subarrays of bin) already carry them
const padB = (buf, fill) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4, fill)])
const js = padB(Buffer.from(JSON.stringify(json)), 0x20)
const bn = padB(Buffer.concat(parts), 0)
const head = Buffer.alloc(12)
head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bn.length, 8)
const ch = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.write(type, 4, 'latin1'); return h }
fs.writeFileSync(dst, Buffer.concat([head, ch(js.length, 'JSON'), js, ch(bn.length, 'BIN\0'), bn]))
fs.writeFileSync(process.argv[4] ?? dst + '.png', png)
