import * as THREE from 'three'

// Tunables.
export const DEFAULT_YAW = THREE.MathUtils.degToRad(45)
export const DEFAULT_PITCH = THREE.MathUtils.degToRad(33)
export const DEFAULT_ZOOM = 1
export const PITCH_MIN = THREE.MathUtils.degToRad(20)
export const PITCH_MAX = THREE.MathUtils.degToRad(75)
export const ZOOM_MIN = 0.7
/** World units visible vertically at zoom 1 (orthographic frustum height). */
export const VIEW_SIZE = 10.5
/** Old zoom ceiling: the look-at point starts rising towards the chef's head beyond this. */
export const ZOOM_HEAD_START = 2.6
/** Zoom at which the look-at point has fully reached head height. */
export const ZOOM_HEAD_FULL = 8
/** Visible height (m) at max zoom: roughly a head-and-shoulders frame. */
export const CLOSEUP_VISIBLE_HEIGHT = 0.55
/** Max zoom, derived from the frustum: VIEW_SIZE / 0.55 m = ~19x. */
export const ZOOM_MAX = VIEW_SIZE / CLOSEUP_VISIBLE_HEIGHT
/** Photo mode ranges. */
export const FREE_PITCH_MIN = THREE.MathUtils.degToRad(5)
export const FREE_PITCH_MAX = THREE.MathUtils.degToRad(88)
export const FREE_RADIUS = 9
export const FREE_HEIGHT_MAX = 4
/** Orbit and zoom smoothing time constant, seconds. */
export const ORBIT_TAU = 0.12
/** Target smoothing while following the chef, seconds. */
export const FOLLOW_TAU = 0.3
/** Target smoothing while panning manually, seconds. */
export const PAN_TAU = 0.12
/** Inertia velocity decay time constant after a drag is released, seconds. */
export const INERTIA_TAU = 0.2
export const KEY_YAW_SPEED = THREE.MathUtils.degToRad(90) // rad/s
export const KEY_PITCH_SPEED = THREE.MathUtils.degToRad(45) // rad/s
/** Radians of orbit per dragged CSS pixel. */
export const DRAG_ROTATE = 0.006
export const PAN_RADIUS = 6
/** Distance from the look-at point to the (orthographic) camera. */
export const CAMERA_DISTANCE = 20
/** Height of the look-at point above the floor. */
export const TARGET_HEIGHT = 0.4
/** Smoothing used instead of the normal constants when Reduced Motion is on. */
const REDUCED_TAU = 0.02

const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / Math.max(tau, 1e-4))

/** Orbit / tilt / zoom / pan state for the orthographic cafe camera, all eased with frame dt. */
export class CameraRig {
  followChef = true
  rotateSpeed = 1
  invertTilt = false
  reducedMotion = false
  /** Photo mode: free focus point, wide ranges, no follow. */
  free = false
  /** Look-at height used at close zoom (chef's head), set by the scene from the chef's height. */
  headHeight = 0.97

  /** Current (eased) values. */
  yaw = DEFAULT_YAW
  pitch = DEFAULT_PITCH
  /** Eased look-at point. */
  readonly center = new THREE.Vector3(0, TARGET_HEIGHT, 0)

  private yawGoal = DEFAULT_YAW
  private pitchGoal = DEFAULT_PITCH
  private zoomGoal = DEFAULT_ZOOM
  /** Where the look-at point wants to be (the chef when following, the pan point otherwise). */
  private readonly panGoal = new THREE.Vector3(0, TARGET_HEIGHT, 0)
  private yawVel = 0
  private pitchVel = 0
  private readonly camera: THREE.OrthographicCamera

  /** Ground-projected view direction (unit) and screen-right, refreshed by update(). */
  readonly forward = new THREE.Vector3()
  readonly right = new THREE.Vector3()

  constructor(camera: THREE.OrthographicCamera) {
    this.camera = camera
    this.apply()
  }

  /** Radians of orbit per dragged pixel at the current Rotate Speed. */
  get dragRadiansPerPixel() {
    return DRAG_ROTATE * this.rotateSpeed
  }

  /** Drag delta in CSS pixels -> orbit. */
  orbit(dx: number, dy: number) {
    const k = this.dragRadiansPerPixel
    this.yawGoal -= dx * k
    this.pitchGoal = this.clampPitch(this.pitchGoal + dy * k * (this.invertTilt ? -1 : 1))
  }

  /** Enter or leave photo mode. Leaving restores follow-chef and the normal pitch range. */
  setFree(on: boolean) {
    if (on === this.free) return
    this.free = on
    if (on) {
      // Remember the gameplay view so leaving photo mode puts the camera back where the player had it.
      this.savedView = { yaw: this.yawGoal, pitch: this.pitchGoal, zoom: this.zoomGoal }
      this.followChef = false
      this.panGoal.copy(this.center)
    } else {
      this.followChef = true
      if (this.savedView) {
        this.yawGoal = this.savedView.yaw
        this.pitchGoal = this.savedView.pitch
        this.zoomGoal = this.savedView.zoom
        this.savedView = null
      }
      this.yawVel = this.pitchVel = 0
      this.pitchGoal = this.clampPitch(this.pitchGoal)
      this.clampGoal()
    }
  }

  private savedView: { yaw: number; pitch: number; zoom: number } | null = null

  /** Photo mode: move the focus point to a world position (e.g. the chef's head). */
  focusOn(p: THREE.Vector3) {
    this.panGoal.copy(p)
    this.clampGoal()
  }

  /** Visible world height (m) at the current eased zoom. */
  get visibleHeight() {
    return VIEW_SIZE / this.camera.zoom
  }

  get zoom() {
    return this.camera.zoom
  }

  /** Look-at height for normal play: eases from the ground-level default up to the head as we zoom in. */
  private gameplayHeight() {
    const t = THREE.MathUtils.clamp((this.camera.zoom - ZOOM_HEAD_START) / (ZOOM_HEAD_FULL - ZOOM_HEAD_START), 0, 1)
    return TARGET_HEIGHT + (this.headHeight - TARGET_HEIGHT) * t * t * (3 - 2 * t)
  }

  /** Feed the instantaneous drag velocity (rad/s) so the orbit keeps coasting after release. */
  setOrbitVelocity(yawVel: number, pitchVel: number) {
    this.yawVel = yawVel
    this.pitchVel = pitchVel
  }

  /** Multiply the zoom goal. */
  zoomBy(factor: number) {
    this.zoomGoal = THREE.MathUtils.clamp(this.zoomGoal * factor, ZOOM_MIN, ZOOM_MAX)
  }

  /** Drag delta in CSS pixels -> pan on the ground plane (switches follow off). */
  pan(dx: number, dy: number, viewHeightPx: number) {
    if (this.followChef) {
      this.followChef = false
      this.panGoal.copy(this.center)
    }
    const camH = this.camera.top - this.camera.bottom
    const upp = camH / this.camera.zoom / Math.max(viewHeightPx, 1) // world units per pixel
    const s = Math.max(Math.sin(this.pitch), 0.2)
    this.panGoal.addScaledVector(this.right, -dx * upp)
    this.panGoal.addScaledVector(this.forward, (dy * upp) / s)
    this.clampGoal()
  }

  /** Back to the default pose, optionally leaving follow off (menu backdrop). */
  reset(follow: boolean, instant = false) {
    const tau = (this.yawGoal - DEFAULT_YAW) / (Math.PI * 2)
    this.yawGoal = DEFAULT_YAW + Math.PI * 2 * Math.round(tau)
    this.pitchGoal = DEFAULT_PITCH
    this.zoomGoal = DEFAULT_ZOOM
    this.yawVel = this.pitchVel = 0
    this.followChef = follow
    this.panGoal.set(0, TARGET_HEIGHT, 0)
    if (instant || this.reducedMotion) this.snap(follow ? null : this.panGoal)
  }

  setFollow(on: boolean) {
    if (on === this.followChef) return
    this.followChef = on
    if (!on) this.panGoal.copy(this.center)
  }

  toggleFollow() {
    this.setFollow(!this.followChef)
  }

  /** Jump every eased value to its goal. */
  private snap(centre: THREE.Vector3 | null) {
    this.yaw = this.yawGoal
    this.pitch = this.pitchGoal
    this.camera.zoom = this.zoomGoal
    if (centre) this.center.copy(centre)
    this.apply()
  }

  private clampPitch(p: number) {
    return this.free
      ? THREE.MathUtils.clamp(p, FREE_PITCH_MIN, FREE_PITCH_MAX)
      : THREE.MathUtils.clamp(p, PITCH_MIN, PITCH_MAX)
  }

  private clampGoal() {
    const g = this.panGoal
    const r = Math.hypot(g.x, g.z)
    const max = this.free ? FREE_RADIUS : PAN_RADIUS
    if (r > max) {
      g.x *= max / r
      g.z *= max / r
    }
    g.y = this.free ? THREE.MathUtils.clamp(g.y, 0, FREE_HEIGHT_MAX) : TARGET_HEIGHT
  }

  /**
   * Advance the rig. `chef` is the follow target (or null), `keys` the held key codes and `input`
   * whether keyboard camera control is allowed right now.
   */
  update(dt: number, chef: THREE.Vector3 | null, keys: ReadonlySet<string>, input: boolean, dragging: boolean) {
    const reduced = this.reducedMotion
    const sign = this.invertTilt ? -1 : 1

    // Held keys.
    if (input) {
      // Z / C rotate continuously; E stays exclusively Interact.
      const yawDir = (keys.has('KeyC') ? 1 : 0) - (keys.has('KeyZ') ? 1 : 0)
      if (yawDir) this.yawGoal += yawDir * KEY_YAW_SPEED * this.rotateSpeed * dt
      const up = (keys.has('PageUp') ? 1 : 0) - (keys.has('PageDown') ? 1 : 0)
      if (up) this.pitchGoal = this.clampPitch(this.pitchGoal + up * sign * KEY_PITCH_SPEED * this.rotateSpeed * dt)
    }

    // Photo mode: WASD moves the focus on the ground relative to the view, Q / E lower / raise it.
    if (input && this.free) {
      const mx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0)
      const mz = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0)
      const my = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0)
      const speed = THREE.MathUtils.clamp(this.visibleHeight * 0.4, 0.3, 4)
      if (mx || mz) {
        const len = Math.hypot(mx, mz)
        this.panGoal.addScaledVector(this.right, (mx / len) * speed * dt)
        this.panGoal.addScaledVector(this.forward, (mz / len) * speed * dt)
      }
      if (my) this.panGoal.y += my * Math.min(speed, 2) * dt
      this.clampGoal()
    }

    // Inertia after a drag.
    if (!dragging && !reduced && (this.yawVel || this.pitchVel)) {
      this.yawGoal += this.yawVel * dt
      this.pitchGoal = this.clampPitch(this.pitchGoal + this.pitchVel * dt)
      const decay = Math.exp(-dt / INERTIA_TAU)
      this.yawVel *= decay
      this.pitchVel *= decay
      if (Math.abs(this.yawVel) < 1e-3) this.yawVel = 0
      if (Math.abs(this.pitchVel) < 1e-3) this.pitchVel = 0
    } else if (reduced) this.yawVel = this.pitchVel = 0

    // Target.
    if (this.followChef && chef) {
      this.panGoal.set(chef.x, TARGET_HEIGHT, chef.z)
      this.clampGoal()
    }
    const orbitK = ease(dt, reduced ? REDUCED_TAU : ORBIT_TAU)
    const moveK = ease(dt, reduced ? REDUCED_TAU : this.followChef ? FOLLOW_TAU : PAN_TAU)
    this.yaw += (this.yawGoal - this.yaw) * orbitK
    this.pitch += (this.pitchGoal - this.pitch) * orbitK
    this.camera.zoom += (this.zoomGoal - this.camera.zoom) * orbitK
    const goalY = this.free ? this.panGoal.y : this.gameplayHeight()
    this.center.x += (this.panGoal.x - this.center.x) * moveK
    this.center.z += (this.panGoal.z - this.center.z) * moveK
    this.center.y += (goalY - this.center.y) * moveK
    this.apply()
  }

  /** Place the camera from the current eased values. */
  private apply() {
    const cp = Math.cos(this.pitch)
    const sy = Math.sin(this.yaw)
    const cy = Math.cos(this.yaw)
    this.camera.position.set(
      this.center.x + sy * cp * CAMERA_DISTANCE,
      this.center.y + Math.sin(this.pitch) * CAMERA_DISTANCE,
      this.center.z + cy * cp * CAMERA_DISTANCE,
    )
    this.camera.lookAt(this.center)
    this.camera.updateProjectionMatrix()
    this.forward.set(-sy, 0, -cy)
    this.right.set(cy, 0, -sy)
  }
}
