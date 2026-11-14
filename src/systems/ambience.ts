// Background ambience (cafe room, street) and the passing car. The car is audio only: an invisible
// point driven along the road behind the cafe, with a Doppler pitch shift on its engine loop.
import * as THREE from 'three'
import type { AudioSystem, LoopHandle } from '../audio/AudioSystem'
import { DopplerTracker } from '../audio/doppler'

const DIR = '/assets/audio/sfx/'
export const AMBIENCE = {
  roomUrl: `${DIR}amb_cafe_room.mp3`,
  streetUrl: `${DIR}amb_street.mp3`,
  carUrl: `${DIR}sfx_car_engine.mp3`,
  roomVolume: 0.25,
  streetVolume: 0.18,
  /** Street ambience low-pass cutoff, Hz. */
  streetLowpass: 2500,
  /** Fade of the ambience loops when entering / leaving, seconds. */
  fade: 0.6,
}

export const CAR = {
  /** Road centre line (matches ROAD_Z in scenes/exterior.ts) and engine height. */
  roadZ: -8.2,
  y: 0.5,
  /** The car drives between -endX and +endX. */
  endX: 24,
  minSpeed: 9,
  maxSpeed: 12,
  /** Seconds between two passes. */
  minGap: 18,
  maxGap: 35,
  volume: 0.5,
  /** Random base pitch per pass (Doppler applies on top). */
  minBaseRate: 0.94,
  maxBaseRate: 1.06,
  fadeOut: 0.3,
}

const rand = (a: number, b: number) => a + Math.random() * (b - a)

interface Run {
  dir: 1 | -1
  speed: number
  baseRate: number
  loop: LoopHandle | null
}

export class Ambience {
  private audio: AudioSystem
  private room: LoopHandle | null = null
  private street: LoopHandle | null = null
  private run: Run | null = null
  private timer = rand(CAR.minGap, CAR.maxGap)
  private pos = new THREE.Vector3()
  private doppler = new DopplerTracker()

  constructor(audio: AudioSystem) {
    this.audio = audio
    audio.preload([AMBIENCE.roomUrl, AMBIENCE.streetUrl, AMBIENCE.carUrl])
  }

  /** True while a car is passing (for tests). */
  get carActive(): boolean {
    return this.run !== null
  }

  /** Current car position (valid while carActive). */
  get carPosition(): THREE.Vector3 {
    return this.pos
  }

  /** Start a pass right now (dev / tests). */
  forceCar() {
    this.timer = 0
  }

  /**
   * Call every rendered frame. `active` = on the playing screen, not paused, Ambient Effects on.
   * Inactive fades the loops out (0.6 s) and aborts a running car.
   */
  update(dt: number, active: boolean) {
    this.updateBed(active)
    this.updateCar(dt, active)
  }

  private updateBed(active: boolean) {
    if (active) {
      // startLoop returns null before unlock(); retried every frame until it works.
      this.room ??= this.audio.startLoop(AMBIENCE.roomUrl, { volume: AMBIENCE.roomVolume, fadeIn: AMBIENCE.fade })
      this.street ??= this.audio.startLoop(AMBIENCE.streetUrl, {
        volume: AMBIENCE.streetVolume,
        fadeIn: AMBIENCE.fade,
        lowpass: AMBIENCE.streetLowpass,
      })
    } else {
      this.room?.stop(AMBIENCE.fade)
      this.street?.stop(AMBIENCE.fade)
      this.room = this.street = null
    }
  }

  private endRun() {
    this.run?.loop?.stop(CAR.fadeOut)
    this.run = null
    this.timer = rand(CAR.minGap, CAR.maxGap)
  }

  private updateCar(dt: number, active: boolean) {
    if (!active) {
      if (this.run) this.endRun()
      return
    }
    if (!this.run) {
      this.timer -= dt
      if (this.timer > 0) return
      const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1
      this.run = {
        dir,
        speed: rand(CAR.minSpeed, CAR.maxSpeed),
        baseRate: rand(CAR.minBaseRate, CAR.maxBaseRate),
        loop: null,
      }
      this.pos.set(-dir * CAR.endX, CAR.y, CAR.roadZ)
      this.doppler.reset() // new car: no velocity history
    }
    const r = this.run
    this.pos.x += r.dir * r.speed * dt
    if (r.dir * this.pos.x > CAR.endX) {
      this.endRun()
      return
    }
    r.loop ??= this.audio.startLoop(AMBIENCE.carUrl, { volume: CAR.volume, position: this.pos })
    if (!r.loop) return
    r.loop.setPosition(this.pos)
    const f = this.doppler.update(dt, this.pos, this.audio.listenerPosition)
    r.loop.setRate(r.baseRate * f)
  }

  dispose() {
    this.room?.stop(0.1)
    this.street?.stop(0.1)
    this.run?.loop?.stop(0.1)
    this.room = this.street = null
    this.run = null
  }
}
