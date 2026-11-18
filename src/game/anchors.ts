// The five ANCHORS: small, slightly brighter objects hidden in the street.
// Looking at one for GAZE.lockSeconds locks it and permanently stabilises a
// bubble around it (handled by the stability field).

import * as THREE from "three";
import { GAZE, PALETTE as C } from "../look";
import type { AnchorKind } from "../world/presets";
import { type Box3, SplatBuilder, type V3, mixc, shade } from "../world/splatBuilder";

export const ANCHOR_INFO: Record<AnchorKind, { label: string; height: number; radius: number }> = {
  cat: { label: "cat", height: 0.32, radius: 0.35 },
  vending: { label: "lit vending machine", height: 1.83, radius: 0.9 },
  parking: { label: "parking sign", height: 2.3, radius: 0.5 },
  bicycle: { label: "bicycle", height: 1.0, radius: 0.8 },
  lantern: { label: "shrine lantern", height: 1.35, radius: 0.5 },
};

const boost = (c: readonly number[]) => shade(c, C.anchorBoost);

/** Anchor geometry in local space: origin at the base, +Z faces the street. */
export function buildAnchorSplats(kind: AnchorKind, density: number, seed = 1): SplatBuilder {
  const B = new SplatBuilder(seed * 31 + kind.length, Math.max(density, 0.8) * 1.6, 1 << 15);
  switch (kind) {
    case "cat": {
      const fur = (d: number, dy: number, x: number, y: number, z: number) => {
        const stripe = Math.sin((x * 0.6 + y * 1.0) * 55) > 0.35;
        if (z > 0.05 && y < 0.2 && Math.abs(x) < 0.05) return boost(C.catWhite);
        return boost(stripe ? shade(C.cat, 0.78) : C.cat);
      };
      B.blob([0, 0.11, -0.02], [0.1, 0.11, 0.15], 3, fur, { size: 0.018, shell: 0.75 });
      B.blob([0, 0.25, 0.08], [0.075, 0.068, 0.07], 3, fur, { size: 0.015, shell: 0.75 });
      for (const sx of [-1, 1]) {
        B.blob([sx * 0.045, 0.32, 0.08], [0.018, 0.03, 0.012], 4, boost(shade(C.cat, 0.9)), { size: 0.01 });
        B.blob([sx * 0.028, 0.26, 0.145], [0.008, 0.008, 0.004], 6, [0.32, 0.5, 0.18], { size: 0.006 });
        B.blob([sx * 0.05, 0.03, 0.1], [0.025, 0.03, 0.03], 3, boost(C.catWhite), { size: 0.012 });
      }
      // tail curling round the side
      let prev: V3 = [0.04, 0.03, -0.15];
      for (let i = 1; i <= 10; i++) {
        const a = (i / 10) * Math.PI * 0.9;
        const p: V3 = [0.04 + Math.sin(a) * 0.14, 0.03, -0.15 + (1 - Math.cos(a)) * 0.12];
        B.line(prev, p, 0.035, boost(i % 3 ? C.cat : shade(C.cat, 0.75)), { spacing: 0.15 });
        prev = p;
      }
      break;
    }
    case "vending": {
      const front = (s: number, t: number) => {
        const u = s, v = t / 1.83;
        if (v > 0.42 && v < 0.9 && u > 0.08 && u < 0.92) {
          const row = Math.floor((v - 0.42) / 0.12);
          const col = Math.floor((u - 0.08) / 0.105);
          if ((v - 0.42) % 0.12 > 0.03) return C.drinks[(row * 5 + col * 3) % C.drinks.length].map((x) => Math.min(1, x * 1.15)) as unknown as [number, number, number];
          return C.vendLit;
        }
        if (v > 0.9) return boost(C.signBlue);
        if (v < 0.25 && u > 0.2 && u < 0.8) return C.vendDark;
        if (u > 0.72 && u < 0.84 && v > 0.3 && v < 0.4) return [0.2, 0.9, 0.4] as [number, number, number];
        return C.vendLit;
      };
      B.rect([-0.5, 0, 0.012], [1, 0, 0], [0, 1.83, 0], front, { spacing: 0.5 });
      // glow: soft light hanging in front of the panel
      for (let i = 0; i < 14; i++) B.puff([(B.rand() - 0.5) * 0.8, 0.9 + (B.rand() - 0.5) * 0.9, 0.2 + B.rand() * 0.25], [0.35, 0.35, 0.12], [1, 1, 0.97], 0.05);
      B.puff([0, 0.03, 0.6], [0.9, 0.03, 0.6], [0.98, 0.98, 0.95], 0.25);
      break;
    }
    case "parking": {
      B.cylinder([0, 0, 0], 2.35, 0.03, boost(C.pole), { spacing: 0.3 });
      const sign = (s: number, t: number) => {
        const u = s / 0.6, v = t / 0.6;
        const edge = u < 0.06 || u > 0.94 || v < 0.06 || v > 0.94;
        if (edge) return C.signWhite;
        // white "P"
        const stem = u > 0.3 && u < 0.42 && v > 0.18 && v < 0.82;
        const dx = u - 0.48, dy = v - 0.64;
        const r = Math.hypot(dx * 1.1, dy);
        const bowl = u > 0.36 && r > 0.1 && r < 0.2 && (dx > -0.05);
        if (stem || bowl) return C.signWhite;
        return boost(C.signBlue);
      };
      B.rect([-0.3, 1.75, 0.04], [0.6, 0, 0], [0, 0.6, 0], sign, { spacing: 0.25 });
      B.rect([-0.3, 1.75, 0.035], [0.6, 0, 0], [0, 0.6, 0], C.pole, { spacing: 0.6 });
      B.rect([-0.25, 1.5, 0.04], [0.5, 0, 0], [0, 0.2, 0], (s, t) => (t > 0.06 && t < 0.14 && s > 0.05 && s < 0.45 && Math.sin(s * 90) > 0 ? C.signRed : C.signWhite), { spacing: 0.25 });
      break;
    }
    case "bicycle": {
      const frame = boost(C.signBlue);
      const metal = boost([0.75, 0.76, 0.78]);
      const tyre = [0.08, 0.08, 0.09];
      const wheel = (cx: number) => {
        for (let i = 0; i < 36; i++) {
          const a0 = (i / 36) * Math.PI * 2, a1 = ((i + 1) / 36) * Math.PI * 2;
          B.line([cx + Math.cos(a0) * 0.33, 0.34 + Math.sin(a0) * 0.33, 0], [cx + Math.cos(a1) * 0.33, 0.34 + Math.sin(a1) * 0.33, 0], 0.045, tyre, { spacing: 0.15 });
        }
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          B.line([cx, 0.34, 0], [cx + Math.cos(a) * 0.3, 0.34 + Math.sin(a) * 0.3, 0], 0.006, metal, { spacing: 0.15 });
        }
      };
      wheel(-0.52);
      wheel(0.52);
      const bb: V3 = [-0.02, 0.32, 0], seat: V3 = [-0.18, 0.82, 0], head: V3 = [0.36, 0.78, 0];
      B.line([-0.52, 0.34, 0], bb, 0.03, frame, { spacing: 0.2 });
      B.line([-0.52, 0.34, 0], seat, 0.03, frame, { spacing: 0.2 });
      B.line(bb, seat, 0.035, frame, { spacing: 0.2 });
      B.line(bb, head, 0.04, frame, { spacing: 0.2 }); // step-through frame
      B.line(head, [0.52, 0.34, 0], 0.03, metal, { spacing: 0.2 });
      B.line(head, [0.32, 1.0, 0], 0.03, metal, { spacing: 0.2 });
      B.line([0.3, 1.0, -0.28], [0.3, 1.0, 0.28], 0.025, metal, { spacing: 0.2 });
      B.blob([-0.2, 0.86, 0], [0.12, 0.03, 0.07], 4, [0.12, 0.1, 0.09], { size: 0.02 });
      // front basket
      B.box([0.42, 0.78, -0.17], [0.72, 1.02, 0.17], metal, { spacing: 0.35, faces: "XxZzy", opacity: 0.85 });
      // mudguards + chain guard
      B.line([-0.7, 0.55, 0], [-0.3, 0.7, 0], 0.05, metal, { spacing: 0.2 });
      B.line([-0.5, 0.36, 0.05], [0.0, 0.33, 0.05], 0.07, frame, { spacing: 0.2 });
      break;
    }
    case "lantern": {
      const stone = boost([0.68, 0.67, 0.63]);
      B.box([-0.28, 0, -0.28], [0.28, 0.15, 0.28], stone, { spacing: 0.4 });
      B.cylinder([0, 0.15, 0], 0.55, 0.08, stone, { spacing: 0.4 });
      B.box([-0.2, 0.7, -0.2], [0.2, 0.78, 0.2], stone, { spacing: 0.35 });
      // firebox with warm lit windows
      const fire = (s: number, t: number) => {
        const lit = s > 0.07 && s < 0.25 && t > 0.06 && t < 0.24;
        return lit ? ([1, 0.86, 0.55] as [number, number, number]) : stone;
      };
      B.rect([-0.16, 0.78, 0.16], [0.32, 0, 0], [0, 0.3, 0], fire, { spacing: 0.25 });
      B.rect([0.16, 0.78, -0.16], [-0.32, 0, 0], [0, 0.3, 0], fire, { spacing: 0.25 });
      B.rect([-0.16, 0.78, -0.16], [0, 0, 0.32], [0, 0.3, 0], fire, { spacing: 0.25 });
      B.rect([0.16, 0.78, 0.16], [0, 0, -0.32], [0, 0.3, 0], fire, { spacing: 0.25 });
      B.puff([0, 0.93, 0], [0.12, 0.12, 0.12], [1, 0.85, 0.55], 0.85);
      for (let i = 0; i < 8; i++) B.puff([(B.rand() - 0.5) * 0.4, 0.93 + (B.rand() - 0.5) * 0.3, (B.rand() - 0.5) * 0.4], [0.22, 0.22, 0.22], [1, 0.9, 0.7], 0.06);
      // roof (stepped pyramid) + finial
      for (let k = 0; k < 5; k++) {
        const h = 0.34 - k * 0.07;
        B.box([-h, 1.08 + k * 0.045, -h], [h, 1.12 + k * 0.045, h], shade(stone, 0.92), { spacing: 0.35, faces: "XxYyZz" });
      }
      B.blob([0, 1.36, 0], [0.05, 0.07, 0.05], 5, stone, { size: 0.015 });
      // red-and-white paper charm
      B.rect([-0.06, 0.3, 0.085], [0.12, 0, 0], [0, 0.22, 0], (s, t) => (t > 0.15 ? mixc(C.shrineRed, [1, 1, 1], 0.1) : C.signWhite), { spacing: 0.2 });
      break;
    }
  }
  return B;
}

export interface AnchorState {
  kind: AnchorKind;
  base: THREE.Vector3;
  center: THREE.Vector3;
  radius: number;
  spotted: boolean;
  locked: boolean;
  lockedAt: number;
}

const tmpDir = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();

function rayHitsBox(o: THREE.Vector3, d: THREE.Vector3, maxT: number, b: Box3) {
  let t0 = 0, t1 = maxT;
  for (let k = 0; k < 3; k++) {
    const ok = k === 0 ? o.x : k === 1 ? o.y : o.z;
    const dk = k === 0 ? d.x : k === 1 ? d.y : d.z;
    const inv = 1 / (dk || 1e-9);
    let ta = (b.min[k] - ok) * inv, tb = (b.max[k] - ok) * inv;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

export class AnchorSystem {
  items: AnchorState[] = [];
  aimed = -1;
  progress = 0;
  occluders: Box3[] = [];

  reset(list: { kind: AnchorKind; pos: V3 }[], occluders: Box3[]) {
    this.occluders = occluders;
    this.items = list.map((a) => {
      const info = ANCHOR_INFO[a.kind];
      const base = new THREE.Vector3(...a.pos);
      return { kind: a.kind, base, center: base.clone().add(new THREE.Vector3(0, info.height * 0.5, 0)), radius: info.radius, spotted: false, locked: false, lockedAt: 0 };
    });
    this.aimed = -1;
    this.progress = 0;
  }

  get lockedCount() {
    return this.items.filter((a) => a.locked).length;
  }

  visible(eye: THREE.Vector3, target: THREE.Vector3) {
    tmpDir.subVectors(target, eye);
    const dist = tmpDir.length();
    tmpDir.divideScalar(dist);
    for (const b of this.occluders) {
      // ignore boxes that contain the target itself (e.g. the wall a cat sits on)
      if (target.x >= b.min[0] - 0.3 && target.x <= b.max[0] + 0.3 && target.z >= b.min[2] - 0.3 && target.z <= b.max[2] + 0.3 && target.y >= b.min[1] && target.y <= b.max[1] + 0.6) continue;
      if (rayHitsBox(eye, tmpDir, dist - 0.4, b)) return false;
    }
    return true;
  }

  /** Returns the index of an anchor that was locked this frame, or -1. */
  update(dt: number, camera: THREE.Camera, time: number): number {
    const eye = camera.getWorldPosition(new THREE.Vector3());
    camera.getWorldDirection(tmpFwd);
    let best = -1;
    let bestAng = Infinity;
    for (let i = 0; i < this.items.length; i++) {
      const a = this.items[i];
      const dir = tmpDir.subVectors(a.center, eye);
      const dist = dir.length();
      const ang = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(dir.dot(tmpFwd) / dist, -1, 1)));
      const angular = THREE.MathUtils.radToDeg(Math.atan2(a.radius, dist));
      if (!a.spotted && dist < GAZE.spotRangeM && ang < GAZE.spotAngleDeg && this.visible(eye, a.center)) a.spotted = true;
      if (a.locked) continue;
      if (dist < GAZE.lockRangeM && ang < Math.max(GAZE.lockAngleDeg, angular) && ang < bestAng && this.visible(eye, a.center)) {
        best = i;
        bestAng = ang;
      }
    }
    if (best !== this.aimed) {
      this.aimed = best;
      this.progress = Math.max(0, this.progress - 0.3);
      if (best < 0) this.progress = 0;
    }
    if (best >= 0) {
      this.progress += dt / GAZE.lockSeconds;
      if (this.progress >= 1) {
        const a = this.items[best];
        a.locked = true;
        a.spotted = true;
        a.lockedAt = time;
        this.progress = 0;
        this.aimed = -1;
        return best;
      }
    }
    return -1;
  }
}
