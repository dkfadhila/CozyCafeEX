// Placement of every Meshy prop in the cafe diorama.
// World: 8 x 8 m floor centred on the origin, top surface at y = 0.
// The camera sits at +X +Z, so the walls on x = -4 and z = -4 are the visible back walls.
// All Meshy models face +Z; rotY turns them (degrees, counter-clockwise seen from above).

export interface Placement {
  asset: string
  /** Position of the model's bottom-centre. */
  pos: [number, number, number]
  rotY?: number
  /** Uniform scale so the model's size on this local axis equals `size` metres. */
  fit?: { axis: 'x' | 'y' | 'z'; size: number }
  /** Or exact local dimensions (non-uniform). Used for the floor and wall panels. */
  dims?: [number, number, number]
  /** Blocks the chef. */
  solid?: boolean
  /** Interaction id for stations (used from Phase 4). */
  station?: string
}

const WALL_H = 2.3
// Panel depth. The Meshy panel is 1.1 cm thick, so a thin depth keeps its flat texture-less edges from being smeared; the
// room-facing surface stays on z/x = -4 (centre = -4 - WALL_T / 2). Walls are not colliders: the chef is clamped by WALK_HALF.
const WALL_T = 0.04
const WALL_C = -4 - WALL_T / 2
const wall = (pos: [number, number, number], rotY = 0): Placement => ({
  asset: 'env_cafe_wall_plain',
  pos,
  rotY,
  dims: [2, WALL_H, WALL_T],
})

export const CAFE_LAYOUT: Placement[] = [
  { asset: 'env_cafe_floor', pos: [0, -0.5, 0], dims: [8.4, 0.5, 8.4] },

  // Back wall on z = -4 (faces +Z) and side wall on x = -4 (faces +X): four 2 m panels each.
  wall([-3, 0, WALL_C]),
  wall([-1, 0, WALL_C]),
  wall([1, 0, WALL_C]),
  wall([3, 0, WALL_C]),
  wall([WALL_C, 0, -3], 90),
  wall([WALL_C, 0, -1], 90),
  wall([WALL_C, 0, 1], 90),
  wall([WALL_C, 0, 3], 90),

  // Openings and wall decor, mounted on the panels.
  { asset: 'env_cafe_wall_door', pos: [3, 0, -3.95], fit: { axis: 'y', size: 2 } },
  { asset: 'env_cafe_wall_window', pos: [-3.95, 0.75, 0.2], rotY: 90, fit: { axis: 'y', size: 1.25 } },
  { asset: 'env_cafe_wall_window', pos: [-3.95, 0.75, 2.6], rotY: 90, fit: { axis: 'y', size: 1.25 } },
  // Shelf unit: 1.1 m tall so its teal backboard stays below the 2.3 m wall top; its back sits flush on the wall
  // (the model is ~0.41 m deep at this size, centred on its position).
  { asset: 'env_cafe_wall_shelf', pos: [-3.79, 1.0, -2.3], rotY: 90, fit: { axis: 'y', size: 1.1 } },

  // Kitchen line along the back wall.
  { asset: 'prop_kitchen_fridge', pos: [-3.35, 0, -3.5], fit: { axis: 'y', size: 1.55 }, solid: true },
  { asset: 'prop_kitchen_sink', pos: [-2.35, 0, -3.5], fit: { axis: 'y', size: 1.05 }, solid: true },
  { asset: 'prop_kitchen_stove', pos: [-1.2, 0, -3.5], fit: { axis: 'y', size: 0.95 }, solid: true, station: 'stove' },
  { asset: 'prop_kitchen_prep_table', pos: [0, 0, -3.55], fit: { axis: 'y', size: 0.95 }, solid: true, station: 'prep' },
  { asset: 'prop_kitchen_pastry_case', pos: [1.15, 0, -3.5], fit: { axis: 'y', size: 1.15 }, solid: true, station: 'pastry' },

  // Service counter between kitchen and dining room, with the countertop machines.
  { asset: 'prop_counter_bar', pos: [-2.5, 0, -1.6], fit: { axis: 'y', size: 0.82 }, solid: true },
  { asset: 'prop_counter_bar', pos: [-0.55, 0, -1.6], fit: { axis: 'y', size: 0.82 }, solid: true },
  { asset: 'prop_kitchen_coffee_machine', pos: [-3.0, 0.82, -1.6], rotY: 180, fit: { axis: 'y', size: 0.6 }, station: 'coffee' },
  { asset: 'prop_kitchen_blender', pos: [-2.0, 0.82, -1.6], rotY: 180, fit: { axis: 'y', size: 0.55 }, station: 'blender' },
  { asset: 'prop_kitchen_register', pos: [-0.3, 0.82, -1.6], fit: { axis: 'y', size: 0.5 }, station: 'register' },

  // Dining room: three two-seat table sets (the Meshy table model includes its two chairs).
  { asset: 'prop_table_dining', pos: [-2.3, 0, 0.9], fit: { axis: 'y', size: 0.74 }, solid: true },
  { asset: 'prop_table_dining', pos: [-2.3, 0, 2.9], fit: { axis: 'y', size: 0.74 }, solid: true },
  { asset: 'prop_table_dining', pos: [0.7, 0, 1.9], fit: { axis: 'y', size: 0.74 }, solid: true },

  // Decor.
  { asset: 'prop_plant_pot', pos: [2.0, 0, -3.45], fit: { axis: 'y', size: 0.9 }, solid: true },
  { asset: 'prop_plant_pot', pos: [-3.5, 0, 3.75], fit: { axis: 'y', size: 0.8 }, solid: true },
  { asset: 'prop_sign_menu', pos: [3.3, 0, 3.2], rotY: 35, fit: { axis: 'y', size: 0.85 }, solid: true },
  { asset: 'prop_chair_wood', pos: [3.45, 0, 1.6], rotY: -90, fit: { axis: 'y', size: 0.9 }, solid: true },
]

/** Half-extent of the walkable floor. */
export const WALK_HALF = 3.7
export const CHEF_SPAWN: [number, number, number] = [1.5, 0, -0.3]
