// Web Audio wrapper: one lazily created context, gain buses (master / music / sfx / voice), a shared
// decoded-buffer cache, single-channel voice, cross-faded music, one-shot and looping SFX with optional
// 3D panning, and a listener the scene moves every frame.
import { Vector3 } from 'three'
import type { Settings } from '../systems/settings'

type AudioSettings = Pick<Settings, 'masterVolume' | 'musicVolume' | 'sfxVolume' | 'voiceVolume' | 'muted'>

/** Default music cross-fade, seconds. */
export const MUSIC_FADE = 1.2
/** Music bus level while a voice line plays (0.6 = 40% lower), and the ramp time, seconds. */
export const DUCK_LEVEL = 0.6
export const DUCK_RAMP = 0.25
/** Minimum milliseconds between two plays of the same one-shot url. */
export const SFX_COOLDOWN_MS = 80
/** Random playbackRate range for one-shots without an explicit rate. */
export const SFX_RATE_MIN = 0.95
export const SFX_RATE_MAX = 1.05
/** One-shots whose buffer takes longer than this to load are dropped instead of playing late. */
const SFX_MAX_LATE_MS = 1000
/** Default fade for loops at start and stop, seconds. */
export const LOOP_FADE_IN = 0.15
export const LOOP_FADE_OUT = 0.3
/** Positional audio (PannerNode) parameters. */
export const PANNER = { refDistance: 3, rolloffFactor: 1, maxDistance: 30 }

export interface VoiceOptions {
  /** Stereo pan, -1 (left) .. 1 (right). */
  pan?: number
  /** 'high' interrupts the current line; 'low' is dropped if a line is already playing. Default 'low'. */
  priority?: 'high' | 'low'
  /** Called when the line actually starts sounding. */
  onStart?: () => void
  /** Called when the line finishes or is stopped (never called if it was dropped or failed to load). */
  onEnd?: () => void
}

export interface MusicOptions {
  /** Cross-fade seconds from the track that is playing. Default MUSIC_FADE. */
  fadeIn?: number
}

export interface SfxOptions {
  volume?: number
  /** Fixed playbackRate; by default a random value in SFX_RATE_MIN..SFX_RATE_MAX. */
  rate?: number
  /** World position; omitted = centred on the sfx bus. */
  position?: Vector3
}

export interface LoopOptions {
  volume?: number
  position?: Vector3
  /** Fade-in seconds. Default LOOP_FADE_IN. */
  fadeIn?: number
  /** Low-pass cutoff in Hz (muffled, "outside" sound). */
  lowpass?: number
}

export interface LoopHandle {
  /** Ramp the loop volume (seconds, default 0.1). */
  setVolume(v: number, ramp?: number): void
  /** Move a positional loop. No effect on a non-positional one. */
  setPosition(v: Vector3): void
  /** Set the playbackRate (1 = original pitch). */
  setRate(r: number): void
  /** Fade out and release the loop (seconds, default LOOP_FADE_OUT). Safe to call twice. */
  stop(fade?: number): void
}

interface Playing {
  id: number
  source: AudioBufferSourceNode
  onEnd?: () => void
}

interface MusicTrack {
  url: string
  source: AudioBufferSourceNode
  gain: GainNode
}

/** Cancel automation and ramp a param linearly to a value. */
function ramp(p: AudioParam, v: number, dur: number, now: number) {
  p.cancelScheduledValues(now)
  p.setValueAtTime(p.value, now)
  if (dur > 0) p.linearRampToValueAtTime(v, now + dur)
  else p.setValueAtTime(v, now)
}

function setPannerPosition(p: PannerNode, v: Vector3) {
  if (p.positionX) {
    p.positionX.value = v.x
    p.positionY.value = v.y
    p.positionZ.value = v.z
  } else p.setPosition(v.x, v.y, v.z)
}

export class AudioSystem {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private music: GainNode | null = null
  /** Duck / pause multiplier in front of the music bus. */
  private musicMix: GainNode | null = null
  private sfx: GainNode | null = null
  private voice: GainNode | null = null
  private settings: AudioSettings = { masterVolume: 0.8, musicVolume: 0.7, sfxVolume: 0.8, voiceVolume: 0.9, muted: false }
  private buffers = new Map<string, AudioBuffer>()
  private loading = new Map<string, Promise<AudioBuffer | null>>()
  private current: Playing | null = null
  /** Id of the latest play request; older pending requests are abandoned. */
  private request = 0
  private warned = false
  private disposed = false

  private musicWant: string | null = null
  private musicCur: MusicTrack | null = null
  private musicToken = 0
  private musicScale = 1
  private lastPlay = new Map<string, number>()
  private loops = new Set<() => void>()
  private preloadList: string[] = []

  private listenerPos = new Vector3(0, 1.2, 0)
  private listenerFwd = new Vector3(-Math.SQRT1_2, 0, -Math.SQRT1_2)

  /** Create or resume the context. Call from a user-gesture handler. */
  unlock() {
    if (this.disposed) return
    try {
      if (!this.ctx) this.create()
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined)
    } catch (e) {
      this.warn(e)
    }
  }

  private create() {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.music = ctx.createGain()
    this.musicMix = ctx.createGain()
    this.sfx = ctx.createGain()
    this.voice = ctx.createGain()
    this.musicMix.connect(this.music)
    this.music.connect(this.master)
    this.sfx.connect(this.master)
    this.voice.connect(this.master)
    this.master.connect(ctx.destination)
    this.applySettings(this.settings)
    this.musicMix.gain.value = this.duckTarget()
    this.updateListener(this.listenerPos, this.listenerFwd)
    for (const u of this.preloadList) void this.load(u)
    if (this.musicWant) this.startMusic()
  }

  /** Set bus levels. Safe before the context exists; values are applied on creation. */
  applySettings(s: AudioSettings) {
    this.settings = { ...s }
    if (!this.master || !this.music || !this.sfx || !this.voice) return
    this.master.gain.value = s.muted ? 0 : s.masterVolume
    this.music.gain.value = s.musicVolume
    this.sfx.gain.value = s.sfxVolume
    this.voice.gain.value = s.voiceVolume
  }

  private warn(e: unknown) {
    if (this.warned) return
    this.warned = true
    console.warn('[audio] playback unavailable:', e)
  }

  /** Fetch and decode once per url; shared by voice, music and sfx. */
  private load(url: string): Promise<AudioBuffer | null> {
    const hit = this.buffers.get(url)
    if (hit) return Promise.resolve(hit)
    let p = this.loading.get(url)
    if (!p) {
      p = (async () => {
        try {
          const ctx = this.ctx
          if (!ctx) return null
          const res = await fetch(url)
          if (!res.ok) throw new Error(`${res.status} ${url}`)
          const data = await res.arrayBuffer()
          const buf = await ctx.decodeAudioData(data)
          if (!this.disposed) this.buffers.set(url, buf)
          return buf
        } catch (e) {
          if (!this.disposed) this.warn(e)
          return null
        } finally {
          this.loading.delete(url)
        }
      })()
      this.loading.set(url, p)
    }
    return p
  }

  /** Start decoding these urls as soon as the context exists (now if it already does). */
  preload(urls: string[]) {
    this.preloadList = [...new Set([...this.preloadList, ...urls])]
    if (this.ctx && !this.disposed) for (const u of urls) void this.load(u)
  }

  // ------------------------------------------------------------------ voice

  /**
   * Play a voice line. Returns false when the line is dropped (low priority while another line is
   * playing, or no audio context). Loading is asynchronous: true means the line was accepted.
   */
  playVoice(url: string, opts: VoiceOptions = {}): boolean {
    if (this.disposed || !this.ctx || !this.voice) return false
    const high = opts.priority === 'high'
    if (!high && (this.current || this.pending)) return false
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined)
    this.stopVoice()
    const id = ++this.request
    this.pending = id
    void this.load(url).then((buf) => {
      if (this.pending === id) this.pending = 0
      if (!buf || id !== this.request || this.disposed || !this.ctx || !this.voice) return
      const ctx = this.ctx
      const source = ctx.createBufferSource()
      source.buffer = buf
      let tail: AudioNode = source
      if (opts.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
        const panner = ctx.createStereoPanner()
        panner.pan.value = Math.max(-1, Math.min(1, opts.pan))
        tail.connect(panner)
        tail = panner
      }
      tail.connect(this.voice)
      const playing: Playing = { id, source, onEnd: opts.onEnd }
      source.onended = () => this.finish(playing)
      this.current = playing
      try {
        source.start()
      } catch (e) {
        this.warn(e)
        this.finish(playing)
        return
      }
      this.updateDuck()
      opts.onStart?.()
    })
    return true
  }

  /** Request id still loading, or 0. */
  private pending = 0

  private finish(p: Playing) {
    if (this.current === p) this.current = null
    p.source.onended = null
    try {
      p.source.disconnect()
    } catch {
      // already disconnected
    }
    this.updateDuck()
    const cb = p.onEnd
    p.onEnd = undefined
    cb?.()
  }

  /** Stop the current line (and cancel one that is still loading). onEnd fires for a started line. */
  stopVoice() {
    this.request++
    this.pending = 0
    const p = this.current
    if (!p) return
    try {
      p.source.stop()
    } catch {
      // not started
    }
    this.finish(p)
  }

  /** True while a voice line is loading or sounding. */
  get speaking(): boolean {
    return !!this.current || this.pending !== 0
  }

  // ------------------------------------------------------------------ music

  private duckTarget(): number {
    return (this.current ? DUCK_LEVEL : 1) * this.musicScale
  }

  private updateDuck() {
    if (!this.ctx || !this.musicMix) return
    ramp(this.musicMix.gain, this.duckTarget(), DUCK_RAMP, this.ctx.currentTime)
  }

  /**
   * Scale the music bus (1 = normal), e.g. 0.5 while the game is paused. Stacks with voice ducking.
   */
  setMusicScale(scale: number, rampSeconds = 0.4) {
    this.musicScale = Math.max(0, scale)
    if (!this.ctx || !this.musicMix) return
    ramp(this.musicMix.gain, this.duckTarget(), rampSeconds, this.ctx.currentTime)
  }

  /**
   * Loop a track on the music bus, cross-fading from the current one. No-op if it is already the
   * requested track. Before unlock() the request is remembered and starts when the context is created.
   */
  playMusic(url: string, opts: MusicOptions = {}) {
    if (this.disposed || this.musicWant === url) return
    this.musicWant = url
    this.musicFade = opts.fadeIn ?? MUSIC_FADE
    this.startMusic()
  }

  private musicFade = MUSIC_FADE

  private startMusic() {
    const url = this.musicWant
    if (!url || !this.ctx || !this.musicMix) return
    const token = ++this.musicToken
    const fade = this.musicFade
    void this.load(url).then((buf) => {
      const ctx = this.ctx
      if (!buf || token !== this.musicToken || this.disposed || !ctx || !this.musicMix) return
      if (this.musicCur?.url === url) return
      try {
        const now = ctx.currentTime
        const source = ctx.createBufferSource()
        source.buffer = buf
        source.loop = true
        const gain = ctx.createGain()
        gain.gain.setValueAtTime(0, now)
        gain.gain.linearRampToValueAtTime(1, now + Math.max(0.01, fade))
        source.connect(gain)
        gain.connect(this.musicMix)
        source.start()
        const old = this.musicCur
        this.musicCur = { url, source, gain }
        if (old) this.fadeOutTrack(old, fade)
      } catch (e) {
        this.warn(e)
      }
    })
  }

  private fadeOutTrack(t: MusicTrack, fade: number) {
    const ctx = this.ctx
    if (!ctx) return
    const now = ctx.currentTime
    ramp(t.gain.gain, 0, Math.max(0.01, fade), now)
    t.source.onended = () => {
      t.source.onended = null
      t.source.disconnect()
      t.gain.disconnect()
    }
    try {
      t.source.stop(now + Math.max(0.01, fade) + 0.05)
    } catch {
      // already stopped
    }
  }

  /** Fade the music out and forget the requested track. */
  stopMusic(fade = MUSIC_FADE) {
    this.musicWant = null
    this.musicToken++
    const cur = this.musicCur
    this.musicCur = null
    if (cur) this.fadeOutTrack(cur, fade)
  }

  // ------------------------------------------------------------------ sfx

  private makePanner(pos: Vector3): PannerNode {
    const p = this.ctx!.createPanner()
    p.panningModel = 'HRTF'
    p.distanceModel = 'inverse'
    p.refDistance = PANNER.refDistance
    p.rolloffFactor = PANNER.rolloffFactor
    p.maxDistance = PANNER.maxDistance
    setPannerPosition(p, pos)
    return p
  }

  /**
   * Play a one-shot. Ignored before unlock(), while the context is not running, and when the same url
   * played less than SFX_COOLDOWN_MS ago.
   */
  playSfx(url: string, opts: SfxOptions = {}) {
    const ctx = this.ctx
    if (this.disposed || !ctx || !this.sfx || ctx.state !== 'running') return
    const t = performance.now()
    if (t - (this.lastPlay.get(url) ?? -Infinity) < SFX_COOLDOWN_MS) return
    this.lastPlay.set(url, t)
    const position = opts.position?.clone()
    void this.load(url).then((buf) => {
      if (!buf || this.disposed || this.ctx !== ctx || !this.sfx) return
      if (performance.now() - t > SFX_MAX_LATE_MS) return
      try {
        const source = ctx.createBufferSource()
        source.buffer = buf
        source.playbackRate.value = opts.rate ?? SFX_RATE_MIN + Math.random() * (SFX_RATE_MAX - SFX_RATE_MIN)
        const gain = ctx.createGain()
        gain.gain.value = opts.volume ?? 1
        source.connect(gain)
        let panner: PannerNode | null = null
        if (position) {
          panner = this.makePanner(position)
          gain.connect(panner)
          panner.connect(this.sfx)
        } else gain.connect(this.sfx)
        source.onended = () => {
          source.onended = null
          source.disconnect()
          gain.disconnect()
          panner?.disconnect()
        }
        source.start()
      } catch (e) {
        this.warn(e)
      }
    })
  }

  /**
   * Start a looping sound. Returns null before unlock() (callers may retry later). The sound starts as
   * soon as its buffer is decoded; stop() before that cancels it.
   */
  startLoop(url: string, opts: LoopOptions = {}): LoopHandle | null {
    const ctx = this.ctx
    if (this.disposed || !ctx || !this.sfx) return null
    const out = ctx.createGain()
    out.gain.value = 0
    const nodes: AudioNode[] = [out]
    let tail: AudioNode = out
    if (opts.lowpass) {
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = opts.lowpass
      tail.connect(f)
      tail = f
      nodes.push(f)
    }
    let panner: PannerNode | null = null
    if (opts.position) {
      panner = this.makePanner(opts.position)
      tail.connect(panner)
      tail = panner
      nodes.push(panner)
    }
    tail.connect(this.sfx)

    let source: AudioBufferSourceNode | null = null
    let rate = 1
    let stopped = false
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.loops.delete(kill)
      if (source) {
        source.onended = null
        source.disconnect()
      }
      for (const n of nodes) n.disconnect()
    }
    /** Immediate teardown (dispose). */
    const kill = () => {
      stopped = true
      try {
        source?.stop()
      } catch {
        // not started
      }
      release()
    }
    this.loops.add(kill)

    ramp(out.gain, opts.volume ?? 1, opts.fadeIn ?? LOOP_FADE_IN, ctx.currentTime)
    void this.load(url).then((buf) => {
      if (stopped || !buf || this.disposed || this.ctx !== ctx) {
        if (stopped) release()
        return
      }
      try {
        const s = ctx.createBufferSource()
        s.buffer = buf
        s.loop = true
        s.playbackRate.value = rate
        s.connect(out)
        s.start()
        source = s
      } catch (e) {
        this.warn(e)
        release()
      }
    })

    return {
      setVolume: (v, r = 0.1) => {
        if (!stopped) ramp(out.gain, v, r, ctx.currentTime)
      },
      setPosition: (v) => {
        if (panner && !stopped) setPannerPosition(panner, v)
      },
      setRate: (r) => {
        rate = r
        if (source && !stopped) source.playbackRate.value = r
      },
      stop: (fade = LOOP_FADE_OUT) => {
        if (stopped) return
        stopped = true
        const now = ctx.currentTime
        const f = Math.max(0.01, fade)
        ramp(out.gain, 0, f, now)
        if (!source) {
          window.setTimeout(release, f * 1000 + 50)
          return
        }
        source.onended = release
        try {
          source.stop(now + f + 0.05)
        } catch {
          release()
        }
      },
    }
  }

  // ------------------------------------------------------------------ listener

  /**
   * Place the 3D listener (world metres) facing `forward` (need not be normalised), up = +Y.
   * Remembered before the context exists.
   */
  updateListener(position: Vector3, forward: Vector3) {
    this.listenerPos.copy(position)
    this.listenerFwd.copy(forward)
    const ctx = this.ctx
    if (!ctx) return
    const l = ctx.listener
    const t = ctx.currentTime
    const f = this.listenerFwd
    if (l.positionX) {
      l.positionX.setValueAtTime(position.x, t)
      l.positionY.setValueAtTime(position.y, t)
      l.positionZ.setValueAtTime(position.z, t)
      l.forwardX.setValueAtTime(f.x, t)
      l.forwardY.setValueAtTime(f.y, t)
      l.forwardZ.setValueAtTime(f.z, t)
      l.upX.setValueAtTime(0, t)
      l.upY.setValueAtTime(1, t)
      l.upZ.setValueAtTime(0, t)
    } else {
      l.setPosition(position.x, position.y, position.z)
      l.setOrientation(f.x, f.y, f.z, 0, 1, 0)
    }
  }

  /** Last listener position passed to updateListener (read-only use). */
  get listenerPosition(): Vector3 {
    return this.listenerPos
  }

  dispose() {
    this.stopVoice()
    this.disposed = true
    this.musicWant = null
    this.musicToken++
    for (const kill of [...this.loops]) kill()
    this.loops.clear()
    const cur = this.musicCur
    this.musicCur = null
    if (cur) {
      try {
        cur.source.stop()
      } catch {
        // already stopped
      }
      cur.source.disconnect()
      cur.gain.disconnect()
    }
    this.buffers.clear()
    this.loading.clear()
    this.lastPlay.clear()
    void this.ctx?.close().catch(() => undefined)
    this.ctx = this.master = this.music = this.musicMix = this.sfx = this.voice = null
  }
}
