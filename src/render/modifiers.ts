// Per-splat GPU effects as Spark dyno shader-graph modifiers:
//  - melt (stability-driven curl drift, upward rise, growth, stretch, fade to smoke)
//  - distance haze (fog + extra melt beyond 60 m so the street never ends)
//  - vortex (twist around a vertical axis, spiral pull, bowl lift)
// No per-frame CPU loop ever touches splat data: only uniforms change.

import { dyno } from "@sparkjsdev/spark";
import * as THREE from "three";
import { FIELD, HAZE, MELT, PALETTE, VORTEX } from "../look";

export type ModifierKind = "world" | "sky" | "anchor" | "import";

const v3 = (c: readonly number[]) => new THREE.Vector3(c[0], c[1], c[2]);

const GLOBALS = dyno.unindent(`
  #define HTS_NX ${FIELD.nx}.0
  #define HTS_NY ${FIELD.ny}.0
  #define HTS_NZ ${FIELD.nz}.0
  float hts_hash(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }

  // Analytic curl of a sum-of-sines vector potential: divergence free, cheap.
  vec3 hts_curl1(vec3 p, float t) {
    float dAzdy = 0.48 * cos(0.8 * p.y + 0.9 * t);
    float dAydz = 1.1 * cos(1.1 * p.z + 0.8 * t);
    float dAxdz = 0.54 * cos(0.9 * p.z - 0.7 * t);
    float dAzdx = 1.2 * cos(1.2 * p.x - 0.6 * t);
    float dAydx = 0.42 * cos(0.7 * p.x + 0.5 * t);
    float dAxdy = 1.3 * cos(1.3 * p.y + t);
    return vec3(dAzdy - dAydz, dAxdz - dAzdx, dAydx - dAxdy);
  }
  vec3 hts_curl(vec3 p, float t) {
    return hts_curl1(p, t) + 0.5 * hts_curl1(p * 2.13 + vec3(3.1, 7.7, 1.3), t * 1.7);
  }

  // Sample the stability field: NY horizontal slices tiled along X in a 2D atlas.
  float hts_stab(sampler2D tex, vec3 p, vec3 fmin, vec3 fsize) {
    vec3 g = clamp((p - fmin) / fsize, 0.0, 1.0);
    float fy = clamp(g.y * HTS_NY - 0.5, 0.0, HTS_NY - 1.0);
    float y0 = floor(fy);
    float y1 = min(y0 + 1.0, HTS_NY - 1.0);
    float ux = clamp(g.x, 0.5 / HTS_NX, 1.0 - 0.5 / HTS_NX);
    float vz = clamp(g.z, 0.5 / HTS_NZ, 1.0 - 0.5 / HTS_NZ);
    float s0 = texture(tex, vec2((y0 + ux) / HTS_NY, vz)).r;
    float s1 = texture(tex, vec2((y1 + ux) / HTS_NY, vz)).r;
    return mix(s0, s1, fy - y0);
  }

  vec4 hts_quatFromX(vec3 d) {
    float c = d.x;
    if (c < -0.9999) return vec4(0.0, 0.0, 1.0, 0.0);
    return normalize(vec4(0.0, -d.z, d.y, 1.0 + c));
  }
  vec4 hts_quatMul(vec4 a, vec4 b) {
    return vec4(
      a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z);
  }
`);

/** All uniforms shared by every splat mesh's modifier. */
export class WorldFx {
  time = dyno.dynoFloat(0, "htsTime");
  camPos = dyno.dynoVec3(new THREE.Vector3(), "htsCamPos");
  stab: ReturnType<typeof dyno.dynoSampler2D<THREE.Texture>>;
  fieldMin = dyno.dynoVec3(new THREE.Vector3(-64, -1, -128), "htsFieldMin");
  fieldSize = dyno.dynoVec3(new THREE.Vector3(128, FIELD.height, 128), "htsFieldSize");
  globalMelt = dyno.dynoFloat(0, "htsGlobalMelt");
  vortex = dyno.dynoFloat(0, "htsVortex");
  vortexPhase = dyno.dynoFloat(0, "htsVortexPhase");
  axis = dyno.dynoVec3(new THREE.Vector3(0, 1, 0), "htsAxis");
  center = dyno.dynoVec3(new THREE.Vector3(), "htsCenter");
  smoke = dyno.dynoVec3(v3(PALETTE.smoke), "htsSmoke");
  haze = dyno.dynoVec3(v3(PALETTE.haze), "htsHaze");
  /** stableAbove, meltedBelow, curlFreq, curlAmp */
  m0 = dyno.dynoVec4(new THREE.Vector4(MELT.stableAbove, MELT.meltedBelow, MELT.curlFreq, MELT.curlAmp), "htsM0");
  /** driftUp, scaleMax, stretch, opacityMin */
  m1 = dyno.dynoVec4(new THREE.Vector4(MELT.driftUp, MELT.scaleMax, MELT.stretch, MELT.opacityMin), "htsM1");
  /** greyMix, flowSpeed, windX, windZ */
  m2 = dyno.dynoVec4(new THREE.Vector4(MELT.greyMix, MELT.flowSpeed, MELT.wind[0], MELT.wind[2]), "htsM2");
  /** fogStart, fogEnd, fogMax, meltStart */
  h0 = dyno.dynoVec4(new THREE.Vector4(HAZE.fogStart, HAZE.fogEnd, HAZE.fogMax, HAZE.meltStart), "htsH0");
  /** meltEnd, meltMax, -, - */
  h1 = dyno.dynoVec4(new THREE.Vector4(HAZE.meltEnd, HAZE.meltMax, 0, 0), "htsH1");
  /** spin, heightTwist, falloffR, pull */
  v0 = dyno.dynoVec4(new THREE.Vector4(VORTEX.spin, VORTEX.heightTwist, VORTEX.falloffR, VORTEX.pull), "htsV0");
  /** pullR, lift, sink, meltAdd */
  v1 = dyno.dynoVec4(new THREE.Vector4(VORTEX.pullR, VORTEX.lift, VORTEX.sink, VORTEX.meltAdd), "htsV1");

  constructor(initialField: THREE.Texture) {
    this.stab = dyno.dynoSampler2D(initialField, "htsStab");
  }

  /** Build a GsplatModifier (dyno graph) for a class of mesh. */
  modifier(kind: ModifierKind) {
    return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
      const fx = this.effectDyno(kind);
      const out = fx.apply({
        gsplat,
        time: this.time,
        camPos: this.camPos,
        stab: this.stab,
        fieldMin: this.fieldMin,
        fieldSize: this.fieldSize,
        globalMelt: this.globalMelt,
        vortex: this.vortex,
        vortexPhase: this.vortexPhase,
        axis: this.axis,
        center: this.center,
        smoke: this.smoke,
        haze: this.haze,
        m0: this.m0,
        m1: this.m1,
        m2: this.m2,
        h0: this.h0,
        h1: this.h1,
        v0: this.v0,
        v1: this.v1,
      });
      return { gsplat: out.gsplat };
    });
  }

  private effectDyno(kind: ModifierKind) {
    const isSky = kind === "sky";
    const meltScale = kind === "anchor" ? 0.45 : 1.0;
    return dyno.dyno({
      inTypes: {
        gsplat: dyno.Gsplat,
        time: "float",
        camPos: "vec3",
        stab: "sampler2D",
        fieldMin: "vec3",
        fieldSize: "vec3",
        globalMelt: "float",
        vortex: "float",
        vortexPhase: "float",
        axis: "vec3",
        center: "vec3",
        smoke: "vec3",
        haze: "vec3",
        m0: "vec4",
        m1: "vec4",
        m2: "vec4",
        h0: "vec4",
        h1: "vec4",
        v0: "vec4",
        v1: "vec4",
      },
      outTypes: { gsplat: dyno.Gsplat },
      globals: () => [GLOBALS],
      statements: ({ inputs: i, outputs: o }) =>
        dyno.unindentLines(`
          ${o.gsplat} = ${i.gsplat};
          if (isGsplatActive(${o.gsplat}.flags)) {
            float t = ${i.time};
            vec3 cam = ${i.camPos};
            vec3 p = ${o.gsplat}.center;
            float h = hts_hash(float(${o.gsplat}.index) * 0.6180339 + ${isSky ? "17.0" : "0.0"});
            vec4 m0 = ${i.m0}; vec4 m1 = ${i.m1}; vec4 m2 = ${i.m2};
            vec4 h0 = ${i.h0}; vec4 h1 = ${i.h1};
            float vtx = ${i.vortex};

            ${
              isSky
                ? `
            // sky haze: slow drift, never photographic, never repaired
            float melt = 0.0;
            p += vec3(sin(t * 0.03 + h * 6.28) * 4.0, sin(t * 0.05 + h * 11.0) * 1.5, cos(t * 0.025 + h * 4.0) * 4.0);
            ${o.gsplat}.center = p;`
                : `
            float stab = hts_stab(${i.stab}, p, ${i.fieldMin}, ${i.fieldSize});
            stab = min(stab, 1.0 - ${i.globalMelt});
            float melt = 1.0 - smoothstep(m0.y, m0.x, stab);
            // distance haze: extra melt far away so the street never visibly ends
            float camDist = length(p - cam);
            melt = max(melt, smoothstep(h0.w, h1.x, camDist) * h1.y);
            // the vortex melts everything outside a calm eye around the player
            vec3 vrel = p - ${i.center};
            float vr = length(vrel - ${i.axis} * dot(vrel, ${i.axis}));
            melt = max(melt, vtx * ${i.v1}.w * smoothstep(5.0, 16.0, vr));
            // stagger per splat so the edge tears apart instead of fading uniformly
            melt = clamp(melt * (0.75 + 0.5 * h) * ${meltScale.toFixed(3)}, 0.0, 1.0);
            if (melt > 0.002) {
              float m = melt;
              float ft = t * m2.y;
              vec3 cv = hts_curl(p * m0.z + vec3(h * 5.0), ft + h * 6.2831);
              vec3 drift = vec3(0.0, m1.x * m * m * (0.45 + h), 0.0)
                + vec3(m2.z, 0.0, m2.w) * m * (0.4 + h)
                + cv * (m0.w * 0.5 * m);
              drift.y += m * 0.5 * sin(t * 0.7 + h * 20.0);
              ${o.gsplat}.center = p + drift;
              vec3 dir = normalize(drift + vec3(0.0, 1e-3, 0.0));
              vec3 sc = ${o.gsplat}.scales;
              float maxS = max(sc.x, max(sc.y, sc.z));
              float grow = mix(1.0, m1.y, m);
              float sm = smoothstep(0.0, 0.7, m);
              vec3 wisp = vec3(maxS * grow * (1.0 + m1.z * m), maxS * grow * 0.55, maxS * grow * 0.55);
              vec4 q0 = ${o.gsplat}.quaternion;
              vec4 qd = hts_quatFromX(dir);
              if (dot(q0, qd) < 0.0) qd = -qd;
              ${o.gsplat}.quaternion = normalize(mix(q0, qd, sm));
              ${o.gsplat}.scales = mix(sc * grow, wisp, sm);
              ${o.gsplat}.rgba.a *= mix(1.0, m1.w, m);
              ${o.gsplat}.rgba.rgb = mix(${o.gsplat}.rgba.rgb, ${i.smoke}, m * m2.x);
            }`
            }

            // ---- vortex: twist around the axis, pull inward on a spiral, lift into a bowl ----
            if (vtx > 0.0005) {
              vec4 v0 = ${i.v0}; vec4 v1 = ${i.v1};
              vec3 axis = ${i.axis};
              vec3 rel = ${o.gsplat}.center - ${i.center};
              float y = dot(rel, axis);
              vec3 radial = rel - axis * y;
              float r = length(radial);
              vec3 rdir = r > 1e-4 ? radial / r : vec3(1.0, 0.0, 0.0);
              // calm eye around the player so the street wraps *around* the camera
              float eye = smoothstep(2.5, 11.0, r);
              float fall = v0.z / (v0.z + r) * mix(0.12, 1.0, eye);
              float ang = vtx * v0.x * fall * (1.0 + v0.y * max(y + 2.0, 0.0)) + ${i.vortexPhase} * fall;
              float pullK = vtx * v0.w * (1.0 - exp(-r / v1.x));
              float r2 = r * (1.0 - pullK);
              vec3 tdir = cross(axis, rdir);
              vec3 rd2 = rdir * cos(ang) + tdir * sin(ang);
              float y2 = y * (1.0 - 0.35 * vtx * smoothstep(20.0, 80.0, y))
                + vtx * v1.y * r2 * (0.4 + 0.6 * vtx)
                - vtx * v1.z * eye * exp(-r / 14.0);
              ${o.gsplat}.center = ${i.center} + axis * y2 + rd2 * r2;
              float ha = 0.5 * ang;
              ${o.gsplat}.quaternion = hts_quatMul(vec4(axis * sin(ha), cos(ha)), ${o.gsplat}.quaternion);
              // tangential smear while spinning
              ${o.gsplat}.scales *= vec3(1.0 + vtx * 0.6 * fall * eye, 1.0, 1.0);
            }

            // ---- distance haze colour ----
            float fog = smoothstep(h0.x, h0.y, length(${o.gsplat}.center - cam)) * h0.z;
            ${o.gsplat}.rgba.rgb = mix(${o.gsplat}.rgba.rgb, ${i.haze}, ${isSky ? "fog * 0.5" : "fog"});
          }
        `),
    });
  }
}
