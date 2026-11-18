// Subtle bloom + film grain + overcast grade (lifted blacks, low contrast,
// desaturation), using pmndrs postprocessing.

import { BlendFunction, BloomEffect, EffectComposer, EffectPass, Effect, NoiseEffect, RenderPass, VignetteEffect } from "postprocessing";
import * as THREE from "three";
import { POST } from "../look";

const GRADE_FRAG = /* glsl */ `
  uniform float lift;
  uniform float contrast;
  uniform float saturation;
  uniform float whiteout;
  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec3 c = pow(max(inputColor.rgb, 0.0), vec3(1.0 / 2.2));
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // keep foliage greens punchy: desaturate less where green dominates
    float greenness = clamp((c.g - max(c.r, c.b)) * 6.0, 0.0, 1.0);
    c = mix(vec3(l), c, mix(saturation, 1.08, greenness));
    c = (c - 0.5) * contrast + 0.5;
    c = lift + c * (1.0 - lift);
    c = mix(c, vec3(0.93, 0.935, 0.94), whiteout);
    outputColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(2.2)), inputColor.a);
  }
`;

class GradeEffect extends Effect {
  constructor() {
    super("GradeEffect", GRADE_FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ["lift", new THREE.Uniform(POST.lift)],
        ["contrast", new THREE.Uniform(POST.contrast)],
        ["saturation", new THREE.Uniform(POST.saturation)],
        ["whiteout", new THREE.Uniform(0)],
      ]),
    });
  }
}

export class Post {
  composer: EffectComposer;
  grade: GradeEffect;
  bloom: BloomEffect;
  noise: NoiseEffect;
  vignette: VignetteEffect;
  renderPass: RenderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new BloomEffect({
      intensity: POST.bloomIntensity,
      luminanceThreshold: POST.bloomThreshold,
      luminanceSmoothing: POST.bloomSmoothing,
      mipmapBlur: true,
      radius: 0.7,
    });
    this.grade = new GradeEffect();
    this.noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    this.noise.blendMode.opacity.value = POST.grain * 2.2;
    this.vignette = new VignetteEffect({ darkness: POST.vignette, offset: 0.35 });
    this.composer.addPass(new EffectPass(camera, this.bloom, this.grade, this.vignette));
    this.composer.addPass(new EffectPass(camera, this.noise));
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h, false);
  }

  setVortex(v: number, whiteout: number) {
    this.grade.uniforms.get("whiteout")!.value = whiteout;
    this.vignette.darkness = POST.vignette + v * 0.35;
    this.noise.blendMode.opacity.value = POST.grain * 2.2 * (1 + v * 1.5);
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}
