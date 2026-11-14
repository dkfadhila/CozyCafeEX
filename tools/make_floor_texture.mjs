// Builds public/assets/textures/floor_checker.webp: a crisp, seamless 2x2-tile checker whose light/dark colours and
// grain strength are sampled from the Meshy floor (tools/render_floor_top.mjs renders it top-down first).
// usage: node tools/make_floor_texture.mjs [--size 1024]
import fs from 'node:fs'
import sharp from 'sharp'
import { decodePNG } from './render_lib.mjs'

const si = process.argv.indexOf('--size')
const N = si >= 0 ? Number(process.argv[si + 1]) : 1024
const top = decodePNG(fs.readFileSync('../generated/debug/floor_top_orig.png'))
// Tile grid measured on that render (1024 px = 1.04 m): columns at x~45..980 (6), rows at y~50..730 (4).
const X0 = 48, TW = 155.5, Y0 = 52, TH = 170
function stats(col, row) {
  const s = [[0, 0, 0], [0, 0, 0]]
  let n = 0
  const x0 = Math.round(X0 + col * TW + TW * 0.25), x1 = Math.round(X0 + (col + 1) * TW - TW * 0.25)
  const y0 = Math.round(Y0 + row * TH + TH * 0.25), y1 = Math.round(Y0 + (row + 1) * TH - TH * 0.25)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    n++
    for (let c = 0; c < 3; c++) { const v = top.data[(y * top.w + x) * 4 + c]; s[0][c] += v; s[1][c] += v * v }
  }
  return s[0].map((m, c) => ({ mean: m / n, std: Math.sqrt(Math.max(0, s[1][c] / n - (m / n) ** 2)) }))
}
const light = stats(0, 0) // tile (0,0) is light, (2,0) dark
const dark = stats(2, 0)
console.log('light', light.map((c) => c.mean.toFixed(1)), 'std', light.map((c) => c.std.toFixed(2)))
console.log('dark ', dark.map((c) => c.mean.toFixed(1)), 'std', dark.map((c) => c.std.toFixed(2)))

// periodic value noise (period divides N so the texture tiles)
const rnd = (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) })()
function lattice(cells) {
  const g = Float32Array.from({ length: cells * cells }, rnd)
  const sm = (t) => t * t * (3 - 2 * t)
  return (x, y) => {
    const fx = (x / N) * cells, fy = (y / N) * cells
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = sm(fx - ix), ty = sm(fy - iy)
    const at = (a, b) => g[(((b % cells) + cells) % cells) * cells + (((a % cells) + cells) % cells)]
    return (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty - 0.5
  }
}
const low = lattice(16)
const mid = lattice(128)
const GROUT = Math.max(2, Math.round(N / 340)) // px half-width of the grout line
const buf = Buffer.alloc(N * N * 3)
const half = N / 2
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const isLight = ((x < half) === (y < half)) // (0,0) light, (1,0) dark, (0,1) dark, (1,1) light
    const base = isLight ? light : dark
    // distance (px) to the nearest tile boundary, wrapping at the texture edge
    const bx = Math.min((x % half), half - 1 - (x % half))
    const by = Math.min((y % half), half - 1 - (y % half))
    const d = Math.min(bx, by)
    const grout = d < GROUT ? 0.16 * (1 - d / GROUT) : 0
    const mot = low(x, y) * 5 + mid(x, y) * 3 // soft mottling, in 8-bit levels
    const grain = (rnd() + rnd() + rnd() - 1.5) * 1.15 // approx gaussian, unit-ish
    for (let c = 0; c < 3; c++) {
      let v = base[c].mean + mot * (base[c].std > 0.5 ? 1 : 0.6) + grain * Math.max(base[c].std, 1.5) * 0.9
      v *= 1 - grout
      buf[(y * N + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v)))
    }
  }
}
const out = 'public/assets/textures/floor_checker.webp'
await sharp(buf, { raw: { width: N, height: N, channels: 3 } }).webp({ quality: 95 }).toFile(out)
console.log(`wrote ${out} ${(fs.statSync(out).size / 1024).toFixed(0)} KB`)
