// The Backrooms as an infinite grid of 3 m cells whose walls, lights and
// pillars are generated on demand — and REGENERATED whenever nobody is looking.
//
//  * Every wall edge / cell tracks when it was last seen (view cone + grid
//    ray cast for occlusion).
//  * Unseen for > SHIFT.unseenDelay and farther than SHIFT.safeCells: it
//    re-rolls instantly (you'll only notice when you turn back).
//  * Visible but deep in the haze (> SHIFT.farCells): it slowly reforms in
//    view with a dissolve, so the far end of a corridor never holds still.
//  * Nothing within SHIFT.safeCells of the player ever changes, and a
//    connectivity guard re-opens walls (out of view) so you are never sealed in.

import { ACTIVE_R, CELL, GRID_N, SHIFT, WALL_H, WALL_T } from "./config";

export const ET = { Open: 0, Wall: 1, Door: 2, Half: 3, Window: 4, Exit: 5 } as const;
export const RT = { Maze: 0, Hall: 1, Corridor: 2, Dark: 3, Room: 4 } as const;
export const MAT = { Wall: 0, Door: 1, Sign: 2, Pillar: 3 } as const;

// ------------------------------------------------------------------ hashing
function mix32(h: number) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
export function hash(a: number, b: number, c: number, d: number, seed: number) {
  const h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x3c6ef372, 0x165667b1) ^ Math.imul((c | 0) + 7, 0x85ebca6b) ^ Math.imul((d | 0) + 13, 0xc2b2ae35) ^ seed;
  return mix32(h) / 4294967296;
}

interface Shiftable {
  visible: boolean;
  seenAt: number;
  hiddenSince: number;
  armAt: number;
  ver: number;
  dist: number;
}

export interface Edge extends Shiftable {
  key: number;
  cx: number;
  cz: number;
  /** 0: east edge (x = (cx+1)*CELL), 1: south edge (z = (cz+1)*CELL). */
  dir: 0 | 1;
  type: number;
  variant: number;
  /** Time it (re)appeared in view (dissolve-in), or -1e9. */
  fadeIn: number;
}

export interface Cell extends Shiftable {
  key: number;
  cx: number;
  cz: number;
  light: number;
  flick: number;
  phase: number;
  pillar: boolean;
  almond: boolean;
}

interface Region {
  type: number;
  orient: number;
  ver: number;
  seenAt: number;
}

/** Receives one axis-aligned box (metres): bounds, material, dissolve start time, dissolve direction. */
export type BoxEmit = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: number, fadeT: number, fadeDir: number) => void;

export const cellKey = (cx: number, cz: number) => (cx + 0x8000) * 0x10000 + (cz + 0x8000);
export const edgeKey = (cx: number, cz: number, dir: number) => cellKey(cx, cz) * 2 + dir;

const BLOCKS_SIGHT = [false, true, false, false, false, true];
const PASSABLE = [true, false, true, true, false, false];

export interface Camera2D {
  /** Camera position in metres. */
  x: number;
  z: number;
  /** Horizontal forward (unit). */
  fx: number;
  fz: number;
  /** Horizontal half field of view (rad). */
  halfFov: number;
}

export class World {
  readonly seed: number;
  readonly level: number;
  edges = new Map<number, Edge>();
  cells = new Map<number, Cell>();
  regions = new Map<number, Region>();
  /** GPU mirror: per cell RGBA = [E edge | pillar<<4, S edge, light, flick | phase<<2]. */
  grid = new Uint8Array(GRID_N * GRID_N * 4);
  gridDirty = true;
  geomDirty = true;
  ghosts: { b: number[]; until: number }[] = [];
  centerX = Number.NaN;
  centerZ = Number.NaN;
  private rngState: number;
  epoch = 0;
  /** Distance field (cells) from the player through passable edges. */
  flow = new Map<number, number>();
  reach = 0;
  private guardT = 0;
  private regionT = 0;
  exit: Edge | null = null;
  exitDueAt: number;
  exitSeen = false;
  /** Count of hidden re-rolls this frame (audio cue for big shifts). */
  shiftedBehind = 0;
  shiftDir = { x: 0, z: 0 };
  /** Multiplier on unseen delay (sanity makes reality less stable). */
  instability = 1;
  /** Disable mutations (debug). */
  frozen = false;
  totalShifts = 0;
  almondDirty = true;
  /** Game clock (s), set by the loop for debug tooling. */
  clockNow = 0;

  constructor(seed: number, level: number, exitDelay: number, now: number) {
    this.seed = seed >>> 0;
    this.level = level;
    this.rngState = this.seed ^ 0x51ed270b;
    this.exitDueAt = now + exitDelay;
  }

  rand() {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    return mix32(this.rngState) / 4294967296;
  }

  // ------------------------------------------------------------ generation
  region(cx: number, cz: number): Region {
    const rx = Math.floor(cx / 5), rz = Math.floor(cz / 5);
    const k = cellKey(rx, rz);
    let r = this.regions.get(k);
    if (!r) {
      r = { type: 0, orient: 0, ver: this.epoch, seenAt: -1e9 };
      this.rollRegion(rx, rz, r);
      this.regions.set(k, r);
    }
    return r;
  }

  private rollRegion(rx: number, rz: number, r: Region) {
    const h = hash(rx, rz, 901, r.ver, this.seed);
    // deeper levels get darker and more maze-like
    const dark = 0.12 + Math.min(0.25, this.level * 0.06);
    const w = [0.42, 0.14, 0.2, dark, 0.08];
    const sum = w.reduce((a, b) => a + b, 0);
    let x = h * sum;
    let t = 0;
    for (; t < w.length - 1; t++) {
      x -= w[t];
      if (x <= 0) break;
    }
    r.type = t;
    r.orient = hash(rx, rz, 902, r.ver, this.seed) < 0.5 ? 0 : 1;
  }

  private rollEdge(e: Edge) {
    const { cx, cz, dir } = e;
    const a = this.region(cx, cz);
    const b = dir === 0 ? this.region(cx + 1, cz) : this.region(cx, cz + 1);
    const h = hash(cx, cz, dir, e.ver, this.seed);
    e.variant = hash(cx, cz, dir + 10, e.ver, this.seed);
    let pWall = 0.38, pDoor = 0.11, pHalf = 0.05, pWin = 0.025;
    if (a !== b) {
      pWall = 0.5;
      pDoor = 0.26;
      pHalf = 0.04;
      pWin = 0.04;
    } else if (a.type === RT.Hall) {
      pWall = 0.025;
      pDoor = 0.01;
      pHalf = 0.02;
      pWin = 0;
    } else if (a.type === RT.Room) {
      pWall = 0.01;
      pDoor = 0;
      pHalf = 0.01;
      pWin = 0;
    } else if (a.type === RT.Corridor) {
      const parallel = (a.orient === 0 && dir === 1) || (a.orient === 1 && dir === 0);
      if (parallel) {
        pWall = 0.84;
        pDoor = 0.08;
        pHalf = 0.02;
        pWin = 0.02;
      } else {
        pWall = 0.06;
        pDoor = 0.03;
        pHalf = 0.02;
        pWin = 0;
      }
    } else if (a.type === RT.Dark) {
      pWall = 0.42;
      pDoor = 0.12;
    }
    let t: number = ET.Open;
    if (h < pWall) t = ET.Wall;
    else if (h < pWall + pDoor) t = ET.Door;
    else if (h < pWall + pDoor + pHalf) t = ET.Half;
    else if (h < pWall + pDoor + pHalf + pWin) t = ET.Window;
    e.type = t;
  }

  private rollCell(c: Cell) {
    const r = this.region(c.cx, c.cz);
    const h = (s: number) => hash(c.cx, c.cz, 500 + s, c.ver, this.seed);
    const pLight = [0.86, 0.96, 0.8, 0.2, 0.55][r.type];
    const hasLight = h(1) < pLight - Math.min(0.2, this.level * 0.04);
    c.light = hasLight ? 0.8 + 0.2 * h(2) : 0;
    const f = h(3);
    const pFlick = r.type === RT.Dark ? 0.3 : 0.055 + this.level * 0.02;
    c.flick = !hasLight ? 0 : f < pFlick ? 1 : f > 0.985 ? 2 : 0;
    c.phase = Math.floor(h(4) * 63);
    const pPillar = r.type === RT.Hall ? 0.55 : r.type === RT.Room ? 0.12 : 0.025;
    c.pillar = h(5) < pPillar;
    c.almond = h(6) < 0.014;
  }

  private newShift(now: number): Shiftable {
    return { visible: false, seenAt: -1e9, hiddenSince: now, armAt: 0, ver: this.epoch * 7919, dist: 99 };
  }

  /** Keep the world materialised around the player's cell. */
  ensure(pcx: number, pcz: number, now: number) {
    if (pcx === this.centerX && pcz === this.centerZ) return;
    this.centerX = pcx;
    this.centerZ = pcz;
    this.epoch++;
    const R = ACTIVE_R;
    for (let cz = pcz - R - 1; cz <= pcz + R + 1; cz++) {
      for (let cx = pcx - R - 1; cx <= pcx + R + 1; cx++) {
        const ck = cellKey(cx, cz);
        if (!this.cells.has(ck)) {
          const c: Cell = { key: ck, cx, cz, light: 0, flick: 0, phase: 0, pillar: false, almond: false, ...this.newShift(now) };
          this.rollCell(c);
          this.cells.set(ck, c);
        }
        for (const dir of [0, 1] as const) {
          const ek = ck * 2 + dir;
          if (!this.edges.has(ek)) {
            const e: Edge = { key: ek, cx, cz, dir, type: 0, variant: 0, fadeIn: -1e9, ...this.newShift(now) };
            this.rollEdge(e);
            this.edges.set(ek, e);
          }
        }
      }
    }
    const lim = R + 3;
    for (const [k, c] of this.cells) if (Math.abs(c.cx - pcx) > lim || Math.abs(c.cz - pcz) > lim) this.cells.delete(k);
    for (const [k, e] of this.edges) {
      if (Math.abs(e.cx - pcx) > lim || Math.abs(e.cz - pcz) > lim) {
        if (e === this.exit) this.loseExit(now);
        this.edges.delete(k);
      }
    }
    for (const [k] of this.regions) {
      const rx = Math.floor(k / 0x10000) - 0x8000, rz = (k % 0x10000) - 0x8000;
      if (Math.abs(rx * 5 - pcx) > lim + 10 || Math.abs(rz * 5 - pcz) > lim + 10) this.regions.delete(k);
    }
    this.writeAllGrid();
    this.geomDirty = true;
  }

  // ------------------------------------------------------------ grid mirror
  private gi(cx: number, cz: number) {
    return (((cz & (GRID_N - 1)) * GRID_N) + (cx & (GRID_N - 1))) * 4;
  }

  private writeCell(cx: number, cz: number) {
    const c = this.cells.get(cellKey(cx, cz));
    const e = this.edges.get(edgeKey(cx, cz, 0));
    const s = this.edges.get(edgeKey(cx, cz, 1));
    const i = this.gi(cx, cz);
    this.grid[i] = (e ? e.type : ET.Wall) | (c?.pillar ? 16 : 0);
    this.grid[i + 1] = s ? s.type : ET.Wall;
    this.grid[i + 2] = c ? Math.round(c.light * 255) : 0;
    this.grid[i + 3] = c ? (c.flick & 3) | (c.phase << 2) : 0;
    this.gridDirty = true;
  }

  private writeAllGrid() {
    const R = ACTIVE_R + 1;
    for (let cz = this.centerZ - R; cz <= this.centerZ + R; cz++) for (let cx = this.centerX - R; cx <= this.centerX + R; cx++) this.writeCell(cx, cz);
  }

  /** Edge type from the GPU mirror (fast; valid inside the active window). */
  typeAt(cx: number, cz: number, dir: number) {
    return this.grid[this.gi(cx, cz) + dir] & 15;
  }

  passable(cx: number, cz: number, dir: number) {
    return PASSABLE[this.typeAt(cx, cz, dir)];
  }

  // ------------------------------------------------------------ visibility
  /** Grid ray cast in cell units: true when no sight-blocking wall is crossed. */
  los(x0: number, z0: number, x1: number, z1: number) {
    let cx = Math.floor(x0), cz = Math.floor(z0);
    const tx = Math.floor(x1), tz = Math.floor(z1);
    const dx = x1 - x0, dz = z1 - z0;
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const ddx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const ddz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let mx = dx !== 0 ? (sx > 0 ? cx + 1 - x0 : x0 - cx) * ddx : Infinity;
    let mz = dz !== 0 ? (sz > 0 ? cz + 1 - z0 : z0 - cz) * ddz : Infinity;
    for (let i = 0; i < 80; i++) {
      if (cx === tx && cz === tz) return true;
      if (mx < mz) {
        if (mx > 1) return true;
        if (BLOCKS_SIGHT[this.typeAt(sx > 0 ? cx : cx - 1, cz, 0)]) return false;
        cx += sx;
        mx += ddx;
      } else {
        if (mz > 1) return true;
        if (BLOCKS_SIGHT[this.typeAt(cx, sz > 0 ? cz : cz - 1, 1)]) return false;
        cz += sz;
        mz += ddz;
      }
    }
    return true;
  }

  private seesPoint(cam: Camera2D, px: number, pz: number, cosLim: number, x: number, z: number) {
    const vx = x - px, vz = z - pz;
    const d = Math.hypot(vx, vz);
    if (d < 0.55) return true;
    if (d > SHIFT.sightCells) return false;
    const cos = (vx * cam.fx + vz * cam.fz) / d;
    // widen by the angular half-size of the thing being tested
    if (cos < cosLim - 0.35 / d) return false;
    // stop just short of the target so its own edge doesn't occlude it
    const k = 1 - 0.03 / d;
    return this.los(px, pz, px + vx * k, pz + vz * k);
  }

  /** Is a world point (metres) currently visible from the camera? */
  pointVisible(cam: Camera2D, x: number, z: number) {
    const cosLim = Math.cos(Math.min(Math.PI, cam.halfFov + (SHIFT.fovMargin * Math.PI) / 180));
    return this.seesPoint(cam, cam.x / CELL, cam.z / CELL, cosLim, x / CELL, z / CELL);
  }

  // ------------------------------------------------------------ the shifting
  update(now: number, dt: number, cam: Camera2D) {
    const px = cam.x / CELL, pz = cam.z / CELL;
    this.ensure(Math.floor(px), Math.floor(pz), now);
    const cosLim = Math.cos(Math.min(Math.PI, cam.halfFov + (SHIFT.fovMargin * Math.PI) / 180));
    const delay = SHIFT.unseenDelay * this.instability;
    const pHidden = 1 - Math.exp(-SHIFT.rate * dt);
    this.shiftedBehind = 0;
    this.shiftDir.x = 0;
    this.shiftDir.z = 0;

    for (const e of this.edges.values()) {
      let mx: number, mz: number, ax: number, az: number, bx: number, bz: number;
      if (e.dir === 0) {
        mx = ax = bx = e.cx + 1;
        mz = e.cz + 0.5;
        az = e.cz + 0.15;
        bz = e.cz + 0.85;
      } else {
        mz = az = bz = e.cz + 1;
        mx = e.cx + 0.5;
        ax = e.cx + 0.15;
        bx = e.cx + 0.85;
      }
      // distance from player to the edge segment
      const tx = e.dir === 0 ? mx : Math.min(e.cx + 1, Math.max(e.cx, px));
      const tz = e.dir === 0 ? Math.min(e.cz + 1, Math.max(e.cz, pz)) : mz;
      e.dist = Math.hypot(px - tx, pz - tz);
      const vis =
        e.dist < SHIFT.sightCells &&
        (this.seesPoint(cam, px, pz, cosLim, mx, mz) || this.seesPoint(cam, px, pz, cosLim, ax, az) || this.seesPoint(cam, px, pz, cosLim, bx, bz));
      this.track(e, vis, now);
      if (this.frozen || e.dist < SHIFT.safeCells) continue;
      const isExit = e.type === ET.Exit;
      if (!vis) {
        const need = isExit ? SHIFT.exitUnseen : delay;
        if (now - e.hiddenSince > need && now >= e.armAt && this.rand() < pHidden) {
          this.mutateEdge(e, now, false);
          e.armAt = now + SHIFT.reArm[0] + this.rand() * (SHIFT.reArm[1] - SHIFT.reArm[0]);
          if (e.dist < 6) {
            this.shiftedBehind++;
            this.shiftDir.x += mx - px;
            this.shiftDir.z += mz - pz;
          }
        }
      } else if (!isExit && e.dist > SHIFT.farCells && this.rand() < SHIFT.farRate * dt / this.instability) {
        this.mutateEdge(e, now, true);
      }
    }

    for (const c of this.cells.values()) {
      const cxm = c.cx + 0.5, czm = c.cz + 0.5;
      c.dist = Math.hypot(px - cxm, pz - czm);
      const vis = c.dist < SHIFT.sightCells && (this.seesPoint(cam, px, pz, cosLim, cxm, czm) || (c.pillar && this.seesPoint(cam, px, pz, cosLim, c.cx, c.cz)));
      this.track(c, vis, now);
      if (vis) this.region(c.cx, c.cz).seenAt = now;
      if (this.frozen || c.dist < SHIFT.safeCells + 0.6) continue;
      if (!vis && now - c.hiddenSince > delay && now >= c.armAt && this.rand() < pHidden) {
        c.ver++;
        const hadAlmond = c.almond, hadPillar = c.pillar;
        this.rollCell(c);
        c.almond = c.almond || (hadAlmond && this.rand() < 0.5);
        c.armAt = now + SHIFT.reArm[0] + this.rand() * (SHIFT.reArm[1] - SHIFT.reArm[0]);
        this.writeCell(c.cx, c.cz);
        if (c.pillar !== hadPillar) this.geomDirty = true;
        this.almondDirty = true;
        this.totalShifts++;
      }
    }

    // whole regions re-theme when left unseen for a while
    this.regionT -= dt;
    if (this.regionT <= 0 && !this.frozen) {
      this.regionT = 1;
      for (const [k, r] of this.regions) {
        const rx = Math.floor(k / 0x10000) - 0x8000, rz = (k % 0x10000) - 0x8000;
        const inside = px >= rx * 5 - 1 && px < rx * 5 + 6 && pz >= rz * 5 - 1 && pz < rz * 5 + 6;
        if (!inside && now - r.seenAt > SHIFT.regionUnseen * this.instability) {
          r.ver++;
          this.rollRegion(rx, rz, r);
          r.seenAt = now;
        }
      }
    }

    // ghosts (dissolving-out geometry)
    if (this.ghosts.length && this.ghosts.some((g) => g.until < now)) {
      this.ghosts = this.ghosts.filter((g) => g.until >= now);
      this.geomDirty = true;
    }

    // connectivity guard + flow field
    this.guardT -= dt;
    if (this.guardT <= 0) {
      this.guardT = 0.3;
      this.computeFlow(Math.floor(px), Math.floor(pz), 16);
      if (!this.frozen) this.guard(now);
    }
    this.updateExit(now, px, pz);
  }

  private track(s: Shiftable, vis: boolean, now: number) {
    s.visible = vis;
    if (vis) {
      s.seenAt = now;
      s.hiddenSince = -1;
      s.armAt = 0;
    } else if (s.hiddenSince < 0) s.hiddenSince = now;
  }

  mutateEdge(e: Edge, now: number, inView: boolean, forceType?: number) {
    const old = e.type;
    if (inView) {
      const until = now + SHIFT.dissolve;
      this.edgeBoxes(e, (x0, y0, z0, x1, y1, z1, mat) => this.ghosts.push({ b: [x0, y0, z0, x1, y1, z1, mat, now, -1], until }));
    }
    if (forceType !== undefined) {
      e.ver++;
      e.type = forceType;
    } else {
      for (let k = 0; k < 3; k++) {
        e.ver++;
        this.rollEdge(e);
        if (e.type !== old) break;
      }
    }
    if (old === ET.Exit && e.type !== ET.Exit && e === this.exit) this.loseExit(now);
    e.fadeIn = inView ? now : -1e9;
    this.writeCell(e.cx, e.cz);
    this.geomDirty = true;
    this.totalShifts++;
  }

  // ------------------------------------------------------------ graph
  private neighbours(cx: number, cz: number, out: number[]) {
    out.length = 0;
    if (this.passable(cx, cz, 0)) out.push(cx + 1, cz);
    if (this.passable(cx - 1, cz, 0)) out.push(cx - 1, cz);
    if (this.passable(cx, cz, 1)) out.push(cx, cz + 1);
    if (this.passable(cx, cz - 1, 1)) out.push(cx, cz - 1);
    return out;
  }

  private computeFlow(pcx: number, pcz: number, radius: number) {
    const flow = this.flow;
    flow.clear();
    const qx: number[] = [pcx], qz: number[] = [pcz];
    flow.set(cellKey(pcx, pcz), 0);
    const nb: number[] = [];
    for (let h = 0; h < qx.length; h++) {
      const cx = qx[h], cz = qz[h];
      const d = flow.get(cellKey(cx, cz))!;
      this.neighbours(cx, cz, nb);
      for (let i = 0; i < nb.length; i += 2) {
        const nx = nb[i], nz = nb[i + 1];
        if (Math.abs(nx - pcx) > radius || Math.abs(nz - pcz) > radius) continue;
        const k = cellKey(nx, nz);
        if (flow.has(k)) continue;
        flow.set(k, d + 1);
        qx.push(nx);
        qz.push(nz);
      }
    }
    this.reach = 0;
    for (const d of flow.values()) if (d <= 7) this.reach++;
  }

  /** Never let the player be sealed into a pocket: open walls out of view. */
  private guard(now: number) {
    if (this.reach >= SHIFT.minReach) return;
    const cand: Edge[] = [];
    for (const [k, d] of this.flow) {
      if (d > 7) continue;
      const cx = Math.floor(k / 0x10000) - 0x8000, cz = (k % 0x10000) - 0x8000;
      const opts: [number, number, number, number, number][] = [
        [cx, cz, 0, cx + 1, cz],
        [cx - 1, cz, 0, cx - 1, cz],
        [cx, cz, 1, cx, cz + 1],
        [cx, cz - 1, 1, cx, cz - 1],
      ];
      for (const [ex, ez, dir, nx, nz] of opts) {
        if (this.flow.has(cellKey(nx, nz))) continue;
        const e = this.edges.get(edgeKey(ex, ez, dir));
        if (e && e.dist > SHIFT.safeCells && e.type !== ET.Exit && !PASSABLE[e.type]) cand.push(e);
      }
    }
    const hidden = cand.filter((e) => !e.visible);
    const pool = hidden.length ? hidden : cand.filter((e) => e.dist > 2.5);
    for (let i = 0; i < Math.min(3, pool.length); i++) {
      const e = pool[Math.floor(this.rand() * pool.length)];
      this.mutateEdge(e, now, e.visible, this.rand() < 0.6 ? ET.Open : ET.Door);
    }
  }

  // ------------------------------------------------------------ exit
  private loseExit(now: number) {
    this.exit = null;
    this.exitSeen = false;
    this.exitDueAt = Math.max(this.exitDueAt, now + 14);
  }

  private updateExit(now: number, px: number, pz: number) {
    if (this.exit) {
      if (this.exit.visible) this.exitSeen = true;
      return;
    }
    if (now < this.exitDueAt) return;
    // an unseen wall a few cells away that borders a reachable cell
    const cand: Edge[] = [];
    for (const e of this.edges.values()) {
      if (e.type !== ET.Wall || e.visible || e.dist < 4 || e.dist > 9) continue;
      const a = this.flow.get(cellKey(e.cx, e.cz));
      const b = this.flow.get(e.dir === 0 ? cellKey(e.cx + 1, e.cz) : cellKey(e.cx, e.cz + 1));
      if (a === undefined && b === undefined) continue;
      cand.push(e);
    }
    if (!cand.length) {
      this.exitDueAt = now + 2;
      return;
    }
    const e = cand[Math.floor(this.rand() * cand.length)];
    e.ver++;
    e.type = ET.Exit;
    e.fadeIn = -1e9;
    this.exit = e;
    this.exitSeen = false;
    this.writeCell(e.cx, e.cz);
    this.geomDirty = true;
    void px;
    void pz;
  }

  /** World position (metres) of the exit door centre. */
  exitPos(): { x: number; z: number; nx: number; nz: number } | null {
    const e = this.exit;
    if (!e) return null;
    if (e.dir === 0) return { x: (e.cx + 1) * CELL, z: (e.cz + 0.5) * CELL, nx: 1, nz: 0 };
    return { x: (e.cx + 0.5) * CELL, z: (e.cz + 1) * CELL, nx: 0, nz: 1 };
  }

  // ------------------------------------------------------------ geometry
  /** Emit the boxes (metres) for one wall edge. Shared by rendering and collision. */
  edgeBoxes(e: Edge, emit: BoxEmit) {
    const t = WALL_T / 2;
    const H = WALL_H;
    const fadeT = e.fadeIn, fadeDir = e.fadeIn > -1e8 ? 1 : 0;
    const X = (e.cx + 1) * CELL, Z = (e.cz + 1) * CELL;
    const push = (a0: number, a1: number, y0: number, y1: number, mat: number = MAT.Wall, thick = t) => {
      if (a1 - a0 < 1e-3) return;
      if (e.dir === 0) emit(X - thick, y0, a0, X + thick, y1, a1, mat, fadeT, fadeDir);
      else emit(a0, y0, Z - thick, a1, y1, Z + thick, mat, fadeT, fadeDir);
    };
    const s0 = (e.dir === 0 ? e.cz : e.cx) * CELL;
    const s1 = s0 + CELL;
    const mid = s0 + CELL / 2;
    switch (e.type) {
      case ET.Wall:
        push(s0 - t, s1 + t, 0, H);
        break;
      case ET.Door: {
        const c = mid + (e.variant - 0.5) * 0.9, w = 1.1, h = 2.15;
        push(s0 - t, c - w / 2, 0, H);
        push(c + w / 2, s1 + t, 0, H);
        push(c - w / 2, c + w / 2, h, H);
        break;
      }
      case ET.Half:
        if (e.variant < 0.5) push(s0 - t, s0 + CELL * 0.55, 0, H);
        else push(s1 - CELL * 0.55, s1 + t, 0, H);
        break;
      case ET.Window: {
        const w = 1.5;
        push(s0 - t, s1 + t, 0, 0.95);
        push(s0 - t, s1 + t, 2.05, H);
        push(s0 - t, mid - w / 2, 0.95, 2.05);
        push(mid + w / 2, s1 + t, 0.95, 2.05);
        break;
      }
      case ET.Exit: {
        const w = 1.0, h = 2.1;
        push(s0 - t, mid - w / 2, 0, H);
        push(mid + w / 2, s1 + t, 0, H);
        push(mid - w / 2, mid + w / 2, h, H);
        push(mid - w / 2, mid + w / 2, 0, h, MAT.Door, 0.035);
        // illuminated EXIT signs on both faces
        if (e.dir === 0) {
          emit(X + t, 2.2, mid - 0.32, X + t + 0.06, 2.44, mid + 0.32, MAT.Sign, fadeT, fadeDir);
          emit(X - t - 0.06, 2.2, mid - 0.32, X - t, 2.44, mid + 0.32, MAT.Sign, fadeT, fadeDir);
        } else {
          emit(mid - 0.32, 2.2, Z + t, mid + 0.32, 2.44, Z + t + 0.06, MAT.Sign, fadeT, fadeDir);
          emit(mid - 0.32, 2.2, Z - t - 0.06, mid + 0.32, 2.44, Z - t, MAT.Sign, fadeT, fadeDir);
        }
        break;
      }
      default:
        break;
    }
  }

  pillarBox(c: Cell, emit: BoxEmit) {
    if (!c.pillar) return;
    const x = c.cx * CELL, z = c.cz * CELL, r = 0.26;
    emit(x - r, 0, z - r, x + r, WALL_H, z + r, MAT.Pillar, -1e9, 0);
  }

  /** Emit every renderable box (walls, pillars, dissolving ghosts). No allocation. */
  emitAll(emit: BoxEmit) {
    for (const e of this.edges.values()) if (e.type !== ET.Open) this.edgeBoxes(e, emit);
    for (const c of this.cells.values()) this.pillarBox(c, emit);
    for (const g of this.ghosts) {
      const b = g.b;
      emit(b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8]);
    }
  }

  private colBuf = new Float32Array(6 * 256);
  private colN = 0;
  private colEmit: BoxEmit = (x0, y0, z0, x1, y1, z1, mat) => {
    if (y0 > 1.7 || mat === MAT.Sign || this.colN >= 256) return;
    const o = this.colN++ * 6;
    this.colBuf[o] = x0;
    this.colBuf[o + 1] = z0;
    this.colBuf[o + 2] = x1;
    this.colBuf[o + 3] = z1;
    void y1;
  };

  /** Push a circle (metres) out of nearby walls and pillars. */
  collide(x: number, z: number, r: number): { x: number; z: number } {
    const pcx = Math.floor(x / CELL), pcz = Math.floor(z / CELL);
    this.colN = 0;
    for (let cz = pcz - 2; cz <= pcz + 1; cz++) {
      for (let cx = pcx - 2; cx <= pcx + 1; cx++) {
        for (let dir = 0; dir < 2; dir++) {
          const e = this.edges.get(edgeKey(cx, cz, dir));
          if (e && e.type !== ET.Open) this.edgeBoxes(e, this.colEmit);
        }
      }
    }
    for (let cz = pcz - 1; cz <= pcz + 2; cz++) for (let cx = pcx - 1; cx <= pcx + 2; cx++) {
      const c = this.cells.get(cellKey(cx, cz));
      if (c) this.pillarBox(c, this.colEmit);
    }
    const B = this.colBuf;
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < this.colN; i++) {
        const o = i * 6;
        const bx0 = B[o], bz0 = B[o + 1], bx1 = B[o + 2], bz1 = B[o + 3];
        const qx = Math.max(bx0, Math.min(x, bx1));
        const qz = Math.max(bz0, Math.min(z, bz1));
        const dx = x - qx, dz = z - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          x = qx + (dx / d) * r;
          z = qz + (dz / d) * r;
        } else {
          // centre inside the box: push out along the shallowest axis
          const p0 = x - bx0, p1 = bx1 - x, p2 = z - bz0, p3 = bz1 - z;
          const m = Math.min(p0, p1, p2, p3);
          if (m === p0) x = bx0 - r;
          else if (m === p1) x = bx1 + r;
          else if (m === p2) z = bz0 - r;
          else z = bz1 + r;
        }
      }
    }
    return { x, z };
  }

  /** Light level 0..1 around a point (CPU mirror of the shader's 3x3 lights). */
  lightAround(x: number, z: number, t: number) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let s = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const c = this.cells.get(cellKey(cx + dx, cz + dz));
      if (!c || c.light <= 0) continue;
      const w = dx === 0 && dz === 0 ? 0.45 : dx === 0 || dz === 0 ? 0.1 : 0.0375;
      s += w * c.light * flicker(c.flick, c.phase / 63, t, cx + dx, cz + dz);
    }
    return Math.min(1, s);
  }
}

// ------------------------------------------------------------ flicker (CPU mirror of the GLSL)
function hash11(n: number) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise1(x: number) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash11(i) * (1 - u) + hash11(i + 1) * u;
}
export function flicker(cls: number, phase: number, t: number, cx: number, cz: number) {
  if (cls === 0) return 1;
  const p = phase * 31 + cx * 0.37 + cz * 0.71;
  if (cls === 1) {
    const n = vnoise1(t * 6.5 + p);
    const n2 = vnoise1(t * 29 + p * 3.1);
    return n > 0.34 ? 0.86 + 0.14 * n2 : 0.04 + 0.22 * n2;
  }
  const b = vnoise1(t * 1.6 + p);
  const s = (t * 13 + p) % 1 > 0.45 ? 1 : 0;
  return b > 0.6 ? s * 0.95 : 0;
}
