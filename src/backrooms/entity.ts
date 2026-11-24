// The thing that follows you. It only moves while it is NOT being observed
// (on screen with a clear line of sight). Watching it holds it in place but
// drains your sanity; looking away lets it come. It paths along the world's
// flow field through real openings, and if the shifting maze cuts it off it
// simply re-appears somewhere you aren't looking.

import type { SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import { CELL, GAME } from "./config";
import { ET, type World, cellKey, edgeKey } from "./world";

const tmp = new THREE.Vector3();

export class Entity {
  active = false;
  x = 0;
  z = 0;
  observed = false;
  everSeen = false;
  dist = 99;
  private lostT = 0;
  private lastObserved = false;

  constructor(
    public mesh: SplatMesh,
    public spawnAt: number,
  ) {}

  reset(spawnAt: number) {
    this.active = false;
    this.mesh.visible = false;
    this.spawnAt = spawnAt;
    this.everSeen = false;
    this.observed = false;
    this.lostT = 0;
  }

  /** Spawn on a reachable cell that is out of view. */
  private relocate(world: World, minD: number, maxD: number) {
    const cand: number[] = [];
    for (const [k, d] of world.flow) {
      if (d < minD || d > maxD) continue;
      const c = world.cells.get(k);
      if (!c || c.visible) continue;
      cand.push(k);
    }
    if (!cand.length) return false;
    const k = cand[Math.floor(Math.random() * cand.length)];
    const cx = Math.floor(k / 0x10000) - 0x8000, cz = (k % 0x10000) - 0x8000;
    this.x = (cx + 0.5) * CELL;
    this.z = (cz + 0.5) * CELL;
    return true;
  }

  private isObserved(camera: THREE.Camera, world: World, camX: number, camZ: number) {
    if (this.dist > 34) return false;
    let onScreen = false;
    for (const y of [0.3, 1.2, 2.1]) {
      tmp.set(this.x, y, this.z).project(camera);
      if (tmp.z < 1 && tmp.z > -1 && Math.abs(tmp.x) < 1.02 && Math.abs(tmp.y) < 1.02) {
        onScreen = true;
        break;
      }
    }
    if (!onScreen) return false;
    return world.los(camX / CELL, camZ / CELL, this.x / CELL, this.z / CELL);
  }

  /** Opening point (metres) on the edge between two adjacent cells. */
  private portal(world: World, cx: number, cz: number, nx: number, nz: number) {
    const dir = nx !== cx ? 0 : 1;
    const ex = dir === 0 ? Math.min(cx, nx) : cx;
    const ez = dir === 1 ? Math.min(cz, nz) : cz;
    const e = world.edges.get(edgeKey(ex, ez, dir));
    let along = 0.5 * CELL;
    if (e && e.type === ET.Door) along = 0.5 * CELL + (e.variant - 0.5) * 0.9;
    if (e && e.type === ET.Half) along = e.variant < 0.5 ? CELL * 0.8 : CELL * 0.2;
    if (dir === 0) return { x: (ex + 1) * CELL, z: ez * CELL + along };
    return { x: ex * CELL + along, z: (ez + 1) * CELL };
  }

  /** Returns "kill" when it reaches you, "spotted" the first time you see it. */
  update(now: number, dt: number, world: World, px: number, pz: number, camera: THREE.Camera, speedMul: number): "kill" | "spotted" | null {
    if (!this.active) {
      if (now < this.spawnAt) return null;
      if (!this.relocate(world, 8, 12) && !this.relocate(world, 5, 15)) return null;
      this.active = true;
      this.mesh.visible = true;
    }
    this.dist = Math.hypot(this.x - px, this.z - pz);
    this.observed = this.isObserved(camera, world, px, pz);
    let event: "spotted" | null = null;
    if (this.observed && !this.lastObserved && (!this.everSeen || this.dist < 9)) event = "spotted";
    if (this.observed) this.everSeen = true;
    this.lastObserved = this.observed;

    if (this.dist < GAME.entityKill) return "kill";

    if (!this.observed) {
      const cx = Math.floor(this.x / CELL), cz = Math.floor(this.z / CELL);
      const d = world.flow.get(cellKey(cx, cz));
      let tx = px, tz = pz;
      if (d === undefined) {
        this.lostT += dt;
        if (this.lostT > 2.2) {
          this.relocate(world, 7, 11);
          this.lostT = 0;
        }
        return event;
      }
      this.lostT = 0;
      if (d > 1) {
        const opts: [number, number, boolean][] = [
          [cx + 1, cz, world.passable(cx, cz, 0)],
          [cx - 1, cz, world.passable(cx - 1, cz, 0)],
          [cx, cz + 1, world.passable(cx, cz, 1)],
          [cx, cz - 1, world.passable(cx, cz - 1, 1)],
        ];
        for (const [nx, nz, ok] of opts) {
          if (!ok || world.flow.get(cellKey(nx, nz)) !== d - 1) continue;
          const p = this.portal(world, cx, cz, nx, nz);
          // aim slightly past the opening so we actually cross it
          tx = p.x + (nx - cx) * 0.6;
          tz = p.z + (nz - cz) * 0.6;
          break;
        }
      }
      const v = GAME.entitySpeed * speedMul * (this.dist < 7 ? 1.35 : 1);
      const dx = tx - this.x, dz = tz - this.z;
      const l = Math.hypot(dx, dz);
      if (l > 1e-3) {
        const step = Math.min(l, v * dt);
        this.x += (dx / l) * step;
        this.z += (dz / l) * step;
      }
    }
    this.mesh.position.set(this.x, 0, this.z);
    this.mesh.rotation.y = Math.atan2(px - this.x, pz - this.z);
    return event;
  }
}
