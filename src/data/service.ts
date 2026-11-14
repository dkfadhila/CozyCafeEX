// Seats and walking routes for customers. Coordinates are [x, y, z] in metres.
// Routes are fixed waypoint chains through the aisles, so customers cannot get stuck on furniture.

type P = [number, number, number]

export interface SeatDef {
  /** Where the customer sits (on the chair). */
  pos: P
  /** Facing while seated, degrees (0 = +Z, 90 = +X). */
  yaw: number
  /** Waypoints from the hub to the spot beside the chair (the last one, where the customer stands to sit and after standing up). */
  approach: P[]
  /** Where the chef serves and cleans from. */
  table: P
}

/** Outside spawn point -> through the door -> hub in the main aisle. */
export const ENTRY_ROUTE: P[] = [
  [3, -0.32, -8.2],
  [3, -0.32, -4.9],
  [3, 0, -4.0],
  [3, 0, -0.35],
]

const AISLE_Z = -0.35
// Measured on the table model at its 0.74 m fit (tools/verify_seating.mjs): the free cushion between the
// backrest and the front edge is centred 0.375-0.38 m from the table centre, its top is 0.411 m high.
// CafeGame re-measures the real geometry at runtime; these values are the fallback and feed audio and food placement.
const CHAIR_OFFSET = 0.378 // chair centre from table centre, along X
const SEAT_Y = 0.41
/** Customers stand this far beside the chair (towards the aisle, along -Z) before sitting down. */
const SIDE_STEP = 0.42

function tableSeats(tx: number, tz: number, westLaneX: number, eastLaneX: number): SeatDef[] {
  return [
    {
      pos: [tx - CHAIR_OFFSET, SEAT_Y, tz],
      yaw: 90,
      approach: [
        [westLaneX, 0, AISLE_Z],
        [westLaneX, 0, tz - SIDE_STEP],
        [tx - CHAIR_OFFSET, 0, tz - SIDE_STEP],
      ],
      table: [tx, 0, tz],
    },
    {
      pos: [tx + CHAIR_OFFSET, SEAT_Y, tz],
      yaw: -90,
      approach: [
        [eastLaneX, 0, AISLE_Z],
        [eastLaneX, 0, tz - SIDE_STEP],
        [tx + CHAIR_OFFSET, 0, tz - SIDE_STEP],
      ],
      table: [tx, 0, tz],
    },
  ]
}

// Must match the three prop_table_dining placements in cafeLayout.ts.
export const SEATS: SeatDef[] = [
  ...tableSeats(-2.3, 0.9, -3.25, -1.35),
  ...tableSeats(-2.3, 2.9, -3.25, -1.35),
  ...tableSeats(0.7, 1.9, -0.25, 1.65),
]

export const DAY = {
  customers: 6,
  firstArrival: 2,
  arrivalGap: 7,
  orderDelay: 2,
  eatTime: 7,
  payTime: 1.2,
}
