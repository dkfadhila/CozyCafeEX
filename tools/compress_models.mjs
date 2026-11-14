// Re-runnable GLB compression: reads every .glb from the backup folder and writes the result into
// public/assets/models. Pipeline: edge-pad atlas (tools/pad_texture.mjs: Meshy leaves the gutters black, which bleeds
// into chart borders under bilinear/mip filtering; every uncovered texel is filled) -> webp q95 at ORIGINAL resolution (no resize) -> meshopt (16-bit UVs).
// Deliberately NOT using `optimize`, because its defaults join/flatten/simplify/weld and would
// rename or merge nodes (bones and holders are looked up by name).
// usage: node tools/compress_models.mjs [--src <dir>] [--dst <dir>] [--quality 95] [--only <regex>]
// anim_*.glb files are copied unchanged (skeleton + animation tracks only; meshopt would re-quantize them).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { padGlb } from './pad_texture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const SRC = path.resolve(arg('src', path.resolve(root, '..', 'generated', 'models_original')))
const DST = path.resolve(arg('dst', path.join(root, 'public', 'assets', 'models')))
// Textures keep their original resolution (the Meshy atlases are tightly packed, so downscaling bleeds across charts).
const WEBP_QUALITY = Number(arg('quality', 95))
const ONLY = arg('only', null) ? new RegExp(arg('only', '')) : null // re-run just the matching files
// Retired backups and untouched originals kept next to the live files (e.g. env_cafe_wall_plain_old.glb, env_cafe_wall_plain_meshy_original.glb) are not shipped.
const SKIP = (f) => f.endsWith('_old.glb') || f.endsWith('_meshy_original.glb')

const cli = (...args) =>
  execFileSync('npx', ['--yes', '@gltf-transform/cli@4', ...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: true })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glb-'))
const failed = []
let before = 0
let after = 0
for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.glb')).sort()) {
  const src = path.join(SRC, f)
  const dst = path.join(DST, f)
  if (ONLY && !ONLY.test(f)) continue
  if (SKIP(f)) {
    console.log(`skip   ${f}`)
    continue
  }
  const inSize = fs.statSync(src).size
  before += inSize
  try {
    if (f.startsWith('anim_')) {
      fs.copyFileSync(src, dst)
    } else {
      const b = path.join(tmp, 'b.glb')
      const c = path.join(tmp, 'c.glb')
      const padded = path.join(tmp, 'p.glb')
      // JPEG originals are first decoded to PNG (lossless re-wrap of the decoded pixels) so every atlas can be padded.
      const png = path.join(tmp, 'o.glb')
      cli('png', src, png, '--formats', '"*"')
      const input = (await padGlb(png, padded)) ? padded : png
      cli('webp', input, b, '--quality', WEBP_QUALITY)
      // 12-bit texcoords (CLI default) give up to 0.25 texel error on a 2048 atlas (visible as shifted chart borders), so use 16 bit;
      // normals 12 bit instead of 10 to avoid banding on smooth surfaces.
      cli('meshopt', b, c, '--level', 'high', '--quantize-texcoord', 16, '--quantize-normal', 12)
      fs.copyFileSync(c, dst)
    }
    after += fs.statSync(dst).size
    console.log(`ok     ${f}  ${(inSize / 1024).toFixed(0)} KB -> ${(fs.statSync(dst).size / 1024).toFixed(0)} KB`)
  } catch (e) {
    // Keep the original on failure.
    fs.copyFileSync(src, dst)
    after += inSize
    failed.push(f)
    console.log(`FAILED ${f}: ${String(e.stderr ?? e.message).split('\n')[0]} (kept original)`)
  }
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`total ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB; failed: ${failed.join(', ') || 'none'}`)
