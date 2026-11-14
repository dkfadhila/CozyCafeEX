// Versioned local save (PRD 5.12). Corrupted or outdated data is discarded, never thrown.
import type { ChefId } from '../assets/manifest'

const KEY = 'cozy-cafe-ex.save'
const VERSION = 1

export interface SaveData {
  saveVersion: number
  selectedChef: ChefId
  currentDay: number
  currency: number
  tutorialCompleted: boolean
}

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<SaveData>
    if (d.saveVersion !== VERSION) return null
    if (d.selectedChef !== 'male' && d.selectedChef !== 'female') return null
    if (!Number.isFinite(d.currentDay) || !Number.isFinite(d.currency)) return null
    return {
      saveVersion: VERSION,
      selectedChef: d.selectedChef,
      currentDay: Math.max(1, Math.floor(d.currentDay!)),
      currency: Math.max(0, Math.floor(d.currency!)),
      tutorialCompleted: !!d.tutorialCompleted,
    }
  } catch {
    return null
  }
}

export function writeSave(d: Omit<SaveData, 'saveVersion'>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...d, saveVersion: VERSION }))
  } catch {
    // Storage unavailable (private window, quota): the game still runs, just without saving.
  }
}
