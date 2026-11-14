// Turns game events into occasional spoken lines (chef reactions, sparse customer chatter) and captions.
import * as THREE from 'three'
import type { AudioSystem } from '../audio/AudioSystem'
import type { ChefId } from '../assets/manifest'
import type { CafeScene } from '../scenes/CafeScene'
import type { CafeGame, GameEvent } from './CafeGame'

const VOICE_DIR = '/assets/audio/voice/'

/** Minimum seconds between two plays of the same chef reaction key. */
export const CHEF_KEY_COOLDOWN = 12
/** Minimum seconds between any two customer lines. */
export const CUSTOMER_COOLDOWN = 6
/** Chance that react_start / react_ready / react_serve plays (react_day always plays). */
export const CHEF_REACT_CHANCE = 0.6
/** Chance per customer event. */
export const CUSTOMER_CHANCE = { greet: 0.45, smell: 0.35, thanks: 0.55, bye: 0.35 }
/** Stereo pan range for customer lines. */
export const CUSTOMER_PAN = 0.7

export type Speaker = 'chef_male' | 'chef_female' | `npc_0${1 | 2 | 3 | 4 | 5 | 6}`

export interface Caption {
  speaker: string
  text: string
}

export function voiceUrl(speaker: Speaker, key: string): string {
  return `${VOICE_DIR}vo_${speaker}_${key}.mp3`
}

export function chefSpeaker(chef: ChefId): Speaker {
  return chef === 'male' ? 'chef_male' : 'chef_female'
}

/** URL of tutorial line `step` (0-based) for the chosen chef. */
export function tutorialUrl(chef: ChefId, step: number): string {
  return voiceUrl(chefSpeaker(chef), `tut_0${step + 1}`)
}

interface DirectorOptions {
  audio: AudioSystem
  game: CafeGame
  scene: CafeScene
  getChef: () => ChefId
  /** True while the tutorial owns the voice channel. */
  tutorialActive: () => boolean
  onCaption: (c: Caption | null) => void
}

const CHEF_LINE = { prepare: 'react_start', ready: 'react_ready', serve: 'react_serve', summary: 'react_day' } as const
const CUSTOMER_LINE = { seated: 'greet', serve: 'smell', paid: 'thanks', leaving: 'bye' } as const

export class VoiceDirector {
  private o: DirectorOptions
  private texts = new Map<string, string>()
  private lastChef = new Map<string, number>()
  private lastCustomer = -Infinity
  private caption: Caption | null = null
  private point = { x: 0, y: 0 }

  constructor(o: DirectorOptions) {
    this.o = o
    void this.loadTexts()
  }

  private async loadTexts() {
    try {
      const res = await fetch(`${VOICE_DIR}voice_manifest.json`)
      const list = (await res.json()) as { file: string; text: string }[]
      for (const l of list) this.texts.set(l.file, l.text)
    } catch {
      // Captions are optional; lines still play.
    }
  }

  private now() {
    return performance.now() / 1000
  }

  /** Feed every game event here (the owner of game.onEvent fans events out to all directors). */
  handle(e: GameEvent) {
    if (this.o.tutorialActive()) return
    const chefKey = e.type in CHEF_LINE ? CHEF_LINE[e.type as keyof typeof CHEF_LINE] : null
    if (chefKey) this.chefLine(chefKey)
    if (e.type in CUSTOMER_LINE && 'npc' in e) this.customerLine(e.npc, CUSTOMER_LINE[e.type as keyof typeof CUSTOMER_LINE])
  }

  private chefLine(key: string) {
    const t = this.now()
    if (t - (this.lastChef.get(key) ?? -Infinity) < CHEF_KEY_COOLDOWN) return
    if (key !== 'react_day' && Math.random() >= CHEF_REACT_CHANCE) return
    const speaker = chefSpeaker(this.o.getChef())
    if (this.play(speaker, key, 'Chef', 0)) this.lastChef.set(key, t)
  }

  private customerLine(npc: number, key: keyof typeof CUSTOMER_CHANCE) {
    const t = this.now()
    if (t - this.lastCustomer < CUSTOMER_COOLDOWN) return
    if (Math.random() >= CUSTOMER_CHANCE[key]) return
    let pan = 0
    const pos = this.o.game.customerPosition(npc)
    if (pos) {
      this.o.scene.project(pos as THREE.Vector3, this.point)
      const w = this.o.scene.viewWidth
      pan = THREE.MathUtils.clamp((this.point.x / w - 0.5) * 2, -1, 1) * CUSTOMER_PAN
    }
    const speaker = `npc_0${npc + 1}` as Speaker
    if (this.play(speaker, key, 'Customer', pan)) this.lastCustomer = t
  }

  private play(speaker: Speaker, key: string, who: string, pan: number): boolean {
    const url = voiceUrl(speaker, key)
    const text = this.texts.get(url.slice(VOICE_DIR.length))
    let mine: Caption | null = null
    return this.o.audio.playVoice(url, {
      pan,
      priority: 'low',
      onStart: () => {
        if (!text) return
        mine = { speaker: who, text }
        this.caption = mine
        this.o.onCaption(mine)
      },
      onEnd: () => {
        if (mine && this.caption === mine) {
          this.caption = null
          this.o.onCaption(null)
        }
      },
    })
  }

  dispose() {
    if (this.caption) this.o.onCaption(null)
    this.caption = null
  }
}
