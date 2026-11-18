// Procedural splat construction helpers. Everything is written into flat typed
// arrays once at level-build time; per-frame effects never touch these arrays
// (they run on the GPU through Spark dyno modifiers).

export type V3 = [number, number, number];
export type ColorFn = (s: number, t: number, x: number, y: number, z: number) => readonly [number, number, number];
export type ColorArg = readonly [number, number, number] | ColorFn;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- tiny value noise (for surface grime, colour variation) ----------
function hash3(x: number, y: number, z: number) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t: number) => t * t * (3 - 2 * t);
export function noise3(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
  return l(l(l(c000, c100, xf), l(c010, c110, xf), yf), l(l(c001, c101, xf), l(c011, c111, xf), yf), zf);
}
export function fbm3(x: number, y: number, z: number, oct = 3) {
  let a = 0.5, f = 1, s = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise3(x * f, y * f, z * f);
    f *= 2.03;
    a *= 0.5;
  }
  return s / (1 - Math.pow(0.5, oct));
}

export const shade = (c: readonly number[], k: number): [number, number, number] => [
  Math.min(1, Math.max(0, c[0] * k)),
  Math.min(1, Math.max(0, c[1] * k)),
  Math.min(1, Math.max(0, c[2] * k)),
];
export const mixc = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// ---------- vector helpers ----------
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const scl = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Quaternion (x,y,z,w) from an orthonormal basis whose columns are u, v, n. */
export function quatFromBasis(u: V3, v: V3, n: V3): [number, number, number, number] {
  const m00 = u[0], m10 = u[1], m20 = u[2];
  const m01 = v[0], m11 = v[1], m21 = v[2];
  const m02 = n[0], m12 = n[1], m22 = n[2];
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return [x, y, z, w];
}

function randomQuat(r: () => number): [number, number, number, number] {
  const u1 = r(), u2 = r() * Math.PI * 2, u3 = r() * Math.PI * 2;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

export interface RectOpts {
  /** Spacing multiplier relative to the builder base spacing. */
  spacing?: number;
  thickness?: number;
  opacity?: number;
  /** In-plane splat size relative to spacing. */
  size?: number;
  /** Random colour jitter (+-). */
  jitter?: number;
}

export interface Box3 {
  min: V3;
  max: V3;
}

export class SplatBuilder {
  count = 0;
  capacity: number;
  pos: Float32Array;
  scale: Float32Array;
  quat: Float32Array;
  rgba: Float32Array;
  rand: () => number;
  /** Base spacing (m) for surfaces at density 1. */
  baseSpacing: number;
  /** Axis-aligned occluders (buildings, walls) used for gaze line-of-sight. */
  occluders: Box3[] = [];

  constructor(seed: number, density = 1, capacity = 1 << 20) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.scale = new Float32Array(capacity * 3);
    this.quat = new Float32Array(capacity * 4);
    this.rgba = new Float32Array(capacity * 4);
    this.rand = mulberry32(seed);
    this.baseSpacing = 0.085 / Math.sqrt(density);
  }

  private grow() {
    const cap = this.capacity * 2;
    const g = (a: Float32Array, k: number) => {
      const n = new Float32Array(cap * k);
      n.set(a);
      return n;
    };
    this.pos = g(this.pos, 3);
    this.scale = g(this.scale, 3);
    this.quat = g(this.quat, 4);
    this.rgba = g(this.rgba, 4);
    this.capacity = cap;
  }

  push(x: number, y: number, z: number, sx: number, sy: number, sz: number, q: readonly number[], r: number, g: number, b: number, a: number) {
    if (this.count >= this.capacity) this.grow();
    const i = this.count++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.scale[i * 3] = sx;
    this.scale[i * 3 + 1] = sy;
    this.scale[i * 3 + 2] = sz;
    this.quat[i * 4] = q[0];
    this.quat[i * 4 + 1] = q[1];
    this.quat[i * 4 + 2] = q[2];
    this.quat[i * 4 + 3] = q[3];
    this.rgba[i * 4] = r;
    this.rgba[i * 4 + 1] = g;
    this.rgba[i * 4 + 2] = b;
    this.rgba[i * 4 + 3] = a;
  }

  /**
   * Flat rectangle o + s*U + t*V (s,t in [0,1]). Splats are flattened along the
   * normal U x V so surfaces read as solid.
   */
  rect(o: V3, U: V3, V: V3, color: ColorArg, opts: RectOpts = {}) {
    const lu = len(U), lv = len(V);
    if (lu < 1e-4 || lv < 1e-4) return;
    const u = scl(U, 1 / lu), v = scl(V, 1 / lv);
    const n = norm(cross(u, v));
    const vv = cross(n, u); // re-orthogonalise
    const q = quatFromBasis(u, vv, n);
    const sp = this.baseSpacing * (opts.spacing ?? 1);
    const nu = Math.max(1, Math.round(lu / sp));
    const nv = Math.max(1, Math.round(lv / sp));
    const du = lu / nu, dv = lv / nv;
    const sz = opts.size ?? 0.62;
    const th = opts.thickness ?? 0.006;
    const op = opts.opacity ?? 1;
    const jit = opts.jitter ?? 0.025;
    const r = this.rand;
    const fn = typeof color === "function" ? (color as ColorFn) : null;
    const cc = fn ? null : (color as readonly number[]);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const s = (i + 0.5 + (r() - 0.5) * 0.7) * du;
        const t = (j + 0.5 + (r() - 0.5) * 0.7) * dv;
        const x = o[0] + u[0] * s + v[0] * t;
        const y = o[1] + u[1] * s + v[1] * t;
        const z = o[2] + u[2] * s + v[2] * t;
        const c = fn ? fn(s, t, x, y, z) : cc!;
        const k = 1 + (r() - 0.5) * 2 * jit;
        const e = 0.85 + r() * 0.3;
        this.push(x, y, z, du * sz * e, dv * sz * (1.7 - e), th, q, c[0] * k, c[1] * k, c[2] * k, op);
      }
    }
  }

  /** Axis-aligned box made of flattened face splats. faces: +x -x +y -y +z -z */
  box(min: V3, max: V3, color: ColorArg | ((face: number) => ColorArg), opts: RectOpts & { faces?: string; occluder?: boolean } = {}) {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const f = opts.faces ?? "XxYyZz";
    const col = (face: number): ColorArg =>
      typeof color === "function" && color.length === 1 ? (color as (f: number) => ColorArg)(face) : (color as ColorArg);
    if (f.includes("X")) this.rect([x1, y0, z1], [0, 0, z0 - z1], [0, y1 - y0, 0], col(0), opts);
    if (f.includes("x")) this.rect([x0, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], col(1), opts);
    if (f.includes("Y")) this.rect([x0, y1, z1], [x1 - x0, 0, 0], [0, 0, z0 - z1], col(2), opts);
    if (f.includes("y")) this.rect([x0, y0, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], col(3), opts);
    if (f.includes("Z")) this.rect([x0, y0, z1], [x1 - x0, 0, 0], [0, y1 - y0, 0], col(4), opts);
    if (f.includes("z")) this.rect([x1, y0, z0], [x0 - x1, 0, 0], [0, y1 - y0, 0], col(5), opts);
    if (opts.occluder) this.occluders.push({ min: [x0, y0, z0], max: [x1, y1, z1] });
  }

  /** Vertical cylinder (open), splats tangent to the surface. */
  cylinder(base: V3, height: number, radius: number, color: ColorArg, opts: RectOpts & { cap?: boolean } = {}) {
    const sp = this.baseSpacing * (opts.spacing ?? 1);
    const na = Math.max(6, Math.round((2 * Math.PI * radius) / sp));
    const nh = Math.max(1, Math.round(height / sp));
    const dh = height / nh, da = (2 * Math.PI * radius) / na;
    const r = this.rand;
    const fn = typeof color === "function" ? (color as ColorFn) : null;
    for (let i = 0; i < na; i++) {
      const a = ((i + r() * 0.5) / na) * Math.PI * 2;
      const nx = Math.cos(a), nz = Math.sin(a);
      const n: V3 = [nx, 0, nz];
      const t: V3 = [-nz, 0, nx];
      const q = quatFromBasis(t, [0, 1, 0], n);
      for (let j = 0; j < nh; j++) {
        const y = base[1] + (j + 0.5) * dh;
        const x = base[0] + nx * radius, z = base[2] + nz * radius;
        const c = fn ? fn(a, y - base[1], x, y, z) : (color as readonly number[]);
        const k = 1 + (r() - 0.5) * 0.05 + nx * 0.04; // faint directional shading
        this.push(x, y, z, da * 0.62, dh * 0.62, 0.005, q, c[0] * k, c[1] * k, c[2] * k, opts.opacity ?? 1);
      }
    }
    if (opts.cap) this.disc([base[0], base[1] + height, base[2]], [0, 1, 0], radius, color, opts);
  }

  /** Disc with normal n. */
  disc(c: V3, n: V3, radius: number, color: ColorArg, opts: RectOpts = {}) {
    const nn = norm(n);
    const helper: V3 = Math.abs(nn[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(helper, nn));
    const v = cross(nn, u);
    const q = quatFromBasis(u, v, nn);
    const sp = this.baseSpacing * (opts.spacing ?? 1);
    const nr = Math.max(1, Math.round(radius / sp));
    const r = this.rand;
    const fn = typeof color === "function" ? (color as ColorFn) : null;
    for (let i = 0; i < nr; i++) {
      const rr = ((i + 0.5) / nr) * radius;
      const na = Math.max(3, Math.round((2 * Math.PI * rr) / sp));
      for (let j = 0; j < na; j++) {
        const a = ((j + r() * 0.6) / na) * Math.PI * 2;
        const ca = Math.cos(a) * rr, sa = Math.sin(a) * rr;
        const x = c[0] + u[0] * ca + v[0] * sa;
        const y = c[1] + u[1] * ca + v[1] * sa;
        const z = c[2] + u[2] * ca + v[2] * sa;
        const col = fn ? fn(rr, a, x, y, z) : (color as readonly number[]);
        const k = 1 + (r() - 0.5) * 0.05;
        this.push(x, y, z, sp * 0.62, sp * 0.62, 0.005, q, col[0] * k, col[1] * k, col[2] * k, opts.opacity ?? 1);
      }
    }
  }

  /** Volumetric cluster of small randomly oriented splats (foliage, fur). */
  blob(c: V3, radii: V3, density: number, color: ColorArg, opts: { size?: number; opacity?: number; shell?: number; droop?: number } = {}) {
    const vol = (4 / 3) * Math.PI * radii[0] * radii[1] * radii[2];
    const area = 4 * Math.PI * Math.pow((radii[0] * radii[1] + radii[0] * radii[2] + radii[1] * radii[2]) / 3, 0.5);
    const dens = (density * 1) / (this.baseSpacing * this.baseSpacing * 140);
    const n = Math.max(8, Math.round(Math.min(vol * 60, area * 55) * dens));
    const r = this.rand;
    const size = opts.size ?? 0.055;
    const shell = opts.shell ?? 0.55;
    const fn = typeof color === "function" ? (color as ColorFn) : null;
    for (let i = 0; i < n; i++) {
      // bias toward the shell so clusters read as leafy volumes
      let dx = 0, dy = 0, dz = 0, d2 = 2;
      while (d2 > 1) {
        dx = r() * 2 - 1;
        dy = r() * 2 - 1;
        dz = r() * 2 - 1;
        d2 = dx * dx + dy * dy + dz * dz;
      }
      const d = Math.sqrt(d2);
      const push = shell + (1 - shell) * d;
      const k = d > 1e-4 ? push / d : 0;
      let x = c[0] + dx * k * radii[0];
      let y = c[1] + dy * k * radii[1];
      const z = c[2] + dz * k * radii[2];
      if (opts.droop) y -= opts.droop * (dx * dx + dz * dz);
      x += (r() - 0.5) * 0.02;
      const col = fn ? fn(d, dy, x, y, z) : (color as readonly number[]);
      const light = 0.82 + 0.3 * (dy * 0.5 + 0.5) + (r() - 0.5) * 0.16;
      const s = size * (0.6 + r() * 0.9);
      this.push(x, y, z, s, s * (0.5 + r() * 0.5), s * 0.18, randomQuat(r), col[0] * light, col[1] * light, col[2] * light, opts.opacity ?? 0.95);
    }
  }

  /** Thin line of splats from a to b (cables, rails, bars). */
  line(a: V3, b: V3, thickness: number, color: readonly number[], opts: { spacing?: number; opacity?: number } = {}) {
    const d = sub(b, a);
    const l = len(d);
    if (l < 1e-4) return;
    const u = scl(d, 1 / l);
    const helper: V3 = Math.abs(u[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const v = norm(cross(helper, u));
    const n = cross(u, v);
    const q = quatFromBasis(u, v, n);
    const sp = Math.max(thickness * 1.2, (opts.spacing ?? 0.5) * this.baseSpacing);
    const ns = Math.max(1, Math.round(l / sp));
    const ds = l / ns;
    for (let i = 0; i < ns; i++) {
      const t = (i + 0.5) * ds;
      this.push(a[0] + u[0] * t, a[1] + u[1] * t, a[2] + u[2] * t, ds * 0.7, thickness * 0.5, thickness * 0.5, q, color[0], color[1], color[2], opts.opacity ?? 1);
    }
  }

  /** Sagging cable between two points. */
  catenary(a: V3, b: V3, sag: number, thickness: number, color: readonly number[]) {
    const segs = Math.max(4, Math.round(len(sub(b, a)) / 1.2));
    let prev: V3 = a;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const p: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
      this.line(prev, p, thickness, color, { spacing: 0.35 });
      prev = p;
    }
  }

  /** Large soft volumetric splat (sky haze, light spill). */
  puff(c: V3, size: V3, color: readonly number[], opacity: number) {
    this.push(c[0], c[1], c[2], size[0], size[1], size[2], randomQuat(this.rand), color[0], color[1], color[2], opacity);
  }

  /** Randomly keep at most `budget` splats (keeps arrays packed). */
  subsample(budget: number, protect = 0) {
    if (this.count <= budget) return;
    const keepP = (budget - protect) / (this.count - protect);
    const r = mulberry32(99);
    let w = protect;
    // compensate density loss with slightly larger in-plane splats
    const g = 1 / Math.sqrt(keepP);
    for (let i = protect; i < this.count; i++) {
      if (r() < keepP) {
        if (w !== i) {
          this.pos.copyWithin(w * 3, i * 3, i * 3 + 3);
          this.scale.copyWithin(w * 3, i * 3, i * 3 + 3);
          this.quat.copyWithin(w * 4, i * 4, i * 4 + 4);
          this.rgba.copyWithin(w * 4, i * 4, i * 4 + 4);
        }
        this.scale[w * 3] *= g;
        this.scale[w * 3 + 1] *= g;
        w++;
      }
    }
    this.count = w;
  }
}
