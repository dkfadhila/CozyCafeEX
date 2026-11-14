// Contact sheets of the textured, skinned chef (head + shoulders close-up, front and back three-quarter) for
// several poses and skin-weight variants, rendered on the CPU (see render_lib.mjs). No browser needed.
// usage: node tools/render_shoulders.mjs [original prev new male ...] [--out ../generated/debug] [--size 480]
// The texture is read from a PNG-converted copy of the GLB:
//   npx @gltf-transform/cli@4 png public/assets/models/char_chef_female.glb ../generated/debug/char_chef_female_n.glb --formats "*"
import fs from 'node:fs'
import * as THREE from 'three'
import { loadGLB } from './skin_lib.mjs'
import { blit, drawText, encodePNG, extractGlbTexture, newImage, renderMesh } from './render_lib.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const OUT = arg('out', '../generated/debug')
const SIZE = Number(arg('size', 480))
const wanted = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !String(all[i - 1]).startsWith('--'))
const dir = 'public/assets/models/'

const POSES = [
  ['idle 30%', 'clips', 'idle', 0.3],
  ['walk 25%', 'walk', null, 0.25],
  ['walk 75%', 'walk', null, 0.75],
  ['cook 40%', 'cook', null, 0.4],
  ['cheer 30%', 'clips', 'cheer', 0.3],
  ['cheer 60%', 'clips', 'cheer', 0.6],
  ['pickup 35%', 'pickup', null, 0.35],
]
const MALE_POSES = [POSES[0], POSES[4]]
const VIEWS = [['front', Math.PI / 4], ['back', Math.PI / 4 + Math.PI]]

const fixes = {
  original: () => () => null,
  prev: async () => (await import('./skinfix_prev.ts')).applySkinFix,
  new: async () => (await import('../src/assets/skinFixes.ts')).applySkinFix,
}

async function sheet(label, who, apply, poses, texFile) {
  const tex = extractGlbTexture(texFile)
  const g = await loadGLB(dir + `char_chef_${who}.glb`)
  let mesh
  g.scene.traverse((o) => { if (o.isSkinnedMesh) mesh = o })
  g.scene.updateMatrixWorld(true)
  mesh.skeleton.update()
  if (who === 'female') apply('femaleChef', g.scene)
  const mixer = new THREE.AnimationMixer(g.scene)
  const COLS = 4
  const cells = poses.length * VIEWS.length
  const rows = Math.ceil(cells / COLS)
  const HEAD = 34
  const img = newImage(COLS * SIZE, rows * (SIZE + 0) + HEAD, [40, 44, 52])
  drawText(img, `${label}`, 10, 8, 3, [255, 255, 255])
  let cell = 0
  for (const [pname, file, cname, frac] of poses) {
    const a = await loadGLB(dir + `anim_chef_${who}_${file}.glb`)
    const clip = cname ? a.animations.find((c) => c.name === cname) : a.animations[0]
    const act = mixer.clipAction(clip)
    act.play()
    act.time = frac * clip.duration
    mixer.update(0)
    g.scene.updateMatrixWorld(true)
    mesh.skeleton.update()
    // Follow the character: aim at the neck and take yaw from the chest bone so 'front' is always 45 deg off her facing.
    const bone = (n) => mesh.skeleton.bones.find((b) => b.name === n)
    const neck = mesh.worldToLocal(bone('neck').getWorldPosition(new THREE.Vector3()))
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(bone('Spine').getWorldQuaternion(new THREE.Quaternion()))
    const yaw = Math.atan2(fwd.x, fwd.z)
    for (const [vname, off] of VIEWS) {
      const eye = [Math.sin(yaw + off), 0.35, Math.cos(yaw + off)]
      const r = renderMesh(mesh, THREE, tex, { eye, target: [neck.x, neck.y + 2, neck.z], half: 40, size: SIZE })
      const x = (cell % COLS) * SIZE
      const y = HEAD + Math.floor(cell / COLS) * SIZE
      blit(img, r, x, y)
      drawText(img, `${pname} ${vname}`, x + 6, y + 6, 2, [20, 20, 20])
      cell++
    }
    act.stop()
  }
  return img
}

for (const name of wanted.length ? wanted : ['original', 'prev', 'new', 'male']) {
  const out = `${OUT}/shoulders_${name}.png`
  let img
  if (name === 'male') img = await sheet('male chef', 'male', null, MALE_POSES, `${OUT}/char_chef_male_n.glb`)
  else img = await sheet(`female chef - ${name} weights`, 'female', await fixes[name](), POSES, `${OUT}/char_chef_female_n.glb`)
  fs.writeFileSync(out, encodePNG(img.w, img.h, img.data))
  console.log('wrote', out, img.w, img.h)
}
