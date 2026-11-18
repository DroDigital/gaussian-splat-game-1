// Procedural Tokyo-style back street, built entirely from oriented splats.
// Runs once per level load; per-frame effects are GPU dyno modifiers.

import { PALETTE as C } from "../look";
import type { AnchorKind, LotKind, PresetDef } from "./presets";
import { type Box3, type ColorFn, SplatBuilder, type V3, fbm3, mixc, mulberry32, noise3, shade } from "./splatBuilder";

export interface Seg {
  p0: [number, number];
  d: [number, number];
  n: [number, number];
  len: number;
  w: number;
  s0: number;
}

export interface AnchorPlacement {
  kind: AnchorKind;
  pos: V3;
  yaw: number;
}

export interface Circle {
  x: number;
  z: number;
  r: number;
}

export interface Level {
  name: string;
  presetId: string | null;
  world: SplatBuilder;
  sky: SplatBuilder;
  anchors: AnchorPlacement[];
  /** Walkable polygons in XZ: [x0, z0, x1, z1, ...]. */
  walkable: number[][];
  obstacles: Circle[];
  ground: (x: number, z: number) => number;
  spawn: { x: number; z: number; yaw: number };
  bounds: { min: V3; max: V3 };
  occluders: Box3[];
}

type Lot = { seg: Seg; side: 1 | -1; a0: number; a1: number; kind: LotKind; base: number; wallH?: number; gateA?: number };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export function buildStreet(preset: PresetDef, density: number): Level {
  const lr = mulberry32(preset.seed); // layout RNG: independent of density
  const R = (a: number, b: number) => lerp(a, b, lr());
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(lr() * arr.length) % arr.length];
  const B = new SplatBuilder(preset.seed * 7 + 3, density);

  // ---------------- segments ----------------
  const [L0, L1] = preset.legs;
  const [w0, w1] = preset.widths;
  const t = preset.turn;
  const seg0: Seg = { p0: [0, 0], d: [0, -1], n: [1, 0], len: L0, w: w0, s0: 0 };
  const seg1: Seg = { p0: [0, -L0], d: [t, 0], n: [0, t], len: L1, w: w1, s0: L0 };
  const segs = [seg0, seg1];
  // inner side of seg0 is toward the turn; inner side of seg1 faces back toward the start
  const inner0: 1 | -1 = t > 0 ? 1 : -1;
  const inner1: 1 | -1 = seg1.n[1] > 0 ? 1 : -1;

  const W = (s: Seg, a: number, c: number): [number, number] => [s.p0[0] + s.d[0] * a + s.n[0] * c, s.p0[1] + s.d[1] * a + s.n[1] * c];
  const P = (s: Seg, a: number, c: number, y: number): V3 => {
    const [x, z] = W(s, a, c);
    return [x, y, z];
  };
  const Ud = (s: Seg, k: number): V3 => [s.d[0] * k, 0, s.d[1] * k];
  const Nd = (s: Seg, k: number): V3 => [s.n[0] * k, 0, s.n[1] * k];
  const local = (s: Seg, x: number, z: number) => {
    const dx = x - s.p0[0], dz = z - s.p0[1];
    return { a: dx * s.d[0] + dz * s.d[1], c: dx * s.n[0] + dz * s.n[1] };
  };
  const pathS = (x: number, z: number) => {
    const l0 = local(seg0, x, z), l1 = local(seg1, x, z);
    const d0 = Math.abs(l0.c) + Math.max(0, l0.a - L0) + Math.max(0, -l0.a);
    const d1 = Math.abs(l1.c) + Math.max(0, -l1.a);
    if (d0 <= d1 || l1.a < -w0 / 2) return Math.min(l0.a, L0);
    return L0 + Math.max(0, l1.a);
  };
  const ground = (x: number, z: number) => preset.height(pathS(x, z));
  const roadY = (s: Seg, a: number) => preset.height(s.s0 + Math.max(s === seg0 ? -1e9 : 0, a));
  /** Local AABB -> world AABB box. */
  const lbox = (s: Seg, a0: number, a1: number, c0: number, c1: number, y0: number, y1: number, col: Parameters<SplatBuilder["box"]>[2], opts: Parameters<SplatBuilder["box"]>[3] = {}) => {
    const p = W(s, a0, c0), q = W(s, a1, c1);
    B.box([Math.min(p[0], q[0]), y0, Math.min(p[1], q[1])], [Math.max(p[0], q[0]), y1, Math.max(p[1], q[1])], col, opts);
  };
  const obstacles: Circle[] = [];
  const anchors: AnchorPlacement[] = [];
  const yawFace = (s: Seg, side: number) => Math.atan2(-side * s.n[0], -side * s.n[1]); // object +Z faces the road

  // ---------------- road ----------------
  const manholes: { seg: Seg; a: number; c: number }[] = [];
  for (const s of segs) {
    for (let a = 6 + lr() * 6; a < s.len + 20; a += R(11, 17)) manholes.push({ seg: s, a, c: R(-0.6, 0.6) });
  }
  const roadColor = (s: Seg, aStart: number): ColorFn => (sa, tc, x, _y, z) => {
    const a = aStart + sa;
    const c = tc - s.w / 2;
    const ac = Math.abs(c);
    const hw = s.w / 2;
    // gutter
    if (ac > hw - 0.32) {
      const grate = ((a % 3.2) + 3.2) % 3.2 < 0.55 && ac > hw - 0.28 && ac < hw - 0.04;
      if (grate) return ((a * 22) | 0) % 2 === 0 ? shade(C.manhole, 0.7) : C.manhole;
      return shade(C.gutter, 0.92 + 0.12 * fbm3(x * 0.8, 0, z * 0.8, 2));
    }
    for (const m of manholes) {
      if (m.seg !== s) continue;
      const dd = Math.hypot(a - m.a, c - m.c);
      if (dd < 0.36) {
        if (dd > 0.31) return C.manholeRim;
        const ring = Math.sin(dd * 60) > 0.2;
        const hatch = (Math.floor((a - m.a) * 18) + Math.floor((c - m.c) * 18)) % 2 === 0;
        return shade(C.manhole, ring ? 1.18 : hatch ? 1.06 : 0.9);
      }
    }
    // edge line (worn)
    if (ac > hw - 0.5 && ac < hw - 0.38 && noise3(x * 2.5, 0.5, z * 2.5) > 0.22) return shade(C.roadLine, 0.95 + 0.05 * lr());
    const big = fbm3(x * 0.09, 1.7, z * 0.09, 3);
    let col = mixc(C.asphalt, C.asphaltDark, smooth(0.35, 0.75, big));
    // tyre tracks
    const track = Math.exp(-Math.pow((ac - 0.85) / 0.35, 2));
    col = shade(col, 1 - 0.07 * track);
    // repair patches
    const patch = noise3(Math.floor(x / 2.7) * 3.1, 9.3, Math.floor(z / 3.3) * 2.3);
    if (patch > 0.86) col = mixc(col, C.asphaltPatch, 0.7);
    // cracks
    const cr = Math.abs(noise3(x * 1.4, 3.3, z * 1.4) - 0.5);
    if (cr < 0.012) col = shade(col, 0.72);
    // oil / wet stains
    col = shade(col, 0.94 + 0.12 * noise3(x * 0.6, 7.1, z * 0.6));
    return col;
  };

  /** Build a strip-wise road surface that follows stairs and ramps. */
  function buildRoad(s: Seg, aStart: number, aEnd: number) {
    const col = roadColor(s, aStart);
    const step = preset.stairs ? 0.34 : 2.0;
    for (let a = aStart; a < aEnd - 1e-3; a += step) {
      const a1 = Math.min(aEnd, a + step);
      const h0 = roadY(s, a + 1e-3), h1 = roadY(s, a1 - 1e-3);
      const o = P(s, a, -s.w / 2, h0);
      const U: V3 = [s.d[0] * (a1 - a), h1 - h0, s.d[1] * (a1 - a)];
      const sub: ColorFn = (ss, tt, x, y, z) => col(ss + (a - aStart), tt, x, y, z);
      const stairTread = preset.stairs && Math.abs(h1 - h0) < 1e-4 && roadY(s, a1 + 1e-3) - h1 > 0.05;
      B.rect(o, U, Nd(s, s.w), stairTread ? (ss, tt, x, y, z) => shade(C.stepStone, 0.94 + 0.1 * noise3(x * 3, y, z * 3)) : sub, { spacing: 1 });
      const hn = roadY(s, a1 + 1e-3);
      if (Math.abs(hn - h1) > 0.02) {
        // riser
        B.rect(P(s, a1, -s.w / 2, Math.min(h1, hn)), [0, Math.abs(hn - h1), 0], Nd(s, s.w), (ss, tt) => shade(C.stepStone, 0.8 + 0.05 * Math.sin(tt * 9)), { spacing: 1 });
        // nosing edge
        B.line(P(s, a1, -s.w / 2, Math.max(h1, hn)), P(s, a1, s.w / 2, Math.max(h1, hn)), 0.03, shade(C.stepStone, 1.1));
      }
    }
  }
  // coarse dark underlayer so gaussian tails never let the bright clear colour through
  for (const [s, a0, a1] of [
    [seg0, -20, L0 + w1 / 2],
    [seg1, w0 / 2, L1 + 32],
  ] as const) {
    for (let a = a0; a < a1; a += 2) {
      const e = Math.min(a1, a + 2);
      const y = Math.min(roadY(s, a + 0.01), roadY(s, e - 0.01)) - 0.025;
      B.rect(P(s, a, -s.w / 2 - 0.4, y), Ud(s, e - a), Nd(s, s.w + 0.8), C.asphaltDark, { spacing: 4, size: 1.1, jitter: 0.01 });
    }
  }
  buildRoad(seg0, -20, L0 + w1 / 2);
  buildRoad(seg1, w0 / 2, L1 + 32);

  // stop line + bar near the corner on seg0
  B.rect(P(seg0, L0 - w1 / 2 - 1.6, -w0 / 2 + 0.5, roadY(seg0, L0 - w1 / 2 - 1.6) + 0.01), Ud(seg0, 0.3), Nd(seg0, w0 - 1), shade(C.roadLine, 0.97), { spacing: 0.8 });

  // ---------------- lots ----------------
  const lots: Lot[] = [];
  const mix = Object.entries(preset.lotMix) as [LotKind, number][];
  const totalMix = mix.reduce((a, [, w]) => a + w, 0);
  const randomKind = (): LotKind => {
    let r = lr() * totalMix;
    for (const [k, w] of mix) {
      r -= w;
      if (r <= 0) return k;
    }
    return mix[0][0];
  };
  const forcedKind = (s: Seg, side: number, a0: number, a1: number): LotKind | null => {
    const si = segs.indexOf(s);
    for (const an of preset.anchors) {
      if (an.seg !== si || an.side !== side || an.a < a0 - 0.5 || an.a > a1 + 0.5) continue;
      if (an.kind === "parking") return "parking";
      if (an.kind === "lantern") return "shrine";
      if (an.kind === "cat") return "house";
    }
    return null;
  };
  function layoutSide(s: Seg, side: 1 | -1, aStart: number, aEnd: number) {
    let a = aStart;
    while (a < aEnd - 2.5) {
      let w = R(6.5, 10.5);
      if (aEnd - (a + w) < 4) w = aEnd - a;
      const kind = forcedKind(s, side, a, a + w) ?? randomKind();
      const kw = kind === "shrine" ? Math.min(w, 5) : kind === "parking" ? Math.max(w, 8) : w;
      const mid = a + kw / 2;
      lots.push({ seg: s, side, a0: a, a1: a + kw, kind, base: roadY(s, mid) });
      a += kw + (lr() < 0.5 ? R(0.7, 1.5) : 0.04);
    }
  }
  layoutSide(seg0, inner0, -20, L0 - w1 / 2 - 0.4);
  layoutSide(seg0, -inner0 as 1 | -1, -20, L0 + w1 / 2);
  layoutSide(seg1, inner1, w0 / 2 + 0.4, L1 + 30);
  layoutSide(seg1, -inner1 as 1 | -1, -w0 / 2, L1 + 30);

  const occluders = B.occluders;

  // façade painter
  type Win = { s0: number; s1: number; t0: number; t1: number; kind: "glass" | "frosted" | "curtain" | "shutter" | "door" | "doorMetal" | "shop" };
  const facadeColor = (base: readonly number[], wins: Win[], storeyH: number, siding: boolean, height: number): ColorFn => (s, tt, x, y, z) => {
    for (const w of wins) {
      if (s < w.s0 || s > w.s1 || tt < w.t0 || tt > w.t1) continue;
      const fr = 0.055;
      const edge = s - w.s0 < fr || w.s1 - s < fr || tt - w.t0 < fr || w.t1 - tt < fr;
      if (w.kind === "door") return edge ? C.facadeTrim : shade(C.door, 0.95 + 0.1 * Math.sin(s * 40));
      if (w.kind === "doorMetal") return edge ? C.facadeTrim : shade(C.doorMetal, 0.9 + 0.08 * ((tt * 8) % 1));
      if (w.kind === "shutter") return shade(C.doorMetal, 0.82 + 0.16 * (((tt * 14) % 1) > 0.5 ? 1 : 0));
      if (edge) return C.windowFrame;
      const mullion = Math.abs(s - (w.s0 + w.s1) / 2) < 0.025 && w.kind !== "shop";
      if (mullion) return C.windowFrame;
      const v = (tt - w.t0) / (w.t1 - w.t0);
      if (w.kind === "frosted") return shade(C.windowFrosted, 0.92 + 0.08 * v);
      if (w.kind === "curtain") return v > 0.15 && Math.abs(s - (w.s0 + w.s1) / 2) > (w.s1 - w.s0) * 0.12 ? shade(C.curtain, 0.88 + 0.12 * Math.sin(s * 30)) : C.window;
      // glass: dark with a soft sky reflection gradient
      return mixc(C.window, C.windowSky, smooth(0.3, 1.0, v) * 0.55 + 0.12 * noise3(x * 2, y * 2, z * 2));
    }
    let col: [number, number, number] = [base[0], base[1], base[2]];
    // floor bands
    const fl = ((tt % storeyH) + storeyH) % storeyH;
    if (tt > 0.5 && fl < 0.12 && tt < height - 0.2) col = shade(col, 0.86);
    if (siding && ((tt * 4.2) % 1) < 0.12) col = shade(col, 0.93);
    // rain streaks + grime, darker near the ground, cleaner high up
    const streak = fbm3(x * 0.6 + z * 0.6, y * 0.08, 0.3, 3);
    col = shade(col, 0.9 + 0.12 * streak - 0.1 * smooth(1.0, 0.0, tt));
    col = shade(col, 0.97 + 0.06 * noise3(x * 3.1, y * 3.1, z * 3.1));
    return col;
  };

  function blockWallColor(): ColorFn {
    return (s, tt, x, y, z) => {
      const row = Math.floor(tt / 0.2);
      const off = row % 2 ? 0.2 : 0;
      const bx = ((s + off) % 0.4 + 0.4) % 0.4;
      const by = tt % 0.2;
      if (bx < 0.018 || by < 0.016) return C.blockMortar;
      const k = 0.94 + 0.08 * noise3(Math.floor((s + off) / 0.4) * 1.7, row * 2.3, 0.5) - 0.08 * smooth(0.5, 0, tt);
      return shade(C.blockWall, k * (0.97 + 0.05 * noise3(x * 4, y * 4, z * 4)));
    };
  }

  function foliage(c: V3, radii: V3, amount = 1, droop = 0) {
    const g1 = pick(C.greens), g2 = pick(C.greens);
    B.blob(c, radii, amount * preset.foliage, (d, dy, x, y, z) => mixc(g1, g2, noise3(x * 1.3, y * 1.3, z * 1.3)), { size: 0.06, shell: 0.5, droop });
  }

  function pottedPlant(p: V3) {
    const pc = lr() < 0.6 ? C.pot : C.potBlue;
    const r = R(0.12, 0.2);
    const h = R(0.22, 0.38);
    B.cylinder(p, h, r, pc, { spacing: 0.5 });
    foliage([p[0], p[1] + h + r * 0.9, p[2]], [r * 1.6, r * 1.6 + R(0, 0.25), r * 1.6], 0.8);
  }

  function acUnit(s: Seg, a: number, c: number, y: number) {
    // c is the wall plane; unit protrudes toward the road (-side*n direction handled by caller passing c)
    lbox(s, a - 0.4, a + 0.4, c, c + 0.0001, y, y + 0.58, C.acUnit, { spacing: 0.6 });
  }

  function vendingMachine(s: Seg, a: number, side: 1 | -1, lit: number, withFront = true) {
    const cFront = side * (s.w / 2 - 0.85);
    const cBack = side * (s.w / 2 - 0.05);
    const y0 = roadY(s, a);
    const front: ColorFn = (ss, tt) => {
      const u = ss / 1.0;
      const v = tt / 1.83;
      if (v > 0.42 && v < 0.9 && u > 0.08 && u < 0.92) {
        const row = Math.floor((v - 0.42) / 0.12);
        const colI = Math.floor((u - 0.08) / 0.105);
        const inRow = ((v - 0.42) % 0.12) > 0.03;
        if (inRow) return shade(C.drinks[(row * 3 + colI * 7) % C.drinks.length], 0.8 + 0.2 * lit);
        return shade(C.vendLit, 0.8 + 0.2 * lit);
      }
      if (v > 0.9) return shade(C.signRed, 0.95);
      if (v < 0.25 && u > 0.2 && u < 0.8) return C.vendDark;
      return C.vendBody;
    };
    const [fx, fz] = W(s, a - 0.5, cFront);
    // front face as a rect running along d
    if (withFront) B.rect([fx, y0, fz], Ud(s, 1.0), [0, 1.83, 0], front, { spacing: 0.55 });
    lbox(s, a - 0.5, a + 0.5, cFront + side * 0.01, cBack, y0, y0 + 1.83, C.vendBody, { spacing: 0.9, faces: "XxYZz".replace(faceLetter(s, side), "") });
    // light spill pool on the ground
    const [gx, gz] = W(s, a, cFront - side * 0.6);
    B.puff([gx, y0 + 0.05, gz], [0.9, 0.04, 0.9], [0.95, 0.95, 0.9], 0.25 * lit);
    obstacles.push({ x: W(s, a, (cFront + cBack) / 2)[0], z: W(s, a, (cFront + cBack) / 2)[1], r: 0.62 });
  }

  function buildLot(L: Lot) {
    const { seg: s, side, a0, a1, kind, base } = L;
    const hw = s.w / 2;
    const cCurb = side * hw;
    const cWall = side * (hw + 0.18);
    const wide = a1 - a0;
    // curb (raised concrete strip) along the lot, follows the road
    for (let a = a0; a < a1; a += 2) {
      const e = Math.min(a1, a + 2);
      const y = roadY(s, (a + e) / 2);
      lbox(s, a, e, cCurb, cCurb + side * 0.16, y, y + 0.1, C.curb, { spacing: 0.9, faces: "XxYZz".replace(faceLetter(s, side), "") + faceLetter(s, side) });
    }

    const setback = kind === "apartment" ? R(0.9, 1.5) : kind === "shop" ? 0.35 : kind === "house" ? R(1.6, 2.6) : 1.2;
    const cFront = side * (hw + 0.3 + setback);
    const depth = R(7, 10);
    const cBack = cFront + side * depth;
    const storeyH = kind === "shop" ? 3.2 : 2.9;
    const nSt = kind === "parking" || kind === "shrine" || kind === "garden" ? 0 : clamp(Math.round(R(preset.storeys[0] - 0.4, preset.storeys[1] + 0.4)), preset.storeys[0], preset.storeys[1]) - (kind === "house" ? 0 : 0);
    const storeys = kind === "house" ? Math.min(nSt, 2) : nSt;
    const H = storeys * storeyH;
    const yb = base - 0.6;

    // ground fill between curb and facade (and the whole lot for open kinds)
    const gEnd = storeys ? cFront : cBack;
    B.rect(P(s, a0, cCurb + side * 0.16, base + 0.005), Ud(s, wide), Nd(s, gEnd - cCurb - side * 0.16), (ss, tt, x, y, z) => shade(kind === "parking" ? C.asphalt : C.gutter, 0.88 + 0.14 * fbm3(x * 0.5, 0, z * 0.5, 2)), { spacing: 1.5 });

    // front wall (block wall) with a gate gap
    const hasWall = kind === "house" || kind === "garden" || (kind === "apartment" && lr() < 0.4);
    const gateA = a0 + wide * R(0.25, 0.7);
    if (hasWall) {
      const wh = kind === "garden" ? R(1.6, 2.0) : R(1.15, 1.5);
      L.wallH = wh;
      L.gateA = gateA;
      const bwc = blockWallColor();
      for (let a = a0; a < a1 - 0.01; a += 1.2) {
        const e = Math.min(a1, a + 1.2);
        if (e > gateA - 0.6 && a < gateA + 0.6) {
          // gate posts
          continue;
        }
        const yr = roadY(s, (a + e) / 2);
        const top = Math.max(yr, base) + wh;
        const yBot = yr - 0.1;
        // street-facing face
        B.rect(P(s, a, cWall, yBot), Ud(s, e - a), [0, top - yBot, 0], (ss, tt, x, y, z) => bwc(ss + a - a0, tt, x, y, z), { spacing: 0.9 });
        // cap + back face
        lbox(s, a, e, cWall - side * 0.02, cWall + side * 0.17, top, top + 0.06, C.wallCap, { spacing: 0.9 });
        B.rect(P(s, a, cWall + side * 0.15, base), Ud(s, e - a), [0, top - base, 0], C.blockWall, { spacing: 1.6 });
        occluders.push(boxOf(s, a, e, cWall, cWall + side * 0.15, yBot, top));
      }
      // gate posts
      for (const ga of [gateA - 0.6, gateA + 0.6]) {
        const y = roadY(s, ga);
        lbox(s, ga - 0.12, ga + 0.12, cWall - side * 0.04, cWall + side * 0.2, y, Math.max(y, base) + wh + 0.15, C.wallCap, { spacing: 0.6 });
      }
      // foliage spilling over the wall
      const nF = Math.round(wide / 2.6 * preset.foliage);
      for (let i = 0; i < nF; i++) {
        const a = R(a0 + 0.6, a1 - 0.6);
        if (Math.abs(a - gateA) < 1) continue;
        const top = Math.max(roadY(s, a), base) + wh;
        const [x, z] = W(s, a, cWall + side * 0.45);
        foliage([x, top + R(0.1, 0.6), z], [R(0.7, 1.4), R(0.45, 0.9), R(0.55, 0.9)], 1.0, 0.25);
        if (lr() < 0.55) {
          const [hx, hz] = W(s, a + R(-0.4, 0.4), cWall - side * 0.12);
          foliage([hx, top - R(0.2, 0.5), hz], [R(0.4, 0.8), R(0.45, 0.8), 0.22], 0.8);
        }
      }
    }

    if (kind === "parking") {
      // back wall and wheel stops
      B.rect(P(s, a0, cBack, base), Ud(s, wide), [0, 1.8, 0], blockWallColor(), { spacing: 1.1 });
      for (let a = a0 + 1.4; a < a1 - 1; a += 2.6) {
        lbox(s, a - 0.6, a + 0.6, cBack - side * 1.0, cBack - side * 1.15, base, base + 0.12, C.curb, { spacing: 0.7 });
        // painted bay lines
        B.rect(P(s, a + 1.25, cCurb + side * 1.5, base + 0.01), Ud(s, 0.1), Nd(s, depth - 1.4), C.roadLine, { spacing: 0.6 });
      }
      foliage(P(s, a1 - 0.8, cBack - side * 0.5, base + 2.0), [1.2, 1.0, 0.8], 1);
      return;
    }

    if (kind === "shrine") {
      // stone base, small wooden shrine with red trim, sacred tree
      const cm = cCurb + side * 2.6;
      const am = (a0 + a1) / 2;
      lbox(s, am - 0.8, am + 0.8, cm - side * 0.6, cm + side * 0.6, base, base + 0.5, C.stepStone, { spacing: 0.6 });
      lbox(s, am - 0.55, am + 0.55, cm - side * 0.4, cm + side * 0.4, base + 0.5, base + 1.4, C.lanternWood, { spacing: 0.5 });
      lbox(s, am - 0.75, am + 0.75, cm - side * 0.6, cm + side * 0.6, base + 1.4, base + 1.52, C.roofTile, { spacing: 0.5 });
      lbox(s, am - 0.6, am + 0.6, cm - side * 0.42, cm - side * 0.44, base + 1.25, base + 1.32, C.shrineRed, { spacing: 0.4 });
      foliage(P(s, am, cm + side * 2.2, base + 4.2), [2.4, 2.0, 2.2], 1.3);
      B.cylinder(P(s, am, cm + side * 2.2, base), 3.2, 0.2, C.bark, { spacing: 0.6 });
      B.rect(P(s, a0, cBack, base), Ud(s, wide), [0, 2.2, 0], blockWallColor(), { spacing: 1.2 });
      return;
    }

    if (kind === "garden") {
      for (let i = 0; i < 2 + Math.floor(lr() * 2); i++) {
        const a = R(a0 + 1.5, a1 - 1.5);
        const c = cCurb + side * R(2.2, 5);
        const h = R(3.2, 6);
        B.cylinder(P(s, a, c, base), h * 0.7, R(0.12, 0.22), C.bark, { spacing: 0.6 });
        foliage(P(s, a, c, base + h), [R(1.6, 2.6), R(1.3, 2.0), R(1.6, 2.6)], 1.2);
      }
      // neighbour's side wall behind
      B.rect(P(s, a0, cBack, base), Ud(s, wide), [0, 5.5, 0], facadeColor(pick(C.facades), [], 2.9, false, 5.5), { spacing: 1.4 });
      return;
    }

    // ---------------- building ----------------
    const fcol = pick(C.facades);
    const siding = kind === "house" && lr() < 0.5;
    const wins: Win[] = [];
    const doorS = clamp(gateA - a0, 0.8, wide - 1.8);
    for (let st = 0; st < storeys; st++) {
      const ft = st * storeyH;
      if (st === 0 && kind === "shop") {
        wins.push({ s0: 0.4, s1: wide - 0.4, t0: 0.05, t1: 2.5, kind: lr() < 0.35 ? "shutter" : "shop" });
        continue;
      }
      if (st === 0) wins.push({ s0: doorS - 0.45, s1: doorS + 0.45, t0: 0, t1: 2.0, kind: kind === "apartment" ? "doorMetal" : "door" });
      const n = Math.max(1, Math.floor(wide / 2.7));
      for (let i = 0; i < n; i++) {
        const cx = ((i + 0.5) / n) * wide;
        if (st === 0 && Math.abs(cx - doorS) < 1.3) continue;
        const ww = R(0.9, 1.6);
        const big = kind === "apartment" && st > 0;
        const kindW = lr() < 0.3 ? "frosted" : lr() < 0.35 ? "curtain" : "glass";
        wins.push({ s0: cx - ww / 2, s1: cx + ww / 2, t0: ft + (big ? 0.15 : 0.85), t1: ft + (big ? 2.2 : 2.1), kind: kindW });
      }
    }
    const fc = facadeColor(fcol, wins, storeyH, siding, H);
    // street facade
    B.rect(P(s, a0, cFront, yb), Ud(s, wide), [0, H - yb + base, 0], (ss, tt, x, y, z) => fc(ss, tt - (base - yb), x, y, z), { spacing: 1 });
    // side walls (visible through gaps), lower density
    for (const ae of [a0, a1]) {
      const sideWins: Win[] = [];
      for (let st = 0; st < storeys; st++) if (lr() < 0.6) sideWins.push({ s0: R(1.5, 3), s1: R(3.6, 4.6), t0: st * storeyH + 0.9, t1: st * storeyH + 1.9, kind: "frosted" });
      const sc = facadeColor(shade(fcol, 0.92), sideWins, storeyH, siding, H);
      B.rect(P(s, ae, cFront, yb), Nd(s, cBack - cFront), [0, H - yb + base, 0], (ss, tt, x, y, z) => sc(Math.abs(ss), tt - (base - yb), x, y, z), { spacing: 1.35 });
    }
    occluders.push(boxOf(s, a0, a1, cFront, cBack, yb, base + H));

    // trims, sills, window frames that protrude
    for (const w of wins) {
      if (w.kind === "door" || w.kind === "doorMetal" || w.kind === "shop" || w.kind === "shutter") continue;
      lbox(s, a0 + w.s0 - 0.05, a0 + w.s1 + 0.05, cFront, cFront - side * 0.09, base + w.t0 - 0.06, base + w.t0, C.windowFrame, { spacing: 0.5, faces: "XxYZz" });
    }
    // roof
    const top = base + H;
    if (kind === "house") {
      const ridge = (cFront + cBack) / 2;
      const rh = R(1.3, 1.9);
      const eave = side * 0.45;
      const roofC: ColorFn = (ss, tt) => shade(C.roofTile, (tt % 0.28) < 0.04 ? 0.78 : 0.97 + 0.06 * Math.sin(ss * 21));
      B.rect(P(s, a0 - 0.3, cFront - eave, top - 0.18), Ud(s, wide + 0.6), [s.n[0] * (ridge - cFront + eave), rh + 0.18, s.n[1] * (ridge - cFront + eave)], roofC, { spacing: 1.1 });
      B.rect(P(s, a0 - 0.3, cBack + eave, top - 0.18), Ud(s, wide + 0.6), [s.n[0] * (ridge - cBack - eave), rh + 0.18, s.n[1] * (ridge - cBack - eave)], roofC, { spacing: 1.6 });
      B.line(P(s, a0 - 0.3, ridge, top + rh + 0.03), P(s, a1 + 0.3, ridge, top + rh + 0.03), 0.12, shade(C.roofTile, 0.8));
      // gable triangles on the side walls
      for (const ae of [a0, a1]) {
        for (let k = 0; k < 6; k++) {
          const f = k / 6;
          const hh = rh * (1 - f);
          const half = (ridge - cFront) * (1 - f);
          B.rect(P(s, ae, ridge - half, top + rh * f), Nd(s, 2 * half), [0, hh / 6 + 0.02, 0], shade(fcol, 0.9), { spacing: 1.4 });
        }
      }
    } else {
      lbox(s, a0, a1, cFront, cBack, top, top + 0.02, C.roofFlat, { spacing: 1.6, faces: "Y" });
      lbox(s, a0, a1, cFront - side * 0.05, cFront + side * 0.2, top, top + 0.55, shade(fcol, 0.95), { spacing: 0.9 });
      // rooftop water tank / AC
      if (lr() < 0.6) lbox(s, a0 + 1, a0 + 2.2, cFront + side * 2, cFront + side * 3, top, top + 0.9, C.acUnit, { spacing: 0.8 });
    }
    lbox(s, a0, a1, cFront, cFront - side * 0.12, top - 0.18, top, C.facadeTrim, { spacing: 0.7 });

    // balconies (apartments)
    if (kind === "apartment") {
      const panel = lr() < 0.6;
      for (let st = 1; st < storeys; st++) {
        const y = base + st * storeyH;
        const bd = 0.95;
        lbox(s, a0 + 0.3, a1 - 0.3, cFront, cFront - side * bd, y - 0.12, y, C.balcony, { spacing: 0.8 });
        if (panel) {
          B.rect(P(s, a0 + 0.3, cFront - side * bd, y), Ud(s, wide - 0.6), [0, 1.05, 0], (ss, tt) => shade(C.balcony, tt > 0.95 ? 0.85 : 0.97 + 0.04 * Math.sin(ss * 3)), { spacing: 0.8 });
        } else {
          for (let a = a0 + 0.35; a < a1 - 0.3; a += 0.12) B.line(P(s, a, cFront - side * bd, y), P(s, a, cFront - side * bd, y + 1.0), 0.025, C.railing);
          B.line(P(s, a0 + 0.3, cFront - side * bd, y + 1.02), P(s, a1 - 0.3, cFront - side * bd, y + 1.02), 0.05, C.railing);
        }
        // AC unit on balcony, laundry pole
        acUnit(s, a0 + R(0.9, wide - 1.2), cFront - side * 0.35, y);
        lbox(s, a0 + 0.9, a0 + 1.7, cFront - side * 0.15, cFront - side * 0.45, y, y + 0.58, C.acUnit, { spacing: 0.6 });
        if (lr() < 0.6) {
          const ly = y + 1.7;
          B.line(P(s, a0 + 0.4, cFront - side * 0.75, ly), P(s, a1 - 0.4, cFront - side * 0.75, ly), 0.03, C.railing);
          for (let a = a0 + 0.7; a < a1 - 0.8; a += R(0.5, 0.9)) {
            const cl = pick(C.laundry);
            B.rect(P(s, a, cFront - side * 0.75, ly - R(0.5, 0.8)), Ud(s, R(0.3, 0.55)), [0, 0.6, 0], cl, { spacing: 0.6 });
          }
        }
      }
    }

    // awnings
    const awnN = kind === "shop" ? 1 : lr() < 0.5 ? 1 : 0;
    for (let i = 0; i < awnN; i++) {
      const aw = pick(C.awnings);
      const len = kind === "shop" ? wide - 0.6 : R(1.6, 2.4);
      const as = kind === "shop" ? a0 + 0.3 : a0 + clamp(doorS - len / 2, 0.2, wide - len - 0.2);
      const y = base + (kind === "shop" ? 2.75 : 2.35);
      const out = kind === "shop" ? 1.2 : 0.8;
      const stripe: ColorFn = (ss) => ((ss / 0.32) | 0) % 2 === 0 ? aw : mixc(aw, C.awningStripe, kind === "shop" ? 0.55 : 0);
      B.rect(P(s, as, cFront, y), Ud(s, len), [-s.n[0] * side * out, -0.38, -s.n[1] * side * out], stripe, { spacing: 0.7 });
      B.rect(P(s, as, cFront - side * out, y - 0.38), Ud(s, len), [0, -0.22, 0], stripe, { spacing: 0.7 });
    }
    // vertical shop sign
    if (kind === "shop") {
      const sc = lr() < 0.6 ? C.signYellow : C.signWhite;
      lbox(s, a1 - 0.7, a1 - 0.62, cFront - side * 0.1, cFront - side * 0.75, base + 3.4, base + 3.4 + R(1.6, 2.6), sc, { spacing: 0.5 });
    }
    // potted plants by the door
    for (let i = 0; i < (kind === "house" ? 3 : 2); i++) {
      if (lr() < 0.3) continue;
      const a = a0 + doorS + R(0.7, 1.6) * (lr() < 0.5 ? -1 : 1);
      if (a < a0 + 0.3 || a > a1 - 0.3) continue;
      pottedPlant(P(s, a, cFront - side * 0.35, base));
    }
    // wall-mounted AC unit beside houses
    if (kind === "house" && lr() < 0.7) acUnit(s, a0 + R(0.6, wide - 0.6), cFront - side * 0.35, base + 0.1);
  }

  function boxOf(s: Seg, a0: number, a1: number, c0: number, c1: number, y0: number, y1: number): Box3 {
    const p = W(s, a0, c0), q = W(s, a1, c1);
    return { min: [Math.min(p[0], q[0]), y0, Math.min(p[1], q[1])], max: [Math.max(p[0], q[0]), y1, Math.max(p[1], q[1])] };
  }
  function faceLetter(s: Seg, side: number) {
    // face whose outward normal points from the lot back toward the road (-side*n)
    const nx = -side * s.n[0], nz = -side * s.n[1];
    if (nx > 0.5) return "X";
    if (nx < -0.5) return "x";
    if (nz > 0.5) return "Z";
    return "z";
  }

  for (const L of lots) buildLot(L);

  // ---------------- poles + wires ----------------
  type Pole = { top: V3[]; mid: V3 };
  const poles: Pole[] = [];
  for (const s of segs) {
    const start = s === seg0 ? -14 : w0 / 2 + 6;
    const end = s === seg0 ? L0 - w1 / 2 - 2 : L1 + 26;
    let side = s === seg0 ? -inner0 : -inner1;
    for (let a = start; a < end; a += preset.poles + R(-3, 3)) {
      const c = side * (s.w / 2 - 0.22);
      const y0 = roadY(s, a);
      const [x, z] = W(s, a, c);
      const h = R(8.4, 9.4);
      B.cylinder([x, y0, z], h, 0.17, (ang, hh) => shade(C.pole, 0.95 - 0.06 * smooth(1.5, 0, hh) + 0.04 * Math.sin(hh * 0.8)), { spacing: 0.55 });
      // yellow-black guard sleeve at the bottom
      B.cylinder([x, y0, z], 1.6, 0.185, (ang, hh) => (((hh * 3) | 0) % 2 ? C.signYellow : [0.12, 0.12, 0.12]), { spacing: 0.5 });
      obstacles.push({ x, z, r: 0.35 });
      occluders.push({ min: [x - 0.17, y0, z - 0.17], max: [x + 0.17, y0 + h, z + 0.17] });
      const ya = y0 + h - 0.5;
      const pa = P(s, a, c - side * 0.75, ya), pb = P(s, a, c + side * 0.75, ya);
      B.line(pa, pb, 0.11, shade(C.pole, 0.85));
      const tops: V3[] = [pa, [x, ya + 0.35, z], pb, P(s, a, c, y0 + 6.0), P(s, a, c, y0 + 5.4)];
      if (lr() < 0.55) {
        const [tx, tz] = W(s, a, c + side * 0.42);
        B.cylinder([tx, y0 + 6.5, tz], 1.0, 0.27, C.transformer, { spacing: 0.5, cap: true });
      }
      // drop lines to houses
      for (let k = 0; k < 2; k++) {
        if (lr() < 0.4) continue;
        const da = R(-6, 6);
        B.catenary(P(s, a, c, y0 + 5.6), P(s, a + da, side * (s.w / 2 + R(1.8, 3.2)), y0 + R(4.6, 5.6)), 0.25, 0.02, C.wire);
      }
      poles.push({ top: tops, mid: [x, y0, z] });
      side = -side as 1 | -1;
    }
  }
  for (let i = 0; i + 1 < poles.length; i++) {
    const p = poles[i], q = poles[i + 1];
    const d = Math.hypot(p.mid[0] - q.mid[0], p.mid[2] - q.mid[2]);
    if (d > 45) continue;
    for (let k = 0; k < p.top.length; k++) B.catenary(p.top[k], q.top[k], 0.35 + d * 0.012 + k * 0.08, k > 2 ? 0.035 : 0.022, C.wire);
  }

  // ---------------- signs, mirror ----------------
  {
    // curve mirror at the corner (outer side of seg0)
    const s = seg0;
    const a = L0 + w1 / 2 - 0.4, c = -inner0 * (w0 / 2 - 0.25);
    const y = roadY(s, a);
    const [x, z] = W(s, a, c);
    B.cylinder([x, y, z], 2.6, 0.045, C.mirrorPole, { spacing: 0.4 });
    B.disc([x, y + 2.75, z], [-s.d[0] * 0.7 + inner0 * s.n[0] * 0.7, 0, -s.d[1] * 0.7 + inner0 * s.n[1] * 0.7], 0.4, (rr) => (rr > 0.34 ? C.mirrorPole : mixc(C.mirror, C.sky, rr * 1.5)), { spacing: 0.35 });
    obstacles.push({ x, z, r: 0.25 });
    // stop sign (inverted red triangle) on the inner side before the corner
    const a2 = L0 - w1 / 2 - 1.2, c2 = inner0 * (w0 / 2 - 0.2);
    const y2 = roadY(s, a2);
    const [x2, z2] = W(s, a2, c2);
    B.cylinder([x2, y2, z2], 2.2, 0.035, C.pole, { spacing: 0.4 });
    for (let k = 0; k < 10; k++) {
      const f = k / 10;
      const half = 0.42 * (1 - f);
      const [sx, sz] = W(s, a2, c2);
      const col = f > 0.85 || k === 0 ? C.signWhite : C.signRed;
      B.rect([sx - half * Math.abs(s.n[0]), y2 + 2.6 - f * 0.72, sz - half * Math.abs(s.n[1])], [Math.abs(s.n[0]) * 2 * half, 0, Math.abs(s.n[1]) * 2 * half], [0, 0.075, 0], col, { spacing: 0.3 });
    }
    obstacles.push({ x: x2, z: z2, r: 0.2 });
  }
  // one ordinary (dimmer) vending machine
  {
    const s = seg0;
    const a = clamp(preset.anchors.find((q) => q.kind === "vending" && q.seg === 0)?.a ?? 30, 0, L0) > 30 ? 12 : 48;
    vendingMachine(s, a, -inner0 as 1 | -1, 0.25);
  }

  // ---------------- preset extras ----------------
  if (preset.station) {
    // elevated railway viaduct crossing the end of seg1, and a station front
    const s = seg1;
    const a = L1 - 4;
    const y0 = roadY(s, a);
    const span = s.w / 2 + 14;
    lbox(s, a - 2.6, a + 2.6, -span, span, y0 + 6.2, y0 + 7.6, C.station, { spacing: 0.9 });
    lbox(s, a - 2.7, a + 2.7, -span, span, y0 + 7.6, y0 + 8.7, shade(C.station, 0.9), { spacing: 1.1, faces: "XxZz" });
    for (const c of [-(s.w / 2 + 1.2), s.w / 2 + 1.2]) {
      lbox(s, a - 0.6, a + 0.6, c - 0.6, c + 0.6, y0, y0 + 6.2, shade(C.station, 0.95), { spacing: 0.8, occluder: true });
    }
    // station building beyond
    const ab = L1 + 12;
    const sc: ColorFn = (ss, tt) => (tt > 2.6 && tt < 3.4 ? C.signBlue : tt < 2.6 && ss % 2.2 > 0.15 ? C.stationGlass : C.station);
    B.rect(P(s, ab, -span, y0), Nd(s, 2 * span), [0, 9, 0], sc, { spacing: 1.1 });
    // more poles/wires converge: extra overhead cables across the street
    for (let k = 0; k < 6; k++) {
      const a1 = R(5, L1 - 6);
      B.catenary(P(s, a1, -s.w / 2 - 1, y0 + R(5.5, 7.5)), P(s, a1 + R(-4, 4), s.w / 2 + 1, y0 + R(5.5, 7.5)), 0.6, 0.025, C.wire);
    }
  }
  if (preset.stairs) {
    // handrail down the middle of the stairs + torii at the top
    const s = seg1;
    let prev: V3 | null = null;
    for (let a = 3; a < 20; a += 1.0) {
      const y = roadY(s, a);
      const p = P(s, a, 0, y + 0.9);
      B.line(P(s, a, 0, y), p, 0.04, C.railing);
      if (prev) B.line(prev, p, 0.05, C.railing);
      prev = p;
    }
    obstacles.push(...Array.from({ length: 17 }, (_, i) => {
      const [x, z] = W(s, 3.5 + i, 0);
      return { x, z, r: 0.3 };
    }));
    const at = L1 - 4;
    const y = roadY(s, at);
    for (const c of [-s.w / 2 + 0.4, s.w / 2 - 0.4]) {
      const [x, z] = W(s, at, c);
      B.cylinder([x, y, z], 4.2, 0.17, C.shrineRed, { spacing: 0.5 });
      obstacles.push({ x, z, r: 0.3 });
    }
    lbox(s, at - 0.2, at + 0.2, -s.w / 2 - 0.6, s.w / 2 + 0.6, y + 4.2, y + 4.45, [0.12, 0.12, 0.12], { spacing: 0.5 });
    lbox(s, at - 0.15, at + 0.15, -s.w / 2 - 0.1, s.w / 2 + 0.1, y + 3.5, y + 3.7, C.shrineRed, { spacing: 0.5 });
  }
  // a few trees along the far end so the street blurs into greenery + haze
  for (let i = 0; i < 6; i++) {
    const s = pick(segs);
    const a = R(0, s.len);
    const side = lr() < 0.5 ? 1 : -1;
    foliage(P(s, a, side * (s.w / 2 + R(5, 9)), roadY(s, a) + R(6, 9)), [R(2, 3.5), R(1.6, 2.5), R(2, 3.5)], 0.7);
  }

  // ---------------- anchors (placements; geometry built in game/anchors.ts) ----------------
  for (const an of preset.anchors) {
    const s = segs[an.seg];
    const side = an.side;
    const y = roadY(s, an.a);
    const lot = lots.find((L) => L.seg === s && L.side === side && an.a >= L.a0 && an.a <= L.a1);
    const base = lot?.base ?? y;
    let pos: V3;
    let yaw = yawFace(s, side);
    switch (an.kind) {
      case "cat": {
        // sitting on top of the block wall
        if (lot?.wallH) {
          let a = an.a;
          if (lot.gateA !== undefined && Math.abs(a - lot.gateA) < 1.1) a = lot.gateA + (a < lot.gateA ? -1.3 : 1.3);
          a = clamp(a, lot.a0 + 0.4, lot.a1 - 0.4);
          const wallTop = Math.max(roadY(s, a), base) + lot.wallH;
          pos = P(s, a, side * (s.w / 2 + 0.26), wallTop + 0.06);
        } else pos = P(s, an.a, side * (s.w / 2 - 0.35), y);
        yaw += 0.6;
        break;
      }
      case "vending":
        vendingMachine(s, an.a, side, 0, false); // body; the lit front is the anchor mesh
        pos = P(s, an.a, side * (s.w / 2 - 0.85), y);
        yaw = yawFace(s, side);
        break;
      case "parking":
        pos = P(s, an.a, side * (s.w / 2 - 0.15), y);
        obstacles.push({ x: pos[0], z: pos[2], r: 0.2 });
        break;
      case "bicycle":
        pos = P(s, an.a, side * (s.w / 2 - 0.45), y);
        yaw = Math.atan2(-s.d[1], s.d[0]); // local +X along the road
        obstacles.push({ x: pos[0], z: pos[2], r: 0.55 });
        break;
      case "lantern":
      default:
        pos = P(s, an.a, side * (s.w / 2 + 1.05), base);
        obstacles.push({ x: pos[0], z: pos[2], r: 0.4 });
        break;
    }
    anchors.push({ kind: an.kind, pos, yaw });
  }

  // ---------------- walkable area ----------------
  const m = 0.32;
  const rectPoly = (s: Seg, a0: number, a1: number, c0: number, c1: number) => {
    const p = [W(s, a0, c0), W(s, a1, c0), W(s, a1, c1), W(s, a0, c1)];
    return p.flat();
  };
  const walkable = [
    rectPoly(seg0, -3, L0 + w1 / 2 - m, -w0 / 2 + m, w0 / 2 - m),
    rectPoly(seg1, -w0 / 2 + m, L1 - 1, -w1 / 2 + m, w1 / 2 - m),
  ];

  // ---------------- sky ----------------
  const sky = buildSky(preset.seed, [t * L1 * 0.35, 0, -L0 * 0.6], segs.map((s) => W(s, s.len + 26, 0)));

  // bounds of the walkable street area (+ lots)
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, maxY = 0;
  for (let i = 0; i < B.count; i++) {
    const x = B.pos[i * 3], y = B.pos[i * 3 + 1], z = B.pos[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    if (y > maxY) maxY = y;
  }

  return {
    name: preset.name,
    presetId: preset.id,
    world: B,
    sky,
    anchors,
    walkable,
    obstacles,
    ground,
    spawn: { x: 0, z: -1.5, yaw: 0 },
    bounds: { min: [minX, preset.height(-1) - 1, minZ], max: [maxX, maxY, maxZ] },
    occluders,
  };
}

/** Thousands of very large, low-opacity grey-white splats forming the overcast haze. */
export function buildSky(seed: number, center: V3, farEnds: [number, number][]): SplatBuilder {
  const S = new SplatBuilder(seed + 11, 1, 1 << 13);
  const r = mulberry32(seed + 5);
  const N = 3200;
  for (let i = 0; i < N; i++) {
    const az = r() * Math.PI * 2;
    // concentrate near the horizon
    const el = Math.pow(r(), 1.8) * 1.25 - 0.04;
    const rad = 120 + r() * 70;
    const x = center[0] + Math.cos(az) * Math.cos(el) * rad;
    const z = center[2] + Math.sin(az) * Math.cos(el) * rad;
    const y = Math.sin(el) * rad * 0.55 + 4;
    const sz = 14 + r() * 26;
    const horizon = 1 - Math.min(1, el / 0.6);
    const col = mixc(C.skyTop, C.haze, horizon * 0.8 + r() * 0.2);
    S.puff([x, y, z], [sz, sz * (0.35 + r() * 0.3), sz], col, 0.05 + 0.09 * r() * (0.6 + horizon * 0.4));
  }
  // ground haze swallowing both far ends of the street
  for (const [fx, fz] of farEnds) {
    for (let i = 0; i < 70; i++) {
      const x = fx + (r() - 0.5) * 30, z = fz + (r() - 0.5) * 30;
      const sz = 4 + r() * 8;
      S.puff([x, 1 + r() * 9, z], [sz, sz * 0.6, sz], mixc(C.haze, [1, 1, 1], 0.4), 0.09 + r() * 0.1);
    }
  }
  return S;
}

