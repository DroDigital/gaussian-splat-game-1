// Per-voxel stability (0 = melted smoke, 1 = photographic) stored as a small
// 3D grid: FIELD.ny horizontal slices tiled along X in one 2D atlas. Updated
// on the GPU every frame by ping-ponging two render targets: gaze-cone repair,
// decay toward a timer-driven floor, anchor bubbles. A tiny reduction pass is
// read back asynchronously a few times a second for the overall score.

import * as THREE from "three";
import { FIELD, GAZE } from "../look";

const NX = FIELD.nx, NY = FIELD.ny, NZ = FIELD.nz;
const RED_W = 64, RED_H = 16;

const VERT = /* glsl */ `
  out vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const UPDATE_FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  uniform sampler2D prev;
  uniform vec3 fmin;
  uniform vec3 fsize;
  uniform vec3 camPos;
  uniform vec3 camDir;
  uniform float dt;
  uniform float cosCone;
  uniform float cosConeSoft;
  uniform float range;
  uniform float repair;
  uniform float decayRate;
  uniform float floorV;
  uniform float nearR;
  uniform float nearK;
  uniform float force;
  uniform float anchorR;
  uniform vec4 anchors[5];
  out highp vec4 outColor;
  void main() {
    ivec2 ip = ivec2(gl_FragCoord.xy);
    vec4 s = texelFetch(prev, ip, 0);
    float tile = floor(float(ip.x) / ${NX}.0);
    float ix = float(ip.x) - tile * ${NX}.0;
    vec3 g = vec3((ix + 0.5) / ${NX}.0, (tile + 0.5) / ${NY}.0, (float(ip.y) + 0.5) / ${NZ}.0);
    vec3 p = fmin + g * fsize;
    float st = s.r;
    vec3 d = p - camPos;
    // test against the nearest point of the voxel column slab so tall walls repair
    float dist = length(d);
    float cosA = dot(d / max(dist, 1e-3), camDir);
    float cone = smoothstep(cosConeSoft, cosCone, cosA) * (1.0 - smoothstep(range * 0.8, range, dist));
    float near = (1.0 - smoothstep(nearR * 0.6, nearR, dist)) * nearK;
    float rep = max(cone, near);
    st += rep * repair * dt;
    if (st > floorV) st = mix(st, floorV, (1.0 - rep) * (1.0 - exp(-decayRate * dt)));
    for (int i = 0; i < 5; i++) {
      vec4 a = anchors[i];
      if (a.w > 0.0) {
        float b = 1.0 - smoothstep(anchorR - 1.2, anchorR, length(p - a.xyz));
        st = max(st, b * a.w);
      }
    }
    st = mix(st, 1.0, force);
    outColor = vec4(clamp(st, 0.0, 1.0), s.g, 0.0, 1.0);
  }
`;

const REDUCE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D field;
  out highp vec4 outColor;
  void main() {
    ivec2 o = ivec2(gl_FragCoord.xy);
    const int BW = ${(NX * NY) / RED_W};
    const int BH = ${NZ / RED_H};
    float sw = 0.0, w = 0.0;
    for (int y = 0; y < BH; y++) {
      for (int x = 0; x < BW; x++) {
        vec4 s = texelFetch(field, ivec2(o.x * BW + x, o.y * BH + y), 0);
        sw += s.r * s.g;
        w += s.g;
      }
    }
    outColor = vec4(sw / max(w, 1e-4), w / float(BW * BH), 0.0, 1.0);
  }
`;

export interface FieldParams {
  dt: number;
  floor: number;
  decayRate: number;
  force: number;
  /** 0 disables gaze repair (e.g. during the vortex endgame). */
  repairScale: number;
}

export class StabilityField {
  readonly min = new THREE.Vector3();
  readonly size = new THREE.Vector3(1, FIELD.height, 1);
  private rts: THREE.WebGLRenderTarget[];
  private cur = 0;
  private init: THREE.DataTexture;
  private updateMat: THREE.ShaderMaterial;
  private reduceMat: THREE.ShaderMaterial;
  private reduceRT: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private readBuf = new Uint8Array(RED_W * RED_H * 4);
  private reading = false;
  private sinceRead = 0;
  readonly anchors = Array.from({ length: 5 }, () => new THREE.Vector4());
  /** Last overall (occupancy-weighted) stability 0..1. */
  overall = 1;
  private needsReset = true;

  constructor(private renderer: THREE.WebGLRenderer) {
    const canHalf = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float");
    const mk = () =>
      new THREE.WebGLRenderTarget(NX * NY, NZ, {
        type: canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        generateMipmaps: false,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
      });
    this.rts = [mk(), mk()];
    this.init = new THREE.DataTexture(new Float32Array(NX * NY * NZ * 4), NX * NY, NZ, THREE.RGBAFormat, THREE.FloatType);
    this.updateMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: UPDATE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        prev: { value: this.init },
        fmin: { value: this.min },
        fsize: { value: this.size },
        camPos: { value: new THREE.Vector3() },
        camDir: { value: new THREE.Vector3(0, 0, -1) },
        dt: { value: 0 },
        cosCone: { value: Math.cos(THREE.MathUtils.degToRad(GAZE.coneDeg)) },
        cosConeSoft: { value: Math.cos(THREE.MathUtils.degToRad(GAZE.coneDeg + 7)) },
        range: { value: GAZE.rangeM },
        repair: { value: GAZE.repairRate },
        decayRate: { value: GAZE.decayRate },
        floorV: { value: GAZE.floorStart },
        nearR: { value: GAZE.nearRadius },
        nearK: { value: GAZE.nearStrength },
        force: { value: 0 },
        anchorR: { value: GAZE.anchorRadius },
        anchors: { value: this.anchors },
      },
    });
    this.reduceMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: REDUCE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: { field: { value: null } },
    });
    this.reduceRT = new THREE.WebGLRenderTarget(RED_W, RED_H, { type: THREE.UnsignedByteType, depthBuffer: false });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.updateMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get texture(): THREE.Texture {
    return this.rts[this.cur].texture;
  }

  /**
   * Configure bounds and per-voxel occupancy weights (one-time CPU pass over
   * splat centres at level load; never per frame).
   */
  configure(min: THREE.Vector3, max: THREE.Vector3, centers: Float32Array[], counts: number[]) {
    const pad = 3;
    this.min.set(min.x - pad, min.y - 0.5, min.z - pad);
    const sx = max.x - min.x + 2 * pad, sz = max.z - min.z + 2 * pad;
    this.size.set(sx, Math.max(FIELD.height, max.y - min.y + 1), sz);
    const occ = new Float32Array(NX * NY * NZ);
    for (let k = 0; k < centers.length; k++) {
      const c = centers[k];
      for (let i = 0; i < counts[k]; i++) {
        const gx = Math.floor(((c[i * 3] - this.min.x) / this.size.x) * NX);
        const gy = Math.floor(((c[i * 3 + 1] - this.min.y) / this.size.y) * NY);
        const gz = Math.floor(((c[i * 3 + 2] - this.min.z) / this.size.z) * NZ);
        if (gx < 0 || gy < 0 || gz < 0 || gx >= NX || gy >= NY || gz >= NZ) continue;
        occ[gz * NX * NY + gy * NX + gx] += 1;
      }
    }
    const data = this.init.image.data as Float32Array;
    for (let i = 0; i < NX * NY * NZ; i++) {
      data[i * 4] = 1;
      data[i * 4 + 1] = Math.min(1, occ[i] / 40);
      data[i * 4 + 2] = 0;
      data[i * 4 + 3] = 1;
    }
    this.init.needsUpdate = true;
    for (const a of this.anchors) a.set(0, 0, 0, 0);
    this.needsReset = true;
    this.overall = 1;
  }

  /** Restore stability to 1 everywhere (keeps occupancy). */
  reset() {
    this.needsReset = true;
    for (const a of this.anchors) a.set(0, 0, 0, 0);
    this.overall = 1;
  }

  step(camPos: THREE.Vector3, camDir: THREE.Vector3, p: FieldParams) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.autoClear = false;
    const u = this.updateMat.uniforms;
    this.quad.material = this.updateMat;
    if (this.needsReset) {
      u.prev.value = this.init;
      u.dt.value = 0;
      u.force.value = 0;
      r.setRenderTarget(this.rts[this.cur]);
      r.render(this.scene, this.cam);
      this.needsReset = false;
    }
    u.prev.value = this.rts[this.cur].texture;
    u.camPos.value.copy(camPos);
    u.camDir.value.copy(camDir).normalize();
    u.dt.value = p.dt;
    u.floorV.value = p.floor;
    u.decayRate.value = p.decayRate;
    u.force.value = p.force;
    u.repair.value = GAZE.repairRate * p.repairScale;
    u.nearK.value = GAZE.nearStrength * p.repairScale;
    const next = 1 - this.cur;
    r.setRenderTarget(this.rts[next]);
    r.render(this.scene, this.cam);
    this.cur = next;

    this.sinceRead += p.dt;
    if (!this.reading && this.sinceRead >= 0.2) {
      this.sinceRead = 0;
      this.quad.material = this.reduceMat;
      this.reduceMat.uniforms.field.value = this.texture;
      r.setRenderTarget(this.reduceRT);
      r.render(this.scene, this.cam);
      this.reading = true;
      r.readRenderTargetPixelsAsync(this.reduceRT, 0, 0, RED_W, RED_H, this.readBuf)
        .then(() => {
          let sw = 0, w = 0;
          for (let i = 0; i < RED_W * RED_H; i++) {
            const ww = this.readBuf[i * 4 + 1] / 255;
            sw += (this.readBuf[i * 4] / 255) * ww;
            w += ww;
          }
          if (w > 0) this.overall = sw / w;
        })
        .catch(() => {})
        .finally(() => {
          this.reading = false;
        });
      this.quad.material = this.updateMat;
    }
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    r.xr.enabled = prevXr;
  }
}
