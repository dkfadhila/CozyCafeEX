// Edge-padding ("dilation") of a GLB's texture atlases. Meshy bakes its UV charts onto a BLACK background; with
// bilinear filtering and mip-maps that black bleeds into every chart border (dark seams, wrong-coloured edges),
// and the smaller the mip the wider the bleed (at the default zoom a 2048 atlas is sampled at mip 4-6, where a
// 40 px gutter is ~1 px). So EVERY uncovered texel is filled with the colour of the nearest covered one (BFS until the
// frontier is empty, no radius limit) and no black remains at any mip level.
// Handles several images per file and every material slot (baseColor, normal, metallicRoughness, emissive, occlusion):
// each image gets its own coverage mask = triangles of the primitives whose material uses that image (with that
// slot's TEXCOORD set). Images that are not 8-bit PNG are left untouched.
// usage: node tools/pad_texture.mjs <in.glb> <out.glb> [--radius N]   (radius default: unlimited)
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
import { decodePNG, encodePNG } from './render_lib.mjs'

/** Rasterise every UV triangle of `uv`/`idx` into `covered` (slightly conservative). */
function cover(covered, W, H, uv, idx) {
  const u = [0, 0]
  const pts = new Float64Array(uv.getCount() * 2)
  for (let i = 0; i < uv.getCount(); i++) {
    uv.getElement(i, u)
    pts[i * 2] = u[0] * W
    pts[i * 2 + 1] = u[1] * H
  }
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 2, b = idx[t + 1] * 2, c = idx[t + 2] * 2
    const x0 = pts[a], y0 = pts[a + 1], x1 = pts[b], y1 = pts[b + 1], x2 = pts[c], y2 = pts[c + 1]
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if (!area) continue
    const minx = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
    const maxx = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)))
    const miny = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
    const maxy = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)))
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5, py = y + 0.5
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area
        if (w0 >= -0.02 && w1 >= -0.02 && w0 + w1 <= 1.02) covered[y * W + x] = 1
      }
    }
  }
}

/** Multi-source BFS (8-neighbourhood): every uncovered texel takes the colour of the nearest covered one. */
export function dilate(data, covered, W, H, radius = Infinity) {
  const dist = new Int32Array(W * H).fill(-1)
  let frontier = []
  for (let i = 0; i < W * H; i++) if (covered[i]) { dist[i] = 0; frontier.push(i) }
  if (!frontier.length) return 0
  const out = new Uint8Array(data)
  let filled = 0
  for (let r = 1; r <= radius && frontier.length; r++) {
    const next = []
    for (const i of frontier) {
      const x = i % W
      const y = (i / W) | 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Y = y + dy
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue
          const j = Y * W + X
          if (dist[j] >= 0) continue
          dist[j] = r
          out[j * 4] = out[i * 4]
          out[j * 4 + 1] = out[i * 4 + 1]
          out[j * 4 + 2] = out[i * 4 + 2]
          out[j * 4 + 3] = 255
          next.push(j)
          filled++
        }
      }
    }
    frontier = next
  }
  data.set(out)
  return filled
}

/** Returns the number of images padded (0 if nothing could be padded). */
export async function padGlb(srcFile, dstFile, radius = Infinity) {
  await MeshoptDecoder.ready
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  const doc = await io.read(srcFile)
  const root = doc.getRoot()

  // texture -> list of { prim, texCoord }
  const users = new Map()
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial()
      if (!mat) continue
      const slots = [
        [mat.getBaseColorTexture(), mat.getBaseColorTextureInfo()],
        [mat.getNormalTexture(), mat.getNormalTextureInfo()],
        [mat.getMetallicRoughnessTexture(), mat.getMetallicRoughnessTextureInfo()],
        [mat.getEmissiveTexture(), mat.getEmissiveTextureInfo()],
        [mat.getOcclusionTexture(), mat.getOcclusionTextureInfo()],
      ]
      for (const [tex, info] of slots) {
        if (!tex) continue
        if (!users.has(tex)) users.set(tex, [])
        users.get(tex).push({ prim, texCoord: info?.getTexCoord() ?? 0 })
      }
    }
  }

  let padded = 0
  for (const [tex, list] of users) {
    if (tex.getMimeType() !== 'image/png') continue
    let img
    try {
      img = decodePNG(Buffer.from(tex.getImage()))
    } catch {
      continue
    }
    const { w: W, h: H } = img
    const covered = new Uint8Array(W * H)
    for (const { prim, texCoord } of list) {
      const uv = prim.getAttribute(`TEXCOORD_${texCoord}`)
      const ind = prim.getIndices()
      if (!uv || !ind) continue
      cover(covered, W, H, uv, ind.getArray())
    }
    const n = dilate(img.data, covered, W, H, radius)
    if (!n) continue
    tex.setImage(new Uint8Array(encodePNG(W, H, img.data)))
    padded++
  }
  if (!padded) return 0
  await io.write(dstFile, doc)
  return padded
}

if (process.argv[1] && process.argv[1].endsWith('pad_texture.mjs') && process.argv[2]) {
  const ri = process.argv.indexOf('--radius')
  const n = await padGlb(process.argv[2], process.argv[3], ri >= 0 ? Number(process.argv[ri + 1]) : Infinity)
  console.log(n ? `padded ${n} image(s) -> ${process.argv[3]}` : 'nothing to pad (no 8-bit PNG textures)')
}
