// Found-footage camcorder look: HDR bloom on the fluorescent panels, ACES
// tone mapping, then barrel distortion, chromatic aberration, sanity warp,
// grain, tracking-line static, vignette, flash and fade.

import { BloomEffect, Effect, EffectAttribute, EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from "postprocessing";
import * as THREE from "three";

const CAM_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uStatic;
  uniform float uWarp;
  uniform float uCA;
  uniform float uFade;
  uniform float uFlash;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uDistort;
  float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 p = uv - 0.5;
    float r2 = dot(p, p);
    vec2 d = p * (1.0 + uDistort * (0.32 * r2 + 0.2 * r2 * r2));
    d += uWarp * 0.012 * vec2(sin(uv.y * 17.0 + uTime * 2.1), cos(uv.x * 13.0 + uTime * 1.7));
    float row = floor(uv.y * 220.0);
    float tear = step(0.975, h21(vec2(row, floor(uTime * 20.0)))) * uStatic;
    d.x += tear * (h21(vec2(row, uTime)) - 0.5) * 0.06;
    vec2 q = d * (1.0 - 0.055 * uDistort) + 0.5;
    float ca = (0.0018 + uCA * 0.007) * (0.6 + r2 * 3.0);
    vec3 col;
    col.r = texture(inputBuffer, q + d * ca).r;
    col.g = texture(inputBuffer, q).g;
    col.b = texture(inputBuffer, q - d * ca).b;
    if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) col = vec3(0.0);
    col *= 1.0 - uVignette * smoothstep(0.3, 0.95, length(p * vec2(1.05, 0.95)) * 1.35);
    float n = h21(uv * resolution + fract(uTime * 37.0) * 517.0);
    col += (n - 0.5) * uGrain * (0.55 + 0.3 * smoothstep(0.0, 0.5, dot(col, vec3(0.33))));
    col *= 0.975 + 0.025 * sin(uv.y * resolution.y * 1.5708);
    col = mix(col, vec3(n * 0.9), clamp(uStatic, 0.0, 1.0) * 0.8);
    col = mix(col, vec3(1.0, 0.98, 0.92), uFlash);
    col *= 1.0 - uFade;
    outputColor = vec4(col, 1.0);
  }
`;

export class CamcorderEffect extends Effect {
  constructor() {
    super("CamcorderEffect", CAM_FRAG, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ["uTime", new THREE.Uniform(0)],
        ["uStatic", new THREE.Uniform(0)],
        ["uWarp", new THREE.Uniform(0)],
        ["uCA", new THREE.Uniform(0)],
        ["uFade", new THREE.Uniform(0)],
        ["uFlash", new THREE.Uniform(0)],
        ["uVignette", new THREE.Uniform(0.55)],
        ["uGrain", new THREE.Uniform(0.06)],
        ["uDistort", new THREE.Uniform(0.45)],
      ]),
    });
  }
  set(name: string, v: number) {
    this.uniforms.get(name)!.value = v;
  }
}

export class BackroomsPost {
  composer: EffectComposer;
  cam = new CamcorderEffect();
  bloom: BloomEffect;
  private bloomPass: EffectPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, bloom: boolean) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new BloomEffect({ intensity: 0.85, luminanceThreshold: 1.05, luminanceSmoothing: 0.35, mipmapBlur: true, radius: 0.72 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.bloomPass = bloom ? new EffectPass(camera, this.bloom, tone) : new EffectPass(camera, tone);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new EffectPass(camera, this.cam));
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h, false);
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}
