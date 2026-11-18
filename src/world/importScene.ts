// Import a captured splat scene (.spz .ply .splat .ksplat .sog from Polycam,
// Postshot, Luma, …). On import: auto-level the ground by fitting a plane to
// the lowest dense layer, scale to metres, and centre it. The player then draws
// the walkable area on the minimap and places the 5 anchors.
// The CPU pass over splat centres here is a one-time load step.

import { SplatMesh, utils } from "@sparkjsdev/spark";
import * as THREE from "three";
import { mulberry32 } from "./splatBuilder";

export interface ImportedScene {
  mesh: SplatMesh;
  name: string;
  /** Transformed sample of centres (world space), xyz triplets. */
  sample: Float32Array;
  sampleCount: number;
  min: THREE.Vector3;
  max: THREE.Vector3;
  /** Default walkable rectangle (XZ polygon). */
  defaultWalkable: number[];
  /** Raw (untransformed) sample, so we can re-level after a flip/scale. */
  raw: Float32Array;
  levelQuat: THREE.Quaternion;
  scale: number;
}

const MAX_SAMPLE = 200_000;

function sampleCenters(mesh: SplatMesh): Float32Array {
  const ps = mesh.packedSplats;
  const n = mesh.numSplats || ps?.numSplats || 0;
  const step = Math.max(1, Math.floor(n / MAX_SAMPLE));
  const out: number[] = [];
  if (ps?.packedArray && ps.numSplats > 0) {
    const a = ps.packedArray;
    for (let i = 0; i < ps.numSplats; i += step) {
      const op = (a[i * 4] >>> 24) / 255;
      if (op < 0.25) continue;
      const w1 = a[i * 4 + 1], w2 = a[i * 4 + 2];
      out.push(utils.fromHalf(w1 & 0xffff), utils.fromHalf(w1 >>> 16), utils.fromHalf(w2 & 0xffff));
    }
  } else {
    let k = 0;
    mesh.forEachSplat((_i, c, _s, _q, o) => {
      if (k++ % step === 0 && o >= 0.25) out.push(c.x, c.y, c.z);
    });
  }
  return new Float32Array(out);
}

/** Trim far floaters: keep points within the 97th percentile distance of the median. */
function trim(p: Float32Array) {
  const n = p.length / 3;
  const med = [0, 1, 2].map((k) => {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = p[i * 3 + k];
    v.sort();
    return v[n >> 1];
  });
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.hypot(p[i * 3] - med[0], p[i * 3 + 1] - med[1], p[i * 3 + 2] - med[2]);
  const ds = Float32Array.from(d).sort();
  const lim = ds[Math.floor(n * 0.97)] || Infinity;
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (d[i] <= lim) out.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  return new Float32Array(out);
}

/** How ground-like the lowest dense layer is along `up`. Returns score and ground height. */
function groundScore(p: Float32Array, up: THREE.Vector3) {
  const n = p.length / 3;
  const h = new Float32Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = p[i * 3] * up.x + p[i * 3 + 1] * up.y + p[i * 3 + 2] * up.z;
    h[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const BINS = 120;
  const hist = new Uint32Array(BINS);
  const range = hi - lo || 1;
  for (let i = 0; i < n; i++) hist[Math.min(BINS - 1, Math.floor(((h[i] - lo) / range) * BINS))]++;
  let max = 0;
  for (const c of hist) max = Math.max(max, c);
  // lowest dense layer: first bin from the bottom with >= 35% of the max bin
  let gb = 0;
  while (gb < BINS - 1 && hist[gb] < max * 0.35) gb++;
  // refine to the local peak above it
  while (gb < BINS - 1 && hist[gb + 1] > hist[gb]) gb++;
  const peak = hist[gb] + (hist[gb - 1] ?? 0) + (hist[gb + 1] ?? 0);
  let above = 0;
  for (let b = gb + 2; b < BINS; b++) above += hist[b];
  const lowness = 1 - gb / BINS;
  const score = (peak / n) * (above / n) * lowness * lowness;
  return { score, ground: lo + ((gb + 0.5) / BINS) * range, range };
}

/** Least-squares plane through points near the ground layer, with RANSAC. */
function fitGround(p: Float32Array, up: THREE.Vector3, ground: number, slab: number) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < p.length / 3; i++) {
    const v = new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    if (Math.abs(v.dot(up) - ground) < slab) pts.push(v);
  }
  if (pts.length < 30) return { normal: up.clone(), d: ground };
  const rnd = mulberry32(7);
  let best = { normal: up.clone(), d: ground, inl: 0 };
  const thr = slab * 0.35;
  for (let it = 0; it < 220; it++) {
    const a = pts[Math.floor(rnd() * pts.length)], b = pts[Math.floor(rnd() * pts.length)], c = pts[Math.floor(rnd() * pts.length)];
    const nrm = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (nrm.lengthSq() < 1e-12) continue;
    nrm.normalize();
    if (nrm.dot(up) < 0) nrm.negate();
    if (nrm.dot(up) < 0.8) continue; // stay close to the coarse up axis
    const d = nrm.dot(a);
    let inl = 0;
    for (let k = 0; k < pts.length; k += 3) if (Math.abs(nrm.dot(pts[k]) - d) < thr) inl++;
    if (inl > best.inl) best = { normal: nrm, d, inl };
  }
  return best;
}

export function autoLevel(raw: Float32Array, flip = false) {
  const p = trim(raw);
  // candidate up axes: ±X, ±Y, ±Z
  const cands = [
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
  ];
  let best = { up: cands[0], s: groundScore(p, cands[0]) };
  for (const u of cands.slice(1)) {
    const s = groundScore(p, u);
    if (s.score > best.s.score) best = { up: u, s };
  }
  let up = best.up.clone();
  if (flip) up.negate();
  const gs = flip ? groundScore(p, up) : best.s;
  const fit = fitGround(p, up, gs.ground, gs.range * 0.03);
  up = fit.normal.clone();
  const q = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
  // heights above ground for metric-scale heuristics
  const n = p.length / 3;
  const hs = new Float32Array(n);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) hs[i] = v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).dot(up) - fit.d;
  hs.sort();
  const h95 = hs[Math.floor(n * 0.95)] || 1;
  // Polycam/Luma exports are metric; COLMAP-based ones (Postshot) are often not.
  const scale = h95 > 2.5 && h95 < 45 ? 1 : 8 / Math.max(1e-3, h95);
  return { quat: q, groundD: fit.d, scale };
}

function transformSample(raw: Float32Array, quat: THREE.Quaternion, groundD: number, scale: number) {
  const n = raw.length / 3;
  const out = new Float32Array(raw.length);
  const v = new THREE.Vector3();
  const xs: number[] = [], zs: number[] = [];
  for (let i = 0; i < n; i++) {
    v.set(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]).applyQuaternion(quat);
    out[i * 3] = v.x * scale;
    out[i * 3 + 1] = (v.y - groundD) * scale;
    out[i * 3 + 2] = v.z * scale;
    if (i % 7 === 0) {
      xs.push(out[i * 3]);
      zs.push(out[i * 3 + 2]);
    }
  }
  xs.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const cx = xs[xs.length >> 1] ?? 0, cz = zs[zs.length >> 1] ?? 0;
  for (let i = 0; i < n; i++) {
    out[i * 3] -= cx;
    out[i * 3 + 2] -= cz;
  }
  return { out, cx, cz };
}

export async function importSplatFile(file: File, onProgress?: (s: string) => void): Promise<ImportedScene> {
  onProgress?.(`reading ${file.name}…`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  onProgress?.(`decoding ${(bytes.length / 1e6).toFixed(1)} MB…`);
  const mesh = new SplatMesh({ fileBytes: bytes, fileName: file.name, raycastable: true });
  await mesh.initialized;
  onProgress?.("levelling ground…");
  const raw = sampleCenters(mesh);
  if (raw.length < 300) throw new Error("scene has too few splats");
  const scene: ImportedScene = {
    mesh,
    name: file.name.replace(/\.[^.]+$/, ""),
    sample: raw,
    sampleCount: raw.length / 3,
    min: new THREE.Vector3(),
    max: new THREE.Vector3(),
    defaultWalkable: [],
    raw,
    levelQuat: new THREE.Quaternion(),
    scale: 1,
  };
  relevel(scene, false, 1);
  return scene;
}

/** (Re)compute the levelling transform; `flip` inverts the detected up axis. */
export function relevel(scene: ImportedScene, flip: boolean, scaleMul: number) {
  const lv = autoLevel(scene.raw, flip);
  const scale = lv.scale * scaleMul;
  const { out, cx, cz } = transformSample(scene.raw, lv.quat, lv.groundD, scale);
  scene.levelQuat.copy(lv.quat);
  scene.scale = scale;
  scene.sample = out;
  const m = scene.mesh;
  m.quaternion.copy(lv.quat);
  m.scale.setScalar(scale);
  // world = (R * p) * s - (0, groundD*s, 0) - (cx, 0, cz)
  m.position.set(-cx, -lv.groundD * scale, -cz);
  m.updateMatrixWorld(true);
  // robust bounds (2..98th percentile)
  const n = out.length / 3;
  const axis = (k: number) => {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = out[i * 3 + k];
    v.sort();
    return [v[Math.floor(n * 0.02)], v[Math.floor(n * 0.98)]];
  };
  const [x0, x1] = axis(0), [y0, y1] = axis(1), [z0, z1] = axis(2);
  scene.min.set(x0, Math.min(y0, -0.5), z0);
  scene.max.set(x1, y1, z1);
  const sx = (x1 - x0) * 0.3, sz = (z1 - z0) * 0.3;
  scene.defaultWalkable = [x0 + sx, z0 + sz, x1 - sx, z0 + sz, x1 - sx, z1 - sz, x0 + sx, z1 - sz];
}
