import { useEffect, useRef, useState } from 'react'
import { EXPRESSIONS, PORTRAITS, type ChefId, type Expression } from '../../assets/manifest'
import { DEFAULT_SETTINGS, type Quality, type Settings } from '../../systems/settings'
import type { GameSnapshot } from '../../systems/CafeGame'
import { STATION_LABEL } from '../../data/recipes'
import './overlays.css'

// ------------------------------------------------------------------ settings

interface SettingsProps {
  value: Settings
  onChange: (s: Settings) => void
  onClose: () => void
}

function Slider(p: { label: string; value: number; min: number; max: number; step: number; show: string; set: (n: number) => void }) {
  return (
    <label className="row">
      <span>{p.label}</span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.set(Number(e.target.value))} />
      <output>{p.show}</output>
    </label>
  )
}

function Toggle(p: { label: string; value: boolean; set: (b: boolean) => void }) {
  return (
    <label className="row">
      <span>{p.label}</span>
      <input type="checkbox" checked={p.value} onChange={(e) => p.set(e.target.checked)} />
      <output>{p.value ? 'On' : 'Off'}</output>
    </label>
  )
}

/** Edits a draft; nothing changes in the game until Apply. */
export function SettingsPanel({ value, onChange, onClose }: SettingsProps) {
  const [d, setD] = useState<Settings>(value)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setD((s) => ({ ...s, [k]: v }))
  const pct = (n: number) => `${Math.round(n * 100)}%`
  return (
    <div className="overlay" role="dialog" aria-label="Settings">
      <div className="sheet settings">
        <h2>Settings</h2>
        <div className="settings-body">
          <h3>Audio</h3>
          <p className="note">
            Voice, music, sound effects and ambience are all in the game and follow their sliders and Mute. Ambient Effects also turns off the background ambience and passing traffic.
          </p>
          <Slider label="Master Volume" value={d.masterVolume} min={0} max={1} step={0.05} show={pct(d.masterVolume)} set={(n) => set('masterVolume', n)} />
          <Slider label="Music Volume" value={d.musicVolume} min={0} max={1} step={0.05} show={pct(d.musicVolume)} set={(n) => set('musicVolume', n)} />
          <Slider label="Sound Effects" value={d.sfxVolume} min={0} max={1} step={0.05} show={pct(d.sfxVolume)} set={(n) => set('sfxVolume', n)} />
          <Slider label="Voice" value={d.voiceVolume} min={0} max={1} step={0.05} show={pct(d.voiceVolume)} set={(n) => set('voiceVolume', n)} />
          <Toggle label="Mute" value={d.muted} set={(b) => set('muted', b)} />

          <h3>Graphics</h3>
          <label className="row">
            <span>Quality</span>
            <select value={d.quality} onChange={(e) => set('quality', e.target.value as Quality)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <output />
          </label>
          <Toggle label="Shadows" value={d.shadows} set={(b) => set('shadows', b)} />
          <Toggle label="Ambient Effects" value={d.ambientEffects} set={(b) => set('ambientEffects', b)} />

          <h3>Gameplay</h3>
          <Slider label="Camera Zoom Speed" value={d.zoomSpeed} min={0.5} max={2} step={0.1} show={`${d.zoomSpeed.toFixed(1)}×`} set={(n) => set('zoomSpeed', n)} />
          <Slider label="Camera Rotate Speed" value={d.cameraRotateSpeed} min={0.5} max={2} step={0.1} show={`${d.cameraRotateSpeed.toFixed(1)}×`} set={(n) => set('cameraRotateSpeed', n)} />
          <Toggle label="Invert Camera Tilt" value={d.invertCameraTilt} set={(b) => set('invertCameraTilt', b)} />

          <h3>Accessibility</h3>
          <Slider label="UI Scale" value={d.uiScale} min={0.85} max={1.3} step={0.05} show={pct(d.uiScale)} set={(n) => set('uiScale', n)} />
          <Toggle label="Reduced Motion" value={d.reducedMotion} set={(b) => set('reducedMotion', b)} />
          <label className="row">
            <span>Language</span>
            <select value="en" disabled>
              <option value="en">English</option>
            </select>
            <output />
          </label>
        </div>
        <div className="sheet-actions">
          <button className="btn" onClick={() => setD({ ...DEFAULT_SETTINGS })}>
            Reset to Defaults
          </button>
          <button className="btn" data-sfx="cancel" onClick={onClose}>
            Back
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onChange(d)
              onClose()
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ pause

interface PauseProps {
  onResume: () => void
  onSettings: () => void
  onSave: () => void
  onRestart: () => void
  onMainMenu: () => void
}

export function PauseMenu({ onResume, onSettings, onSave, onRestart, onMainMenu }: PauseProps) {
  const [confirm, setConfirm] = useState(false)
  const [saved, setSaved] = useState(false)
  return (
    <div className="overlay" role="dialog" aria-label="Paused">
      <div className="sheet pause">
        <h2>Paused</h2>
        {confirm ? (
          <>
            <p>Restart this day? Today's orders and earnings will be lost.</p>
            <button className="btn primary" onClick={onRestart}>
              Restart Day
            </button>
            <button className="btn" data-sfx="cancel" onClick={() => setConfirm(false)}>
              Back
            </button>
          </>
        ) : (
          <>
            <button className="btn primary" onClick={onResume}>
              Resume
            </button>
            <button className="btn" onClick={onSettings}>
              Settings
            </button>
            <button
              className="btn"
              onClick={() => {
                onSave()
                setSaved(true)
              }}
            >
              {saved ? '✔ Game Saved' : 'Save Game'}
            </button>
            <button className="btn" onClick={() => setConfirm(true)}>
              Restart Day
            </button>
            <button className="btn" onClick={onMainMenu}>
              Main Menu
            </button>
            <p className="note">Progress is saved at the start of each day. Leaving now restarts the current day.</p>
          </>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ tutorial

interface Step {
  text: string
  /** Which portrait of the chef to show. */
  expr: Expression
  /** Extra line telling the player what to do. */
  hint?: string
  /** Auto-advance when this becomes true. Steps without it wait for Next. */
  done?: (s: GameSnapshot, moved: number) => boolean
  /** What to point at. */
  highlight?: (s: GameSnapshot) => string | null
  /** Outline the order queue. */
  queue?: boolean
}

// Lines from 07_COPY_AND_DIALOGUE_STARTER.md.
const STEPS: Step[] = [
  { text: "Welcome to Cozy Cafe EX! I'm your chef for today.", expr: 'happy' },
  { text: "Let's take a quick look around.", expr: 'friendly' },
  {
    text: 'Use the movement keys to walk around the cafe.',
    expr: 'explaining',
    hint: 'W A S D or the arrow keys',
    done: (_s, moved) => moved > 2,
  },
  {
    text: 'Come closer to a station to interact with it.',
    expr: 'explaining',
    hint: 'Walk behind the counter, next to the coffee machine',
    done: (s) => s.nearStation,
    highlight: () => 'coffee',
  },
  {
    text: "A customer has arrived. Let's check their order.",
    expr: 'surprised',
    hint: 'New orders appear in the Orders list',
    done: (s) => s.orders.length > 0,
    queue: true,
  },
  {
    text: 'Choose the right station to prepare the order.',
    expr: 'thinking',
    hint: 'Stand next to the station, press E, and wait for it to finish',
    done: (s) => s.orders.some((o) => o.status === 'Ready' || o.status === 'Carried') || s.everServed > 0,
    highlight: (s) => s.nextStation,
    queue: true,
  },
  {
    text: 'Your order is ready! Pick it up and bring it to the customer.',
    expr: 'encouraging',
    hint: 'Press E at the station, then press E at their table',
    done: (s) => s.everServed > 0,
  },
  {
    text: 'Lovely work! The customer is enjoying their treat.',
    expr: 'happy',
    hint: 'They pay when they finish. Clean the table afterwards with E',
    done: (s) => s.everPaid > 0,
  },
  { text: "That's the basics. Let's make this cafe a little busier!", expr: 'encouraging' },
]

interface TutorialProps {
  chef: ChefId
  snap: GameSnapshot
  /** Chef position on the floor, read each poll. */
  chefPos: () => { x: number; z: number } | null
  setHighlight: (station: string | null) => void
  onFinish: () => void
  /** Speak tutorial line `step` (0-based); a new call replaces the previous line. */
  speak?: (step: number) => void
  /** Stop the tutorial voice. */
  stopSpeech?: () => void
}

export function Tutorial({ chef, snap, chefPos, setHighlight, onFinish, speak, stopSpeech }: TutorialProps) {
  const [i, setI] = useState(0)
  const moved = useRef(0)
  const last = useRef<{ x: number; z: number } | null>(null)
  const step = STEPS[i]

  // Distance walked during the current step.
  useEffect(() => {
    moved.current = 0
    last.current = chefPos()
  }, [i]) // eslint-disable-line react-hooks/exhaustive-deps

  // Runs on every snapshot poll (5 Hz).
  useEffect(() => {
    const p = chefPos()
    if (p && last.current) moved.current += Math.hypot(p.x - last.current.x, p.z - last.current.z)
    if (p) last.current = { x: p.x, z: p.z }
    setHighlight(step.highlight?.(snap) ?? null)
    if (step.done?.(snap, moved.current)) setI((n) => Math.min(n + 1, STEPS.length - 1))
  }, [snap]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => setHighlight(null), []) // eslint-disable-line react-hooks/exhaustive-deps

  // Voice: the active step's line plays for the chosen chef; leaving the tutorial stops it.
  useEffect(() => {
    speak?.(i)
  }, [i, chef]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stopSpeech?.(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const lastStep = i === STEPS.length - 1
  const station = step.highlight?.(snap)
  return (
    <>
      {step.queue && <div className="queue-ring" aria-hidden />}
      <div className="tutorial" role="dialog" aria-label="Tutorial">
        {/* All six portraits stay mounted (so they are preloaded) and cross-fade by opacity. */}
        <div className="portrait" aria-hidden>
          {EXPRESSIONS.map((e) => (
            <img key={e} src={PORTRAITS[chef][e]} alt="" decoding="async" className={e === step.expr ? 'on' : ''} />
          ))}
        </div>
        <div className="bubble-box">
          <p className="say" aria-live="polite">
            {step.text}
          </p>
          {step.hint && (
            <p className="hint">
              {step.hint}
              {station && station in STATION_LABEL ? ` (${STATION_LABEL[station as keyof typeof STATION_LABEL]})` : ''}
            </p>
          )}
          <div className="tutorial-actions">
            <span className="count">
              {i + 1} / {STEPS.length}
            </span>
            {!lastStep && (
              <button className="link" onClick={onFinish}>
                Skip
              </button>
            )}
            {i > 0 && !lastStep && (
              <button className="btn small" data-sfx="cancel" onClick={() => setI(i - 1)}>
                Back
              </button>
            )}
            <button className="btn small primary" onClick={() => (lastStep ? onFinish() : setI(i + 1))}>
              {lastStep ? "Let's go!" : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
