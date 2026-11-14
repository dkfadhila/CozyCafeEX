// Procedural Three.js surroundings for the cafe: grass island, street, houses, trees, bushes.
// This is the one part of the 3D world that is NOT a Meshy asset (the user asked for it in code).
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

const GROUND_Y = -0.32 // the cafe platform (top at y = 0) sits slightly proud of the grass

// Small seeded PRNG so the layout is identical on every load.
function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const mat = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true })

const M = {
  grass: mat('#a9d38a'),
  grassDark: mat('#8fc274'),
  soil: mat('#b99873'),
  road: mat('#c9c2b8'),
  kerb: mat('#ece5d8'),
  path: mat('#e2d3b8'),
  trunk: mat('#9a6b47'),
  leaf: [mat('#6fb36a'), mat('#84c476'), mat('#5aa26b'), mat('#9ad08a')],
  bush: [mat('#7cc07a'), mat('#93cf85'), mat('#68b072')],
  flower: [mat('#ffb3c7'), mat('#fff2a8'), mat('#ffffff'), mat('#c9b8ff')],
  wall: [mat('#fbe3c8'), mat('#ffd6d6'), mat('#d8ecf2'), mat('#e6f0cf'), mat('#fff0c2')],
  roof: [mat('#e58f76'), mat('#7fb7a4'), mat('#8aa6d6'), mat('#d9a05b')],
  door: mat('#a86f4a'),
  window: mat('#bfe6f2'),
  trim: mat('#fffaf0'),
  lamp: mat('#5f6b66'),
  glow: new THREE.MeshStandardMaterial({ color: '#fff3c4', emissive: '#ffe08a', emissiveIntensity: 0.9 }),
}

function shadow<T extends THREE.Object3D>(o: T, cast = true, receive = true): T {
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = cast
      c.receiveShadow = receive
    }
  })
  return o
}

function tree(r: () => number): THREE.Group {
  const g = new THREE.Group()
  const h = 1.1 + r() * 0.7
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.19, h, 6), M.trunk)
  trunk.position.y = h / 2
  g.add(trunk)
  const leaf = M.leaf[Math.floor(r() * M.leaf.length)]
  if (r() < 0.45) {
    // Pine: stacked cones.
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.0 - i * 0.24, 1.15, 7), leaf)
      cone.position.y = h + 0.3 + i * 0.62
      g.add(cone)
    }
  } else {
    // Round tree: a few squashed blobs.
    const blobs = 3 + Math.floor(r() * 2)
    for (let i = 0; i < blobs; i++) {
      const rad = 0.7 + r() * 0.35
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(rad, 1), leaf)
      b.position.set((r() - 0.5) * 0.8, h + 0.45 + r() * 0.7, (r() - 0.5) * 0.8)
      b.scale.y = 0.85
      g.add(b)
    }
  }
  g.rotation.y = r() * Math.PI * 2
  g.scale.setScalar(0.9 + r() * 0.5)
  return shadow(g)
}

function bush(r: () => number, withFlowers: boolean): THREE.Group {
  const g = new THREE.Group()
  const m = M.bush[Math.floor(r() * M.bush.length)]
  const n = 2 + Math.floor(r() * 2)
  for (let i = 0; i < n; i++) {
    const rad = 0.26 + r() * 0.16
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(rad, 1), m)
    b.position.set((r() - 0.5) * 0.5, rad * 0.7, (r() - 0.5) * 0.5)
    b.scale.y = 0.8
    g.add(b)
    if (withFlowers) {
      const fm = M.flower[Math.floor(r() * M.flower.length)]
      for (let k = 0; k < 3; k++) {
        const f = new THREE.Mesh(new THREE.IcosahedronGeometry(0.055, 0), fm)
        const a = r() * Math.PI * 2
        f.position.set(b.position.x + Math.cos(a) * rad * 0.7, b.position.y + rad * 0.55, b.position.z + Math.sin(a) * rad * 0.7)
        g.add(f)
      }
    }
  }
  return shadow(g)
}

function house(r: () => number): THREE.Group {
  const g = new THREE.Group()
  const w = 2.6 + r() * 1.2
  const d = 2.4 + r() * 0.6
  const h = 1.9 + r() * 0.6
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M.wall[Math.floor(r() * M.wall.length)])
  body.position.y = h / 2
  g.add(body)

  // Gable roof: a triangular prism extruded along the depth.
  const rh = 1.0 + r() * 0.4
  const shape = new THREE.Shape()
  shape.moveTo(-w / 2 - 0.25, 0)
  shape.lineTo(w / 2 + 0.25, 0)
  shape.lineTo(0, rh)
  shape.closePath()
  const roof = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: d + 0.4, bevelEnabled: false }),
    M.roof[Math.floor(r() * M.roof.length)],
  )
  roof.position.set(0, h, -d / 2 - 0.2)
  g.add(roof)

  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.8, 0.32), M.trim)
  chimney.position.set(w * 0.25, h + rh * 0.6, 0)
  g.add(chimney)

  // Front (+Z) details.
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.05, 0.06), M.door)
  door.position.set(-w * 0.2, 0.52, d / 2 + 0.02)
  g.add(door)
  for (const x of [w * 0.22, -w * 0.2]) {
    const y = x > 0 ? 1.0 : h - 0.35
    if (y + 0.25 > h) continue
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.56, 0.05), M.trim)
    frame.position.set(x, y, d / 2 + 0.02)
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.42, 0.06), M.window)
    glass.position.copy(frame.position)
    glass.position.z += 0.01
    g.add(frame, glass)
  }
  // Side (+X) window, visible from the camera.
  const side = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.45, 0.55), M.window)
  side.position.set(w / 2 + 0.02, 1.05, 0)
  g.add(side)
  return shadow(g)
}

function lampPost(): THREE.Group {
  const g = new THREE.Group()
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 2.1, 6), M.lamp)
  pole.position.y = 1.05
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 1), M.glow)
  head.position.y = 2.2
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.14, 6), M.lamp)
  cap.position.y = 2.38
  g.add(pole, head, cap)
  return shadow(g, true, false)
}

/** True where tall objects are allowed: behind the two back walls, never in front of the cafe
 *  (the camera sits at +X +Z, so anything tall there would hide the interior). */
const behindCafe = (x: number, z: number) => x < -5.2 || z < -5.2
const insideCafe = (x: number, z: number, pad: number) => Math.abs(x) < 4.3 + pad && Math.abs(z) < 4.3 + pad

export function buildExterior(): THREE.Group {
  const root = new THREE.Group()
  root.name = 'exterior'
  const r = rng(20261113)

  // Grass island with a soil rim.
  const grass = new THREE.Mesh(new THREE.CylinderGeometry(24, 24, 0.5, 64), M.grass)
  grass.position.y = GROUND_Y - 0.25
  grass.receiveShadow = true
  const soil = new THREE.Mesh(new THREE.CylinderGeometry(24, 23, 1.6, 64), M.soil)
  soil.position.y = GROUND_Y - 1.3
  root.add(grass, soil)

  // Darker grass patches for a little variation.
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2
    const d = 5 + r() * 16
    const patch = new THREE.Mesh(new THREE.CircleGeometry(0.8 + r() * 1.6, 9), M.grassDark)
    patch.rotation.x = -Math.PI / 2
    patch.position.set(Math.cos(a) * d, GROUND_Y + 0.005, Math.sin(a) * d)
    patch.receiveShadow = true
    root.add(patch)
  }

  // Street behind the back wall (the cafe door at x = 3 opens onto it).
  const ROAD_Z = -8.2
  const road = new THREE.Mesh(new THREE.BoxGeometry(44, 0.06, 2.6), M.road)
  road.position.set(0, GROUND_Y + 0.03, ROAD_Z)
  road.receiveShadow = true
  root.add(road)
  for (const dz of [-1.45, 1.45]) {
    const kerb = new THREE.Mesh(new THREE.BoxGeometry(44, 0.12, 0.3), M.kerb)
    kerb.position.set(0, GROUND_Y + 0.06, ROAD_Z + dz)
    kerb.receiveShadow = true
    root.add(kerb)
  }
  const walk = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 2.7), M.path)
  walk.position.set(3, GROUND_Y + 0.04, -5.5)
  walk.receiveShadow = true
  root.add(walk)

  // Houses across the street (facing the camera) and beside the left wall.
  const reserved: { x: number; z: number; rad: number }[] = []
  for (const x of [-15, -9.5, -4, 1.5, 7, 12.5]) {
    const h = house(r)
    h.position.set(x + (r() - 0.5) * 0.8, GROUND_Y, -11.5 - r() * 0.6)
    h.scale.setScalar(0.85)
    root.add(h)
    reserved.push({ x: h.position.x, z: h.position.z, rad: 2.6 })
  }
  for (const z of [-2.5, 3.5, 9.5]) {
    const h = house(r)
    h.rotation.y = Math.PI / 2
    h.position.set(-10.4 - r() * 0.6, GROUND_Y, z + (r() - 0.5) * 0.8)
    h.scale.setScalar(0.85)
    root.add(h)
    reserved.push({ x: h.position.x, z: h.position.z, rad: 2.6 })
  }

  // Street lamps.
  for (const x of [-8, -1, 6, 13]) {
    const l = lampPost()
    l.position.set(x, GROUND_Y, ROAD_Z + 1.75)
    root.add(l)
  }

  const free = (x: number, z: number, rad: number) =>
    !insideCafe(x, z, rad) &&
    Math.abs(z - ROAD_Z) > 1.7 + rad &&
    !(Math.abs(x - 3) < 1 && z < -4 && z > -7) &&
    reserved.every((o) => Math.hypot(o.x - x, o.z - z) > o.rad + rad) &&
    Math.hypot(x, z) < 22

  // Trees: only behind the cafe.
  let placed = 0
  for (let i = 0; i < 400 && placed < 34; i++) {
    const x = -20 + r() * 40
    const z = -20 + r() * 40
    if (!behindCafe(x, z) || !free(x, z, 0.9)) continue
    const t = tree(r)
    t.position.set(x, GROUND_Y, z)
    root.add(t)
    reserved.push({ x, z, rad: 1.1 })
    placed++
  }

  // Bushes and flowers everywhere, including the open front lawn (they stay low).
  placed = 0
  for (let i = 0; i < 600 && placed < 70; i++) {
    const x = -20 + r() * 40
    const z = -20 + r() * 40
    if (!free(x, z, 0.4)) continue
    const b = bush(r, r() < 0.6)
    b.position.set(x, GROUND_Y, z)
    b.rotation.y = r() * Math.PI * 2
    b.scale.setScalar(0.8 + r() * 0.7)
    root.add(b)
    placed++
  }

  // A hedge hugging the outside of the two back walls.
  for (let i = -4; i <= 4; i += 0.8) {
    for (const [x, z] of [
      [i, -4.75],
      [-4.75, i],
    ]) {
      if (Math.abs(x - 3) < 0.9 && z < -4) continue // keep the doorway clear
      const b = bush(r, false)
      b.position.set(x, GROUND_Y, z)
      b.scale.setScalar(1.1)
      root.add(b)
    }
  }

  return bake(root)
}

/** Merge the whole static exterior into one mesh per material (about 30 draw calls instead of ~650). */
function bake(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true)
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()
    g.applyMatrix4(m.matrixWorld)
    const list = byMat.get(m.material as THREE.Material) ?? []
    list.push(g)
    byMat.set(m.material as THREE.Material, list)
    m.geometry.dispose()
  })
  const baked = new THREE.Group()
  baked.name = 'exterior'
  const ambient = new THREE.Group()
  ambient.name = 'ambient'
  for (const [material, geos] of byMat) {
    const mesh = new THREE.Mesh(mergeGeometries(geos), material)
    mesh.castShadow = material !== M.grass && material !== M.grassDark && material !== M.road
    mesh.receiveShadow = true
    // Purely decorative extras go in their own group so the Ambient Effects setting can hide them.
    const decorative = material === M.grassDark || material === M.glow || M.flower.includes(material as never)
    ;(decorative ? ambient : baked).add(mesh)
    geos.forEach((g) => g.dispose())
  }
  baked.add(ambient)
  return baked
}
