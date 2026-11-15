import { useCallback, useEffect, useRef, useState } from 'react'
import { CafeScene } from './scenes/CafeScene'
import { AudioSystem } from './audio/AudioSystem'
import { tutorialUrl, VoiceDirector, type Caption } from './systems/voiceDirector'
import { SFX, SfxDirector } from './systems/sfxDirector'
import { Ambience } from './systems/ambience'
import * as THREE from 'three'
import { CafeGame, type GameSnapshot } from './systems/CafeGame'
import { loadSave, writeSave, type SaveData } from './systems/save'
import { loadSettings, saveSettings, type Settings } from './systems/settings'
import { CharacterSelect, LoadingScreen, MainMenu } from './components/ui/Screens'
import { PhotoMode } from './components/ui/PhotoMode'
import { PauseMenu, SettingsPanel, Tutorial } from './components/ui/Overlays'
import type { ChefId } from './assets/manifest'
import './App.css'

// BOOT/LOADING -> MAIN_MENU -> CHARACTER_SELECT -> TUTORIAL/PLAYING, with PAUSED and SETTINGS overlays.
type Screen = 'loading' | 'menu' | 'select' | 'playing'

declare global {
  interface Window {
    __cafe?: CafeScene
    __game?: CafeGame
    __audio?: AudioSystem
  }
}

const MUSIC = { menu: '/assets/audio/music/music_menu_theme.mp3', cafe: '/assets/audio/music/music_cafe_loop.mp3' }
/** Music bus scale while the game is paused (pause menu or settings over the game). */
const PAUSE_MUSIC_SCALE = 0.5
const UI_HOVER_VOLUME = 0.6
const UI_CLICK_VOLUME = 0.8
const LISTENER_HEIGHT = 1.2

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<CafeScene | null>(null)
  const gameRef = useRef<CafeGame | null>(null)
  const audioRef = useRef<AudioSystem | null>(null)
  const ambientOnRef = useRef(true)
  const tutorialActiveRef = useRef(false)
  const summaryOpenRef = useRef(false)
  const chefRef = useRef<ChefId>('male')
  const tutorialDoneRef = useRef(false)
  const [screen, setScreen] = useState<Screen>('loading')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [save, setSave] = useState<SaveData | null>(() => loadSave())
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [snap, setSnap] = useState<GameSnapshot | null>(null)
  const [paused, setPaused] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tutorial, setTutorial] = useState(false)
  const [photo, setPhoto] = useState(false)
  const [caption, setCaption] = useState<Caption | null>(null)
  const [menuCovered, setMenuCovered] = useState(true)
  const params = new URLSearchParams(location.search)
  const animFile = import.meta.env.DEV ? params.get('anim') : null
  const gallery = import.meta.env.DEV && (params.has('gallery') || !!animFile)

  /** Write the save and mirror it in state (so Continue enables immediately). */
  const persist = useCallback((day: number, money: number) => {
    const next = {
      selectedChef: chefRef.current,
      currentDay: day,
      currency: money,
      tutorialCompleted: tutorialDoneRef.current,
    }
    writeSave(next)
    setSave({ ...next, saveVersion: 1 })
  }, [])

  useEffect(() => {
    if (animFile) {
      void import('./scenes/animPreview').then((m) => m.runAnimPreview(canvasRef.current!, animFile))
      return
    }
    if (gallery) {
      void import('./scenes/gallery').then((m) => m.runGallery(canvasRef.current!))
      return
    }
    const scene = new CafeScene(canvasRef.current!)
    const game = new CafeGame(scene, labelsRef.current!)
    const audio = new AudioSystem()
    audio.applySettings(loadSettings())
    const director = new VoiceDirector({
      audio,
      game,
      scene,
      getChef: () => chefRef.current,
      tutorialActive: () => tutorialActiveRef.current,
      onCaption: setCaption,
    })
    const sfx = new SfxDirector({ audio, game, scene })
    const ambience = new Ambience(audio)
    // Both directors see every game event.
    game.onEvent = (e) => {
      director.handle(e)
      sfx.handle(e)
    }
    // Every rendered frame, paused or not: listener at the chef, station loops, ambience, traffic.
    const listener = new THREE.Vector3()
    scene.onFrame = (dt) => {
      const chef = scene.chefPosition
      if (chef) {
        listener.set(chef.x, chef.y + LISTENER_HEIGHT, chef.z)
        audio.updateListener(listener, scene.viewForward)
      }
      sfx.update(dt)
      ambience.update(dt, !scene.paused && ambientOnRef.current)
    }
    sceneRef.current = scene
    gameRef.current = game
    audioRef.current = audio
    if (import.meta.env.DEV) {
      window.__cafe = scene
      window.__game = game
      window.__audio = audio
    }
    let cancelled = false
    scene.paused = true
    ambientOnRef.current = loadSettings().ambientEffects
    scene.applySettings(loadSettings())
    game.onDayAdvance = (day, money) => persist(day, money)
    Promise.all([scene.loadEnvironment(), game.load(), scene.loadChef('male')])
      .then(() => {
        if (cancelled) return
        game.prepareSeats()
        setScreen('menu')
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    const poll = window.setInterval(() => setSnap(game.snapshot()), 200)
    return () => {
      cancelled = true
      window.clearInterval(poll)
      scene.onFrame = null
      game.onEvent = null
      director.dispose()
      sfx.dispose()
      ambience.dispose()
      audio.dispose()
      audioRef.current = null
      game.dispose()
      scene.dispose()
      sceneRef.current = null
      gameRef.current = null
    }
  }, [gallery, animFile, persist])

  // The simulation runs only on the Playing screen with no overlay open.
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.paused = screen !== 'playing' || paused || settingsOpen || photo
    if (sceneRef.current) sceneRef.current.cameraInputEnabled = screen === 'playing' && !paused && !settingsOpen
  }, [screen, paused, settingsOpen, photo])

  // Photo mode: free camera and chef poses; the scene keeps rendering while the simulation is frozen.
  useEffect(() => {
    sceneRef.current?.setPhotoMode(photo && screen === 'playing')
    if (photo && screen !== 'playing') setPhoto(false)
  }, [photo, screen])

  // Skip drawing while an opaque screen covers the canvas. The menu covers it only with the video or still.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const covered = screen === 'loading' || screen === 'select' || (screen === 'menu' && menuCovered)
    scene.renderEnabled = !covered
  }, [screen, menuCovered])

  // Camera: default pose behind the menus, follow the chef while playing.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (screen === 'playing') scene.setCameraFollow(true)
    else if (screen !== 'loading') scene.resetCamera(false)
  }, [screen])

  // Esc: close Settings, otherwise toggle Pause.
  useEffect(() => {
    if (screen !== 'playing') return
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyV' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!paused && !settingsOpen && !summaryOpenRef.current) setPhoto((p) => !p)
        return
      }
      if (e.code !== 'Escape') return
      if (photo) {
        setPhoto(false)
        return
      }
      if (settingsOpen) setSettingsOpen(false)
      else setPaused((p) => !p)
      if (settingsOpen || paused) audioRef.current?.playSfx(SFX.cancel, { volume: UI_CLICK_VOLUME })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen, settingsOpen, paused, photo])

  // Music follows the screen: menu theme on menu and chef select, cafe loop while playing (also over
  // pause, Settings and the Day Summary). The request is remembered until the first user gesture.
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    if (screen === 'menu' || screen === 'select') a.playMusic(MUSIC.menu)
    else if (screen === 'playing') a.playMusic(MUSIC.cafe)
    a.setMusicScale(screen === 'playing' && (paused || settingsOpen) ? PAUSE_MUSIC_SCALE : 1)
  }, [screen, paused, settingsOpen])

  // The first user gesture creates / resumes the audio context (browser autoplay policy).
  useEffect(() => {
    const unlock = () => audioRef.current?.unlock()
    const types = ['pointerdown', 'keydown', 'click'] as const
    for (const t of types) window.addEventListener(t, unlock, true)
    return () => {
      for (const t of types) window.removeEventListener(t, unlock, true)
    }
  }, [])

  // UI sounds, one delegated listener: hover on .btn / chef cards, confirm on primary buttons and chef
  // cards, cancel on Back. A button can override with data-sfx="confirm" | "cancel" | "none".
  useEffect(() => {
    const live = (el: Element | null) => (el && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' ? el : null)
    const onOver = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return
      const el = live(e.target.closest('.btn, .chef-card'))
      if (!el || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return
      audioRef.current?.playSfx(SFX.hover, { volume: UI_HOVER_VOLUME, rate: 1 })
    }
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return
      const el = live(e.target.closest('button'))
      if (!el) return
      const kind = (el as HTMLElement).dataset.sfx ?? (el.classList.contains('primary') || el.classList.contains('chef-card') ? 'confirm' : 'none')
      if (kind === 'confirm' || kind === 'cancel') audioRef.current?.playSfx(SFX[kind], { volume: UI_CLICK_VOLUME, rate: 1 })
    }
    window.addEventListener('mouseover', onOver)
    window.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('mouseover', onOver)
      window.removeEventListener('click', onClick)
    }
  }, [])

  // Voice lines stop whenever the game is not running (pause, settings, menus).
  useEffect(() => {
    if (screen !== 'playing' || paused || settingsOpen) audioRef.current?.stopVoice()
  }, [screen, paused, settingsOpen])

  // The tutorial owns the voice channel while it is on screen.
  useEffect(() => {
    tutorialActiveRef.current = tutorial && !snap?.summary
  }, [tutorial, snap?.summary])

  useEffect(() => {
    summaryOpenRef.current = !!snap?.summary
  }, [snap?.summary])

  const changeSettings = (s: Settings) => {
    setSettings(s)
    saveSettings(s)
    ambientOnRef.current = s.ambientEffects
    sceneRef.current?.applySettings(s)
    audioRef.current?.applySettings(s)
  }

  /** Swap in the chosen chef if needed, then start the simulation. */
  const startPlaying = async (chef: ChefId, day: number, money: number, tutorialDone: boolean, writeNew = false) => {
    const scene = sceneRef.current
    const game = gameRef.current
    if (!scene || !game) return
    audioRef.current?.unlock()
    setBusy(true)
    try {
      // Ask the scene which model is really loaded; chefRef only tracks the selection.
      if (chef !== scene.loadedChef) await scene.loadChef(chef)
      chefRef.current = chef
      tutorialDoneRef.current = tutorialDone
      if (writeNew) persist(day, money)
      game.restore(day, money)
      setTutorial(!tutorialDone)
      setPaused(false)
      setScreen('playing')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setScreen('loading')
    } finally {
      setBusy(false)
    }
  }

  const confirmChef = (chef: ChefId) => {
    audioRef.current?.unlock()
    // The save is written inside startPlaying once the chosen model is loaded.
    void startPlaying(chef, 1, 0, false, true)
  }

  const finishTutorial = () => {
    tutorialDoneRef.current = true
    setTutorial(false)
    const g = gameRef.current
    if (g) persist(g.progress.day, g.progress.money)
  }

  const saveNow = () => {
    const g = gameRef.current
    if (g) persist(g.progress.day, g.progress.money)
  }

  const toMainMenu = () => {
    saveNow()
    gameRef.current?.restartDay()
    setPaused(false)
    setScreen('menu')
  }

  if (gallery) return <canvas ref={canvasRef} className="stage" />

  return (
    <div
      className={`app ${settings.reducedMotion ? 'reduced-motion' : ''}`}
      style={{ '--ui-scale': settings.uiScale } as React.CSSProperties}
    >
      <canvas ref={canvasRef} className="stage" />
      <div ref={labelsRef} className="labels" style={photo ? { display: 'none' } : undefined} />

      {screen === 'loading' && <LoadingScreen error={error || undefined} />}
      {screen === 'menu' && (
        <MainMenu
          canContinue={!!save && !busy}
          onBackdropChange={setMenuCovered}
          onNewGame={() => {
            audioRef.current?.unlock()
            setScreen('select')
          }}
          onContinue={() => {
            audioRef.current?.unlock()
            if (save) void startPlaying(save.selectedChef, save.currentDay, save.currency, save.tutorialCompleted)
          }}
          onSettings={() => setSettingsOpen(true)}
        />
      )}
      {screen === 'select' && (
        <CharacterSelect
          initial={save?.selectedChef ?? 'male'}
          busy={busy}
          onConfirm={confirmChef}
          onBack={() => setScreen('menu')}
        />
      )}

      {screen === 'playing' && photo && sceneRef.current && (
        <PhotoMode scene={sceneRef.current} onExit={() => setPhoto(false)} />
      )}

      {screen === 'playing' && snap && !photo && (
        <div className="hud">
          <div className="stats">
            <span>Day {snap.day}</span>
            <span>💰 ${snap.money}</span>
            <span>
              Customers {snap.served}/{snap.total}
            </span>
            {snap.carrying && <span className="carry-chip">Carrying: {snap.carrying}</span>}
          </div>
          <div className="controls-hint">Move: W A S D · Interact: E · Camera: drag / Z C · Zoom: wheel · Reset: R · Photo mode: V</div>
          <button className="photo-btn" onClick={() => setPhoto(true)} aria-label="Photo mode (V)" title="Photo mode (V)">
            📷 Photo (V)
          </button>
          <button className="pause-btn" onClick={() => setPaused(true)}>
            Pause (Esc)
          </button>

          <aside className="queue" aria-label="Order queue">
            <h2>Orders</h2>
            {snap.orders.length === 0 && <p className="empty">No orders yet</p>}
            {snap.orders.map((o) => (
              <div key={o.id} className={`order st-${o.status}`}>
                <span className="ico">{o.icon}</span>
                <div>
                  <b>{o.name}</b>
                  <small>
                    {CafeGame.statusText(o.status)} · {o.station}
                  </small>
                </div>
              </div>
            ))}
          </aside>

          {snap.prompt && (
            <div className="prompt">
              <kbd>E</kbd> {snap.prompt}
            </div>
          )}
          {snap.notice && <div className="notice">{snap.notice}</div>}
          {caption && !tutorial && (
            <div className="caption" aria-live="polite">
              <b>{caption.speaker}:</b>
              {caption.text}
            </div>
          )}

          {tutorial && !snap.summary && (
            <Tutorial
              chef={chefRef.current}
              snap={snap}
              chefPos={() => sceneRef.current?.chefPosition ?? null}
              setHighlight={(s) => {
                if (gameRef.current) gameRef.current.highlight = s
              }}
              onFinish={finishTutorial}
              speak={(step) => audioRef.current?.playVoice(tutorialUrl(chefRef.current, step), { priority: 'high' })}
              stopSpeech={() => audioRef.current?.stopVoice()}
            />
          )}

          {snap.summary && (
            <div className="modal">
              <div className="card">
                <h1>Day Summary</h1>
                <dl>
                  <dt>Customers Served</dt>
                  <dd>{snap.summary.customers}</dd>
                  <dt>Orders Completed</dt>
                  <dd>{snap.summary.orders}</dd>
                  <dt>Total Revenue</dt>
                  <dd>${snap.summary.revenue}</dd>
                </dl>
                <p className="saved-note">Your progress is saved when you continue.</p>
                <button className="primary" onClick={() => gameRef.current?.nextDay()}>
                  Continue
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {screen === 'playing' && paused && !settingsOpen && (
        <PauseMenu
          onResume={() => setPaused(false)}
          onSettings={() => setSettingsOpen(true)}
          onSave={saveNow}
          onRestart={() => {
            gameRef.current?.restartDay()
            setPaused(false)
          }}
          onMainMenu={toMainMenu}
        />
      )}
      {settingsOpen && (
        <SettingsPanel value={settings} onChange={changeSettings} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}
