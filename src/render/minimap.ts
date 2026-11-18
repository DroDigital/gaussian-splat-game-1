// Picture-in-picture overview: dark grey grid floor + the live splat world seen
// from above, in a green-bordered node-viewer frame labelled `geo_splats`.
// A second SparkRenderer (its own sort for the top-down view) renders into an
// offscreen target at a low rate; the result is composited into the canvas.

import { SparkRenderer } from "@sparkjsdev/spark";
import * as THREE from "three";
import { MINIMAP } from "../look";
import type { AnchorState } from "../game/anchors";
import { MINIMAP_LAYER } from "./spark";

const GRID_FRAG = /* glsl */ `
  uniform vec3 base;
  uniform vec3 line;
  varying vec3 vWorld;
  void main() {
    vec2 g = abs(fract(vWorld.xz / 5.0 - 0.5) - 0.5) / fwidth(vWorld.xz / 5.0);
    float l = 1.0 - min(min(g.x, g.y), 1.0);
    vec2 g2 = abs(fract(vWorld.xz / 25.0 - 0.5) - 0.5) / fwidth(vWorld.xz / 25.0);
    float l2 = 1.0 - min(min(g2.x, g2.y), 1.0);
    vec3 c = mix(base, line, max(l * 0.6, l2));
    gl_FragColor = vec4(c, 1.0);
  }
`;
const GRID_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

export class Minimap {
  spark: SparkRenderer;
  camera = new THREE.PerspectiveCamera(32, 1, 1, 2000);
  frame: HTMLDivElement;
  marks: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private grid: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quadMat: THREE.MeshBasicMaterial;
  private since = 1;
  /** Whole-scene overview (edit mode) instead of following the player. */
  overview = false;
  span = 72;
  center = new THREE.Vector3();
  groundY = 0;
  boundsCenter = new THREE.Vector3();
  boundsSpan = 140;
  editPoints: number[] = [];
  onPick: ((x: number, z: number) => void) | null = null;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const px = MINIMAP.targetPx;
    this.spark = new SparkRenderer({ renderer, target: { width: px, height: px, doubleBuffer: true }, sortRadial: false, maxStdDev: Math.sqrt(6) });
    this.camera.layers.set(0);
    this.camera.layers.enable(MINIMAP_LAYER);
    this.grid = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        vertexShader: GRID_VERT,
        fragmentShader: GRID_FRAG,
        uniforms: { base: { value: new THREE.Color(...MINIMAP.grid) }, line: { value: new THREE.Color(...MINIMAP.gridLine) } },
      }),
    );
    this.grid.layers.set(MINIMAP_LAYER);
    this.grid.frustumCulled = false;
    scene.add(this.grid);
    this.quadMat = new THREE.MeshBasicMaterial({ map: null, depthTest: false, depthWrite: false, toneMapped: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.quadMat);
    quad.frustumCulled = false;
    this.quadScene.add(quad);

    this.frame = document.createElement("div");
    this.frame.id = "minimap";
    this.frame.innerHTML = `<div class="mm-label">geo_splats</div><div class="mm-tag">viewer</div>`;
    this.marks = document.createElement("canvas");
    this.frame.appendChild(this.marks);
    document.body.appendChild(this.frame);
    this.ctx = this.marks.getContext("2d")!;
    this.frame.addEventListener("pointerdown", (e) => this.pick(e));
    this.setSize();
  }

  setSize() {
    const r = this.frame.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio);
    this.marks.width = Math.round(r.width * dpr);
    this.marks.height = Math.round(r.height * dpr);
  }

  setBounds(min: THREE.Vector3, max: THREE.Vector3, groundY: number) {
    this.boundsCenter.set((min.x + max.x) / 2, groundY, (min.z + max.z) / 2);
    this.boundsSpan = Math.max(max.x - min.x, max.z - min.z) * 1.08;
    this.groundY = groundY;
    this.grid.position.y = groundY - 0.08;
  }

  setOverview(on: boolean) {
    this.overview = on;
    this.frame.classList.toggle("big", on);
    requestAnimationFrame(() => this.setSize());
    this.since = 1;
  }

  private placeCamera(player: THREE.Vector3, yaw: number, vortex: number, time: number) {
    const span = this.overview ? this.boundsSpan : this.span;
    const c = this.overview ? this.boundsCenter : this.center.lerp(player, 0.25);
    const h = span / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const tilt = THREE.MathUtils.degToRad(MINIMAP.tiltDeg) * vortex;
    const swirl = vortex * (time * 0.6);
    this.camera.position.set(c.x + Math.sin(swirl) * Math.sin(tilt) * h, c.y + Math.cos(tilt) * h, c.z + Math.cos(swirl) * Math.sin(tilt) * h);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(c.x, c.y, c.z);
    this.camera.rotateZ(vortex * Math.sin(time * 0.8) * 0.4);
    this.camera.updateMatrixWorld();
    void yaw;
  }

  /** Render the top-down splat view into the offscreen target (throttled). */
  update(dt: number, scene: THREE.Scene, player: THREE.Vector3, yaw: number, vortex: number, time: number) {
    this.since += dt;
    if (this.since < 1 / MINIMAP.fps) return;
    this.since = 0;
    this.placeCamera(player, yaw, vortex, time);
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(new THREE.Color(...MINIMAP.grid), 1);
    const target = this.spark.renderTarget({ scene, camera: this.camera });
    this.renderer.setClearColor(prevClear, prevAlpha);
    if (!this.quadMat.map) this.quadMat.needsUpdate = true;
    this.quadMat.map = target.texture;
  }

  /** Composite the target into the canvas under the frame, and draw markers. */
  draw(anchors: AnchorState[], player: THREE.Vector3, yaw: number) {
    const r = this.frame.getBoundingClientRect();
    if (r.width < 4 || !this.quadMat.map) return;
    const ren = this.renderer;
    const canvas = ren.domElement;
    const cr = canvas.getBoundingClientRect();
    const sx = canvas.width / cr.width, sy = canvas.height / cr.height;
    const pr = ren.getPixelRatio();
    const x = (r.left - cr.left + 1) * sx / pr, w = (r.width - 2) * sx / pr;
    const y = (cr.bottom - r.bottom + 1) * sy / pr, h = (r.height - 2) * sy / pr;
    const prevAuto = ren.autoClear;
    ren.autoClear = false;
    ren.setRenderTarget(null);
    ren.setViewport(x, y, w, h);
    ren.setScissor(x, y, w, h);
    ren.setScissorTest(true);
    ren.render(this.quadScene, this.quadCam);
    ren.setScissorTest(false);
    ren.setViewport(0, 0, canvas.width / pr, canvas.height / pr);
    ren.autoClear = prevAuto;

    // markers
    const ctx = this.ctx;
    const W = this.marks.width, H = this.marks.height;
    ctx.clearRect(0, 0, W, H);
    const proj = (p: THREE.Vector3) => {
      const v = p.clone().project(this.camera);
      return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, ok: v.z < 1 };
    };
    const s = W / 220;
    for (const a of anchors) {
      if (!a.spotted && !this.overview) continue;
      const q = proj(a.center);
      if (!q.ok) continue;
      ctx.lineWidth = 1.5 * s;
      ctx.strokeStyle = a.locked ? "#46d36a" : "#e8e4d0";
      ctx.fillStyle = a.locked ? "rgba(70,211,106,0.85)" : "rgba(0,0,0,0)";
      ctx.beginPath();
      ctx.rect(q.x - 4 * s, q.y - 4 * s, 8 * s, 8 * s);
      ctx.fill();
      ctx.stroke();
    }
    if (this.editPoints.length) {
      ctx.strokeStyle = "#46d36a";
      ctx.fillStyle = "rgba(70,211,106,0.18)";
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      for (let i = 0; i < this.editPoints.length; i += 2) {
        const q = proj(new THREE.Vector3(this.editPoints[i], this.groundY, this.editPoints[i + 1]));
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      for (let i = 0; i < this.editPoints.length; i += 2) {
        const q = proj(new THREE.Vector3(this.editPoints[i], this.groundY, this.editPoints[i + 1]));
        ctx.fillStyle = "#46d36a";
        ctx.fillRect(q.x - 3 * s, q.y - 3 * s, 6 * s, 6 * s);
      }
    }
    // player arrow
    const pp = proj(player);
    ctx.save();
    ctx.translate(pp.x, pp.y);
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).add(player);
    const pf = proj(fwd);
    ctx.rotate(Math.atan2(pf.y - pp.y, pf.x - pp.x) + Math.PI / 2);
    ctx.fillStyle = "#46d36a";
    ctx.beginPath();
    ctx.moveTo(0, -7 * s);
    ctx.lineTo(4.5 * s, 5 * s);
    ctx.lineTo(0, 2.5 * s);
    ctx.lineTo(-4.5 * s, 5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private pick(e: PointerEvent) {
    if (!this.onPick) return;
    const r = this.frame.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const hit = new THREE.Vector3();
    if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.groundY), hit)) this.onPick(hit.x, hit.z);
  }
}
