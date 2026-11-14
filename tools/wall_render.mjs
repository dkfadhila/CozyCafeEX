// CPU check renders of the cafe wall panels. usage: node tools/wall_render.mjs <glbPng> <out.png> <depth> [--front]
import fs from 'node:fs'
import * as THREE from 'three'
import { loadGLB } from './skin_lib.mjs'
import { encodePNG, extractGlbTexture, renderMesh } from './render_lib.mjs'
const [file, out, depthS, mode] = process.argv.slice(2)
const depth = Number(depthS)
const tex = extractGlbTexture(file)
const g = await loadGLB(file)
let mesh; g.scene.traverse((o) => { if (o.isMesh) mesh = o })
const box = new THREE.Box3().setFromObject(g.scene)
const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3())
// bake the game placement (dims [2, 2.3, depth], bottom-centre at origin) into a geometry copy
const sc = new THREE.Vector3(2 / size.x, 2.3 / size.y, depth / size.z)
// de-interleave (clone() of interleaved attributes shares the buffer, so per-panel translate would pile up)
const geo = mesh.geometry.clone()
for (const name of ['position', 'normal', 'uv']) {
  const a = geo.attributes[name]
  const arr = new Float32Array(a.count * a.itemSize)
  for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) arr[i * a.itemSize + c] = a.getComponent(i, c)
  geo.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize))
}
geo.translate(-c.x, -box.min.y, -c.z)
geo.scale(sc.x, sc.y, sc.z)
const zc = -4 - depth / 2
const view = mode === '--front'
  ? { eye: [0, 0, 1], target: [0, 1.15, 0], half: 1.15, size: 1024, ss: 2 }
  : { eye: [Math.cos(0.576) * 0.7071, Math.sin(0.576), Math.cos(0.576) * 0.7071], target: [0, 1.15, 0], half: 1.15, size: 1024, ss: 2 }
if (mode !== '--front') {
  // back wall row: four panels at x = -3,-1,1,3, z = -4.08 (default camera from +X +Z, 33 deg down)
  const geos = []
  for (const x of [-3, -1, 1, 3]) { const q = geo.clone(); q.translate(x, 0, zc); geos.push(q) }
  const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js')
  const merged = mergeGeometries(geos, false)
  mesh = new THREE.Mesh(merged, mesh.material)
  view.target = [0, 1.45, zc]
  view.half = 2.6
  view.size = 1024
} else mesh = new THREE.Mesh(geo, mesh.material)
const img = renderMesh(mesh, THREE, tex, view)
fs.writeFileSync(out, encodePNG(img.w, img.h, img.data))
