// 3D serving models that follow an order: station -> chef's hands -> table -> leftover.
// Clones share geometry and materials with the loaded holders, so nothing here is disposed per order.
import * as THREE from 'three'
import { createGLTFLoader, sharpenTextures } from '../assets/loader'
import { FOOD } from '../assets/manifest'
import { CAFE_LAYOUT } from '../data/cafeLayout'
import type { StationId } from '../data/recipes'
import { SEATS } from '../data/service'
import type { CafeScene } from '../scenes/CafeScene'

/** Largest horizontal side of plated food, metres. */
export const PLATE_SIZE = 0.3
/** Height of drinks, metres. */
export const DRINK_HEIGHT = 0.2
/** Cap on the largest horizontal side of drinks on a saucer (coffee, tea), metres. */
export const SAUCER_MAX_SIDE = 0.24
/** Drinks are sized by height; every other recipe by its plate. */
const DRINKS = new Set(['coffee', 'iced_coffee', 'tea', 'lemonade'])
const SAUCER_DRINKS = new Set(['coffee', 'tea'])
/** Distance from the table centre towards the customer's seat, metres. */
export const TABLE_OFFSET = 0.12
/** Fallback tabletop height when the raycast misses, metres. */
const TABLE_FALLBACK_Y = 0.5
/** Items on counter-top machines are placed this far in front of the machine (towards the dining room, +Z). */
export const COUNTER_FRONT_OFFSET = 0.25
const COUNTER_STATIONS = new Set<string>(['coffee', 'blender'])
/** Leftover dishes: scale and tilt (radians). */
export const LEFTOVER_SCALE = 0.7
export const LEFTOVER_TILT = 0.07

interface Item {
  obj: THREE.Object3D
  /** Seat the item sits at once served, else null. */
  seat: number | null
}

export class FoodVisuals {
  private holders = new Map<string, THREE.Group>()
  private items = new Map<number, Item>()
  private scene: CafeScene
  private ray = new THREE.Raycaster()

  constructor(scene: CafeScene) {
    this.scene = scene
  }

  /** Load and normalise all food models once. */
  async load(): Promise<void> {
    const loader = createGLTFLoader()
    await Promise.all(
      Object.entries(FOOD).map(async ([id, url]) => {
        const gltf = await loader.loadAsync(url)
        const model = gltf.scene
        sharpenTextures(model)
        model.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true
            o.receiveShadow = true
          }
        })
        const box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        const centre = box.getCenter(new THREE.Vector3())
        const side = Math.max(size.x, size.z)
        let scale = PLATE_SIZE / side
        if (DRINKS.has(id)) {
          scale = DRINK_HEIGHT / size.y
          if (SAUCER_DRINKS.has(id)) scale = Math.min(scale, SAUCER_MAX_SIDE / side)
        }
        model.scale.setScalar(scale)
        model.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale)
        const holder = new THREE.Group()
        holder.name = `food:${id}`
        holder.add(model)
        this.holders.set(id, holder)
      }),
    )
  }

  /** The order is ready: show it on its station. */
  ready(orderId: number, recipeId: string, station: StationId) {
    this.remove(orderId)
    const obj = this.holders.get(recipeId)?.clone()
    if (!obj) return
    this.place(obj, this.stationPoint(station))
    this.scene.scene.add(obj)
    this.items.set(orderId, { obj, seat: null })
  }

  /** The chef picked it up: move it into the chef's hands. */
  pickup(orderId: number) {
    const it = this.items.get(orderId)
    const mount = this.scene.chefCarry
    if (!it || !mount) return
    it.obj.position.set(0, 0, 0)
    it.obj.rotation.set(0, 0, 0)
    it.obj.scale.setScalar(1)
    mount.add(it.obj)
  }

  /** Served: put it on the table in front of the customer. */
  serve(orderId: number, seat: number) {
    const it = this.items.get(orderId)
    if (!it) return
    const s = SEATS[seat]
    const d = new THREE.Vector3(s.pos[0] - s.table[0], 0, s.pos[2] - s.table[2])
    const len = d.length() || 1
    const p = new THREE.Vector3(s.table[0] + (d.x / len) * TABLE_OFFSET, 0, s.table[2] + (d.z / len) * TABLE_OFFSET)
    p.y = this.surfaceY(this.nearestHolder('prop_table_dining', p), p, 1.5, TABLE_FALLBACK_Y)
    it.obj.rotation.set(0, Math.atan2(d.x, d.z), 0)
    it.obj.scale.setScalar(1)
    it.obj.position.copy(p)
    this.scene.scene.add(it.obj)
    it.seat = seat
  }

  /** The customer paid and left: keep the dishes as a "needs clearing" cue. */
  leftover(orderId: number) {
    const it = this.items.get(orderId)
    if (!it) return
    it.obj.scale.setScalar(LEFTOVER_SCALE)
    it.obj.rotation.x = LEFTOVER_TILT
    it.obj.rotation.z = -LEFTOVER_TILT * 0.6
  }

  /** The table at this seat was cleaned. */
  clean(seat: number) {
    for (const [id, it] of this.items) if (it.seat === seat) this.remove(id)
  }

  /** Remove every food model (restart, next day, dispose). */
  clear() {
    for (const id of [...this.items.keys()]) this.remove(id)
  }

  private remove(orderId: number) {
    const it = this.items.get(orderId)
    if (!it) return
    it.obj.removeFromParent()
    this.items.delete(orderId)
  }

  private place(obj: THREE.Object3D, p: THREE.Vector3) {
    obj.position.copy(p)
    obj.rotation.set(0, 0, 0)
    obj.scale.setScalar(1)
  }

  /** Where food rests for a station: on the counter in front of machines, else on the station's top surface. */
  private stationPoint(station: StationId): THREE.Vector3 {
    const top = this.scene.stations.get(station)
    if (!top) return new THREE.Vector3()
    if (COUNTER_STATIONS.has(station)) {
      const base = CAFE_LAYOUT.find((p) => p.station === station)?.pos[1] ?? top.y
      const p = new THREE.Vector3(top.x, base, top.z + COUNTER_FRONT_OFFSET)
      const counters = this.scene.scene.children.filter((o) => o.name === 'prop_counter_bar')
      const y = this.surfaceY(counters, p, base + 0.5, base)
      p.y = Math.abs(y - base) < 0.15 ? y : base
      return p
    }
    const holder = this.scene.scene.getObjectByName(`station:${station}`)
    const p = top.clone()
    p.y = this.surfaceY(holder ? [holder] : [], p, top.y + 0.5, top.y)
    return p
  }

  private nearestHolder(name: string, p: THREE.Vector3): THREE.Object3D[] {
    let best: THREE.Object3D | null = null
    let bestD = Infinity
    for (const o of this.scene.scene.children) {
      if (o.name !== name) continue
      const d = Math.hypot(o.position.x - p.x, o.position.z - p.z)
      if (d < bestD) {
        bestD = d
        best = o
      }
    }
    return best ? [best] : []
  }

  /** Height of the highest surface under (p.x, p.z) on the given objects, or the fallback. */
  private surfaceY(targets: THREE.Object3D[], p: THREE.Vector3, fromY: number, fallback: number): number {
    if (!targets.length) return fallback
    for (const t of targets) t.updateMatrixWorld(true)
    this.ray.set(new THREE.Vector3(p.x, fromY, p.z), new THREE.Vector3(0, -1, 0))
    const hit = this.ray.intersectObjects(targets, true)[0]
    return hit ? hit.point.y : fallback
  }
}
