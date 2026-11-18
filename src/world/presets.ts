// Level presets. Each one is an L-shaped street (~120 m of walkable path)
// built procedurally by streetGen.ts.

export type AnchorKind = "cat" | "vending" | "parking" | "bicycle" | "lantern";
export type LotKind = "house" | "apartment" | "shop" | "parking" | "garden" | "shrine";

export interface AnchorSlot {
  kind: AnchorKind;
  seg: number;
  /** Distance along the segment (m). */
  a: number;
  /** Which side of the road (+1 / -1). */
  side: 1 | -1;
}

export interface PresetDef {
  id: string;
  name: string;
  blurb: string;
  seed: number;
  /** Lengths of the two legs of the L (m). */
  legs: [number, number];
  /** Road width of each leg (m). */
  widths: [number, number];
  /** +1: second leg turns to +X, -1: to -X. */
  turn: 1 | -1;
  /** Path-distance -> ground height (m). */
  height: (s: number) => number;
  lotMix: Partial<Record<LotKind, number>>;
  storeys: [number, number];
  foliage: number;
  poles: number; // pole spacing (m)
  station?: boolean;
  stairs?: boolean;
  anchors: AnchorSlot[];
}

const flat = () => 0;

/** Hillside: gentle ramp up the first leg, flat landing, then a long stair. */
function hillsideHeight(s: number) {
  const L0 = 62;
  if (s < L0) return Math.max(0, s) * 0.055;
  const base = L0 * 0.055;
  const stairStart = L0 + 6;
  if (s < stairStart) return base;
  const tread = 0.34, rise = 0.15;
  const n = Math.min(Math.floor((s - stairStart) / tread) + 1, 40);
  // landing every 14 steps
  return base + n * rise;
}

export const PRESETS: PresetDef[] = [
  {
    id: "alley",
    name: "Back Alley",
    blurb: "A quiet residential lane. Laundry, potted plants, a cat somewhere.",
    seed: 1701,
    legs: [64, 56],
    widths: [5.2, 4.6],
    turn: 1,
    height: flat,
    lotMix: { house: 5, apartment: 3, garden: 1, parking: 0.6 },
    storeys: [2, 3],
    foliage: 1.0,
    poles: 24,
    anchors: [
      { kind: "cat", seg: 0, a: 21, side: -1 },
      { kind: "vending", seg: 0, a: 44, side: 1 },
      { kind: "parking", seg: 1, a: 14, side: 1 },
      { kind: "bicycle", seg: 1, a: 31, side: -1 },
      { kind: "lantern", seg: 1, a: 47, side: 1 },
    ],
  },
  {
    id: "station",
    name: "Station Approach",
    blurb: "Shops, signs and wires converge on an elevated line.",
    seed: 4242,
    legs: [58, 62],
    widths: [7.2, 6.4],
    turn: -1,
    height: flat,
    lotMix: { shop: 5, apartment: 3, house: 1.5, parking: 0.8 },
    storeys: [2, 4],
    foliage: 0.55,
    poles: 20,
    station: true,
    anchors: [
      { kind: "vending", seg: 0, a: 15, side: 1 },
      { kind: "bicycle", seg: 0, a: 37, side: -1 },
      { kind: "parking", seg: 1, a: 10, side: -1 },
      { kind: "cat", seg: 1, a: 29, side: 1 },
      { kind: "lantern", seg: 1, a: 44, side: -1 },
    ],
  },
  {
    id: "hillside",
    name: "Hillside Steps",
    blurb: "A sloping lane that climbs into a long stair toward a shrine.",
    seed: 9311,
    legs: [64, 52],
    widths: [4.4, 3.6],
    turn: 1,
    height: hillsideHeight,
    lotMix: { house: 5, garden: 2.5, apartment: 1.5 },
    storeys: [2, 3],
    foliage: 1.6,
    poles: 26,
    stairs: true,
    anchors: [
      { kind: "bicycle", seg: 0, a: 17, side: 1 },
      { kind: "cat", seg: 0, a: 39, side: -1 },
      { kind: "vending", seg: 0, a: 55, side: 1 },
      { kind: "parking", seg: 1, a: 6, side: -1 },
      { kind: "lantern", seg: 1, a: 40, side: 1 },
    ],
  },
];

export function presetById(id: string) {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
