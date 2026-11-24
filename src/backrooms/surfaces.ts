// Surfaces of the Backrooms: instanced wall boxes + infinite floor/ceiling,
// shaded by one custom shader that reads the world grid texture for
// fluorescent lights (with flicker), wall occlusion, analytic AO, water damage,
// damp carpet, ceiling panels, dissolve-in/out and fog.
// A depth-only pre-pass guarantees each pixel is shaded exactly once.

import * as THREE from "three";
import { ACTIVE_R, CELL, FOG, GRID_N, LIGHT, PALETTE, SHIFT, TILE, WALL_H, WALL_T } from "./config";
import type { TextureSet } from "./textures";
import type { World } from "./world";

const MAX_BOXES = 14000;

const COMMON = /* glsl */ `
  #define CELL ${CELL.toFixed(4)}
  #define WALL_H ${WALL_H.toFixed(4)}
  #define WALL_T ${WALL_T.toFixed(4)}
  #define GRID_N ${GRID_N}
  uniform float uTime;
  uniform float uFadeDur;
  float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
  bool dissolved(vec3 P, vec2 fade) {
    if (fade.y == 0.0) return false;
    float p = clamp((uTime - fade.x) / uFadeDur, 0.0, 1.0);
    float n = hash13(floor(P * 13.0)) * 0.65 + hash13(floor(P * 47.0)) * 0.35;
    float thr = fade.y > 0.0 ? p : 1.0 - p;
    return n > thr;
  }
`;

const WALL_VERT = /* glsl */ `
  invariant gl_Position;
  in vec3 iMin;
  in vec3 iMax;
  in vec3 iMat;
  out vec3 vWorld;
  out vec3 vN;
  out vec3 vLocal;
  flat out float vMat;
  flat out vec2 vFade;
  void main() {
    vec3 c = (iMin + iMax) * 0.5;
    vec3 s = iMax - iMin;
    vec3 p = c + position * s;
    vWorld = p;
    vN = normal;
    vLocal = position;
    vMat = iMat.x;
    vFade = iMat.yz;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const PLANE_VERT = /* glsl */ `
  invariant gl_Position;
  out vec3 vWorld;
  out vec3 vN;
  out vec3 vLocal;
  flat out float vMat;
  flat out vec2 vFade;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    vLocal = position;
    vMat = 0.0;
    vFade = vec2(0.0);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const DEPTH_FRAG = /* glsl */ `
  precision highp float;
  ${COMMON}
  in vec3 vWorld;
  flat in vec2 vFade;
  out highp vec4 outColor;
  void main() {
    if (dissolved(vWorld, vFade)) discard;
    outColor = vec4(0.0);
  }
`;

function surfaceFrag(surf: 0 | 1 | 2, lowQ: boolean) {
  return /* glsl */ `
  precision highp float;
  precision highp int;
  #define SURF ${surf}
  ${lowQ ? "#define LOWQ 1" : ""}
  ${COMMON}
  uniform sampler2D uGrid;
  uniform sampler2D uWallA; uniform sampler2D uWallN;
  uniform sampler2D uCarpetA; uniform sampler2D uCarpetN;
  uniform sampler2D uCeilA; uniform sampler2D uCeilN;
  uniform sampler2D uGrime;
  uniform sampler2D uSign;
  uniform vec3 uCamPos;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform vec3 uLightColor;
  uniform float uLightInt;
  uniform float uEmit;
  uniform vec3 uBounceColor;
  uniform float uBounce;
  uniform vec3 uAmbient;
  uniform float uPower;     // global mains flicker / sanity dimming
  uniform vec3 uTint;       // per-level colour drift
  uniform vec3 uDoorColor;
  in vec3 vWorld;
  in vec3 vN;
  in vec3 vLocal;
  flat in float vMat;
  flat in vec2 vFade;
  out highp vec4 outColor;

  const float TILE_WALL = ${TILE.wall.toFixed(4)};
  const float TILE_CARPET = ${TILE.carpet.toFixed(4)};
  const float TILE_CEIL = ${TILE.ceiling.toFixed(4)};
  const float TILE_GRIME = ${TILE.grime.toFixed(4)};

  ivec4 gridAt(ivec2 c) {
    return ivec4(texelFetch(uGrid, c & ivec2(GRID_N - 1), 0) * 255.0 + 0.5);
  }
  float transmit(int t) {
    // open, wall, door, half, window, exit
    return t == 0 ? 1.0 : t == 2 ? 0.55 : t == 3 ? 0.5 : t == 4 ? 0.3 : 0.0;
  }
  float blockAO(int t) {
    return t == 0 ? 0.0 : t == 2 ? 0.55 : t == 3 ? 0.5 : 1.0;
  }
  float aoCurve(float d) { return 0.4 + 0.6 * smoothstep(0.0, 0.8, max(d, 0.0)); }

  float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float vnoise1(float x) { float i = floor(x); float f = fract(x); float u = f * f * (3.0 - 2.0 * f); return mix(hash11(i), hash11(i + 1.0), u); }
  float flicker(int cls, float phase, vec2 cc) {
    if (cls == 0) return 1.0;
    float p = phase * 31.0 + cc.x * 0.37 + cc.y * 0.71;
    float t = uTime;
    if (cls == 1) {
      float n = vnoise1(t * 6.5 + p);
      float n2 = vnoise1(t * 29.0 + p * 3.1);
      return n > 0.34 ? 0.86 + 0.14 * n2 : 0.04 + 0.22 * n2;
    }
    float b = vnoise1(t * 1.6 + p);
    float s = fract(t * 13.0 + p) > 0.45 ? 1.0 : 0.0;
    return b > 0.6 ? s * 0.95 : 0.0;
  }
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

  void main() {
    vec3 P = vWorld;
  #if SURF == 0
    if (dissolved(P, vFade)) discard;
  #endif
    vec3 N0 = normalize(vN);
    vec3 V = normalize(uCamPos - P);
    // a wall face belongs to the cell it faces
    ivec2 c = ivec2(floor((P.xz + N0.xz * 0.03) / CELL));
    vec2 lc = P.xz - vec2(c) * CELL;   // 0..CELL inside the cell

    ivec4 g[9];
    for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) g[j * 3 + i] = gridAt(c + ivec2(i - 1, j - 1));

    // ---------------------------------------------------------------- material
    vec3 albedo; float rough; vec3 N = N0; vec3 emissive = vec3(0.0); float aoMat = 1.0;
    float spec = 1.0;
  #if SURF == 0
    if (vMat < 0.5 || vMat > 2.5) {
      vec2 uv;
      float along;
      if (abs(N0.x) > 0.5) { uv = vec2(P.z, P.y); along = P.z; }
      else if (abs(N0.z) > 0.5) { uv = vec2(P.x, P.y); along = P.x; }
      else { uv = P.xz; along = P.x; }
      uv /= TILE_WALL;
      vec4 A = texture(uWallA, uv);
      vec3 nm = texture(uWallN, uv).xyz * 2.0 - 1.0;
      albedo = A.rgb * uTint; rough = A.a;
      if (abs(N0.x) > 0.5) N = normalize(vec3(N0.x * nm.z, nm.y, nm.x));
      else if (abs(N0.z) > 0.5) N = normalize(vec3(nm.x, nm.y, N0.z * nm.z));
      vec4 gA = texture(uGrime, vec2(along, P.y) / TILE_GRIME);
      vec4 gB = texture(uGrime, vec2(along * 0.37 + 11.3, P.y * 0.37 + 3.1) / TILE_GRIME);
      float damage = smoothstep(0.5, 0.74, gB.r * 0.6 + gA.r * 0.4);
      float tide = 0.05 + damage * 0.62 + (gA.g - 0.5) * 0.18;
      float below = 1.0 - smoothstep(tide - 0.02, tide + 0.02, P.y);
      float line = exp(-pow((P.y - tide) / 0.014, 2.0)) * damage;
      albedo = mix(albedo, albedo * vec3(0.8, 0.71, 0.55), below * (0.3 + 0.7 * damage));
      albedo *= 1.0 - line * 0.45;
      albedo *= 0.88 + 0.16 * gB.g;
      albedo *= mix(0.68, 1.0, smoothstep(0.0, 0.16, P.y));
      float mould = gA.b * (1.0 - smoothstep(0.05, 0.55 + damage * 0.6, P.y));
      albedo *= 1.0 - mould * 0.45;
      albedo *= mix(0.86, 1.0, smoothstep(0.0, 0.35, WALL_H - P.y));
      rough = mix(rough, 0.5, below * damage);
    } else if (vMat < 1.5) {
      // painted steel exit door
      vec2 q = vec2(abs(N0.x) > 0.5 ? vLocal.z : vLocal.x, vLocal.y);
      albedo = pow(uDoorColor, vec3(2.2));
      vec4 gA = texture(uGrime, P.xy * 1.7 / TILE_GRIME + P.z * 0.3);
      albedo *= 0.82 + 0.3 * gA.g;
      float kick = 1.0 - step(-0.39, q.y);           // kick plate (bottom ~22 cm)
      float bar = step(abs(q.y + 0.02), 0.025);       // push bar
      float panel = step(0.38, abs(q.x)) + step(0.44, abs(q.y));
      albedo = mix(albedo, vec3(0.32, 0.31, 0.29), kick);
      albedo = mix(albedo, vec3(0.42, 0.42, 0.4), bar);
      albedo *= 1.0 - 0.15 * clamp(panel, 0.0, 1.0);
      rough = mix(0.45, 0.3, max(kick, bar));
    } else {
      // illuminated EXIT sign
      bool face = abs(N0.x) > 0.5 || abs(N0.z) > 0.5;
      vec2 sUv;
      if (abs(N0.x) > abs(N0.z)) sUv = vec2((N0.x > 0.0 ? -vLocal.z : vLocal.z), vLocal.y);
      else sUv = vec2((N0.z > 0.0 ? vLocal.x : -vLocal.x), vLocal.y);
      sUv += 0.5;
      bool front = face && (abs(N0.x) > 0.5 ? abs(vLocal.x) > 0.49 : abs(vLocal.z) > 0.49);
      albedo = vec3(0.03, 0.01, 0.01); rough = 0.4;
      if (front) {
        vec3 s = texture(uSign, sUv).rgb;
        emissive = s * vec3(6.0, 1.4, 1.1) * (0.9 + 0.1 * sin(uTime * 2.3));
      }
    }
  #elif SURF == 1
    vec2 uv = P.xz / TILE_CARPET;
    vec4 A = texture(uCarpetA, uv);
    vec3 nm = texture(uCarpetN, uv).xyz * 2.0 - 1.0;
    albedo = A.rgb * uTint; rough = A.a;
    N = normalize(vec3(nm.x, nm.z, nm.y));
    vec4 gA = texture(uGrime, P.xz / TILE_GRIME);
    vec4 gB = texture(uGrime, P.xz * 0.41 / TILE_GRIME + 0.3);
    float damp = smoothstep(0.5, 0.66, gA.a * 0.55 + gB.a * 0.45);
    albedo *= mix(1.0, 0.6, damp);
    albedo = mix(albedo, albedo * vec3(0.9, 0.82, 0.66), damp * 0.7);
    rough = mix(rough, 0.38, damp);
    N = normalize(mix(N, vec3(0.0, 1.0, 0.0), damp * 0.65));
    albedo *= 0.88 + 0.16 * gB.g;
    spec = 0.35 + damp * 1.4;
  #else
    vec2 uv = P.xz / TILE_CEIL;
    vec4 A = texture(uCeilA, uv);
    vec3 nm = texture(uCeilN, uv).xyz * 2.0 - 1.0;
    albedo = A.rgb * mix(vec3(1.0), uTint, 0.5); rough = A.a;
    N = normalize(vec3(nm.x, -nm.z, nm.y));
    vec2 tid = floor(P.xz / 0.6);
    float th = hash12(tid + 0.37);
    vec2 tl = fract(P.xz / 0.6);
    float I0 = float(g[4].b) / 255.0;
    bool inPanel = I0 > 0.0 && lc.x > 1.2 && lc.x < 1.8 && lc.y > 1.2 && lc.y < 2.4;
    if (inPanel) {
      float fl = flicker(g[4].a & 3, float(g[4].a >> 2) / 63.0, vec2(c)) * I0 * uPower;
      vec2 pl = lc - vec2(1.2, 1.2);
      float edge = min(min(pl.x, 0.6 - pl.x), min(pl.y, 1.2 - pl.y));
      float frame = 1.0 - step(0.022, edge);
      vec2 pr = abs(fract(pl * 95.0) - 0.5) * 2.0;
      float prism = 0.84 + 0.16 * (1.0 - pr.x) * (1.0 - pr.y);
      float dimEdge = smoothstep(0.0, 0.09, edge);
      emissive = (1.0 - frame) * uEmit * uLightColor * fl * prism * (0.88 + 0.12 * th) * (0.7 + 0.3 * dimEdge);
      albedo = mix(vec3(0.55, 0.54, 0.5), pow(vec3(${PALETTE.tbar.join(",")}), vec3(2.2)), frame);
      rough = 0.35; N = vec3(0.0, -1.0, 0.0);
    } else if (th > 0.986 && !(lc.x > 1.15 && lc.x < 1.85 && lc.y > 1.15 && lc.y < 2.45)) {
      albedo = vec3(0.004); aoMat = 0.25; N = vec3(0.0, -1.0, 0.0);   // missing tile: a black void
    } else {
      if (th < 0.09) {
        vec2 sc = vec2(0.3) + 0.4 * vec2(hash12(tid + 3.1), hash12(tid + 7.7));
        float r = length(tl - sc);
        float rad = 0.12 + 0.18 * hash12(tid + 9.9);
        float ringv = exp(-pow((r - rad) / 0.012, 2.0)) + 0.5 * exp(-pow((r - rad * 0.7) / 0.01, 2.0));
        float fill = 1.0 - smoothstep(rad - 0.02, rad, r);
        albedo *= mix(vec3(1.0), vec3(0.86, 0.75, 0.52), clamp(fill * 0.6 + ringv * 0.8, 0.0, 1.0));
      }
      if (th < 0.3) albedo *= vec3(1.0, 0.965, 0.86);
    }
  #endif

    // ---------------------------------------------------------------- light visibility through walls
    int eE = g[4].r & 15, eW = g[3].r & 15, eS = g[4].g & 15, eN = g[1].g & 15;
    float tE = transmit(eE), tW = transmit(eW), tS = transmit(eS), tN = transmit(eN);
    float vis[9];
    vis[4] = 1.0;
    vis[5] = tE; vis[3] = tW; vis[7] = tS; vis[1] = tN;
    // diagonals: max over the two L-shaped paths
    vis[8] = max(tE * transmit(g[5].g & 15), tS * transmit(g[7].r & 15));
    vis[6] = max(tW * transmit(g[3].g & 15), tS * transmit(g[6].r & 15));
    vis[2] = max(tE * transmit(g[2].g & 15), tN * transmit(g[1].r & 15));
    vis[0] = max(tW * transmit(g[0].g & 15), tN * transmit(g[0].r & 15));

    // ---------------------------------------------------------------- lights
    vec3 direct = vec3(0.0);
    float bounce = 0.0;
    float specAcc = 0.0;
    float a = max(rough * rough, 0.03);
    float a2 = a * a;
    for (int k = 0; k < 9; k++) {
      ivec4 gk = g[k];
      float I = float(gk.b) / 255.0;
      if (I <= 0.0) continue;
      ivec2 lcell = c + ivec2(k - (k / 3) * 3 - 1, k / 3 - 1);
      I *= flicker(gk.a & 3, float(gk.a >> 2) / 63.0, vec2(lcell)) * uPower;
      vec3 Lp = vec3((float(lcell.x) + 0.5) * CELL, WALL_H - 0.04, (float(lcell.y) + 0.6) * CELL);
      vec3 Lv = Lp - P;
      float d2 = dot(Lv, Lv);
      vec3 L = Lv * inversesqrt(d2);
      float dh = length(Lv.xz);
      float win = 1.0 - smoothstep(CELL * 0.85, CELL * 1.5, dh);
      float v = vis[k];
      float emitCos = 0.3 + 0.7 * clamp(L.y, 0.0, 1.0);
      float atten = win / (d2 * 0.24 + 0.55);
      float ndl = max(dot(N, L), 0.0);
      float w = I * v * emitCos * atten;
      direct += w * ndl;
      bounce += I * win * (0.3 + 0.7 * v) / (d2 * 0.09 + 1.0);
  #ifndef LOWQ
      vec3 H = normalize(L + V);
      float ndh = max(dot(N, H), 0.0);
      float D = a2 / (3.14159 * pow(ndh * ndh * (a2 - 1.0) + 1.0, 2.0));
      specAcc += w * ndl * D;
  #endif
    }

    // ---------------------------------------------------------------- ambient occlusion
    float ao = aoMat;
    float bE = blockAO(eE), bW = blockAO(eW), bS = blockAO(eS), bN = blockAO(eN);
    float dE = CELL - lc.x - WALL_T * 0.5, dW = lc.x - WALL_T * 0.5;
    float dS = CELL - lc.y - WALL_T * 0.5, dN = lc.y - WALL_T * 0.5;
  #if SURF == 0
    if (abs(N0.x) > 0.5) ao *= mix(1.0, aoCurve(dS), bS) * mix(1.0, aoCurve(dN), bN);
    else if (abs(N0.z) > 0.5) ao *= mix(1.0, aoCurve(dE), bE) * mix(1.0, aoCurve(dW), bW);
    ao *= mix(0.5, 1.0, smoothstep(0.0, 0.5, P.y)) * mix(0.68, 1.0, smoothstep(0.0, 0.4, WALL_H - P.y));
  #else
    ao *= mix(1.0, aoCurve(dE), bE) * mix(1.0, aoCurve(dW), bW) * mix(1.0, aoCurve(dS), bS) * mix(1.0, aoCurve(dN), bN);
  #endif
    // pillars at the four corners of this cell
    vec2 cw = vec2(c) * CELL;
    if (((g[4].r >> 4) & 1) == 1) ao *= aoCurve(length(P.xz - cw) - 0.3);
    if (((g[5].r >> 4) & 1) == 1) ao *= aoCurve(length(P.xz - cw - vec2(CELL, 0.0)) - 0.3);
    if (((g[7].r >> 4) & 1) == 1) ao *= aoCurve(length(P.xz - cw - vec2(0.0, CELL)) - 0.3);
    if (((g[8].r >> 4) & 1) == 1) ao *= aoCurve(length(P.xz - cw - vec2(CELL)) - 0.3);

  #if SURF == 2
    // glow spilling onto the tiles around a lit panel
    float I0g = float(g[4].b) / 255.0;
    if (I0g > 0.0) {
      vec2 pd = max(abs(lc - vec2(1.5, 1.8)) - vec2(0.3, 0.6), 0.0);
      float glow = exp(-length(pd) * 4.5) * I0g * flicker(g[4].a & 3, float(g[4].a >> 2) / 63.0, vec2(c)) * uPower;
      emissive += albedo * uLightColor * glow * 1.6;
    }
  #endif

    vec3 col = albedo * (uLightColor * direct * uLightInt + uBounceColor * bounce * uBounce + uAmbient) * ao;
    col += uLightColor * uLightInt * specAcc * 0.045 * spec * ao;
    col += emissive;

    float dist = length(P - uCamPos);
    float fog = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
    col = mix(col, uFogColor * (0.6 + 0.4 * uPower), fog);
    outColor = vec4(col, 1.0);
  }
  `;
}

export interface SurfaceUniforms {
  [k: string]: THREE.IUniform;
}

export class Surfaces {
  group = new THREE.Group();
  uniforms: SurfaceUniforms;
  gridTex: THREE.DataTexture;
  private wallGeo: THREE.InstancedBufferGeometry;
  private iMin: THREE.InstancedBufferAttribute;
  private iMax: THREE.InstancedBufferAttribute;
  private iMat: THREE.InstancedBufferAttribute;
  private floor: THREE.Mesh;
  private ceil: THREE.Mesh;
  private floorD: THREE.Mesh;
  private ceilD: THREE.Mesh;
  count = 0;

  constructor(tex: TextureSet, gridData: Uint8Array, lowQ: boolean) {
    this.gridTex = new THREE.DataTexture(gridData, GRID_N, GRID_N, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.gridTex.minFilter = THREE.NearestFilter;
    this.gridTex.magFilter = THREE.NearestFilter;
    this.gridTex.generateMipmaps = false;
    this.gridTex.needsUpdate = true;
    const c3 = (c: readonly number[]) => new THREE.Vector3(c[0], c[1], c[2]);
    this.uniforms = {
      uTime: { value: 0 },
      uFadeDur: { value: SHIFT.dissolve },
      uGrid: { value: this.gridTex },
      uWallA: { value: tex.wallA },
      uWallN: { value: tex.wallN },
      uCarpetA: { value: tex.carpetA },
      uCarpetN: { value: tex.carpetN },
      uCeilA: { value: tex.ceilA },
      uCeilN: { value: tex.ceilN },
      uGrime: { value: tex.grime },
      uSign: { value: tex.sign },
      uCamPos: { value: new THREE.Vector3() },
      uFogColor: { value: c3(FOG.color) },
      uFogDensity: { value: FOG.density },
      uLightColor: { value: c3(LIGHT.color) },
      uLightInt: { value: LIGHT.intensity },
      uEmit: { value: LIGHT.emit },
      uBounceColor: { value: c3(LIGHT.bounceColor) },
      uBounce: { value: LIGHT.bounce },
      uAmbient: { value: c3(LIGHT.ambient) },
      uPower: { value: 1 },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uDoorColor: { value: c3(PALETTE.door) },
    };
    const mat = (vert: string, surf: 0 | 1 | 2) =>
      new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: surfaceFrag(surf, lowQ), uniforms: this.uniforms, depthWrite: false, depthFunc: THREE.LessEqualDepth });
    const depthMat = (vert: string) =>
      new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: DEPTH_FRAG, uniforms: this.uniforms, colorWrite: false });

    // instanced walls
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.wallGeo = new THREE.InstancedBufferGeometry();
    this.wallGeo.index = box.index;
    this.wallGeo.setAttribute("position", box.getAttribute("position"));
    this.wallGeo.setAttribute("normal", box.getAttribute("normal"));
    this.iMin = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOXES * 3), 3);
    this.iMax = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOXES * 3), 3);
    this.iMat = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOXES * 3), 3);
    for (const a of [this.iMin, this.iMax, this.iMat]) a.setUsage(THREE.DynamicDrawUsage);
    this.wallGeo.setAttribute("iMin", this.iMin);
    this.wallGeo.setAttribute("iMax", this.iMax);
    this.wallGeo.setAttribute("iMat", this.iMat);
    this.wallGeo.instanceCount = 0;
    const wallsDepth = new THREE.Mesh(this.wallGeo, depthMat(WALL_VERT));
    const walls = new THREE.Mesh(this.wallGeo, mat(WALL_VERT, 0));
    for (const m of [wallsDepth, walls]) m.frustumCulled = false;

    // floor + ceiling: large planes that follow the player (shading is world-space)
    const size = (ACTIVE_R * 2 + 4) * CELL;
    const plane = new THREE.PlaneGeometry(size, size, 1, 1);
    this.floor = new THREE.Mesh(plane, mat(PLANE_VERT, 1));
    this.floor.rotation.x = -Math.PI / 2;
    this.ceil = new THREE.Mesh(plane, mat(PLANE_VERT, 2));
    this.ceil.rotation.x = Math.PI / 2;
    this.ceil.position.y = WALL_H;
    this.floorD = new THREE.Mesh(plane, depthMat(PLANE_VERT));
    this.floorD.rotation.x = -Math.PI / 2;
    this.ceilD = new THREE.Mesh(plane, depthMat(PLANE_VERT));
    this.ceilD.rotation.x = Math.PI / 2;
    this.ceilD.position.y = WALL_H;

    // depth pre-pass first, then shading with depthFunc <= and no depth writes
    wallsDepth.renderOrder = -3;
    this.floorD.renderOrder = -2;
    this.ceilD.renderOrder = -2;
    walls.renderOrder = 1;
    this.floor.renderOrder = 2;
    this.ceil.renderOrder = 2;
    for (const m of [wallsDepth, this.floorD, this.ceilD, walls, this.floor, this.ceil]) {
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  follow(x: number, z: number) {
    for (const m of [this.floor, this.ceil, this.floorD, this.ceilD]) {
      m.position.x = x;
      m.position.z = z;
    }
  }

  /** Rebuild the instance buffers from the world (no allocations). */
  rebuild(world: World) {
    const mn = this.iMin.array as Float32Array, mx = this.iMax.array as Float32Array, mt = this.iMat.array as Float32Array;
    let n = 0;
    world.emitAll((x0, y0, z0, x1, y1, z1, mat, fadeT, fadeDir) => {
      if (n >= MAX_BOXES) return;
      const o = n * 3;
      mn[o] = x0;
      mn[o + 1] = y0;
      mn[o + 2] = z0;
      mx[o] = x1;
      mx[o + 1] = y1;
      mx[o + 2] = z1;
      mt[o] = mat;
      mt[o + 1] = fadeT;
      mt[o + 2] = fadeDir;
      n++;
    });
    this.count = n;
    this.wallGeo.instanceCount = n;
    for (const a of [this.iMin, this.iMax, this.iMat]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * 3);
      a.needsUpdate = true;
    }
  }

  uploadGrid() {
    this.gridTex.needsUpdate = true;
  }
}
