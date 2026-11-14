// Top-down render of the original Meshy floor (texture sampled per UV) to count tiles / sample colours.
import fs from 'node:fs'
import * as THREE from 'three'
import { loadGLB } from './skin_lib.mjs'
import { decodePNG, encodePNG, renderMesh } from './render_lib.mjs'
import { execFileSync } from 'node:child_process'
const src = '../generated/models_original/env_cafe_floor.glb'
const png = '../generated/debug/floor_o_png.glb'
execFileSync('npx', ['--yes', '@gltf-transform/cli@4', 'png', src, png, '--formats', '"*"'], { shell: true, stdio: 'pipe' })
const { extractGlbTexture } = await import('./render_lib.mjs')
const tex = extractGlbTexture(png)
const g = await loadGLB(src)
let mesh
g.scene.traverse((o) => { if (o.isMesh) mesh = o })
mesh.updateWorldMatrix(true, true)
const img = renderMesh(mesh, THREE, tex, { eye: [0, 1, 0.0001], target: [0, 0.13, 0], half: 0.52, size: 1024, ss: 2 })
fs.writeFileSync('../generated/debug/floor_top_orig.png', encodePNG(img.w, img.h, img.data))
