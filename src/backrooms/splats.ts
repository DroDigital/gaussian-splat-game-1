// Gaussian-splat elements rendered with Spark (they depth-test against the
// wall meshes): dust motes hanging in the fluorescent air, the entity — a
// writhing smoke silhouette with pale eyes — and almond-water bottles.
// All animation runs on the GPU as dyno modifiers; the CPU only moves uniforms.

import { PackedSplats, SparkRenderer, SplatMesh, dyno, utils } from "@sparkjsdev/spark";
import * as THREE from "three";
import { SplatBuilder, mulberry32 } from "../world/splatBuilder";
import { FOG, WALL_H } from "./config";

function pack(b: SplatBuilder) {
  const n = b.count;
  const cap = Math.max(2048, Math.ceil(n / 2048) * 2048);
  const arr = new Uint32Array(cap * 4);
  const { pos, scale, quat, rgba } = b;
  for (let i = 0; i < n; i++) {
    utils.setPackedSplat(
      arr,
      i,
      pos[i * 3],
      pos[i * 3 + 1],
      pos[i * 3 + 2],
      scale[i * 3],
      scale[i * 3 + 1],
      scale[i * 3 + 2],
      quat[i * 4],
      quat[i * 4 + 1],
      quat[i * 4 + 2],
      quat[i * 4 + 3],
      Math.min(1, Math.max(0, rgba[i * 4 + 3])),
      Math.min(1, Math.max(0, rgba[i * 4])),
      Math.min(1, Math.max(0, rgba[i * 4 + 1])),
      Math.min(1, Math.max(0, rgba[i * 4 + 2])),
    );
  }
  return new PackedSplats({ packedArray: arr, numSplats: n });
}

const GL = dyno.unindent(`
  float brHash(float n) { n = fract(n * 0.1031); n *= n + 33.33; n *= n + n; return fract(n); }
`);

export class SplatFx {
  spark: SparkRenderer;
  time = dyno.dynoFloat(0, "brTime");
  camPos = dyno.dynoVec3(new THREE.Vector3(), "brCam");
  fogColor = dyno.dynoVec3(new THREE.Vector3(...FOG.color), "brFogColor");
  fogDensity = dyno.dynoFloat(FOG.density, "brFogDensity");
  agitation = dyno.dynoFloat(0, "brAgitation");
  dustLight = dyno.dynoFloat(1, "brDustLight");
  entity: SplatMesh;
  dust: SplatMesh;
  bottles: SplatMesh[] = [];
  private dustBox = new THREE.Vector3(14, WALL_H, 14);

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, dustCount: number) {
    this.spark = new SparkRenderer({ renderer, maxStdDev: Math.sqrt(7) });
    scene.add(this.spark);
    this.dust = new SplatMesh({ packedSplats: pack(this.buildDust(dustCount)), raycastable: false });
    this.dust.worldModifier = this.dustModifier();
    this.dust.updateGenerator();
    scene.add(this.dust);
    this.entity = new SplatMesh({ packedSplats: pack(buildEntity()), raycastable: false });
    this.entity.objectModifier = this.entityModifier();
    this.entity.worldModifier = this.fogModifier(false);
    this.entity.updateGenerator();
    this.entity.visible = false;
    scene.add(this.entity);
    const bottle = pack(buildBottle());
    for (let i = 0; i < 6; i++) {
      const m = new SplatMesh({ packedSplats: bottle, raycastable: false });
      m.worldModifier = this.fogModifier(true);
      m.updateGenerator();
      m.visible = false;
      scene.add(m);
      this.bottles.push(m);
    }
  }

  private buildDust(n: number) {
    const B = new SplatBuilder(77, 1, Math.max(1024, n));
    const r = mulberry32(5);
    for (let i = 0; i < n; i++) {
      const s = 0.0025 + r() * 0.004;
      const warm = 0.75 + r() * 0.25;
      B.puff([(r() - 0.5) * this.dustBox.x, r() * this.dustBox.y, (r() - 0.5) * this.dustBox.z], [s, s, s], [1.0 * warm, 0.93 * warm, 0.72 * warm], 0.35 + r() * 0.4);
    }
    return B;
  }

  private dustModifier() {
    const box = dyno.dynoVec3(this.dustBox, "brDustBox");
    return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
      const d = dyno.dyno({
        inTypes: { gsplat: dyno.Gsplat, t: "float", cam: "vec3", box: "vec3", fogC: "vec3", fogD: "float", light: "float" },
        outTypes: { gsplat: dyno.Gsplat },
        globals: () => [GL],
        statements: ({ inputs: i, outputs: o }) =>
          dyno.unindentLines(`
            ${o.gsplat} = ${i.gsplat};
            float h = brHash(float(${o.gsplat}.index) * 0.7311 + 3.0);
            float t = ${i.t};
            vec3 p = ${o.gsplat}.center;
            p += vec3(sin(t * 0.13 + h * 40.0) * 0.35, t * (0.008 + 0.02 * h), cos(t * 0.11 + h * 23.0) * 0.35);
            vec3 B = ${i.box};
            vec2 rel = mod(p.xz - ${i.cam}.xz + B.xz * 0.5, B.xz) - B.xz * 0.5;
            p.xz = ${i.cam}.xz + rel;
            p.y = 0.05 + mod(p.y, B.y - 0.1);
            ${o.gsplat}.center = p;
            float edge = 1.0 - smoothstep(B.x * 0.3, B.x * 0.5, max(abs(rel.x), abs(rel.y)));
            float dist = length(p - ${i.cam});
            float fog = exp(-pow(dist * ${i.fogD}, 2.0));
            float twinkle = 0.6 + 0.4 * sin(t * (0.6 + h * 2.0) + h * 50.0);
            ${o.gsplat}.rgba.a *= edge * fog * smoothstep(0.25, 0.9, dist) * twinkle;
            ${o.gsplat}.rgba.rgb *= ${i.light};
          `),
      });
      return { gsplat: d.apply({ gsplat, t: this.time, cam: this.camPos, box, fogC: this.fogColor, fogD: this.fogDensity, light: this.dustLight }).gsplat };
    });
  }

  private entityModifier() {
    return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
      const d = dyno.dyno({
        inTypes: { gsplat: dyno.Gsplat, t: "float", ag: "float" },
        outTypes: { gsplat: dyno.Gsplat },
        globals: () => [GL],
        statements: ({ inputs: i, outputs: o }) =>
          dyno.unindentLines(`
            ${o.gsplat} = ${i.gsplat};
            float h = brHash(float(${o.gsplat}.index) * 0.6180339);
            float t = ${i.t};
            float ag = ${i.ag};
            bool eye = ${o.gsplat}.rgba.r > 0.8;
            vec3 p = ${o.gsplat}.center;
            float k = (0.012 + 0.05 * ag) * (0.4 + smoothstep(0.3, 1.9, p.y)) * (eye ? 0.15 : 1.0);
            // jerky stop-motion twitching while watched
            float tt = ag > 0.5 ? floor(t * 9.0) / 9.0 : t;
            p += vec3(sin(tt * 2.1 + h * 31.0 + p.y * 4.0), sin(tt * 1.7 + h * 17.0), cos(tt * 1.9 + h * 23.0 + p.y * 3.0)) * k;
            if (h > 0.8 && !eye) {
              float ph = fract(t * 0.22 + h * 7.0);
              p.y += ph * 0.7;
              p.xz *= 1.0 + ph * 0.6;
              ${o.gsplat}.rgba.a *= 1.0 - ph;
              ${o.gsplat}.scales *= 1.0 + ph * 2.5;
            }
            ${o.gsplat}.center = p;
          `),
      });
      return { gsplat: d.apply({ gsplat, t: this.time, ag: this.agitation }).gsplat };
    });
  }

  private fogModifier(lit: boolean) {
    return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
      const d = dyno.dyno({
        inTypes: { gsplat: dyno.Gsplat, cam: "vec3", fogC: "vec3", fogD: "float", light: "float" },
        outTypes: { gsplat: dyno.Gsplat },
        statements: ({ inputs: i, outputs: o }) =>
          dyno.unindentLines(`
            ${o.gsplat} = ${i.gsplat};
            float dist = length(${o.gsplat}.center - ${i.cam});
            float fog = 1.0 - exp(-pow(dist * ${i.fogD}, 2.0));
            ${lit ? `${o.gsplat}.rgba.rgb *= 0.35 + 0.65 * ${i.light};` : ""}
            ${o.gsplat}.rgba.rgb = mix(${o.gsplat}.rgba.rgb, ${i.fogC}, fog);
            ${o.gsplat}.rgba.a *= 1.0 - fog * 0.5;
          `),
      });
      return { gsplat: d.apply({ gsplat, cam: this.camPos, fogC: this.fogColor, fogD: this.fogDensity, light: this.dustLight }).gsplat };
    });
  }

  update(t: number, cam: THREE.Vector3, light: number) {
    this.time.value = t;
    this.camPos.value.copy(cam);
    this.dustLight.value = light;
    this.dust.updateVersion();
    if (this.entity.visible) this.entity.updateVersion();
    for (const b of this.bottles) if (b.visible) b.updateVersion();
  }
}

/** A tall thin figure of dark smoke, ~2.35 m, facing +Z, feet at the origin. */
function buildEntity() {
  const B = new SplatBuilder(1313, 1.4, 1 << 15);
  const ink = (d: number, dy: number) => {
    const k = 0.012 + 0.03 * Math.max(0, dy) * d;
    return [k, k * 0.9, k * 0.8] as [number, number, number];
  };
  const body = (c: [number, number, number], r: [number, number, number], dens = 1.6) => B.blob(c, r, dens, ink, { size: 0.03, shell: 0.35, opacity: 0.93 });
  body([-0.11, 0.5, 0], [0.065, 0.52, 0.07]);
  body([0.11, 0.5, 0], [0.065, 0.52, 0.07]);
  body([0, 1.33, 0], [0.18, 0.46, 0.11], 1.8);
  body([0, 1.83, 0], [0.25, 0.07, 0.1]);
  body([0, 1.95, 0.0], [0.05, 0.08, 0.05]);
  body([0, 2.12, 0.02], [0.1, 0.16, 0.115], 2.2);
  // impossibly long arms hanging past the knees
  for (const sx of [-1, 1]) {
    const a: [number, number, number] = [sx * 0.27, 1.82, 0];
    const h: [number, number, number] = [sx * 0.37, 0.45, 0.05];
    for (let k = 0; k <= 12; k++) {
      const f = k / 12;
      body([a[0] + (h[0] - a[0]) * f, a[1] + (h[1] - a[1]) * f, a[2] + (h[2] - a[2]) * f], [0.045, 0.08, 0.045], 1.2);
    }
    for (let f = 0; f < 4; f++) {
      const ox = sx * (0.34 + f * 0.018), oz = 0.02 + (f - 1.5) * 0.02;
      B.line([ox, 0.42, oz], [ox + sx * 0.02, 0.18, oz + 0.01], 0.012, [0.01, 0.01, 0.01], { spacing: 0.2 });
    }
  }
  // smoke aura
  const r = mulberry32(9);
  for (let i = 0; i < 900; i++) {
    const y = r() * 2.3;
    const ang = r() * Math.PI * 2;
    const rad = 0.18 + r() * 0.3 * (1 - Math.abs(y - 1.2) / 1.6);
    const s = 0.05 + r() * 0.12;
    B.puff([Math.cos(ang) * rad, y, Math.sin(ang) * rad * 0.6], [s, s * 1.6, s], [0.015, 0.013, 0.012], 0.12 + r() * 0.18);
  }
  // pale eyes (bright: the modifier keeps them steady)
  for (const sx of [-1, 1]) {
    B.puff([sx * 0.038, 2.14, 0.125], [0.011, 0.006, 0.004], [1, 0.98, 0.9], 1.0);
    B.puff([sx * 0.038, 2.14, 0.12], [0.03, 0.02, 0.01], [0.95, 0.92, 0.8], 0.25);
  }
  return B;
}

/** A 500 ml bottle of almond water: clear plastic, blue label, white cap. */
function buildBottle() {
  const B = new SplatBuilder(4242, 2.4, 1 << 13);
  B.cylinder([0, 0.0, 0], 0.2, 0.034, (_a, h) => (h > 0.07 && h < 0.13 ? [0.95, 0.95, 0.92] : [0.82, 0.88, 0.9]), { spacing: 0.35, opacity: 0.55 });
  B.cylinder([0, 0.075, 0], 0.05, 0.0352, (a) => (Math.sin(a * 3) > 0.6 ? [0.2, 0.42, 0.78] : [0.93, 0.93, 0.9]), { spacing: 0.3, opacity: 0.98 });
  B.cylinder([0, 0.0, 0], 0.17, 0.03, [0.75, 0.86, 0.92], { spacing: 0.5, opacity: 0.22 });
  B.cylinder([0, 0.2, 0], 0.03, 0.018, [0.96, 0.96, 0.95], { spacing: 0.3, cap: true });
  B.disc([0, 0.002, 0], [0, 1, 0], 0.034, [0.8, 0.86, 0.9], { spacing: 0.4, opacity: 0.5 });
  return B;
}
