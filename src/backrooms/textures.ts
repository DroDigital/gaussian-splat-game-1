// High-resolution, fully procedural, seamlessly tiling PBR-ish textures,
// synthesised on the GPU at startup (no image assets):
//   wallpaper  — mono-yellow paper, alternating bands, printed diamond motif,
//                roll seams, paper grain + fibres            (albedo+rough, normal)
//   carpet     — cut-pile tufts in two yarn colours, tufting rows, mottling
//   ceiling    — 2x2 acoustic tiles, fissures, pinholes, T-bar grid
//   grime      — world-space wear masks (water damage, blotches, mould, damp)
// Albedo is written in linear space; the A channel holds roughness.

import * as THREE from "three";
import { PALETTE, TILE } from "./config";

const NOISE = /* glsl */ `
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
  // tileable value noise (period in lattice cells)
  float tnoise(vec2 p, vec2 per) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = hash12(mod(i, per));
    float b = hash12(mod(i + vec2(1.0, 0.0), per));
    float c = hash12(mod(i + vec2(0.0, 1.0), per));
    float d = hash12(mod(i + vec2(1.0, 1.0), per));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float tfbm(vec2 uv, float f0, int oct) {
    float s = 0.0, a = 0.5, n = 0.0, f = f0;
    for (int i = 0; i < 8; i++) {
      if (i >= oct) break;
      s += a * tnoise(uv * f, vec2(f));
      n += a; f *= 2.0; a *= 0.5;
    }
    return s / n;
  }
  // tileable Worley: x = F1 distance (cell units), y = cell id hash
  vec2 tworley(vec2 uv, float n) {
    vec2 p = uv * n; vec2 i = floor(p); vec2 f = fract(p);
    float best = 9.0; float id = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 c = mod(i + g, vec2(n));
      vec2 d = g + hash22(c) - f;
      float dd = dot(d, d);
      if (dd < best) { best = dd; id = hash12(c + 17.3); }
    }
    return vec2(sqrt(best), id);
  }
  vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
`;

// ---------------------------------------------------------------- wallpaper
const WALL = /* glsl */ `
  uniform vec3 uBase; uniform vec3 uInk;
  const float TILE_MM = ${(TILE.wall * 1000).toFixed(1)};
  float ink(vec2 uv) {
    float x = uv.x * 13.0; float col = floor(x); float sx = fract(x);
    if (mod(col, 2.0) < 0.5) {
      // plain band: faint hairline down the middle
      float e = abs(sx - 0.5) * TILE_MM / 13.0;
      return (1.0 - smoothstep(0.25, 0.6, e)) * 0.35;
    }
    float wmm = TILE_MM / 13.0, hmm = TILE_MM / 10.0;
    float e = min(sx, 1.0 - sx) * wmm;
    float pin = 1.0 - smoothstep(0.35, 0.8, abs(e - 2.2));
    vec2 q = vec2((sx - 0.5) * wmm, (fract(uv.y * 10.0) - 0.5) * hmm);
    float dia = abs(q.x) * 1.35 + abs(q.y);
    float ring = 1.0 - smoothstep(0.55, 1.25, abs(dia - 16.5));
    float inner = 1.0 - smoothstep(0.45, 1.0, abs(dia - 9.0));
    float dotc = 1.0 - smoothstep(1.6, 2.6, length(q));
    // small ticks between motifs
    vec2 q2 = vec2(q.x, abs(q.y) - hmm * 0.5);
    float tick = (1.0 - smoothstep(0.4, 0.9, abs(q2.x))) * (1.0 - smoothstep(2.0, 3.0, abs(q2.y)));
    return max(max(pin, ring), max(max(inner * 0.7, dotc), tick));
  }
  float seamMM(vec2 uv) { return abs(fract(uv.x * 2.0 + 0.5) - 0.5) * TILE_MM; }
  float heightF(vec2 uv) {
    float grain = tfbm(uv, 256.0, 2);
    float fibre = tnoise(vec2(uv.x * 700.0, uv.y * 90.0), vec2(700.0, 90.0));
    float i = ink(uv);
    float s = seamMM(uv);
    float groove = 1.0 - smoothstep(0.2, 0.9, s);
    float lift = (1.0 - smoothstep(0.9, 4.0, s)) * (1.0 - groove);
    return grain * 0.45 + fibre * 0.2 + i * 0.35 - groove * 1.2 + lift * 0.25 + tfbm(uv, 3.0, 3) * 0.3;
  }
  vec4 albedoF(vec2 uv) {
    vec3 base = lin(uBase);
    float grain = tfbm(uv, 256.0, 2);
    float fibre = tnoise(vec2(uv.x * 700.0, uv.y * 90.0), vec2(700.0, 90.0));
    float uneven = tfbm(uv, 3.0, 4);
    float band = mod(floor(uv.x * 13.0), 2.0);
    float inkM = ink(uv) * (0.7 + 0.3 * tnoise(uv * 180.0, vec2(180.0)));
    vec3 col = base * (0.94 + 0.09 * uneven) * (0.975 + 0.05 * grain) * (0.985 + 0.03 * fibre);
    col *= mix(1.04, 0.975, band);
    col = mix(col, lin(uInk) * (0.95 + 0.1 * uneven), inkM * 0.85);
    float s = seamMM(uv);
    float seam = 1.0 - smoothstep(0.2, 0.75, s);
    float seamLight = (1.0 - smoothstep(0.75, 3.5, s)) * (1.0 - seam);
    col *= (1.0 - seam * 0.45) * (1.0 + seamLight * 0.035);
    float rough = 0.8 - inkM * 0.14 + grain * 0.05;
    return vec4(col, rough);
  }
`;

// ---------------------------------------------------------------- carpet
const CARPET = /* glsl */ `
  uniform vec3 uBase; uniform vec3 uInk;
  float heightF(vec2 uv) {
    vec2 w = tworley(uv, 320.0);
    vec2 w2 = tworley(uv + vec2(0.37, 0.11), 512.0);
    float tuft = 1.0 - smoothstep(0.0, 0.66, w.x);
    float tuft2 = 1.0 - smoothstep(0.0, 0.6, w2.x);
    float rows = 0.5 + 0.5 * sin((uv.x * 128.0 + uv.y * 32.0) * 6.2831853);
    return tuft * 0.7 + tuft2 * 0.3 + rows * 0.08 + tfbm(uv, 8.0, 3) * 0.25;
  }
  vec4 albedoF(vec2 uv) {
    vec2 w = tworley(uv, 320.0);
    vec2 w2 = tworley(uv + vec2(0.37, 0.11), 512.0);
    float tuft = 1.0 - smoothstep(0.0, 0.66, w.x);
    float tuft2 = 1.0 - smoothstep(0.0, 0.6, w2.x);
    float mott = tfbm(uv, 6.0, 5);
    float rows = 0.5 + 0.5 * sin((uv.x * 128.0 + uv.y * 32.0) * 6.2831853);
    vec3 yarn = mix(lin(uBase), lin(uInk), smoothstep(0.25, 0.85, w.y));
    yarn *= 0.88 + 0.24 * fract(w.y * 13.7);
    yarn = mix(yarn, yarn * vec3(1.05, 0.95, 0.8), step(0.93, fract(w.y * 7.31)));
    vec3 col = yarn * (0.5 + 0.5 * tuft) * (0.86 + 0.26 * mott) * (0.96 + 0.05 * rows);
    col *= 0.9 + 0.1 * tuft2;
    return vec4(col, 0.94 - 0.04 * tuft);
  }
`;

// ---------------------------------------------------------------- ceiling
const CEILING = /* glsl */ `
  uniform vec3 uBase; uniform vec3 uInk;
  const float TILE_MM = ${((TILE.ceiling / 2) * 1000).toFixed(1)};
  float barM(vec2 uv, out float bevel) {
    vec2 t = fract(uv * 2.0);
    vec2 d = min(t, 1.0 - t) * TILE_MM;
    float dB = min(d.x, d.y);
    float bar = 1.0 - smoothstep(11.0, 12.6, dB);
    bevel = (1.0 - smoothstep(12.6, 24.0, dB)) * (1.0 - bar);
    return bar;
  }
  float fissure(vec2 uv) {
    float n1 = tfbm(uv + vec2(0.13, 0.71), 40.0, 3);
    float n2 = tfbm(uv + vec2(3.1, 1.7), 90.0, 2);
    float f = 1.0 - smoothstep(0.01, 0.028, abs(n1 - 0.5));
    return max(f, (1.0 - smoothstep(0.008, 0.02, abs(n2 - 0.5))) * 0.7);
  }
  float pinhole(vec2 uv) {
    vec2 ph = tworley(uv, 240.0);
    return (1.0 - smoothstep(0.07, 0.15, ph.x)) * step(0.55, fract(ph.y * 7.13));
  }
  float heightF(vec2 uv) {
    float bevel; float bar = barM(uv, bevel);
    float speck = tnoise(uv * 700.0, vec2(700.0));
    return bar * 1.2 - bevel * 0.6 + (1.0 - bar) * (-0.45 * fissure(uv) - 0.6 * pinhole(uv) + 0.12 * speck);
  }
  vec4 albedoF(vec2 uv) {
    float bevel; float bar = barM(uv, bevel);
    float speck = tnoise(uv * 700.0, vec2(700.0));
    vec3 tileC = lin(uBase) * (0.955 + 0.07 * speck) * (1.0 - 0.24 * fissure(uv)) * (1.0 - 0.5 * pinhole(uv)) * (1.0 - 0.22 * bevel);
    tileC *= 0.96 + 0.06 * tfbm(uv, 4.0, 4);
    vec3 col = mix(tileC, lin(uInk), bar);
    return vec4(col, mix(0.93, 0.42, bar));
  }
`;

// ---------------------------------------------------------------- grime masks
const GRIME = /* glsl */ `
  uniform vec3 uBase; uniform vec3 uInk;
  float heightF(vec2 uv) { return 0.0; }
  vec4 albedoF(vec2 uv) {
    float r = tfbm(uv, 3.0, 5);
    float g = tfbm(uv + vec2(0.31, 0.77), 11.0, 4);
    vec2 w = tworley(uv, 180.0);
    float b = (1.0 - smoothstep(0.02, 0.1, w.x)) * step(0.86, w.y);
    vec2 warp = vec2(tfbm(uv, 4.0, 3), tfbm(uv + vec2(5.2, 1.3), 4.0, 3)) - 0.5;
    float a = tfbm(uv + warp * 0.18, 2.0, 5);
    return vec4(r, g, b, a);
  }
`;

const VERT = /* glsl */ `
  out vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function frag(body: string, normal: boolean, depthMM: number, tileMM: number) {
  return /* glsl */ `
    precision highp float;
    in vec2 vUv;
    uniform float uSize;
    out highp vec4 outColor;
    ${NOISE}
    ${body}
    void main() {
      vec2 uv = (floor(gl_FragCoord.xy) + 0.5) / uSize;
      ${
        normal
          ? `
      float e = 1.0 / uSize;
      float hx = heightF(fract(uv + vec2(e, 0.0))) - heightF(fract(uv - vec2(e, 0.0)));
      float hy = heightF(fract(uv + vec2(0.0, e))) - heightF(fract(uv - vec2(0.0, e)));
      float k = ${depthMM.toFixed(4)} / (2.0 * e * ${tileMM.toFixed(2)});
      vec3 n = normalize(vec3(-hx * k, -hy * k, 1.0));
      outColor = vec4(n * 0.5 + 0.5, 1.0);`
          : `outColor = albedoF(uv);`
      }
    }
  `;
}

export interface TextureSet {
  wallA: THREE.Texture;
  wallN: THREE.Texture;
  carpetA: THREE.Texture;
  carpetN: THREE.Texture;
  ceilA: THREE.Texture;
  ceilN: THREE.Texture;
  grime: THREE.Texture;
  sign: THREE.Texture;
  dispose(): void;
}

const v3 = (c: readonly number[]) => new THREE.Vector3(c[0], c[1], c[2]);

export function buildTextures(renderer: THREE.WebGLRenderer, size: number, aniso: number): TextureSet {
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  scene.add(quad);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const targets: THREE.WebGLRenderTarget[] = [];
  const prevTarget = renderer.getRenderTarget();

  const make = (body: string, sz: number, base: readonly number[], inkC: readonly number[], normal: boolean, depthMM: number, tileM: number) => {
    const rt = new THREE.WebGLRenderTarget(sz, sz, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
    });
    rt.texture.anisotropy = Math.min(aniso, maxAniso);
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: frag(body, normal, depthMM, tileM * 1000),
      uniforms: { uSize: { value: sz }, uBase: { value: v3(base) }, uInk: { value: v3(inkC) } },
      depthTest: false,
      depthWrite: false,
    });
    quad.material = mat;
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    mat.dispose();
    targets.push(rt);
    return rt.texture;
  };

  const P = PALETTE;
  const set: TextureSet = {
    wallA: make(WALL, size, P.wallpaper, P.wallInk, false, 0, TILE.wall),
    wallN: make(WALL, size, P.wallpaper, P.wallInk, true, 0.16, TILE.wall),
    carpetA: make(CARPET, size, P.carpet, P.carpetAlt, false, 0, TILE.carpet),
    carpetN: make(CARPET, size, P.carpet, P.carpetAlt, true, 1.3, TILE.carpet),
    ceilA: make(CEILING, size, P.ceiling, P.tbar, false, 0, TILE.ceiling),
    ceilN: make(CEILING, size, P.ceiling, P.tbar, true, 1.1, TILE.ceiling),
    grime: make(GRIME, Math.min(1024, size), [0, 0, 0], [0, 0, 0], false, 0, TILE.grime),
    sign: makeSignTexture(),
    dispose() {
      for (const t of targets) t.dispose();
      set.sign.dispose();
    },
  };
  renderer.setRenderTarget(prevTarget);
  quad.geometry.dispose();
  return set;
}

/** Red "EXIT" lettering, drawn once on a 2D canvas. */
function makeSignTexture() {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 192;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0b0302";
  g.fillRect(0, 0, c.width, c.height);
  g.font = "900 136px 'Arial Black', 'Helvetica Neue', Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = "rgba(255,40,30,0.9)";
  g.shadowBlur = 18;
  g.fillStyle = "#ff3b2a";
  g.fillText("EXIT", c.width / 2, c.height / 2 + 6);
  g.shadowBlur = 0;
  g.fillStyle = "#ffb1a3";
  g.globalAlpha = 0.35;
  g.fillText("EXIT", c.width / 2, c.height / 2 + 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
