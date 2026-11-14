// Doppler pitch factor for one moving sound source. Web Audio has no built-in Doppler, so the
// caller applies `factor` to the source's playbackRate. Used only for the passing car.
import { Vector3 } from 'three'

/** Speed of sound in air, m/s. */
export const SPEED_OF_SOUND = 343
/** The pitch factor is clamped to this range so the effect stays subtle. */
export const DOPPLER_MIN = 0.94
export const DOPPLER_MAX = 1.06
/** Exponential smoothing time constant of the factor, seconds. */
export const DOPPLER_SMOOTH = 0.15

export class DopplerTracker {
  /** Smoothed pitch factor (1 = no shift). */
  factor = 1
  private src = new Vector3()
  private lis = new Vector3()
  private vs = new Vector3()
  private vl = new Vector3()
  private u = new Vector3()
  private primed = false

  /** Forget position history (source teleported or respawned): no velocity until the next sample. */
  reset() {
    this.primed = false
    this.factor = 1
  }

  /**
   * Feed the current positions; velocities come from the change since the previous call.
   * Standard form f = (c + vl.u) / (c + vs.u), u = unit vector listener -> source,
   * so a source moving towards the listener (vs.u < 0) raises the pitch.
   */
  update(dt: number, source: Vector3, listener: Vector3): number {
    if (!this.primed || dt < 1e-4) {
      this.src.copy(source)
      this.lis.copy(listener)
      this.primed = true
      return this.factor
    }
    this.vs.copy(source).sub(this.src).divideScalar(dt)
    this.vl.copy(listener).sub(this.lis).divideScalar(dt)
    this.src.copy(source)
    this.lis.copy(listener)
    this.u.copy(source).sub(listener)
    const len = this.u.length()
    let target = 1
    if (len > 1e-3) {
      this.u.divideScalar(len)
      const raw = (SPEED_OF_SOUND + this.vl.dot(this.u)) / (SPEED_OF_SOUND + this.vs.dot(this.u))
      target = Math.min(DOPPLER_MAX, Math.max(DOPPLER_MIN, raw))
    }
    this.factor += (target - this.factor) * (1 - Math.exp(-dt / DOPPLER_SMOOTH))
    return this.factor
  }
}
