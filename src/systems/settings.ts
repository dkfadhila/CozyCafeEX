// Player settings (PRD 5.10). Persisted separately from the save so they survive New Game.

const KEY = 'cozy-cafe-ex.settings'
const VERSION = 1

export type Quality = 'low' | 'medium' | 'high'

export interface Settings {
  masterVolume: number // 0..1
  musicVolume: number
  sfxVolume: number
  voiceVolume: number
  muted: boolean
  quality: Quality
  shadows: boolean
  ambientEffects: boolean
  /** Mouse-wheel zoom speed multiplier, 0.5..2. */
  zoomSpeed: number
  /** Camera drag and Z/C rotation speed multiplier, 0.5..2. */
  cameraRotateSpeed: number
  /** Flip the vertical (tilt) direction of the camera. */
  invertCameraTilt: boolean
  /** HUD scale, 0.85..1.3. */
  uiScale: number
  reducedMotion: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  masterVolume: 0.8,
  musicVolume: 0.7,
  sfxVolume: 0.8,
  voiceVolume: 0.9,
  muted: false,
  quality: 'high',
  shadows: true,
  ambientEffects: true,
  zoomSpeed: 1,
  cameraRotateSpeed: 1,
  invertCameraTilt: false,
  uiScale: 1,
  reducedMotion:
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false,
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

export function loadSettings(): Settings {
  const d = DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...d }
    const s = JSON.parse(raw) as Partial<Settings> & { version?: number }
    if (s.version !== VERSION) return { ...d }
    return {
      masterVolume: clamp(s.masterVolume, 0, 1, d.masterVolume),
      musicVolume: clamp(s.musicVolume, 0, 1, d.musicVolume),
      sfxVolume: clamp(s.sfxVolume, 0, 1, d.sfxVolume),
      voiceVolume: clamp(s.voiceVolume, 0, 1, d.voiceVolume),
      muted: bool(s.muted, d.muted),
      quality: s.quality === 'low' || s.quality === 'medium' || s.quality === 'high' ? s.quality : d.quality,
      shadows: bool(s.shadows, d.shadows),
      ambientEffects: bool(s.ambientEffects, d.ambientEffects),
      zoomSpeed: clamp(s.zoomSpeed, 0.5, 2, d.zoomSpeed),
      cameraRotateSpeed: clamp(s.cameraRotateSpeed, 0.5, 2, d.cameraRotateSpeed),
      invertCameraTilt: bool(s.invertCameraTilt, d.invertCameraTilt),
      uiScale: clamp(s.uiScale, 0.85, 1.3, d.uiScale),
      reducedMotion: bool(s.reducedMotion, d.reducedMotion),
    }
  } catch {
    return { ...d }
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...s, version: VERSION }))
  } catch {
    // Storage unavailable: settings still apply for this session.
  }
}
