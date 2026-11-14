// Before/after renders at low mip levels (CPU renderer, atlas box-filtered by 8x and 16x to emulate GPU mips 3 and 4,
// then sampled bilinearly) to show dark seam lines ("cracks") from unpadded atlases.
// usage: node tools/cracks_compare.mjs <beforeDir> <afterDir> <name> ...   -> ../generated/debug/cracks_{before,after}_<name>.png
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import * as THREE from 'three'
import { loadGLB } from './skin_lib.mjs'
import { blit, drawText, encodePNG, extractGlbTexture, newImage, renderMesh } from './render_lib.mjs'

const [bdir, adir, ...names] = process.argv.slice(2)
const cli = (...a) => execFileSync('npx', ['--yes', '@gltf-transform/cli@4', ...a], { stdio: 'pipe', shell: true })
const SIZE = 256
function down(t, f) {
  const w = t.w / f, h = t.h / f
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = [0, 0, 0]
    for (let j = 0; j < f * f; j++) {
      const o = ((y * f + ((j / f) | 0)) * t.w + x * f + (j % f)) * 4
      a[0] += t.data[o]; a[1] += t.data[o + 1]; a[2] += t.data[o + 2]
    }
    data.set([a[0] / f / f, a[1] / f / f, a[2] / f / f, 255], (y * w + x) * 4)
  }
  return { w, h, data }
}
for (const [label, dir] of [['before', bdir], ['after', adir]]) {
  for (const name of names) {
    const tmp = `../generated/debug/_cmp_${label}_${name}.glb`
    cli('png', `${dir}/${name}.glb`, tmp, '--formats', '"*"')
    const tex = extractGlbTexture(tmp)
    const g = await loadGLB(`${dir}/${name}.glb`)
    let mesh
    g.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o })
    g.scene.updateMatrixWorld(true)
    mesh.skeleton?.update()
    const box = new THREE.Box3()
    const vv = new THREE.Vector3()
    for (let i = 0; i < mesh.geometry.attributes.position.count; i++) box.expandByPoint(mesh.getVertexPosition(i, vv))
    const c = box.getCenter(new THREE.Vector3())
    const half = Math.max(...box.getSize(new THREE.Vector3()).toArray()) * 0.55
    const sheet = newImage(SIZE * 2, SIZE + 18, [30, 30, 36])
    ;[8, 16].forEach((f, i) => {
      const img = renderMesh(mesh, THREE, down(tex, f), { eye: [1, 0.55, 1], target: c.toArray(), half, size: SIZE, ss: 2, bg: [196, 208, 222] })
      blit(sheet, img, i * SIZE, 18)
      drawText(sheet, `${label} ${name} mip${Math.log2(f)}`, 4 + i * SIZE, 4, 1, [255, 255, 255])
    })
    fs.writeFileSync(`../generated/debug/cracks_${label}_${name}.png`, encodePNG(sheet.w, sheet.h, sheet.data))
    fs.rmSync(tmp)
  }
}
