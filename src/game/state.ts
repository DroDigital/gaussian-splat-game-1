// Game state: phases, the level timer, decay pressure, vortex progression,
// win/lose, and walkable-area collision.

import { GAZE, LEVEL, VORTEX } from "../look";
import type { Circle } from "../world/streetGen";

export type Phase = "loading" | "title" | "playing" | "paused" | "won" | "lost" | "edit";

export class GameState {
  phase: Phase = "loading";
  /** Seconds since the level started (only advances while playing). */
  time = 0;
  /** Linear vortex progress 0..1 (eased for rendering). */
  vortexRaw = 0;
  vortexPhase = 0;
  /** Seconds since win/lose. */
  endT = 0;
  overall = 1;
  /** Running average of stability for the score. */
  private stabSum = 0;
  private stabN = 0;
  finalTime = 0;
  finalStability = 0;

  reset() {
    this.time = 0;
    this.vortexRaw = 0;
    this.vortexPhase = 0;
    this.endT = 0;
    this.overall = 1;
    this.stabSum = 0;
    this.stabN = 0;
  }

  get timeLeft() {
    return Math.max(0, LEVEL.durationS - this.time);
  }

  /** Unobserved stability decays toward this floor; it collapses over the timer. */
  get floor() {
    const k = Math.min(1, this.time / LEVEL.durationS);
    return GAZE.floorStart * Math.pow(1 - k, GAZE.floorPow);
  }

  /** Decay speeds up as the timer runs. */
  get decayRate() {
    const k = Math.min(1, this.time / LEVEL.durationS);
    return GAZE.decayRate * (1 + 1.6 * k);
  }

  /** Eased vortex amount used by shaders/camera (continuous, no popping). */
  get vortex() {
    const x = this.vortexRaw;
    return x * x * (3 - 2 * x);
  }

  /** Advance timer + vortex. Returns "lost" when the vortex completes. */
  tick(dt: number, overall: number): "lost" | null {
    this.time += dt;
    this.overall = overall;
    this.stabSum += overall * dt;
    this.stabN += dt;
    const trigger = overall < VORTEX.trigger || this.time >= LEVEL.durationS;
    if (trigger) this.vortexRaw = Math.min(1, this.vortexRaw + dt / VORTEX.rampUp);
    else this.vortexRaw = Math.max(0, this.vortexRaw - dt / VORTEX.rampDown);
    this.vortexPhase += dt * VORTEX.spinRate * this.vortex;
    if (this.vortexRaw >= 1) {
      this.finish();
      return "lost";
    }
    return null;
  }

  finish() {
    this.finalTime = this.time;
    this.finalStability = this.stabN > 0 ? this.stabSum / this.stabN : this.overall;
    this.endT = 0;
  }

  get score() {
    return Math.round(this.finalStability * 1000 + Math.max(0, LEVEL.durationS - this.finalTime) * 6);
  }
}

// ---------------- walkable collision ----------------

export function pointInPoly(poly: number[], x: number, z: number) {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], zi = poly[i * 2 + 1], xj = poly[j * 2], zj = poly[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function walkableAt(polys: number[][], obstacles: Circle[], x: number, z: number) {
  if (polys.length && !polys.some((p) => pointInPoly(p, x, z))) return false;
  for (const o of obstacles) if ((x - o.x) ** 2 + (z - o.z) ** 2 < o.r * o.r) return false;
  return true;
}

/** Move with sliding along the walkable boundary. */
export function slide(polys: number[][], obstacles: Circle[], x: number, z: number, nx: number, nz: number) {
  if (walkableAt(polys, obstacles, nx, nz)) return { x: nx, z: nz };
  if (walkableAt(polys, obstacles, nx, z)) return { x: nx, z };
  if (walkableAt(polys, obstacles, x, nz)) return { x, z: nz };
  return { x, z };
}
