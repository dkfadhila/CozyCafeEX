// Central asset manifest: logical ids -> files under public/assets.
// Every 3D model listed here is a Meshy output. Add entries only for files that exist.
import type { SkinFix } from './skinFixes'

export type ChefId = 'male' | 'female'

export type ClipName =
  | 'walk'
  | 'idle'
  | 'sitDown'
  | 'sitIdle'
  | 'drink'
  | 'standUp'
  | 'cheer'
  | 'cook'
  | 'pickup'

export interface ClipFile {
  url: string
  /** Name to give the file's single clip. Omit when the clips inside are already named. */
  as?: ClipName
}

export interface CharacterAsset {
  /** Rigged GLB (skinned mesh + skeleton). */
  model: string
  /** Skeleton-only GLBs holding Meshy animation clips for this character's rig. */
  clipFiles: ClipFile[]
  /** World height in metres the model is normalised to. */
  height: number
  /** Runtime skin-weight repair applied right after the model loads (see skinFixes.ts). */
  skinFix?: SkinFix
}

/** 2D and video assets. Files that do not exist yet are handled by fallbacks in the screens. */
export const UI = {
  /** Seedream 5.5 still (Dreamina), 1920x1080 JPEG; the 2560 px original is in /generated. */
  loading: '/assets/ui/ui_loading_16x9.jpg',
  /** Seedance 2.5 loop (Dreamina), 8 s, 16:9, 720p. */
  menuVideo: '/assets/video/video_mainmenu_loop_16x9_8s.mp4',
  /** First and last frame of the menu video; shown while it loads or if it cannot play. */
  menuStill: '/assets/ui/ui_menu_fallback_16x9.jpg',
  /** Copies of the supplied character art (BoyMC.png, Girl MC.png). */
  selectMale: '/assets/ui/select_chef_male.png',
  selectFemale: '/assets/ui/select_chef_female.png',
}

/** Tutorial chef expressions; one 512x512 portrait per chef and expression. */
export const EXPRESSIONS = ['friendly', 'explaining', 'surprised', 'thinking', 'encouraging', 'happy'] as const
export type Expression = (typeof EXPRESSIONS)[number]

/** Head-and-chest portraits on a plain cream background (JPEG), keyed by chef then expression. */
export const PORTRAITS: Record<ChefId, Record<Expression, string>> = {
  male: Object.fromEntries(EXPRESSIONS.map((e) => [e, `/assets/ui/portrait_chef_male_${e}.jpg`])) as Record<Expression, string>,
  female: Object.fromEntries(EXPRESSIONS.map((e) => [e, `/assets/ui/portrait_chef_female_${e}.jpg`])) as Record<Expression, string>,
}

export interface PropAsset {
  url: string
}

const model = (name: string): PropAsset => ({ url: `/assets/models/${name}.glb` })

const FOOD_IDS = ['coffee', 'iced_coffee', 'tea', 'lemonade', 'pancakes', 'burger', 'sandwich', 'salad', 'cake', 'donut']

/** Static Meshy props, keyed by file name. */
export const PROPS: Record<string, PropAsset> = Object.fromEntries(
  [
    'env_cafe_floor',
    'env_cafe_wall_plain',
    'env_cafe_wall_window',
    'env_cafe_wall_door',
    'env_cafe_wall_shelf',
    'prop_table_dining',
    'prop_chair_wood',
    'prop_counter_bar',
    'prop_sign_menu',
    'prop_plant_pot',
    'prop_kitchen_coffee_machine',
    'prop_kitchen_blender',
    'prop_kitchen_stove',
    'prop_kitchen_prep_table',
    'prop_kitchen_pastry_case',
    'prop_kitchen_sink',
    'prop_kitchen_fridge',
    'prop_kitchen_register',
    // Serving models: not in CAFE_LAYOUT, listed here so the dev gallery shows them.
    ...FOOD_IDS.map((id) => `food_${id}`),
  ].map((n) => [n, model(n)]),
)

/** Serving model per recipe id (file name after "food_" equals the recipe id). */
export const FOOD: Record<string, string> = Object.fromEntries(FOOD_IDS.map((id) => [id, model(`food_${id}`).url]))

/** The six customers, generated from `Npc (1..6).png`. */
export const NPCS: CharacterAsset[] = [1, 2, 3, 4, 5, 6].map((n) => ({
  model: `/assets/models/npc_customer_0${n}.glb`,
  clipFiles: [
    { url: `/assets/models/anim_npc_0${n}_walk.glb`, as: 'walk' },
    { url: `/assets/models/anim_npc_0${n}_clips.glb` }, // idle, sitDown, sitIdle, drink, standUp
  ],
  height: 1.05,
}))

export const CHEFS: Record<ChefId, CharacterAsset> = {
  male: {
    model: '/assets/models/char_chef_male.glb',
    clipFiles: [
      { url: '/assets/models/anim_chef_male_walk.glb', as: 'walk' },
      { url: '/assets/models/anim_chef_male_clips.glb' }, // idle, cheer
      { url: '/assets/models/anim_chef_male_cook.glb' },
      { url: '/assets/models/anim_chef_male_pickup.glb' },
    ],
    height: 1.1,
  },
  female: {
    model: '/assets/models/char_chef_female.glb',
    clipFiles: [
      { url: '/assets/models/anim_chef_female_walk.glb', as: 'walk' },
      { url: '/assets/models/anim_chef_female_clips.glb' }, // idle, cheer
      { url: '/assets/models/anim_chef_female_cook.glb' },
      { url: '/assets/models/anim_chef_female_pickup.glb' },
    ],
    height: 1.1,
    skinFix: 'femaleChef', // bob hair was weighted to the forearms and tore when the arms moved
  },
}
