// Maps game events and per-frame state to positional sound effects: door bell, footsteps, chairs,
// station loops, cup / plate / pickup / register one-shots. Ambience and traffic live in ambience.ts.
import * as THREE from 'three'
import type { AudioSystem, LoopHandle } from '../audio/AudioSystem'
import type { CafeScene } from '../scenes/CafeScene'
import { ENTRY_ROUTE, SEATS } from '../data/service'
import type { CafeGame, GameEvent } from './CafeGame'

const DIR = '/assets/audio/sfx/'
export const SFX = {
  doorBell: `${DIR}sfx_door_bell.mp3`,
  footsteps: `${DIR}sfx_footsteps.mp3`,
  chair: `${DIR}sfx_chair.mp3`,
  cup: `${DIR}sfx_cup_place.mp3`,
  plate: `${DIR}sfx_plate_place.mp3`,
  pickup: `${DIR}sfx_pickup.mp3`,
  register: `${DIR}sfx_register.mp3`,
  coffee: `${DIR}sfx_coffee_machine.mp3`,
  milk: `${DIR}sfx_milk_steam.mp3`,
  blender: `${DIR}sfx_blender.mp3`,
  sizzle: `${DIR}sfx_sizzle.mp3`,
  hover: `${DIR}sfx_ui_hover.mp3`,
  confirm: `${DIR}sfx_ui_confirm.mp3`,
  cancel: `${DIR}sfx_ui_cancel.mp3`,
}

export const SFX_VOLUME = {
  doorBellIn: 1,
  doorBellOut: 0.7,
  customerSteps: 0.35,
  chefSteps: 0.3,
  chair: 0.8,
  place: 0.8,
  pickup: 0.8,
  register: 0.6,
  stationLoop: 0.45,
}
/** Seconds of walking between two footstep clips (the file holds four steps). */
export const CUSTOMER_STEP_INTERVAL = 2.0
export const CHEF_STEP_INTERVAL = 1.6
/** Footsteps only play for customers with |x| and |z| under this (inside the cafe). */
export const INSIDE_LIMIT = 4.2
/** Chef counts as moving above this speed (m/s); jumps above CHEF_TELEPORT_SPEED are ignored. */
const CHEF_MOVING_SPEED = 0.4
const CHEF_TELEPORT_SPEED = 8
/** Milk steam joins a 'coffee' prep for the last part of it. */
export const MILK_START = 0.6

const COFFEE_MACHINE_RECIPES = new Set(['coffee', 'iced_coffee', 'tea'])
const DRINK_STATIONS = new Set<string>(['coffee', 'blender'])

const DOOR = new THREE.Vector3(ENTRY_ROUTE[2][0], 1.2, ENTRY_ROUTE[2][2])

interface DirectorOptions {
  audio: AudioSystem
  game: CafeGame
  scene: CafeScene
}

export class SfxDirector {
  private o: DirectorOptions
  private loops = new Map<string, LoopHandle>()
  private steps = new Map<number, number>()
  private chefStep = 0
  private lastChef = new THREE.Vector3()
  private haveChef = false
  private tmp = new THREE.Vector3()

  constructor(o: DirectorOptions) {
    this.o = o
    o.audio.preload(Object.values(SFX))
  }

  private at(p: THREE.Vector3 | [number, number, number] | undefined | null, lift = 0): THREE.Vector3 | undefined {
    if (!p) return undefined
    const v = Array.isArray(p) ? this.tmp.set(p[0], p[1], p[2]) : this.tmp.copy(p)
    v.y += lift
    return v
  }

  private stationPos(id: string) {
    return this.at(this.o.scene.stations.get(id))
  }

  private tablePos(seat: number) {
    return this.at(SEATS[seat]?.table, 0.8)
  }

  handle(e: GameEvent) {
    const a = this.o.audio
    switch (e.type) {
      case 'door':
        a.playSfx(SFX.doorBell, { position: DOOR, volume: e.entering ? SFX_VOLUME.doorBellIn : SFX_VOLUME.doorBellOut })
        break
      case 'seated':
      case 'standUp':
        a.playSfx(SFX.chair, { position: this.at(SEATS[e.seat]?.pos, 0.3), volume: SFX_VOLUME.chair })
        break
      case 'ready':
        a.playSfx(DRINK_STATIONS.has(e.station) ? SFX.cup : SFX.plate, {
          position: this.stationPos(e.station),
          volume: SFX_VOLUME.place,
        })
        break
      case 'pickup':
        a.playSfx(SFX.pickup, { position: this.stationPos(e.station), volume: SFX_VOLUME.pickup })
        break
      case 'clean':
        a.playSfx(SFX.pickup, { position: this.tablePos(e.seat), volume: SFX_VOLUME.pickup })
        break
      case 'serve':
        a.playSfx(DRINK_STATIONS.has(e.station) ? SFX.cup : SFX.plate, {
          position: this.tablePos(e.seat),
          volume: SFX_VOLUME.place,
        })
        break
      case 'paid':
        a.playSfx(SFX.register, { position: this.stationPos('register'), volume: SFX_VOLUME.register })
        break
      case 'reset':
        this.stopLoops()
        this.steps.clear()
        break
    }
  }

  /** Call every rendered frame (paused or not). */
  update(dt: number) {
    if (this.o.scene.paused) {
      this.stopLoops()
      this.haveChef = false
      return
    }
    this.updateLoops()
    this.updateCustomerSteps(dt)
    this.updateChefSteps(dt)
  }

  private stopLoops() {
    for (const h of this.loops.values()) h.stop(0.3)
    this.loops.clear()
  }

  /** Station loops follow the live list of orders being prepared. */
  private updateLoops() {
    const want = new Map<string, { url: string; station: string }>()
    for (const p of this.o.game.preparing) {
      let url: string | null = null
      if (p.station === 'coffee' && COFFEE_MACHINE_RECIPES.has(p.recipe)) url = SFX.coffee
      else if (p.station === 'blender') url = SFX.blender
      else if (p.station === 'stove') url = SFX.sizzle
      if (url) want.set(`${p.station}|${url}`, { url, station: p.station })
      if (p.station === 'coffee' && p.recipe === 'coffee' && p.progress >= MILK_START)
        want.set(`${p.station}|${SFX.milk}`, { url: SFX.milk, station: p.station })
    }
    for (const [key, h] of this.loops) {
      if (want.has(key)) continue
      h.stop(0.3)
      this.loops.delete(key)
    }
    for (const [key, w] of want) {
      if (this.loops.has(key)) continue
      const pos = this.o.scene.stations.get(w.station)
      const h = this.o.audio.startLoop(w.url, { volume: SFX_VOLUME.stationLoop, position: pos, fadeIn: 0.15 })
      if (h) this.loops.set(key, h) // null before unlock: retried next frame
    }
  }

  private updateCustomerSteps(dt: number) {
    const seen = new Set<number>()
    for (const w of this.o.game.walkers) {
      seen.add(w.npc)
      let t = (this.steps.get(w.npc) ?? 0) - dt
      const inside = Math.abs(w.pos.x) < INSIDE_LIMIT && Math.abs(w.pos.z) < INSIDE_LIMIT
      if (t <= 0 && inside) {
        this.o.audio.playSfx(SFX.footsteps, { position: this.at(w.pos, 0.1), volume: SFX_VOLUME.customerSteps })
        t = CUSTOMER_STEP_INTERVAL
      }
      this.steps.set(w.npc, Math.max(0, t))
    }
    for (const k of this.steps.keys()) if (!seen.has(k)) this.steps.delete(k)
  }

  private updateChefSteps(dt: number) {
    const chef = this.o.scene.chefPosition
    if (!chef) return
    let moving = false
    if (this.haveChef && dt > 1e-4) {
      const speed = Math.hypot(chef.x - this.lastChef.x, chef.z - this.lastChef.z) / dt
      moving = speed > CHEF_MOVING_SPEED && speed < CHEF_TELEPORT_SPEED
    }
    this.lastChef.copy(chef)
    this.haveChef = true
    if (!moving) {
      this.chefStep = 0
      return
    }
    this.chefStep -= dt
    if (this.chefStep <= 0) {
      this.o.audio.playSfx(SFX.footsteps, { position: this.at(chef, 0.1), volume: SFX_VOLUME.chefSteps })
      this.chefStep = CHEF_STEP_INTERVAL
    }
  }

  dispose() {
    this.stopLoops()
  }
}
