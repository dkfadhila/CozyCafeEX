import { useEffect, useRef, useState } from 'react'
import type { ChefId } from '../../assets/manifest'
import { UI } from '../../assets/manifest'
import './screens.css'

const LOADING_LINES = ['Preparing your cozy cafe…', 'Setting the tables…', 'Brewing something lovely…']

/** Static 16:9 artwork with an indeterminate bar. Falls back to a plain warm backdrop if the image is missing. */
export function LoadingScreen({ error }: { error?: string }) {
  const [line, setLine] = useState(0)
  const [art, setArt] = useState(true)
  useEffect(() => {
    const t = window.setInterval(() => setLine((n) => (n + 1) % LOADING_LINES.length), 2400)
    return () => window.clearInterval(t)
  }, [])
  return (
    <div className="screen loading">
      {art && <img className="art" src={UI.loading} alt="" onError={() => setArt(false)} />}
      <div className="loading-foot">
        <Logo />
        {error ? (
          <p className="load-error">Asset failed to load: {error}</p>
        ) : (
          <>
            <div className="bar" role="progressbar" aria-label="Loading">
              <i />
            </div>
            <p aria-live="polite">{LOADING_LINES[line]}</p>
          </>
        )}
      </div>
    </div>
  )
}

function Logo() {
  return (
    <div className="logo" aria-label="Cozy Cafe EX">
      <span>Cozy Cafe</span>
      <em>EX</em>
    </div>
  )
}

interface MenuProps {
  canContinue: boolean
  onNewGame: () => void
  onContinue: () => void
  onSettings: () => void
  /** True while the video or still covers the screen (3D scene may be suspended), false for the live 3D fallback. */
  onBackdropChange?: (covered: boolean) => void
}

/** Menu over the looping 8 s video. Order of fallbacks: video -> still image -> the live 3D cafe behind. */
export function MainMenu({ canContinue, onNewGame, onContinue, onSettings, onBackdropChange }: MenuProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [video, setVideo] = useState(true)
  const [still, setStill] = useState(true)
  const [panel, setPanel] = useState<'credits' | null>(null)

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    // The source is attached here rather than in JSX so that this effect can run twice
    // (React StrictMode) without the cleanup leaving the element empty.
    let active = true
    v.src = UI.menuVideo
    v.play().catch(() => active && setVideo(false)) // autoplay blocked
    const onError = () => active && setVideo(false)
    v.addEventListener('error', onError)
    return () => {
      // Stop decoding as soon as the menu closes.
      active = false
      v.removeEventListener('error', onError)
      v.pause()
      v.removeAttribute('src')
      v.load()
    }
  }, [])

  const covered = video || still
  useEffect(() => {
    onBackdropChange?.(covered)
  }, [covered, onBackdropChange])

  return (
    <div className={`screen menu ${video || still ? '' : 'live-backdrop'}`}>
      {still && <img className="art" src={UI.menuStill} alt="" onError={() => setStill(false)} />}
      {video && (
        <video ref={videoRef} className="art" muted loop playsInline />
      )}
      <div className="menu-shade" />
      <nav className="menu-panel">
        <Logo />
        <p className="tagline">Are you ready for a cozy day?</p>
        <button className="btn primary" onClick={onNewGame}>
          New Game
        </button>
        <button className="btn" data-sfx="confirm" onClick={onContinue} disabled={!canContinue}>
          Continue
        </button>
        <button className="btn" onClick={onSettings}>
          Settings
        </button>
        <button className="btn" onClick={() => setPanel('credits')}>
          Credits
        </button>
      </nav>
      <a className="menu-x" href="https://x.com/TirtaVEX" target="_blank" rel="noopener noreferrer">
        made by <b>𝕏 @TirtaVEX</b>
      </a>

      {panel === 'credits' && (
        <div className="overlay" onClick={() => setPanel(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Credits</h2>
            <dl>
              <dt>Game design and direction</dt>
              <dd>
                Tirtavex ·{' '}
                <a href="https://x.com/TirtaVEX" target="_blank" rel="noopener noreferrer">
                  @TirtaVEX on X
                </a>
              </dd>
              <dt>3D characters and cafe assets</dt>
              <dd>Generated with Meshy</dd>
              <dt>Engine</dt>
              <dd>Three.js and React</dd>
            </dl>
            <button className="btn primary" data-sfx="cancel" onClick={() => setPanel(null)}>
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const CHEF_INFO: Record<ChefId, { name: string; title: string; blurb: string; img: string }> = {
  male: {
    name: 'Male Chef',
    title: 'The Steady Hand',
    blurb: 'Calm, helpful and a little playful. Never rushes a good cup.',
    img: UI.selectMale,
  },
  female: {
    name: 'Female Chef',
    title: 'The Bright Spark',
    blurb: 'Energetic, encouraging and observant. Notices every empty plate.',
    img: UI.selectFemale,
  },
}

interface SelectProps {
  initial: ChefId
  busy: boolean
  onConfirm: (id: ChefId) => void
  onBack: () => void
}

export function CharacterSelect({ initial, busy, onConfirm, onBack }: SelectProps) {
  const [pick, setPick] = useState<ChefId>(initial)
  return (
    <div className="screen select">
      <h1>Choose Your Chef</h1>
      <div className="cards" role="radiogroup" aria-label="Choose your chef">
        {(Object.keys(CHEF_INFO) as ChefId[]).map((id) => {
          const c = CHEF_INFO[id]
          const on = pick === id
          return (
            <button
              key={id}
              role="radio"
              aria-checked={on}
              className={`chef-card ${on ? 'on' : ''}`}
              onClick={() => setPick(id)}
            >
              <span className="badge">{on ? '✔ Selected' : 'Select'}</span>
              <img src={c.img} alt={`${c.name} full-body preview`} />
              <strong>{c.name}</strong>
              <small>{c.title}</small>
              <p>{c.blurb}</p>
            </button>
          )
        })}
      </div>
      <div className="select-actions">
        <button className="btn" data-sfx="cancel" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button className="btn primary" onClick={() => onConfirm(pick)} disabled={busy}>
          {busy ? "Let's get started!" : 'Confirm'}
        </button>
      </div>
    </div>
  )
}
