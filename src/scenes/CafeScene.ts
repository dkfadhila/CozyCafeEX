import * as THREE from 'three'
import { createGLTFLoader, setMaxAnisotropy, sharpenTextures } from '../assets/loader'
import { CHEFS, PROPS, type CharacterAsset, type ChefId, type ClipName } from '../assets/manifest'
import { CAFE_LAYOUT, CHEF_SPAWN, WALK_HALF, type Placement } from '../data/cafeLayout'
import { applySkinFix } from '../assets/skinFixes'
import { buildExterior } from './exterior'
import { CAMERA_DISTANCE, CameraRig } from './CameraRig'
import type { Settings } from '../systems/settings'

const VIEW_SIZE = 10.5 // world units visible vertically
const WALK_SPEED = 2.2 // metres per second
const TURN_RATE = 12 // higher = snappier turning
const CHEF_RADIUS = 0.28
const WHEEL_ZOOM_RATE = 0.001
/** Wall cutaway: camera ground offset (m, along the wall normal) at the middle of the fade band. */
const CUTAWAY_CENTRE = -1
/** Half-width of the fade band: fully visible above centre + this, fully faded below centre - this. */
const CUTAWAY_HALF_BAND = 1.5
const WALL_FADED_OPACITY = 0.12
const WALL_FADE_TAU = 0.15
/** The sun's shadow frustum follows the look-at point in steps of this many metres (limits shimmer). */
const SHADOW_SNAP = 0.5
const SUN_OFFSET = new THREE.Vector3(-4, 9, 5)
const DRAG_THRESHOLD_PX = 3
/** Carried food position in the chef's local space (x right, y up, z forward) for a chef of CARRY_REFERENCE_HEIGHT. */
export const CHEF_CARRY_OFFSET: readonly [number, number, number] = [0, 0.5, 0.2]
const CARRY_REFERENCE_HEIGHT = 1.1

/** A rigged Meshy character in the scene. */
export interface Character {
  root: THREE.Group
  mixer: THREE.AnimationMixer
  actions: Partial<Record<ClipName, THREE.AnimationAction>>
  bones: Record<string, THREE.Bone>
  /** Height of the hip joint above the feet when standing, in metres. */
  hipHeight: number
  /** Standing height in metres. */
  height: number
  /** Clip currently driving the character (null before the first playClip). */
  current: ClipName | null
}

interface WallMat {
  mat: THREE.Material
  opacity: number
  transparent: boolean
  depthWrite: boolean
}

/** A cafe wall (all panels, door, windows and shelf on one side) that fades when the camera is behind it. */
interface Wall {
  /** Which axis the wall's outward normal points along (z = back wall, x = left wall). */
  axis: 'x' | 'z'
  meshes: THREE.Mesh[]
  mats: WallMat[]
  /** 0 = fully visible, 1 = fully faded (eased). */
  fade: number
}

interface Collider {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** Cross-fade to a clip. No-op (true) if it is already current; false if the character lacks the clip. */
export function playClip(
  c: Character,
  name: ClipName,
  opts: { loop?: boolean; fade?: number; speed?: number } = {},
): boolean {
  const next = c.actions[name]
  if (!next) return false
  if (c.current === name) return true
  const fade = opts.fade ?? 0.2
  const loop = opts.loop ?? true
  const prev = c.current ? c.actions[c.current] : undefined
  next.reset()
  next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
  next.clampWhenFinished = !loop
  next.timeScale = opts.speed ?? 1
  next.play()
  if (prev && prev !== next) {
    if (fade > 0) next.crossFadeFrom(prev, fade, false)
    else prev.stop()
  } else if (!prev) {
    for (const a of Object.values(c.actions)) if (a && a !== next) a.stop()
  }
  c.current = name
  return true
}

/** Duration of a clip in seconds at the given playback speed (0 when the clip is missing). */
export function clipSeconds(c: Character, name: ClipName, speed = 1): number {
  const a = c.actions[name]
  return a ? a.getClip().duration / speed : 0
}

/** Stand still (idle clip) or walk. Falls back to pausing the walk clip when there is no idle clip. */
export function setWalking(c: Character, walking: boolean) {
  if (c.actions.idle) {
    playClip(c, walking ? 'walk' : 'idle')
    return
  }
  const walk = c.actions.walk
  if (!walk) return
  if (!walk.isRunning()) walk.play()
  if (walking) walk.paused = false
  else {
    walk.paused = true
    walk.time = 0
  }
}

/** Remove horizontal root motion: every Hips.position keyframe takes the first keyframe's X and Z. */
function makeInPlace(clip: THREE.AnimationClip) {
  const track = clip.tracks.find((t) => t.name.endsWith('Hips.position'))
  if (!track || track.values.length < 3) return
  const v = track.values
  const x0 = v[0]
  const z0 = v[2]
  for (let i = 0; i < v.length; i += 3) {
    v[i] = x0
    v[i + 2] = z0
  }
}

/** Turn towards a yaw (radians) at a limited rate. */
export function turnTowards(o: THREE.Object3D, yaw: number, dt: number) {
  let d = yaw - o.rotation.y
  d = Math.atan2(Math.sin(d), Math.cos(d))
  o.rotation.y += d * Math.min(1, TURN_RATE * dt)
}

export class CafeScene {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.OrthographicCamera
  /** World position of each interactive station, keyed by station id. */
  readonly stations = new Map<string, THREE.Vector3>()
  /** Called every frame with the frame time; set by the gameplay system. */
  onTick: ((dt: number) => void) | null = null
  /** Called after every rendered frame, paused or not (audio listener, ambience). */
  onFrame: ((dt: number) => void) | null = null
  /** When true the simulation (chef, customers, timers) is frozen; rendering continues. */
  paused = false
  /** True only while the player may control the camera (playing, no menu or overlay on top). */
  cameraInputEnabled = false
  private _renderEnabled = true
  /** False while an opaque screen fully covers the canvas: no camera update and no draw call. */
  get renderEnabled() {
    return this._renderEnabled
  }
  set renderEnabled(on: boolean) {
    if (on === this._renderEnabled) return
    this._renderEnabled = on
    if (on && !this.disposed) {
      // One frame right away so the canvas is never blank when the cover goes away.
      this.updateCamera(0)
      this.renderer.render(this.scene, this.camera)
    }
  }

  private renderer: THREE.WebGLRenderer
  private clock = new THREE.Clock()
  private loader = createGLTFLoader()
  private keys = new Set<string>()
  private chef: Character | null = null
  private chefMount: THREE.Group | null = null
  private chefId: ChefId = 'male'
  private chefAction: { name: ClipName; left: number } | null = null
  private colliders: Collider[] = []
  private raf = 0
  private disposed = false
  private canvas: HTMLCanvasElement
  private sun = new THREE.DirectionalLight('#fff1dc', 2.2)
  private ambient: THREE.Object3D = new THREE.Group()
  private zoomSpeed = 1
  private rig: CameraRig
  private walls: Wall[] = []
  private shadowCentre = new THREE.Vector3()
  private drag: { id: number; mode: 'orbit' | 'pan'; x: number; y: number; moved: number } | null = null
  private touches = new Map<number, { x: number; y: number }>()
  private pinchDist = 0
  /** Smoothed orbit drag velocity (rad/s), for inertia on release. */
  private dragVel = new THREE.Vector2()
  private lastMoveAt = 0

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy())
    this.scene.background = new THREE.Color('#d6eef2')

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    this.rig = new CameraRig(this.camera) // default pose: 45 degrees around, 33 degrees down

    this.addLights()
    const exterior = buildExterior()
    this.scene.add(exterior)
    this.ambient = exterior.getObjectByName('ambient') ?? this.ambient

    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerEnd)
    canvas.addEventListener('pointercancel', this.onPointerEnd)
    canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    this.onResize()
    this.tick()
  }

  /** Apply the graphics and camera settings. Safe to call at any time. */
  applySettings(
    s: Pick<
      Settings,
      'quality' | 'shadows' | 'zoomSpeed' | 'ambientEffects' | 'cameraRotateSpeed' | 'invertCameraTilt' | 'reducedMotion'
    >,
  ) {
    const ratio = { low: 1, medium: 1.5, high: 2 }[s.quality]
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, ratio))
    const mapSize = { low: 1024, medium: 2048, high: 4096 }[s.quality]
    if (this.sun.shadow.mapSize.x !== mapSize) {
      this.sun.shadow.mapSize.set(mapSize, mapSize)
      this.sun.shadow.map?.dispose()
      this.sun.shadow.map = null
    }
    this.renderer.shadowMap.enabled = s.shadows
    this.sun.castShadow = s.shadows
    this.zoomSpeed = s.zoomSpeed
    this.rig.rotateSpeed = s.cameraRotateSpeed
    this.rig.invertTilt = s.invertCameraTilt
    this.rig.reducedMotion = s.reducedMotion
    // Ambient effects: the small decorative extras outside the cafe (flowers, grass patches, lamp glow).
    this.ambient.visible = s.ambientEffects
    this.onResize()
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.cameraInputEnabled) return
    e.preventDefault()
    this.rig.zoomBy(Math.exp(-e.deltaY * WHEEL_ZOOM_RATE * this.zoomSpeed))
  }

  private onContextMenu = (e: Event) => e.preventDefault()

  private onPointerDown = (e: PointerEvent) => {
    if (!this.cameraInputEnabled || e.target !== this.canvas) return
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      this.canvas.setPointerCapture(e.pointerId)
      if (this.touches.size === 2) {
        this.drag = null
        this.pinchDist = this.touchSpan()
      } else if (this.touches.size === 1) {
        this.drag = { id: e.pointerId, mode: 'orbit', x: e.clientX, y: e.clientY, moved: 0 }
        this.lastMoveAt = e.timeStamp
      }
      return
    }
    if (this.drag) return
    // Left and right buttons orbit; middle button or Shift + drag pans.
    const mode = e.button === 1 || e.shiftKey ? 'pan' : e.button === 0 || e.button === 2 ? 'orbit' : null
    if (!mode) return
    e.preventDefault()
    this.canvas.setPointerCapture(e.pointerId)
    this.drag = { id: e.pointerId, mode, x: e.clientX, y: e.clientY, moved: 0 }
    this.lastMoveAt = e.timeStamp
    this.dragVel.set(0, 0)
    this.rig.setOrbitVelocity(0, 0)
  }

  private touchSpan() {
    const [a, b] = [...this.touches.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this.touches.size === 2) {
        const span = this.touchSpan()
        if (this.pinchDist > 0 && span > 0 && this.cameraInputEnabled) this.rig.zoomBy(span / this.pinchDist)
        this.pinchDist = span
        return
      }
    }
    const d = this.drag
    if (!d || d.id !== e.pointerId) return
    if (!this.cameraInputEnabled) {
      this.endDrag(e.timeStamp)
      return
    }
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.x = e.clientX
    d.y = e.clientY
    d.moved += Math.abs(dx) + Math.abs(dy)
    if (d.mode === 'pan') {
      this.rig.pan(dx, dy, this.canvas.clientHeight)
      return
    }
    this.rig.orbit(dx, dy)
    // Smoothed drag velocity (rad/s) for the coast after release.
    const dt = Math.max((e.timeStamp - this.lastMoveAt) / 1000, 1 / 240)
    this.lastMoveAt = e.timeStamp
    const k = this.rig.dragRadiansPerPixel
    this.dragVel.x += (-(dx * k) / dt - this.dragVel.x) * 0.4
    this.dragVel.y += ((dy * k * (this.rig.invertTilt ? -1 : 1)) / dt - this.dragVel.y) * 0.4
  }

  private onPointerEnd = (e: PointerEvent) => {
    this.touches.delete(e.pointerId)
    if (this.touches.size < 2) this.pinchDist = 0
    if (this.drag && this.drag.id === e.pointerId) this.endDrag(e.timeStamp)
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
  }

  private endDrag(now: number) {
    const d = this.drag
    this.drag = null
    // Only an orbit drag that was still moving when released coasts.
    if (d && d.mode === 'orbit' && d.moved >= DRAG_THRESHOLD_PX && now - this.lastMoveAt < 80) {
      this.rig.setOrbitVelocity(this.dragVel.x, this.dragVel.y)
    }
    this.dragVel.set(0, 0)
  }

  private addLights() {
    this.scene.add(new THREE.HemisphereLight('#fff6e8', '#c9b39a', 1.1))
    const sun = this.sun
    sun.position.copy(SUN_OFFSET)
    sun.castShadow = true
    this.scene.add(sun.target) // moves with the camera's look-at point
    sun.shadow.mapSize.set(4096, 4096)
    const c = sun.shadow.camera
    c.left = c.bottom = -13
    c.right = c.top = 13
    c.near = 1
    c.far = 30
    sun.shadow.bias = -0.0005
    this.scene.add(sun)
  }

  /** Build the cafe from Meshy props according to CAFE_LAYOUT. */
  async loadEnvironment(): Promise<void> {
    const names = [...new Set(CAFE_LAYOUT.map((p) => p.asset))]
    const sources = new Map<string, { scene: THREE.Object3D; box: THREE.Box3 }>()
    await Promise.all(
      names.map(async (name) => {
        const asset = PROPS[name]
        if (!asset) throw new Error(`Layout uses unknown asset "${name}"`)
        const gltf = await this.loader.loadAsync(asset.url)
        sharpenTextures(gltf.scene)
        gltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = name !== 'env_cafe_floor'
            o.receiveShadow = true
          }
        })
        sources.set(name, { scene: gltf.scene, box: new THREE.Box3().setFromObject(gltf.scene) })
      }),
    )
    if (this.disposed) return

    for (const p of CAFE_LAYOUT) {
      const src = sources.get(p.asset)!
      const size = src.box.getSize(new THREE.Vector3())
      const centre = src.box.getCenter(new THREE.Vector3())
      const scale = new THREE.Vector3(1, 1, 1)
      if (p.dims) scale.set(p.dims[0] / size.x, p.dims[1] / size.y, p.dims[2] / size.z)
      else if (p.fit) scale.setScalar(p.fit.size / size[p.fit.axis])

      // Clones share geometry and materials with the source.
      const model = src.scene.clone()
      model.scale.copy(scale)
      model.position.set(-centre.x * scale.x, -src.box.min.y * scale.y, -centre.z * scale.z)
      const holder = new THREE.Group()
      holder.name = p.station ? `station:${p.station}` : p.asset
      holder.add(model)
      holder.position.set(...p.pos)
      holder.rotation.y = THREE.MathUtils.degToRad(p.rotY ?? 0)
      this.scene.add(holder)
      this.registerWall(holder, p.asset, p.pos)
      if (p.asset === 'env_cafe_floor') this.addFloorTop(p)

      if (p.station) {
        const top = new THREE.Vector3(p.pos[0], p.pos[1] + size.y * scale.y, p.pos[2])
        this.stations.set(p.station, top)
      }
      if (p.solid) {
        holder.updateMatrixWorld(true)
        const b = new THREE.Box3().setFromObject(holder)
        this.colliders.push({ minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z })
      }
    }
  }

  /**
   * The Meshy floor atlas has a very low texel density on its top (stair-stepped, blurry tile edges), so the slab is kept
   * for its sides and the top gets a crisp tiling checker (public/assets/textures/floor_checker.webp, made by
   * tools/make_floor_texture.mjs from the Meshy tile colours). One texture covers 2x2 tiles of FLOOR_TILE metres.
   */
  private addFloorTop(p: Placement) {
    const FLOOR_TILE = 1.4 // 8.4 m / 6 tiles per side (the Meshy floor had ~6 tiles of ~1.3 m)
    const w = p.dims![0]
    const d = p.dims![2]
    const tex = new THREE.TextureLoader().load('/assets/textures/floor_checker.webp')
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(w / (FLOOR_TILE * 2), d / (FLOOR_TILE * 2))
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    tex.generateMipmaps = true
    tex.minFilter = THREE.LinearMipmapLinearFilter
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.8,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    const top = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat)
    top.name = 'floor_top'
    top.rotation.x = -Math.PI / 2
    top.position.set(p.pos[0], p.pos[1] + p.dims![1] + 0.003, p.pos[2]) // 3 mm above the slab top
    top.receiveShadow = true
    this.scene.add(top)
  }

  /** Add a wall-mounted holder (panel, door, window, shelf) to its wall group, with its own material copies. */
  private registerWall(holder: THREE.Group, asset: string, pos: readonly [number, number, number]) {
    if (!asset.startsWith('env_cafe_wall')) return
    const axis = Math.abs(pos[2] + 4) < 0.3 ? 'z' : Math.abs(pos[0] + 4) < 0.3 ? 'x' : null
    if (!axis) return
    let wall = this.walls.find((w) => w.axis === axis)
    if (!wall) {
      wall = { axis, meshes: [], mats: [], fade: 0 }
      this.walls.push(wall)
    }
    // Clones share materials with other props and each other: give this holder private copies.
    const copies = new Map<THREE.Material, THREE.Material>()
    const own = (m: THREE.Material) => {
      let c = copies.get(m)
      if (!c) {
        c = m.clone()
        copies.set(m, c)
        wall.mats.push({ mat: c, opacity: c.opacity, transparent: c.transparent, depthWrite: c.depthWrite })
      }
      return c
    }
    holder.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material)
      wall.meshes.push(mesh)
    })
  }

  /** Fade each wall that stands between the camera and the cafe centre. Colliders are untouched. */
  private updateWalls(dt: number) {
    const k = 1 - Math.exp(-dt / WALL_FADE_TAU)
    const horiz = Math.cos(this.rig.pitch) // camera ground offset per unit of distance
    for (const w of this.walls) {
      // Camera offset from the cafe centre along the wall normal (the walls face +Z and +X).
      const off = (w.axis === 'z' ? Math.cos(this.rig.yaw) : Math.sin(this.rig.yaw)) * horiz * CAMERA_DISTANCE
      const t = THREE.MathUtils.clamp((CUTAWAY_CENTRE + CUTAWAY_HALF_BAND - off) / (2 * CUTAWAY_HALF_BAND), 0, 1)
      const goal = t * t * (3 - 2 * t)
      const prev = w.fade
      w.fade = this.rig.reducedMotion ? goal : w.fade + (goal - w.fade) * k
      if (Math.abs(w.fade - goal) < 0.002) w.fade = goal
      if (w.fade === prev && w.fade === goal) continue
      const faded = w.fade > 0.001
      for (const m of w.mats) {
        m.mat.opacity = m.opacity * (1 - w.fade * (1 - WALL_FADED_OPACITY))
        const transparent = faded || m.transparent
        if (m.mat.transparent !== transparent) {
          m.mat.transparent = transparent
          m.mat.needsUpdate = true
        }
        m.mat.depthWrite = faded ? false : m.depthWrite
      }
      const casts = w.fade < 0.5
      for (const mesh of w.meshes) mesh.castShadow = casts
    }
  }

  /** Push a circle of CHEF_RADIUS out of every solid footprint. */
  private resolveCollisions(p: THREE.Vector3) {
    p.x = THREE.MathUtils.clamp(p.x, -WALK_HALF, WALK_HALF)
    p.z = THREE.MathUtils.clamp(p.z, -WALK_HALF, WALK_HALF)
    for (const c of this.colliders) {
      const nx = THREE.MathUtils.clamp(p.x, c.minX, c.maxX)
      const nz = THREE.MathUtils.clamp(p.z, c.minZ, c.maxZ)
      const dx = p.x - nx
      const dz = p.z - nz
      const d2 = dx * dx + dz * dz
      if (d2 >= CHEF_RADIUS * CHEF_RADIUS) continue
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2)
        p.x = nx + (dx / d) * CHEF_RADIUS
        p.z = nz + (dz / d) * CHEF_RADIUS
      } else {
        // Centre is inside the box: exit through the nearest face.
        const exits = [
          { v: p.x - c.minX, x: c.minX - CHEF_RADIUS, z: p.z },
          { v: c.maxX - p.x, x: c.maxX + CHEF_RADIUS, z: p.z },
          { v: p.z - c.minZ, x: p.x, z: c.minZ - CHEF_RADIUS },
          { v: c.maxZ - p.z, x: p.x, z: c.maxZ + CHEF_RADIUS },
        ].sort((a, b) => a.v - b.v)[0]
        p.x = exits.x
        p.z = exits.z
      }
    }
  }

  /** Load a rigged character and its clips. The returned root is not yet in the scene. */
  async loadCharacter(asset: CharacterAsset): Promise<Character> {
    const gltf = await this.loader.loadAsync(asset.model)
    const model = gltf.scene
    sharpenTextures(model)
    if (asset.skinFix) applySkinFix(asset.skinFix, model)

    // Normalise height and put the feet on the floor.
    const box = new THREE.Box3().setFromObject(model)
    const scale = asset.height / (box.max.y - box.min.y)
    model.scale.setScalar(scale)
    model.position.y = -box.min.y * scale
    const bones: Record<string, THREE.Bone> = {}
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true
        o.frustumCulled = false // skinned bounds are unreliable
      }
      if ((o as THREE.Bone).isBone) bones[o.name] = o as THREE.Bone
    })

    const root = new THREE.Group()
    root.add(model)

    const mixer = new THREE.AnimationMixer(model)
    const actions: Character['actions'] = {}
    const files = await Promise.all(asset.clipFiles.map((f) => this.loader.loadAsync(f.url)))
    files.forEach((g, i) => {
      const f = asset.clipFiles[i]
      if (!g.animations.length) throw new Error(`No animation clip inside ${f.url}`)
      for (const clip of f.as ? [g.animations[0]] : g.animations) {
        makeInPlace(clip)
        actions[(f.as ?? clip.name) as ClipName] = mixer.clipAction(clip)
      }
    })
    const c: Character = {
      root,
      mixer,
      actions,
      bones,
      hipHeight: asset.height * 0.3,
      height: asset.height,
      current: null,
    }
    setWalking(c, false) // standing pose: measured below
    mixer.update(0)
    if (bones.Hips) {
      root.updateMatrixWorld(true)
      c.hipHeight = bones.Hips.getWorldPosition(new THREE.Vector3()).y
    }
    return c
  }

  /** Load a chef, replacing the current one. Rejects if a file is missing. */
  async loadChef(id: ChefId): Promise<void> {
    if (this.chef && this.chefId === id) return // already the loaded model
    const next = await this.loadCharacter(CHEFS[id])
    if (this.disposed) {
      this.removeCharacter(next)
      return
    }
    if (this.chef) {
      next.root.position.copy(this.chef.root.position)
      next.root.rotation.y = this.chef.root.rotation.y
    } else next.root.position.set(...CHEF_SPAWN)
    // Carry mount: follows the chef root, so held items turn with the chef.
    const mount = new THREE.Group()
    mount.position.set(...CHEF_CARRY_OFFSET).multiplyScalar(next.height / CARRY_REFERENCE_HEIGHT)
    next.root.add(mount)
    // Hand over held items before the old chef is disposed.
    if (this.chefMount) for (const item of [...this.chefMount.children]) mount.add(item)
    this.removeCharacter(this.chef)
    this.scene.add(next.root)
    this.chef = next
    this.chefId = id
    this.chefMount = mount
    this.chefAction = null
  }

  /** Which chef model is actually in the scene (null before the first load). */
  get loadedChef(): ChefId | null {
    return this.chef ? this.chefId : null
  }

  /** Group in the chef's local space (in front of the chest) that carried items attach to; null before the chef loads. */
  get chefCarry(): THREE.Group | null {
    return this.chefMount
  }

  removeCharacter(c: Character | null) {
    if (!c) return
    c.mixer.stopAllAction()
    c.mixer.uncacheRoot(c.root.children[0])
    this.scene.remove(c.root)
    c.root.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.geometry.dispose()
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose()
        mat.dispose()
      }
    })
  }

  /** Chef position on the floor, or null before the chef has loaded. */
  get chefPosition(): THREE.Vector3 | null {
    return this.chef ? this.chef.root.position : null
  }

  /** Canvas width in CSS pixels. */
  get viewWidth(): number {
    return this.canvas.clientWidth || window.innerWidth
  }

  get chefHeight(): number {
    return this.chef?.height ?? 1.1
  }

  /** World point -> CSS pixels inside the canvas. */
  project(world: THREE.Vector3, out: { x: number; y: number }) {
    const v = world.clone().project(this.camera)
    out.x = (v.x * 0.5 + 0.5) * this.canvas.clientWidth
    out.y = (-v.y * 0.5 + 0.5) * this.canvas.clientHeight
  }

  private updateChef(dt: number) {
    const chef = this.chef
    if (!chef) return
    let x = 0
    let z = 0
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z += 1
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z -= 1
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1
    const moving = x !== 0 || z !== 0

    if (moving) {
      const dir = new THREE.Vector3()
        .addScaledVector(this.rig.right, x)
        .addScaledVector(this.rig.forward, z)
        .normalize()
      const p = chef.root.position
      p.addScaledVector(dir, WALK_SPEED * dt)
      this.resolveCollisions(p)
      turnTowards(chef.root, Math.atan2(dir.x, dir.z), dt) // Meshy models face +Z
    }
    if (moving) {
      this.chefAction = null
      setWalking(chef, true)
    } else if (this.chefAction) {
      this.chefAction.left -= dt
      if (this.chefAction.left <= 0) {
        this.chefAction = null
        setWalking(chef, false)
      }
    } else setWalking(chef, false)
    chef.mixer.update(dt)
  }

  /** Play a one-shot chef clip (cook, pickup, cheer). Walking cancels it; it returns to idle when done. */
  chefAct(name: ClipName, opts: { seconds?: number; loop?: boolean; speed?: number } = {}) {
    const chef = this.chef
    if (!chef) return
    const speed = opts.speed ?? 1
    const loop = opts.loop ?? false
    if (chef.current === name) {
      const a = chef.actions[name]!
      a.reset().play()
      a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
      a.clampWhenFinished = !loop
      a.timeScale = speed
    } else if (!playClip(chef, name, { loop, speed })) return
    this.chefAction = { name, left: opts.seconds ?? clipSeconds(chef, name, speed) }
  }

  /** Instantly turn the chef to face a floor point. */
  chefFace(x: number, z: number) {
    const chef = this.chef
    if (!chef) return
    const p = chef.root.position
    if (Math.hypot(x - p.x, z - p.z) < 1e-3) return
    chef.root.rotation.y = Math.atan2(x - p.x, z - p.z)
  }

  private tick = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.tick)
    const dt = Math.min(this.clock.getDelta(), 0.05)
    if (!this.paused) {
      this.updateChef(dt)
      this.onTick?.(dt)
    }
    if (this.renderEnabled) {
      this.updateCamera(dt)
      this.renderer.render(this.scene, this.camera)
    }
    this.onFrame?.(dt) // audio only, cheap; keeps ambience fades correct while suspended
  }

  /** Runs every frame, paused or not, so the backdrop never jumps. */
  private updateCamera(dt: number) {
    this.rig.update(dt, this.chef?.root.position ?? null, this.keys, this.cameraInputEnabled, this.drag !== null)
    this.updateWalls(dt)
    // Keep the shadow frustum over what is on screen.
    const c = this.rig.center
    const sx = Math.round(c.x / SHADOW_SNAP) * SHADOW_SNAP
    const sz = Math.round(c.z / SHADOW_SNAP) * SHADOW_SNAP
    if (sx !== this.shadowCentre.x || sz !== this.shadowCentre.z) {
      this.shadowCentre.set(sx, 0, sz)
      this.sun.target.position.copy(this.shadowCentre)
      this.sun.position.copy(this.shadowCentre).add(SUN_OFFSET)
    }
  }

  /** Camera view direction projected on the ground (unit length); screen-right is `forward x up`. */
  get viewForward(): THREE.Vector3 {
    return this.rig.forward
  }

  /** Smoothly return to the default pose. `follow` chooses whether the chef is followed afterwards. */
  resetCamera(follow: boolean, instant = false) {
    this.rig.reset(follow, instant)
  }

  /** Turn follow-chef mode on or off. */
  setCameraFollow(on: boolean) {
    this.rig.setFollow(on)
  }

  get cameraFollowing(): boolean {
    return this.rig.followChef
  }

  private onResize = () => {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    const aspect = w / h
    this.camera.left = (-VIEW_SIZE * aspect) / 2
    this.camera.right = (VIEW_SIZE * aspect) / 2
    this.camera.top = VIEW_SIZE / 2
    this.camera.bottom = -VIEW_SIZE / 2
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code)
    if (e.repeat || !this.cameraInputEnabled || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.code === 'KeyR') this.rig.reset(true)
    else if (e.code === 'KeyF') this.rig.toggleFollow()
  }
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code)
  private onBlur = () => this.keys.clear()

  /** Debug info for the dev overlay and tests. */
  get info() {
    return {
      chefLoaded: !!this.chef,
      position: this.chef ? this.chef.root.position.toArray().map((n) => +n.toFixed(2)) : null,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    }
  }

  /** Test helper: put the chef somewhere (dev only). */
  teleportChef(x: number, z: number) {
    this.chef?.root.position.set(x, 0, z)
  }

  dispose() {
    this.disposed = true
    this.onFrame = null
    cancelAnimationFrame(this.raf)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerEnd)
    this.canvas.removeEventListener('pointercancel', this.onPointerEnd)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.chefMount?.clear() // shared food geometry must survive the chef disposal
    this.chefMount = null
    this.removeCharacter(this.chef)
    this.chef = null
    this.renderer.dispose()
  }
}
