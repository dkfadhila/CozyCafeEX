// Minimal CPU software renderer (z-buffer, bilinear texture, lambert) + PNG codec + 5x7 label font.
// Used to inspect skinned characters without a browser. No dependencies beyond node and three.
import fs from 'node:fs'
import zlib from 'node:zlib'

// ---------- PNG ----------
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (b) => {
  let c = 0xffffffff
  for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
export function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}
export function decodePNG(buf) {
  let p = 8
  let w = 0
  let h = 0
  let ct = 0
  let bd = 8
  let il = 0
  let plte = null
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    const d = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      w = d.readUInt32BE(0)
      h = d.readUInt32BE(4)
      bd = d[8]
      ct = d[9]
      il = d[12]
    } else if (type === 'PLTE') plte = d
    else if (type === 'IDAT') idat.push(d)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (bd !== 8 || il) throw new Error('unsupported PNG')
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct]
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const o = y * stride
    const s = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[o + x - ch] : 0
      const b = y ? out[o - stride + x] : 0
      const c = x >= ch && y ? out[o - stride + x - ch] : 0
      let v = raw[s + x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[o + x] = v & 255
    }
  }
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    let r
    let g
    let b
    let a = 255
    if (ct === 6) [r, g, b, a] = [out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]]
    else if (ct === 2) [r, g, b] = [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]
    else if (ct === 0) r = g = b = out[i]
    else if (ct === 4) {
      r = g = b = out[i * 2]
      a = out[i * 2 + 1]
    } else [r, g, b] = [plte[out[i] * 3], plte[out[i] * 3 + 1], plte[out[i] * 3 + 2]]
    rgba.set([r, g, b, a], i * 4)
  }
  return { w, h, data: rgba }
}
/** First image of a GLB whose images are PNG (convert with `gltf-transform png` first). */
export function extractGlbTexture(file) {
  const b = fs.readFileSync(file)
  const jl = b.readUInt32LE(12)
  const json = JSON.parse(b.toString('utf8', 20, 20 + jl))
  const bin = b.subarray(20 + jl + 8)
  const bv = json.bufferViews[json.images[0].bufferView]
  return decodePNG(bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength))
}

// ---------- font ----------
const G = {
  A: '01110,10001,10001,11111,10001,10001,10001', B: '11110,10001,10001,11110,10001,10001,11110', C: '01110,10001,10000,10000,10000,10001,01110',
  D: '11110,10001,10001,10001,10001,10001,11110', E: '11111,10000,10000,11110,10000,10000,11111', F: '11111,10000,10000,11110,10000,10000,10000',
  G: '01110,10001,10000,10111,10001,10001,01111', H: '10001,10001,10001,11111,10001,10001,10001', I: '01110,00100,00100,00100,00100,00100,01110',
  J: '00111,00010,00010,00010,00010,10010,01100', K: '10001,10010,10100,11000,10100,10010,10001', L: '10000,10000,10000,10000,10000,10000,11111',
  M: '10001,11011,10101,10101,10001,10001,10001', N: '10001,11001,10101,10011,10001,10001,10001', O: '01110,10001,10001,10001,10001,10001,01110',
  P: '11110,10001,10001,11110,10000,10000,10000', Q: '01110,10001,10001,10001,10101,10010,01101', R: '11110,10001,10001,11110,10100,10010,10001',
  S: '01111,10000,10000,01110,00001,00001,11110', T: '11111,00100,00100,00100,00100,00100,00100', U: '10001,10001,10001,10001,10001,10001,01110',
  V: '10001,10001,10001,10001,10001,01010,00100', W: '10001,10001,10001,10101,10101,11011,10001', X: '10001,10001,01010,00100,01010,10001,10001',
  Y: '10001,10001,01010,00100,00100,00100,00100', Z: '11111,00001,00010,00100,01000,10000,11111',
  0: '01110,10001,10011,10101,11001,10001,01110', 1: '00100,01100,00100,00100,00100,00100,01110', 2: '01110,10001,00001,00010,00100,01000,11111',
  3: '11110,00001,00001,01110,00001,00001,11110', 4: '00010,00110,01010,10010,11111,00010,00010', 5: '11111,10000,11110,00001,00001,10001,01110',
  6: '00110,01000,10000,11110,10001,10001,01110', 7: '11111,00001,00010,00100,01000,01000,01000', 8: '01110,10001,10001,01110,10001,10001,01110',
  9: '01110,10001,10001,01111,00001,00010,01100', '%': '11001,11010,00010,00100,01000,01011,10011', '-': '00000,00000,00000,11111,00000,00000,00000',
  '.': '00000,00000,00000,00000,00000,01100,01100', ':': '00000,01100,01100,00000,01100,01100,00000', _: '00000,00000,00000,00000,00000,00000,11111',
}
export function drawText(img, text, x0, y0, scale, rgb) {
  let x = x0
  for (const chRaw of text.toUpperCase()) {
    const g = G[chRaw]
    if (g) {
      g.split(',').forEach((row, ry) => {
        for (let rx = 0; rx < 5; rx++) {
          if (row[rx] !== '1') continue
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = x + rx * scale + sx
              const py = y0 + ry * scale + sy
              if (px >= 0 && py >= 0 && px < img.w && py < img.h) img.data.set([rgb[0], rgb[1], rgb[2], 255], (py * img.w + px) * 4)
            }
          }
        }
      })
    }
    x += 6 * scale
  }
}
export const newImage = (w, h, rgb) => {
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4)
  return { w, h, data }
}
export function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const X = dx + x
      const Y = dy + y
      if (X < dst.w && Y < dst.h) dst.data.set(src.data.subarray((y * src.w + x) * 4, (y * src.w + x) * 4 + 4), (Y * dst.w + X) * 4)
    }
  }
}

// ---------- rasteriser ----------
/**
 * Render a skinned mesh (current pose) orthographically.
 * view: { eye:[x,y,z] direction from target to camera, target:[x,y,z], half: half extent (world units), size, ss, bg }
 * opts: { flat:true } grey shading only; { vertexColor(i)->[r,g,b] } per-vertex colours instead of the texture.
 */
export function renderMesh(mesh, THREE, tex, view, opts = {}) {
  const ss = view.ss ?? 2
  const S = view.size * ss
  const W = S
  const H = S
  const geo = mesh.geometry
  const n = geo.attributes.position.count
  const idx = geo.index.array
  const uv = geo.attributes.uv
  const cur = new Float32Array(n * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < n; i++) {
    mesh.getVertexPosition(i, v)
    cur[i * 3] = v.x
    cur[i * 3 + 1] = v.y
    cur[i * 3 + 2] = v.z
  }
  const nrm = new Float32Array(n * 3)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3
    const b = idx[t + 1] * 3
    const c = idx[t + 2] * 3
    const ux = cur[b] - cur[a]
    const uy = cur[b + 1] - cur[a + 1]
    const uz = cur[b + 2] - cur[a + 2]
    const vx = cur[c] - cur[a]
    const vy = cur[c + 1] - cur[a + 1]
    const vz = cur[c + 2] - cur[a + 2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    for (const q of [a, b, c]) {
      nrm[q] += nx
      nrm[q + 1] += ny
      nrm[q + 2] += nz
    }
  }
  const norm = (a) => {
    const l = Math.hypot(...a) || 1
    return a.map((x) => x / l)
  }
  const e = norm(view.eye)
  const right = norm([e[2], 0, -e[0]]) // up x e
  const up = [e[1] * right[2] - e[2] * right[1], e[2] * right[0] - e[0] * right[2], e[0] * right[1] - e[1] * right[0]]
  const L = norm([e[0] + up[0] * 0.6 - right[0] * 0.5, e[1] + up[1] * 0.6 - right[1] * 0.5, e[2] + up[2] * 0.6 - right[2] * 0.5])
  const sx = new Float32Array(n)
  const sy = new Float32Array(n)
  const sz = new Float32Array(n)
  const sh = new Float32Array(n)
  const k = S / (2 * view.half)
  for (let i = 0; i < n; i++) {
    const px = cur[i * 3] - view.target[0]
    const py = cur[i * 3 + 1] - view.target[1]
    const pz = cur[i * 3 + 2] - view.target[2]
    sx[i] = S / 2 + (px * right[0] + py * right[1] + pz * right[2]) * k
    sy[i] = S / 2 - (px * up[0] + py * up[1] + pz * up[2]) * k
    sz[i] = px * e[0] + py * e[1] + pz * e[2]
    const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]) || 1
    sh[i] = (nrm[i * 3] * L[0] + nrm[i * 3 + 1] * L[1] + nrm[i * 3 + 2] * L[2]) / l
  }
  const zb = new Float32Array(W * H).fill(-1e9)
  const col = new Uint8Array(W * H * 4)
  const bg = view.bg ?? [196, 208, 222]
  for (let i = 0; i < W * H; i++) col.set([bg[0], bg[1], bg[2], 255], i * 4)
  const cull = mesh.material.side === 0 // FrontSide
  const sample = (u, vv) => {
    const x = u * tex.w - 0.5
    const y = vv * tex.h - 0.5
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const out = [0, 0, 0]
    for (let j = 0; j < 4; j++) {
      const xx = (((x0 + (j & 1)) % tex.w) + tex.w) % tex.w
      const yy = (((y0 + (j >> 1)) % tex.h) + tex.h) % tex.h
      const w = (j & 1 ? fx : 1 - fx) * (j >> 1 ? fy : 1 - fy)
      const o = (yy * tex.w + xx) * 4
      out[0] += tex.data[o] * w
      out[1] += tex.data[o + 1] * w
      out[2] += tex.data[o + 2] * w
    }
    return out
  }
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t]
    const i1 = idx[t + 1]
    const i2 = idx[t + 2]
    const area = (sx[i1] - sx[i0]) * (sy[i2] - sy[i0]) - (sx[i2] - sx[i0]) * (sy[i1] - sy[i0])
    if (Math.abs(area) < 1e-9) continue
    const back = area > 0 // screen y is flipped: CCW in world is negative area
    if (cull && back) continue
    const minx = Math.max(0, Math.floor(Math.min(sx[i0], sx[i1], sx[i2])))
    const maxx = Math.min(W - 1, Math.ceil(Math.max(sx[i0], sx[i1], sx[i2])))
    const miny = Math.max(0, Math.floor(Math.min(sy[i0], sy[i1], sy[i2])))
    const maxy = Math.min(H - 1, Math.ceil(Math.max(sy[i0], sy[i1], sy[i2])))
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5
        const py = y + 0.5
        const w0 = ((sx[i1] - px) * (sy[i2] - py) - (sx[i2] - px) * (sy[i1] - py)) / area
        const w1 = ((sx[i2] - px) * (sy[i0] - py) - (sx[i0] - px) * (sy[i2] - py)) / area
        const w2 = 1 - w0 - w1
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue
        const z = w0 * sz[i0] + w1 * sz[i1] + w2 * sz[i2]
        if (z <= zb[y * W + x]) continue
        zb[y * W + x] = z
        let c
        if (opts.vertexColor) {
          const a = opts.vertexColor(i0)
          const b = opts.vertexColor(i1)
          const d = opts.vertexColor(i2)
          c = [0, 1, 2].map((q) => w0 * a[q] + w1 * b[q] + w2 * d[q])
        } else if (opts.flat) c = [190, 190, 190]
        else c = sample(w0 * uv.getX(i0) + w1 * uv.getX(i1) + w2 * uv.getX(i2), w0 * uv.getY(i0) + w1 * uv.getY(i1) + w2 * uv.getY(i2))
        let l = w0 * sh[i0] + w1 * sh[i1] + w2 * sh[i2]
        if (back) l = -l
        const f = 0.55 + 0.45 * Math.max(0, l)
        col.set([c[0] * f, c[1] * f, c[2] * f, 255], (y * W + x) * 4)
      }
    }
  }
  const out = { w: view.size, h: view.size, data: new Uint8Array(view.size * view.size * 4) }
  for (let y = 0; y < view.size; y++) {
    for (let x = 0; x < view.size; x++) {
      const a = [0, 0, 0]
      for (let j = 0; j < ss * ss; j++) {
        const o = ((y * ss + ((j / ss) | 0)) * W + x * ss + (j % ss)) * 4
        a[0] += col[o]
        a[1] += col[o + 1]
        a[2] += col[o + 2]
      }
      out.data.set([a[0] / ss / ss, a[1] / ss / ss, a[2] / ss / ss, 255], (y * view.size + x) * 4)
    }
  }
  return out
}
