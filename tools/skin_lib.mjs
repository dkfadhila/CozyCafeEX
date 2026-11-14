// Node helpers for CPU skinning analysis of the Meshy characters (no WebGL, textures are stubbed).
import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

// Textures are irrelevant here and cannot be decoded in Node: hand back a dummy image.
globalThis.self ??= globalThis
THREE.ImageLoader.prototype.load = function (_url, onLoad) {
  onLoad({ width: 1, height: 1 })
  return {}
}

export async function loadGLB(file) {
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  const buf = fs.readFileSync(file)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Promise((res, rej) => loader.parse(ab, '', res, rej))
}

// Ignore edges shorter than this (rest-pose units, cm here): their ratio is numerical noise.
const MIN_EDGE = 0.3

/** Per-vertex displacement and triangle edge stretch of a skinned mesh against its bind pose. */
export function measure(mesh, bindPos, edges, scale) {
  const n = bindPos.length / 3
  const v = new THREE.Vector3()
  const cur = new Float32Array(n * 3)
  let maxDisp = 0
  for (let i = 0; i < n; i++) {
    mesh.getVertexPosition(i, v)
    cur[i * 3] = v.x
    cur[i * 3 + 1] = v.y
    cur[i * 3 + 2] = v.z
  }
  // Edge stretch = current length / bind length (only edges longer than 5 mm in bind pose).
  let worst = 1
  let worstEdge = -1
  const stretch = new Float32Array(edges.length / 2)
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e]
    const b = edges[e + 1]
    const l0 = Math.hypot(bindPos[a * 3] - bindPos[b * 3], bindPos[a * 3 + 1] - bindPos[b * 3 + 1], bindPos[a * 3 + 2] - bindPos[b * 3 + 2])
    const l1 = Math.hypot(cur[a * 3] - cur[b * 3], cur[a * 3 + 1] - cur[b * 3 + 1], cur[a * 3 + 2] - cur[b * 3 + 2])
    const r = l0 > MIN_EDGE / scale ? l1 / l0 : 1
    stretch[e / 2] = r
    if (r > worst) {
      worst = r
      worstEdge = e / 2
    }
  }
  return { cur, worst, worstEdge, stretch, maxDisp }
}
