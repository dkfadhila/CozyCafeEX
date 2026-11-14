// Menu from the PRD (section 5.8). Data-driven: add a row to add a recipe.
// `icon` is a 2D HUD glyph. The 3D serving models (food_*.glb) are a later Meshy batch.

export type StationId = 'coffee' | 'blender' | 'stove' | 'prep' | 'pastry'

export interface Recipe {
  id: string
  name: string
  price: number
  /** Seconds of preparation at the station. */
  prep: number
  station: StationId
  icon: string
}

export const RECIPES: Recipe[] = [
  { id: 'coffee', name: 'Coffee', price: 4, prep: 4, station: 'coffee', icon: '☕' },
  { id: 'iced_coffee', name: 'Iced Coffee', price: 5, prep: 5, station: 'coffee', icon: '🧋' },
  { id: 'tea', name: 'Tea', price: 3, prep: 4, station: 'coffee', icon: '🍵' },
  { id: 'lemonade', name: 'Lemonade', price: 4, prep: 4, station: 'blender', icon: '🍋' },
  { id: 'pancakes', name: 'Pancakes', price: 7, prep: 7, station: 'stove', icon: '🥞' },
  { id: 'burger', name: 'Burger', price: 9, prep: 8, station: 'stove', icon: '🍔' },
  { id: 'sandwich', name: 'Sandwich', price: 6, prep: 5, station: 'prep', icon: '🥪' },
  { id: 'salad', name: 'Salad', price: 6, prep: 5, station: 'prep', icon: '🥗' },
  { id: 'cake', name: 'Cake', price: 6, prep: 3, station: 'pastry', icon: '🍰' },
  { id: 'donut', name: 'Donut', price: 3, prep: 3, station: 'pastry', icon: '🍩' },
]

export const STATION_LABEL: Record<StationId, string> = {
  coffee: 'Coffee Machine',
  blender: 'Blender',
  stove: 'Stove',
  prep: 'Prep Table',
  pastry: 'Pastry Case',
}
