// Core service loop: customers arrive, sit, order; the chef prepares, serves, gets paid, cleans.
// Follows the customer state machine in the GDD (section 7). Cozy rules: no patience timers, no failure.
import * as THREE from 'three'
import { NPCS } from '../assets/manifest'
import { RECIPES, STATION_LABEL, type Recipe, type StationId } from '../data/recipes'
import { DAY, ENTRY_ROUTE, SEATS } from '../data/service'
import { FoodVisuals } from './foodVisuals'
import { measureSeatSpot, seatedPoses, seatedRoot, type SeatedPoses, type SeatSpot } from './seating'
import { clipSeconds, playClip, setWalking, turnTowards, type CafeScene, type Character } from '../scenes/CafeScene'

export type OrderStatus = 'New' | 'Preparing' | 'Ready' | 'Carried' | 'Served' | 'Completed'

interface Order {
  id: number
  recipe: Recipe
  seat: number
  status: OrderStatus
  /** 0..1 while Preparing. */
  progress: number
}

type CustomerState =
  | 'Entering'
  | 'WalkToSeat'
  | 'Seated'
  | 'WaitingForOrder'
  | 'Eating'
  | 'Payment'
  | 'StandingUp'
  | 'Leaving'

interface Customer {
  npc: number
  char: Character
  seat: number
  state: CustomerState
  path: THREE.Vector3[]
  timer: number
  order: Order | null
  /** Seconds elapsed in the current sit-down / stand-up clip, and its length (0 = none running). */
  anim: number
  animLen: number
  /** Smooth move of the root (clip-to-clip pelvis offset changes, sitting down, standing up). */
  glide: Glide | null
  /** Started when the current glide finishes (stand-up: first match the clip pose, then rise and step aside). */
  glideNext: { to: THREE.Vector3; dur: number } | null
}

interface Glide {
  from: THREE.Vector3
  to: THREE.Vector3
  t: number
  dur: number
}

interface Seat {
  occupied: boolean
  dirty: boolean
}

type Action =
  | { kind: 'serve'; customer: Customer; label: string }
  | { kind: 'clean'; seat: number; label: string }
  | { kind: 'pickup'; station: StationId; label: string }
  | { kind: 'prepare'; station: StationId; order: Order; label: string }

/** Small typed events for listeners that must stay outside the simulation (voice, captions, ...). */
export type GameEvent =
  | { type: 'seated'; npc: number; seat: number }
  | { type: 'standUp'; npc: number; seat: number }
  /** A customer passes the door (entering = coming in, otherwise leaving). */
  | { type: 'door'; npc: number; entering: boolean }
  | { type: 'prepare'; station: StationId; recipe: string }
  | { type: 'ready'; station: StationId }
  | { type: 'pickup'; station: StationId }
  | { type: 'clean'; seat: number }
  | { type: 'serve'; npc: number; seat: number; station: StationId }
  | { type: 'paid'; npc: number }
  | { type: 'leaving'; npc: number }
  | { type: 'summary' }
  /** The day was restarted: orders and customers are gone. */
  | { type: 'reset' }

export interface GameSnapshot {
  day: number
  money: number
  served: number
  total: number
  carrying: string | null
  prompt: string | null
  notice: string | null
  orders: { id: number; icon: string; name: string; status: OrderStatus; station: string }[]
  summary: { day: number; customers: number; orders: number; revenue: number } | null
  /** Tutorial signals. */
  nearStation: boolean
  nextStation: StationId | null
  everServed: number
  everPaid: number
}

const NPC_SPEED = 1.25
const REACH_STATION = 1.45
const REACH_TABLE = 1.5
/** Seconds over which the root slides when the seated clip (and with it the pelvis offset) changes. */
export const SEAT_BLEND_SECONDS = 0.25
/** Seconds the root takes to reach the stand-up clip's first pose (matches the clip cross-fade). */
const CLIP_FADE = 0.1
/** Speech bubbles float this far above a seated customer's head. */
const LABEL_ABOVE_HEAD = 0.12
export const SIT_DOWN_SPEED = 2.2
export const STAND_UP_SPEED = 2.5
export const DRINK_SPEED = 1.4
/** Chef pickup clip: only the first part is shown (the clip turns the body late). */
export const PICKUP_SECONDS = 1.0
const PICKUP_SPEED = 1.3
/** Door waypoint on the entry route (customers pass it on the way in and out). */
const DOOR = ENTRY_ROUTE[2]
const smooth = (t: number) => t * t * (3 - 2 * t)
const v3 = (p: [number, number, number]) => new THREE.Vector3(...p)

const STATUS_TEXT: Record<OrderStatus, string> = {
  New: 'New Order',
  Preparing: 'Preparing…',
  Ready: 'Ready to Serve',
  Carried: 'On the Way',
  Served: 'Order Served',
  Completed: 'Completed',
}

export class CafeGame {
  private pool: (Character | null)[] = []
  private busyNpc = new Set<number>()
  private customers: Customer[] = []
  private spots: (SeatSpot | null)[] = SEATS.map(() => null)
  private seats: Seat[] = SEATS.map(() => ({ occupied: false, dirty: false }))
  private orders: Order[] = []
  private stationOrder = new Map<StationId, Order>()
  private carrying: Order | null = null
  private nextOrderId = 1
  private everServed = 0
  private everPaid = 0
  private day = 1
  private money = 0
  private dayRevenue = 0
  private arrived = 0
  private finished = 0
  private ordersDone = 0
  private spawnTimer = DAY.firstArrival
  private summary: GameSnapshot['summary'] = null
  private notice: { text: string; ttl: number } | null = null
  private action: Action | null = null
  private labels = new Map<string, HTMLDivElement>()
  private live = new Set<string>()
  private screen = { x: 0, y: 0 }
  /** Optional listener for game events. */
  onEvent: ((e: GameEvent) => void) | null = null
  private scene: CafeScene
  private layer: HTMLElement
  private food: FoodVisuals

  constructor(scene: CafeScene, labelLayer: HTMLElement) {
    this.scene = scene
    this.food = new FoodVisuals(scene)
    this.layer = labelLayer
    window.addEventListener('keydown', this.onKey)
    scene.onTick = (dt) => this.update(dt)
  }

  /** Load the six customers once; they are reused for every visit. */
  async load(): Promise<void> {
    const [pool] = await Promise.all([Promise.all(NPCS.map((a) => this.scene.loadCharacter(a))), this.food.load()])
    this.pool = pool
    // Measure the seated poses of every customer once (this poses the skeleton, so reset it to standing afterwards).
    for (const ch of pool) {
      if (!ch) continue
      seatedPoses(ch)
      ch.current = null
      this.stand(ch)
    }
  }

  dispose() {
    this.food.clear()
    window.removeEventListener('keydown', this.onKey)
    this.scene.onTick = null
    this.labels.forEach((el) => el.remove())
    this.pool.forEach((c) => this.scene.removeCharacter(c))
  }

  private onKey = (e: KeyboardEvent) => {
    if ((e.code === 'KeyE' || e.code === 'Space') && !e.repeat) {
      e.preventDefault()
      this.interact()
    }
  }

  /** World position of the customer with this npc index, or null when not in the cafe. */
  customerPosition(npc: number): THREE.Vector3 | null {
    const c = this.customers.find((k) => k.npc === npc)
    return c ? c.char.root.position.clone() : null
  }

  private emit(e: GameEvent) {
    this.onEvent?.(e)
  }

  /** Put a pooled character back into a clean standing state. */
  private stand(char: Character) {
    playClip(char, 'idle', { fade: 0 })
    setWalking(char, false)
  }

  // ---------------------------------------------------------------- customers

  private trySpawn() {
    if (this.arrived >= DAY.customers) return
    const seat = this.seats.findIndex((s) => !s.occupied && !s.dirty)
    const npc = this.pool.findIndex((c, i) => c && !this.busyNpc.has(i))
    if (seat < 0 || npc < 0) {
      if (seat < 0) this.say('No Available Seats')
      return
    }
    const char = this.pool[npc]!
    this.busyNpc.add(npc)
    this.seats[seat].occupied = true
    this.arrived++
    this.stand(char)
    char.root.position.copy(v3(ENTRY_ROUTE[0]))
    char.root.rotation.y = 0
    this.scene.scene.add(char.root)
    this.customers.push({
      npc,
      char,
      seat,
      state: 'Entering',
      path: ENTRY_ROUTE.slice(1).map(v3),
      timer: 0,
      order: null,
      anim: 0,
      animLen: 0,
      glide: null,
      glideNext: null,
    })
  }

  /** Walk along c.path. Returns true when the path is finished. */
  private walk(c: Customer, dt: number): boolean {
    const target = c.path[0]
    if (!target) return true
    const pos = c.char.root.position
    const to = target.clone().sub(pos)
    const dist = to.length()
    const step = NPC_SPEED * dt
    if (dist <= step) {
      pos.copy(target)
      c.path.shift()
      if (target.x === DOOR[0] && target.z === DOOR[2]) this.emit({ type: 'door', npc: c.npc, entering: c.state === 'Entering' })
    } else {
      to.divideScalar(dist)
      pos.addScaledVector(to, step)
      turnTowards(c.char.root, Math.atan2(to.x, to.z), dt)
    }
    setWalking(c.char, true)
    return c.path.length === 0
  }

  /** Measure every chair once (call after the environment has loaded) so no seat hitches mid-game. */
  prepareSeats() {
    for (let i = 0; i < SEATS.length; i++) this.spotFor(i)
  }

  /** The chair seat of this seat index: measured from the table model once it is in the scene, else the static data. */
  private spotFor(seat: number): Pick<SeatSpot, 'x' | 'y' | 'z'> {
    const cached = this.spots[seat]
    if (cached) return cached
    const s = SEATS[seat]
    let holder: THREE.Object3D | null = null
    let best = Infinity
    for (const o of this.scene.scene.children) {
      if (o.name !== 'prop_table_dining') continue
      const d = Math.hypot(o.position.x - s.table[0], o.position.z - s.table[2])
      if (d < best) {
        best = d
        holder = o
      }
    }
    const spot = holder && best < 0.1 ? measureSeatSpot(holder, s.table[0], s.table[2], s.pos[0] < s.table[0] ? -1 : 1) : null
    if (!spot) return { x: s.pos[0], y: s.pos[1], z: s.pos[2] } // table not loaded (yet): do not cache
    this.spots[seat] = spot
    return spot
  }

  /** Root position that puts the pelvis of this clip pose over the seat centre with the buttocks on the cushion. */
  private seatedRootFor(c: Customer, pose: keyof SeatedPoses): THREE.Vector3 {
    const spot = this.spotFor(c.seat)
    const poses = seatedPoses(c.char)
    if (!poses) return new THREE.Vector3(spot.x, spot.y - c.char.hipHeight + 0.14, spot.z)
    return seatedRoot(spot, SEATS[c.seat].yaw, poses[pose])
  }

  /** Slide the root to a target over dur seconds, starting from where it is now. */
  private glideTo(c: Customer, to: THREE.Vector3, dur = SEAT_BLEND_SECONDS) {
    c.glide = { from: c.char.root.position.clone(), to, t: 0, dur }
  }

  private updateGlide(c: Customer, dt: number) {
    const g = c.glide
    if (!g) return
    g.t += dt
    const k = smooth(Math.min(1, g.t / Math.max(g.dur, 1e-4)))
    c.char.root.position.lerpVectors(g.from, g.to, k)
    if (g.t < g.dur) return
    c.glide = null
    if (c.glideNext) {
      this.glideTo(c, c.glideNext.to, c.glideNext.dur)
      c.glideNext = null
    }
  }

  private hasSitClips(c: Customer) {
    return !!c.char.actions.sitIdle
  }

  private sit(c: Customer) {
    const s = SEATS[c.seat]
    const root = c.char.root
    root.rotation.y = THREE.MathUtils.degToRad(s.yaw)
    c.anim = 0
    c.animLen = 0
    c.glide = c.glideNext = null
    if (this.hasSitClips(c)) {
      if (playClip(c.char, 'sitDown', { loop: false, speed: SIT_DOWN_SPEED, fade: 0.1 }))
        c.animLen = clipSeconds(c.char, 'sitDown', SIT_DOWN_SPEED)
      else playClip(c.char, 'sitIdle')
      // Lower from the standing spot beside the chair onto the seat.
      if (c.animLen) this.glideTo(c, this.seatedRootFor(c, 'sitDownEnd'), c.animLen)
      else root.position.copy(this.seatedRootFor(c, 'sitIdle'))
    } else {
      root.position.copy(this.seatedRootFor(c, 'sitIdle'))
      setWalking(c.char, false)
    }
  }

  /** Finish any running sit-down so the character is settled on the seat. */
  private settle(c: Customer) {
    if (!this.hasSitClips(c)) return
    c.animLen = 0
    this.glideTo(c, this.seatedRootFor(c, 'sitIdle'))
  }

  /** Advance the sit-down animation; when it ends the idle loop starts and the root settles to its pelvis offset. */
  private updateSitDown(c: Customer, dt: number) {
    if (!c.animLen) return
    c.anim += dt
    if (c.anim >= c.animLen) {
      c.animLen = 0
      playClip(c.char, 'sitIdle')
      this.glideTo(c, this.seatedRootFor(c, 'sitIdle'))
    }
  }

  /** Seated pose: thighs forward, shins down. Only a fallback for characters without a sitIdle clip. */
  private applySitPose(c: Character) {
    const b = c.bones
    b.LeftUpLeg?.rotateX(-1.4)
    b.RightUpLeg?.rotateX(-1.4)
    b.LeftLeg?.rotateX(1.4)
    b.RightLeg?.rotateX(1.4)
  }

  private updateCustomer(c: Customer, dt: number) {
    const seated = c.state === 'Seated' || c.state === 'WaitingForOrder' || c.state === 'Eating' || c.state === 'Payment'
    if (c.state === 'Seated' || c.state === 'WaitingForOrder') this.updateSitDown(c, dt)
    if (seated || c.state === 'StandingUp') this.updateGlide(c, dt)
    switch (c.state) {
      case 'Entering':
        if (this.walk(c, dt)) {
          c.path = SEATS[c.seat].approach.map(v3)
          c.state = 'WalkToSeat'
        }
        break
      case 'WalkToSeat':
        if (this.walk(c, dt)) {
          this.sit(c)
          c.state = 'Seated'
          c.timer = DAY.orderDelay
          this.emit({ type: 'seated', npc: c.npc, seat: c.seat })
        }
        break
      case 'Seated':
        c.timer -= dt
        if (c.timer <= 0) {
          const recipe = RECIPES[Math.floor(Math.random() * RECIPES.length)]
          c.order = { id: this.nextOrderId++, recipe, seat: c.seat, status: 'New', progress: 0 }
          this.orders.push(c.order)
          c.state = 'WaitingForOrder'
          this.say('New Order')
        }
        break
      case 'WaitingForOrder':
        break // cozy: customers wait as long as it takes
      case 'Eating':
        c.timer -= dt
        if (c.timer <= 0) {
          c.state = 'Payment'
          c.timer = DAY.payTime
          playClip(c.char, 'sitIdle')
          this.glideTo(c, this.seatedRootFor(c, 'sitIdle'))
        }
        break
      case 'Payment':
        c.timer -= dt
        if (c.timer <= 0) {
          const o = c.order!
          o.status = 'Completed'
          this.money += o.recipe.price
          this.dayRevenue += o.recipe.price
          this.ordersDone++
          this.everPaid++
          this.say('Customer Paid')
          this.seats[c.seat].dirty = true
          this.food.leftover(o.id)
          this.emit({ type: 'paid', npc: c.npc })
          this.emit({ type: 'standUp', npc: c.npc, seat: c.seat })
          c.state = 'StandingUp'
          c.anim = 0
          c.animLen = 0
          if (this.hasSitClips(c) && playClip(c.char, 'standUp', { loop: false, speed: STAND_UP_SPEED, fade: 0.1 })) {
            c.animLen = clipSeconds(c.char, 'standUp', STAND_UP_SPEED)
            // First match the clip's first pose (pelvis stays over the seat), then rise and step beside the chair.
            const s = SEATS[c.seat]
            const beside = s.approach[s.approach.length - 1]
            this.glideTo(c, this.seatedRootFor(c, 'standUpStart'), CLIP_FADE)
            c.glideNext = { to: v3(beside), dur: Math.max(c.animLen - CLIP_FADE, 0.1) }
          }
        }
        break
      case 'StandingUp': {
        c.anim += dt
        if (!c.glide) {
          c.glideNext = null
          const s = SEATS[c.seat]
          const beside = s.approach[s.approach.length - 1]
          c.char.root.position.set(beside[0], 0, beside[2])
          c.path = [...s.approach.slice(0, -1).reverse(), ...ENTRY_ROUTE.slice().reverse()].map(v3)
          c.state = 'Leaving'
          c.animLen = 0
          setWalking(c.char, true)
          this.emit({ type: 'leaving', npc: c.npc })
        }
        break
      }
      case 'Leaving':
        if (this.walk(c, dt)) {
          this.scene.scene.remove(c.char.root)
          this.stand(c.char)
          this.busyNpc.delete(c.npc)
          this.seats[c.seat].occupied = false
          this.finished++
          this.customers.splice(this.customers.indexOf(c), 1)
          return
        }
        break
    }
    c.char.mixer.update(dt)
    if (seated && !this.hasSitClips(c)) this.applySitPose(c.char)
  }

  // ---------------------------------------------------------------- chef actions

  private near(p: THREE.Vector3 | [number, number, number], reach: number): boolean {
    const chef = this.scene.chefPosition
    if (!chef) return false
    const x = Array.isArray(p) ? p[0] : p.x
    const z = Array.isArray(p) ? p[2] : p.z
    return Math.hypot(chef.x - x, chef.z - z) <= reach
  }

  /** The one thing the interact key would do right now, by priority. */
  private findAction(): Action | null {
    if (this.carrying) {
      const c = this.customers.find((k) => k.order === this.carrying)
      if (c && this.near(SEATS[c.seat].table, REACH_TABLE))
        return { kind: 'serve', customer: c, label: `Serve ${this.carrying.recipe.name}` }
    }
    const dirty = this.seats.findIndex((s, i) => s.dirty && !s.occupied && this.near(SEATS[i].table, REACH_TABLE))
    if (dirty >= 0) return { kind: 'clean', seat: dirty, label: 'Clean Table' }

    for (const [id, pos] of this.scene.stations) {
      if (!this.near(pos, REACH_STATION)) continue
      const station = id as StationId
      if (!(station in STATION_LABEL)) continue
      const current = this.stationOrder.get(station)
      if (current?.status === 'Ready' && !this.carrying)
        return { kind: 'pickup', station, label: `Pick Up ${current.recipe.name}` }
      if (!current) {
        const order = this.orders.find((o) => o.status === 'New' && o.recipe.station === station)
        if (order) return { kind: 'prepare', station, order, label: `Prepare ${order.recipe.name}` }
      }
    }
    return null
  }

  interact() {
    if (this.summary || this.scene.paused) return
    const a = this.findAction()
    if (!a) return
    switch (a.kind) {
      case 'prepare': {
        a.order.status = 'Preparing'
        this.stationOrder.set(a.station, a.order)
        this.say('Preparing…')
        this.faceStation(a.station)
        this.scene.chefAct('cook', { loop: true, seconds: 2.2 })
        this.emit({ type: 'prepare', station: a.station, recipe: a.order.recipe.id })
        break
      }
      case 'pickup': {
        this.faceStation(a.station)
        this.scene.chefAct('pickup', { speed: PICKUP_SPEED, seconds: PICKUP_SECONDS })
        const o = this.stationOrder.get(a.station)!
        o.status = 'Carried'
        this.carrying = o
        this.food.pickup(o.id)
        this.stationOrder.delete(a.station)
        this.emit({ type: 'pickup', station: a.station })
        break
      }
      case 'serve': {
        const o = this.carrying!
        o.status = 'Served'
        this.everServed++
        this.carrying = null
        this.food.serve(o.id, a.customer.seat)
        a.customer.state = 'Eating'
        a.customer.timer = DAY.eatTime
        this.settle(a.customer)
        playClip(a.customer.char, 'drink', { speed: DRINK_SPEED })
        this.glideTo(a.customer, this.seatedRootFor(a.customer, 'drink'))
        this.say('Order Served')
        this.faceTable(a.customer.seat)
        this.scene.chefAct('pickup', { speed: PICKUP_SPEED, seconds: PICKUP_SECONDS })
        this.emit({ type: 'serve', npc: a.customer.npc, seat: a.customer.seat, station: o.recipe.station })
        break
      }
      case 'clean':
        this.seats[a.seat].dirty = false
        this.food.clean(a.seat)
        this.faceTable(a.seat)
        this.scene.chefAct('pickup', { speed: PICKUP_SPEED, seconds: PICKUP_SECONDS })
        this.emit({ type: 'clean', seat: a.seat })
        break
    }
    this.action = this.findAction()
  }

  private faceStation(id: StationId) {
    const p = this.scene.stations.get(id)
    if (p) this.scene.chefFace(p.x, p.z)
  }

  private faceTable(seat: number) {
    const t = SEATS[seat].table
    this.scene.chefFace(t[0], t[2])
  }

  private say(text: string) {
    this.notice = { text, ttl: 2.2 }
  }

  // ---------------------------------------------------------------- update

  private update(dt: number) {
    if (this.summary) return

    this.spawnTimer -= dt
    if (this.spawnTimer <= 0) {
      this.trySpawn()
      this.spawnTimer = DAY.arrivalGap
    }

    for (const c of [...this.customers]) this.updateCustomer(c, dt)

    for (const [station, o] of [...this.stationOrder]) {
      if (o.status !== 'Preparing') continue
      o.progress = Math.min(1, o.progress + dt / o.recipe.prep)
      if (o.progress >= 1) {
        o.status = 'Ready'
        this.food.ready(o.id, o.recipe.id, station)
        this.say('Ready to Serve')
        this.emit({ type: 'ready', station })
      }
    }

    if (this.notice && (this.notice.ttl -= dt) <= 0) this.notice = null
    this.action = this.findAction()
    this.updateLabels()

    const allGone = this.arrived >= DAY.customers && this.customers.length === 0
    if (allGone && this.seats.every((s) => !s.dirty)) {
      this.summary = { day: this.day, customers: this.finished, orders: this.ordersDone, revenue: this.dayRevenue }
      this.clearLabels()
      this.scene.chefAct('cheer', { loop: true, seconds: 3 })
      this.emit({ type: 'summary' })
    }
  }

  /** Called with the new day number and total money whenever a day is completed. */
  onDayAdvance: ((day: number, money: number) => void) | null = null

  /** Continue from a save. Only valid before the first customer of the session. */
  restore(day: number, money: number) {
    this.day = day
    this.money = money
  }

  /** Station (or null) the tutorial wants the player to look at; drawn as a bouncing pointer. */
  highlight: string | null = null

  /** Throw away the current day's progress and start it again (Pause > Restart Day). */
  restartDay() {
    for (const c of this.customers) {
      this.scene.scene.remove(c.char.root)
      this.stand(c.char)
    }
    this.customers = []
    this.busyNpc.clear()
    this.seats.forEach((s) => (s.occupied = s.dirty = false))
    this.orders = []
    this.stationOrder.clear()
    this.carrying = null
    this.food.clear()
    this.money -= this.dayRevenue
    this.arrived = this.finished = this.ordersDone = this.dayRevenue = 0
    this.spawnTimer = DAY.firstArrival
    this.summary = null
    this.notice = null
    this.action = null
    this.clearLabels()
    this.emit({ type: 'reset' })
  }

  /** Orders currently being prepared (live view for sound loops). */
  get preparing(): { station: StationId; recipe: string; progress: number }[] {
    const out: { station: StationId; recipe: string; progress: number }[] = []
    for (const [station, o] of this.stationOrder)
      if (o.status === 'Preparing') out.push({ station, recipe: o.recipe.id, progress: o.progress })
    return out
  }

  /** Customers currently walking (in, to the seat or out); `pos` is the live position. */
  get walkers(): { npc: number; pos: THREE.Vector3 }[] {
    const out: { npc: number; pos: THREE.Vector3 }[] = []
    for (const c of this.customers)
      if (c.state === 'Entering' || c.state === 'WalkToSeat' || c.state === 'Leaving') out.push({ npc: c.npc, pos: c.char.root.position })
    return out
  }

  get progress() {
    return { day: this.day, money: this.money - this.dayRevenue }
  }

  nextDay() {
    if (!this.summary) return
    this.summary = null
    this.day++
    this.onDayAdvance?.(this.day, this.money)
    this.arrived = this.finished = this.ordersDone = this.dayRevenue = 0
    this.orders = []
    this.food.clear()
    this.spawnTimer = DAY.firstArrival
  }

  // ---------------------------------------------------------------- world-space labels

  private label(key: string, world: THREE.Vector3, html: string, cls = '') {
    let el = this.labels.get(key)
    if (!el) {
      el = document.createElement('div')
      this.layer.appendChild(el)
      this.labels.set(key, el)
    }
    if (el.dataset.html !== html) {
      el.innerHTML = html
      el.dataset.html = html
    }
    el.className = `world-label ${cls}`
    this.scene.project(world, this.screen)
    el.style.transform = `translate(-50%, -100%) translate(${this.screen.x.toFixed(1)}px, ${this.screen.y.toFixed(1)}px)`
    this.live.add(key)
  }

  private clearLabels() {
    this.labels.forEach((el) => el.remove())
    this.labels.clear()
  }

  /** Approximate head-top height of a seated customer. */
  private seatedHeadY(c: Customer): number {
    const poses = seatedPoses(c.char)
    const rootY = c.char.root.position.y
    return poses ? rootY + c.char.height - c.char.hipHeight + poses.sitIdle.hips.y : this.spotFor(c.seat).y + 0.75
  }

  private updateLabels() {
    this.live.clear()
    const p = new THREE.Vector3()

    for (const c of this.customers) {
      const head = p.copy(c.char.root.position)
      const seated = c.state !== 'Entering' && c.state !== 'WalkToSeat' && c.state !== 'Leaving'
      head.y = (seated ? this.seatedHeadY(c) : head.y + c.char.height) + LABEL_ABOVE_HEAD
      const o = c.order
      if (c.state === 'WaitingForOrder' && o)
        this.label(`c${c.npc}`, head, `<span class="ico">${o.recipe.icon}</span>${o.recipe.name}`, 'bubble')
      else if (c.state === 'Eating') this.label(`c${c.npc}`, head, '<span class="ico">😋</span>Enjoying', 'bubble soft')
      else if (c.state === 'Payment') this.label(`c${c.npc}`, head, '<span class="ico">💰</span>Thank you!', 'bubble soft')
    }

    for (const [station, o] of this.stationOrder) {
      const pos = this.scene.stations.get(station)
      if (!pos) continue
      p.copy(pos).y += 0.25
      if (o.status === 'Preparing')
        this.label(
          `s${station}`,
          p,
          `<span class="ico">${o.recipe.icon}</span>Preparing…<i class="bar"><b style="width:${Math.round(o.progress * 100)}%"></b></i>`,
          'station',
        )
      else if (o.status === 'Ready')
        this.label(`s${station}`, p, `<span class="ico">${o.recipe.icon}</span>✔ Ready to Serve`, 'station ready')
    }

    this.seats.forEach((s, i) => {
      if (!s.dirty) return
      p.set(SEATS[i].table[0], 1.1, SEATS[i].table[2])
      this.label(`t${Math.floor(i / 2)}`, p, '<span class="ico">🧽</span>Table Needs Cleaning', 'station')
    })

    const target = this.highlight ? this.scene.stations.get(this.highlight) : null
    if (target) {
      p.copy(target).y += this.stationOrder.has(this.highlight as StationId) ? 0.75 : 0.3
      this.label('highlight', p, '▼', 'pointer')
    }

    for (const [key, el] of this.labels) {
      if (this.live.has(key)) continue
      el.remove()
      this.labels.delete(key)
    }
  }

  // ---------------------------------------------------------------- HUD state

  snapshot(): GameSnapshot {
    return {
      day: this.day,
      money: this.money,
      served: this.finished,
      total: DAY.customers,
      carrying: this.carrying ? `${this.carrying.recipe.icon} ${this.carrying.recipe.name}` : null,
      prompt: this.action?.label ?? null,
      notice: this.notice?.text ?? null,
      orders: this.orders
        .filter((o) => o.status !== 'Completed')
        .map((o) => ({
          id: o.id,
          icon: o.recipe.icon,
          name: o.recipe.name,
          status: o.status,
          station: STATION_LABEL[o.recipe.station],
        })),
      summary: this.summary,
      nearStation: [...this.scene.stations].some(([id, pos]) => id in STATION_LABEL && this.near(pos, REACH_STATION)),
      nextStation: this.orders.find((o) => o.status === 'New')?.recipe.station ?? null,
      everServed: this.everServed,
      everPaid: this.everPaid,
    }
  }

  static statusText(s: OrderStatus) {
    return STATUS_TEXT[s]
  }

  /** Dev/test view of the simulation. */
  get debug() {
    return {
      customers: this.customers.map((c) => ({
        npc: c.npc,
        seat: c.seat,
        state: c.state,
        order: c.order ? `${c.order.recipe.id}:${c.order.status}` : null,
        pos: c.char.root.position.toArray().map((n) => +n.toFixed(2)),
      })),
      seats: this.seats.map((s) => `${s.occupied ? 'O' : '-'}${s.dirty ? 'D' : '-'}`).join(' '),
      stations: Object.fromEntries([...this.scene.stations].map(([k, v]) => [k, [+v.x.toFixed(2), +v.z.toFixed(2)]])),
      action: this.action?.label ?? null,
    }
  }
}
