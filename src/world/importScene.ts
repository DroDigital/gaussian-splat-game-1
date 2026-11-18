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

/**
 * Find the ground: RANSAC over dominant planes in the sample; the ground is the
 * large plane with (nearly) every other point on one side of it, i.e. the
 * lowest dense layer. Robust to arbitrary up axes and tilted captures.
 */
function findGround(p: Float32Array, flip: boolean) {
  const n = p.length / 3;
  const rnd = mulberry32(11);
  // working subsample
  const m = Math.min(n, 30000);
  const S = new Float32Array(m * 3);
  for (let i = 0; i < m; i++) {
    const k = Math.floor(rnd() * n);
    S[i * 3] = p[k * 3];
    S[i * 3 + 1] = p[k * 3 + 1];
    S[i * 3 + 2] = p[k * 3 + 2];
  }
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m; i++)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], S[i * 3 + k]);
      hi[k] = Math.max(hi[k], S[i * 3 + k]);
    }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const thr = diag * 0.006;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3();
  let best = { score: -1, normal: new THREE.Vector3(0, 1, 0), d: 0 };
  const ITER = 700;
  for (let it = 0; it < ITER; it++) {
    const i0 = Math.floor(rnd() * m), i1 = Math.floor(rnd() * m), i2 = Math.floor(rnd() * m);
    a.fromArray(S, i0 * 3);
    b.fromArray(S, i1 * 3);
    c.fromArray(S, i2 * 3);
    nrm.subVectors(b, a).cross(c.sub(a));
    if (nrm.lengthSq() < 1e-14) continue;
    nrm.normalize();
    const d = nrm.dot(a);
    let inl = 0, pos = 0, neg = 0;
    for (let i = 0; i < m; i += 2) {
      const e = nrm.x * S[i * 3] + nrm.y * S[i * 3 + 1] + nrm.z * S[i * 3 + 2] - d;
      if (Math.abs(e) < thr) inl++;
      else if (e > 0) pos++;
      else neg++;
    }
    const side = Math.max(pos, neg) / Math.max(1, pos + neg);
    const score = inl * Math.pow(side, 6);
    if (score > best.score) best = { score, normal: (pos >= neg ? nrm.clone() : nrm.clone().negate()), d: pos >= neg ? d : -d };
  }
  // least-squares refine on inliers (PCA: smallest-variance direction)
  const up = best.normal;
  const inl: number[] = [];
  for (let i = 0; i < m; i++) {
    const e = up.x * S[i * 3] + up.y * S[i * 3 + 1] + up.z * S[i * 3 + 2] - best.d;
    if (Math.abs(e) < thr * 1.5) inl.push(i);
  }
  if (inl.length > 50) {
    const mean = new THREE.Vector3();
    for (const i of inl) mean.add(a.fromArray(S, i * 3));
    mean.divideScalar(inl.length);
    const cov = new THREE.Matrix3();
    const e = cov.elements;
    for (const i of inl) {
      const x = S[i * 3] - mean.x, y = S[i * 3 + 1] - mean.y, z = S[i * 3 + 2] - mean.z;
      e[0] += x * x; e[1] += x * y; e[2] += x * z; e[4] += y * y; e[5] += y * z; e[8] += z * z;
    }
    e[3] = e[1]; e[6] = e[2]; e[7] = e[5];
    // inverse iteration for the smallest eigenvector, seeded with the RANSAC normal
    const reg = new THREE.Matrix3().copy(cov);
    const tr = (e[0] + e[4] + e[8]) * 1e-6 + 1e-12;
    reg.elements[0] += tr; reg.elements[4] += tr; reg.elements[8] += tr;
    const inv = reg.clone().invert();
    const v = up.clone();
    for (let k = 0; k < 12; k++) v.applyMatrix3(inv).normalize();
    if (v.dot(up) < 0) v.negate();
    if (v.dot(up) > 0.95) up.copy(v);
    best.d = up.dot(mean);
  }
  if (flip) {
    up.negate();
    best.d = -best.d;
  }
  return { up, d: best.d };
}

export function autoLevel(raw: Float32Array, flip = false) {
  const p = trim(raw);
  const g = findGround(p, flip);
  const q = new THREE.Quaternion().setFromUnitVectors(g.up, new THREE.Vector3(0, 1, 0));
  // heights above ground for metric-scale heuristics
  const n = p.length / 3;
  const hs = new Float32Array(n);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) hs[i] = v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).dot(g.up) - g.d;
  hs.sort();
  const h95 = hs[Math.floor(n * 0.95)] || 1;
  // Polycam/Luma exports are metric; COLMAP-based ones (Postshot) are often not.
  const scale = h95 > 2.5 && h95 < 45 ? 1 : 8 / Math.max(1e-3, h95);
  // ground offset in the rotated frame: rotated y of a ground point == d
  return { quat: q, groundD: g.d, scale };
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
