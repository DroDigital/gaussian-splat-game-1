import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./style.css";

import * as THREE from "three";
import { Controls } from "../input/controls";
import { DynamicResolution } from "../perf";
import { BackroomsAudio } from "./audio";
import { CELL, FOG, GAME, PLAYER, QUALITY, type QualityName, SHIFT, WALL_H } from "./config";
import { Entity } from "./entity";
import { BackroomsHud } from "./hud";
import { BackroomsPost } from "./post";
import { SplatFx } from "./splats";
import { Surfaces } from "./surfaces";
import { buildTextures } from "./textures";
import { ET, World, type Camera2D, cellKey, flicker, hash } from "./world";

const params = new URLSearchParams(location.search);
const DEBUG = params.has("debug");
type Desktop = { quit: () => void; isDesktop: boolean };
const desktop = (window as unknown as { desktop?: Desktop }).desktop;

// ---------------------------------------------------------------- quality
const touch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
let stored: string | null = null;
try {
  stored = localStorage.getItem("br-quality");
} catch {
  /* private mode */
}
const qWanted = (params.get("quality") || stored || (touch ? "low" : "high")) as QualityName;
const quality: QualityName = qWanted in QUALITY ? qWanted : "high";
const Q = QUALITY[quality];
const texSize = Number(params.get("tex")) || Q.tex;

// ---------------------------------------------------------------- renderer
const canvas = document.createElement("canvas");
canvas.id = "view";
document.body.appendChild(canvas);
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  stencil: false,
  powerPreference: "high-performance",
  preserveDrawingBuffer: params.has("capture"),
});
renderer.setClearColor(0x000000, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(74, 1, 0.05, 140);
camera.rotation.order = "YXZ";
scene.add(camera);

const textures = buildTextures(renderer, texSize, Q.aniso);
const surfaces = new Surfaces(textures, new Uint8Array(64 * 64 * 4), quality === "low");
scene.add(surfaces.group);
const splats = new SplatFx(renderer, scene, Number(params.get("dust")) || Q.dust);
const post = new BackroomsPost(renderer, scene, camera, Q.bloom);
const audio = new BackroomsAudio();
const controls = new Controls(canvas);
const drs = new DynamicResolution(Q.minScale, Math.min(Q.maxScale, Math.max(1, window.devicePixelRatio)), Math.min(1, Q.maxScale));
const entity = new Entity(splats.entity, 1e9);

// ---------------------------------------------------------------- state
type Phase = "title" | "playing" | "paused" | "dead" | "escaped";
const S = {
  phase: "title" as Phase,
  level: Number(params.get("level")) || 0,
  clock: 0,
  playT: 0,
  dist: 0,
  sanity: 1,
  stamina: 1,
  endT: 0,
  shiftCool: 0,
  bob: 0,
  lastStep: 0,
  power: 1,
  exitToasted: false,
};
let world = makeWorld();
const player = { x: 1.5, z: 1.5, eyeY: PLAYER.eye };

function makeWorld() {
  const seed = Number(params.get("seed")) || Math.floor(Math.random() * 0xffffffff);
  const exitDelay = GAME.exitDelay + S.level * 18 + Math.random() * GAME.exitDelayJitter;
  const w = new World(seed + S.level * 7919, S.level, exitDelay, S.clock);
  surfaces.gridTex.image.data = w.grid;
  surfaces.gridTex.needsUpdate = true;
  const tint = levelTint(S.level);
  surfaces.uniforms.uTint.value.set(tint[0], tint[1], tint[2]);
  return w;
}

function levelTint(level: number): [number, number, number] {
  // deeper levels drift dingier and greener
  const k = Math.min(1, level / 5);
  return [1 - 0.12 * k, 1 - 0.05 * k, 1 - 0.2 * k];
}

const hud = new BackroomsHud(
  {
    start: () => beginPlay(),
    resume: () => resume(),
    restart: () => beginPlay(),
    menu: () => toTitle(),
    next: () => {
      S.level++;
      beginPlay();
    },
    quality: (q) => setQuality(q),
    quit: desktop ? () => desktop.quit() : undefined,
  },
  touch,
  !!desktop,
);
hud.setQuality(quality);
document.addEventListener("br-pause", () => pause());
controls.onPause = () => {
  if (S.phase === "playing") pause();
};
canvas.addEventListener("click", () => {
  if (S.phase === "playing" && !document.pointerLockElement) controls.requestLock();
});

function setQuality(q: QualityName) {
  try {
    localStorage.setItem("br-quality", q);
  } catch {
    /* ignore */
  }
  const u = new URL(location.href);
  u.searchParams.delete("quality");
  location.replace(u.toString());
}

function beginPlay() {
  S.phase = "playing";
  S.playT = 0;
  S.dist = 0;
  S.sanity = 1;
  S.stamina = 1;
  S.endT = 0;
  S.exitToasted = false;
  world = makeWorld();
  player.x = 1.5;
  player.z = 1.5;
  player.eyeY = PLAYER.eye;
  controls.yaw = Math.random() * Math.PI * 2;
  controls.pitch = 0;
  entity.reset(S.clock + Math.max(22, GAME.entityDelay - S.level * 8));
  for (const b of splats.bottles) b.visible = false;
  post.cam.set("uFade", 0);
  post.cam.set("uFlash", 0);
  hud.show(null);
  controls.enabled = true;
  controls.requestLock();
  audio.start();
  hud.toast(S.level === 0 ? "find an exit." : `level ${S.level}. it is darker here.`, 3.5);
}

function pause() {
  if (S.phase !== "playing") return;
  S.phase = "paused";
  controls.enabled = false;
  controls.releaseLock();
  hud.show("pause");
}

function resume() {
  if (S.phase !== "paused") return;
  S.phase = "playing";
  hud.show(null);
  controls.enabled = true;
  controls.requestLock();
  audio.start();
}

function toTitle() {
  S.phase = "title";
  controls.enabled = false;
  controls.releaseLock();
  entity.reset(1e9);
  world = makeWorld();
  hud.show("title");
}

function die() {
  S.phase = "dead";
  S.endT = 0;
  controls.enabled = false;
  controls.releaseLock();
  audio.jumpscare();
}

function escape() {
  S.phase = "escaped";
  S.endT = 0;
  controls.enabled = false;
  controls.releaseLock();
  audio.escape();
}

// ---------------------------------------------------------------- resize / resolution
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(drs.scale);
  renderer.setSize(w, h, false);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  post.setSize(w, h);
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- debug overlay
const dbg = { frozen: false, god: false, map: DEBUG, timeScale: 1 };
let mapCtx: CanvasRenderingContext2D | null = null;
let statsEl: HTMLDivElement | null = null;
if (DEBUG) {
  const c = document.createElement("canvas");
  c.id = "br-debug";
  c.width = 260;
  c.height = 260;
  document.body.appendChild(c);
  mapCtx = c.getContext("2d");
  statsEl = document.createElement("div");
  statsEl.id = "br-stats";
  document.body.appendChild(statsEl);
  void import("lil-gui").then(({ default: GUI }) => {
    const gui = new GUI({ title: "backrooms · debug" });
    gui.add(dbg, "frozen").name("freeze shifting");
    gui.add(dbg, "god").name("entity harmless");
    gui.add(dbg, "map");
    gui.add(dbg, "timeScale", 0, 4, 0.1);
    gui.add(surfaces.uniforms.uLightInt, "value", 0, 20).name("light");
    gui.add(surfaces.uniforms.uBounce, "value", 0, 2).name("bounce");
    gui.add(surfaces.uniforms.uFogDensity, "value", 0, 0.1).name("fog");
    gui.add({ exitNow: () => (world.exitDueAt = 0) }, "exitNow").name("exit due now");
    gui.add({ entityNow: () => (entity.spawnAt = 0) }, "entityNow").name("spawn entity");
    gui.close();
  });
}

function drawMap() {
  if (!mapCtx || !dbg.map) return;
  const g = mapCtx;
  const W = 260, s = 9; // px per cell
  g.clearRect(0, 0, W, W);
  const pcx = player.x / CELL, pcz = player.z / CELL;
  const X = (cx: number) => W / 2 + (cx - pcx) * s, Z = (cz: number) => W / 2 + (cz - pcz) * s;
  for (const c of world.cells.values()) {
    if (c.light > 0) {
      g.fillStyle = c.visible ? "rgba(255,230,120,0.5)" : "rgba(255,230,120,0.15)";
      g.fillRect(X(c.cx + 0.4), Z(c.cz + 0.4), 2, 2);
    }
    if (world.flow.has(c.key)) {
      g.fillStyle = "rgba(80,160,255,0.08)";
      g.fillRect(X(c.cx), Z(c.cz), s, s);
    }
  }
  for (const e of world.edges.values()) {
    if (e.type === ET.Open) continue;
    const recent = e.fadeIn > world.clockNow - 1.5;
    g.strokeStyle = e.type === ET.Exit ? "#3f6" : recent ? "#f44" : e.visible ? "#ffe680" : "rgba(255,230,128,0.3)";
    g.lineWidth = e.type === ET.Wall || e.type === ET.Exit ? 2 : 1;
    g.beginPath();
    if (e.dir === 0) {
      g.moveTo(X(e.cx + 1), Z(e.cz));
      g.lineTo(X(e.cx + 1), Z(e.cz + 1));
    } else {
      g.moveTo(X(e.cx), Z(e.cz + 1));
      g.lineTo(X(e.cx + 1), Z(e.cz + 1));
    }
    g.stroke();
  }
  // view cone
  const hf = halfFov();
  g.strokeStyle = "rgba(255,255,255,0.4)";
  g.beginPath();
  for (const a of [-hf, hf]) {
    const ang = controls.yaw + a;
    g.moveTo(W / 2, W / 2);
    g.lineTo(W / 2 - Math.sin(ang) * 120, W / 2 - Math.cos(ang) * 120);
  }
  g.stroke();
  g.fillStyle = "#fff";
  g.fillRect(W / 2 - 2, W / 2 - 2, 4, 4);
  if (entity.active) {
    g.fillStyle = entity.observed ? "#f0f" : "#f22";
    g.fillRect(X(entity.x / CELL) - 3, Z(entity.z / CELL) - 3, 6, 6);
  }
}

// ---------------------------------------------------------------- per-frame helpers
function halfFov() {
  return Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
}

const cam2D: Camera2D = { x: 0, z: 0, fx: 0, fz: -1, halfFov: 1 };
const fwd = new THREE.Vector3();
let bottleT = 0;
type BottleSlot = { key: number; x: number; z: number };
const bottleSlots: (BottleSlot | null)[] = [null, null, null, null, null, null];

function updateBottles(dt: number) {
  bottleT -= dt;
  if (bottleT > 0 && !world.almondDirty) return;
  bottleT = 0.25;
  world.almondDirty = false;
  const near: BottleSlot[] = [];
  for (const c of world.cells.values()) {
    if (!c.almond || c.dist > 7) continue;
    const h1 = hash(c.cx, c.cz, 77, c.ver, world.seed), h2 = hash(c.cx, c.cz, 78, c.ver, world.seed);
    near.push({ key: c.key, x: (c.cx + 0.25 + 0.5 * h1) * CELL, z: (c.cz + 0.25 + 0.5 * h2) * CELL });
  }
  near.sort((a, b) => Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z));
  for (let i = 0; i < splats.bottles.length; i++) {
    const s = near[i] ?? null;
    bottleSlots[i] = s;
    const m = splats.bottles[i];
    m.visible = !!s;
    if (s) {
      m.position.set(s.x, 0, s.z);
      m.rotation.set(0, (s.key % 628) / 100, 0);
    }
  }
}

function pickupBottles() {
  for (let i = 0; i < bottleSlots.length; i++) {
    const s = bottleSlots[i];
    if (!s || Math.hypot(s.x - player.x, s.z - player.z) > 0.65) continue;
    const c = world.cells.get(s.key);
    if (c) c.almond = false;
    bottleSlots[i] = null;
    splats.bottles[i].visible = false;
    world.almondDirty = true;
    S.sanity = Math.min(1, S.sanity + GAME.almond / 100);
    audio.gulp();
    hud.toast("almond water. your head clears a little.");
  }
}

// ---------------------------------------------------------------- loop
const timer = new THREE.Timer();
let fpsAcc = 0, fpsN = 0, fpsShow = 0, fpsT = 0;

function frame(ts: number) {
  timer.update(ts);
  const rawDt = Math.min(0.1, timer.getDelta());
  if (drs.sample(rawDt * 1000)) resize();
  const dt = rawDt * dbg.timeScale;
  const live = S.phase !== "paused";
  if (live) S.clock += dt;
  const now = S.clock;
  world.clockNow = now;
  fpsAcc += rawDt;
  fpsN++;
  if (ts - fpsT > 500) {
    fpsShow = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
    fpsT = ts;
  }

  const playing = S.phase === "playing";
  // ---- movement + collision
  if (playing) {
    S.playT += dt;
    const inp = controls.sample();
    const wantRun = inp.run && S.stamina > 0.05 && inp.z > 0.2;
    S.stamina = Math.max(0, Math.min(1, S.stamina + (wantRun ? -PLAYER.staminaDrain : PLAYER.staminaRegen) * dt));
    const speed = wantRun ? PLAYER.run : PLAYER.walk;
    const sy = Math.sin(controls.yaw), cy = Math.cos(controls.yaw);
    const vx = (-sy * inp.z + cy * inp.x) * speed * dt;
    const vz = (-cy * inp.z - sy * inp.x) * speed * dt;
    const moved = world.collide(player.x + vx, player.z + vz, PLAYER.radius);
    const d = Math.hypot(moved.x - player.x, moved.z - player.z);
    player.x = moved.x;
    player.z = moved.z;
    S.dist += d;
    // head bob + footsteps
    S.bob += (d / Math.max(dt, 1e-4)) * dt * PLAYER.bobFreq * 1.6;
    const step = Math.floor(S.bob / Math.PI);
    if (step !== S.lastStep && d > 0.001) {
      S.lastStep = step;
      audio.footstep(wantRun);
    }
  } else if (S.phase === "title") {
    controls.yaw += dt * 0.07;
    player.x = 1.5;
    player.z = 1.5;
  }

  // ---- camera
  const sway = playing ? Math.sin(now * 0.7) * 0.004 + Math.sin(now * 1.9) * 0.002 : 0;
  const bobY = Math.sin(S.bob) * 0.028;
  const bobX = Math.cos(S.bob * 0.5) * 0.012;
  camera.position.set(player.x + Math.cos(controls.yaw) * bobX, player.eyeY + bobY, player.z - Math.sin(controls.yaw) * bobX);
  const insanity = 1 - S.sanity;
  let roll = sway * 2 + Math.sin(now * 0.37) * 0.03 * insanity * insanity;
  let yaw = controls.yaw, pitch = controls.pitch + sway;
  if (S.phase === "dead") {
    // the jumpscare: it is right there
    const k = Math.min(1, S.endT * 6);
    camera.getWorldDirection(fwd);
    entity.mesh.visible = S.endT < 1.2;
    entity.mesh.position.set(camera.position.x + fwd.x * (1.6 - k), 0, camera.position.z + fwd.z * (1.6 - k));
    entity.mesh.position.y = camera.position.y - 2.05;
    entity.mesh.rotation.y = Math.atan2(camera.position.x - entity.mesh.position.x, camera.position.z - entity.mesh.position.z);
    roll += (Math.random() - 0.5) * 0.08;
    yaw += (Math.random() - 0.5) * 0.03;
    pitch += (Math.random() - 0.5) * 0.03;
  }
  camera.rotation.set(pitch, yaw, roll);
  camera.updateMatrixWorld();
  camera.getWorldDirection(fwd);

  // ---- world shifting
  const shifting = S.phase === "playing" || S.phase === "title";
  if (shifting) {
    cam2D.x = camera.position.x;
    cam2D.z = camera.position.z;
    const l = Math.hypot(fwd.x, fwd.z) || 1;
    cam2D.fx = fwd.x / l;
    cam2D.fz = fwd.z / l;
    cam2D.halfFov = halfFov();
    world.frozen = dbg.frozen;
    world.instability = 1 - 0.55 * insanity;
    world.update(now, dt, cam2D);
    if (world.shiftedBehind > 5 && S.shiftCool <= 0 && playing) {
      const sx = world.shiftDir.x, sz = world.shiftDir.z;
      const l2 = Math.hypot(sx, sz) || 1;
      audio.shift((sx * Math.cos(controls.yaw) - sz * Math.sin(controls.yaw)) / l2, world.shiftedBehind);
      S.shiftCool = 3 + Math.random() * 4;
    }
    S.shiftCool -= dt;
  }
  if (world.geomDirty) {
    surfaces.rebuild(world);
    world.geomDirty = false;
  }
  if (world.gridDirty) {
    surfaces.uploadGrid();
    world.gridDirty = false;
  }
  surfaces.follow(camera.position.x, camera.position.z);

  // ---- gameplay
  const light = world.lightAround(player.x, player.z, now);
  let flickNear = 1;
  {
    const pcx = Math.floor(player.x / CELL), pcz = Math.floor(player.z / CELL);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const c = world.cells.get(cellKey(pcx + dx, pcz + dz));
      if (c && c.flick && c.light > 0) flickNear = Math.min(flickNear, flicker(c.flick, c.phase / 63, now, pcx + dx, pcz + dz));
    }
  }
  if (playing) {
    updateBottles(dt);
    pickupBottles();
    const speedMul = (1 + S.level * 0.12) * (1 + insanity * 0.45);
    const ev = entity.update(now, dt, world, player.x, player.z, camera, speedMul);
    if (ev === "kill" && !dbg.god) die();
    else if (ev === "spotted") audio.sting();
    // sanity
    let drain = GAME.sanityDrain / 100;
    if (light < 0.18) drain *= GAME.sanityDarkMul;
    if (entity.active && entity.observed) drain *= GAME.sanityWatchMul * (entity.dist < 8 ? 1.6 : 1);
    else if (entity.active && entity.dist < 12) drain *= 1.5;
    S.sanity = Math.max(0, S.sanity - drain * dt);
    if (S.sanity <= 0 && !dbg.god) {
      // you collapse; it finds you
      entity.active = true;
      entity.mesh.visible = true;
      die();
    }
    // exit
    const ex = world.exitPos();
    if (ex) {
      if (world.exitSeen && !S.exitToasted) {
        S.exitToasted = true;
        hud.toast("an exit. don't look away from it.", 3.5);
      }
      const dx = player.x - ex.x, dz = player.z - ex.z;
      if (Math.hypot(dx, dz) < 0.78) escape();
    }
  } else if (S.phase === "dead" || S.phase === "escaped") {
    S.endT += rawDt;
    if (S.endT > 1.9 && S.endT - rawDt <= 1.9) hud.showEnd(S.phase === "escaped", S.level, S.playT, S.dist, world.totalShifts);
  }

  // ---- power: brownouts when sanity is low
  if (Math.random() < dt * insanity * insanity * 0.25) S.power = 0.25 + Math.random() * 0.4;
  S.power += (1 - S.power) * Math.min(1, dt * 3);

  // ---- uniforms
  const U = surfaces.uniforms;
  U.uTime.value = now;
  U.uCamPos.value.copy(camera.position);
  U.uPower.value = S.power;
  U.uFogDensity.value = FOG.density * (1 + insanity * 0.6);
  splats.agitation.value = entity.observed ? 1 : 0;
  splats.fogDensity.value = U.uFogDensity.value;
  splats.update(now, camera.position, 0.4 + 0.6 * light);

  // ---- post
  const near = entity.active ? Math.max(0, 1 - entity.dist / 9) : 0;
  let stat = near * near * (entity.observed ? 0.65 : 0.35);
  if (S.phase === "dead") stat = Math.min(1, 0.4 + S.endT * 1.2);
  const cam = post.cam;
  cam.set("uTime", now);
  cam.set("uStatic", stat);
  cam.set("uWarp", Math.max(0, insanity - 0.45) * 2.2);
  cam.set("uCA", 0.15 + insanity * 0.7 + near * 0.6);
  cam.set("uGrain", 0.042 + insanity * 0.05);
  cam.set("uFlash", S.phase === "escaped" ? Math.max(0, 1 - Math.abs(S.endT - 0.6) * 1.6) : 0);
  cam.set("uFade", S.phase === "dead" ? Math.min(1, Math.max(0, (S.endT - 0.9) * 1.4)) : S.phase === "escaped" ? Math.min(0.92, Math.max(0, (S.endT - 1.2) * 1.5)) : 0);
  post.render(rawDt);

  // ---- hud + audio
  hud.update({ time: S.playT, level: S.level, stamina: S.stamina, sanity: S.sanity, blink: Math.floor(now * 1.25) % 2 === 0 });
  audio.setListener(camera.position, fwd);
  const ep = world.exitPos();
  audio.update(rawDt, {
    light: light * S.power,
    flick: flickNear,
    entity: entity.active ? { x: entity.x, y: 1.7, z: entity.z } : null,
    entityDist: entity.dist,
    exit: ep ? { x: ep.x, y: 2.3, z: ep.z } : null,
    sanity: S.sanity,
    paused: !playing,
    alive: S.phase !== "dead",
  });
  drawMap();
  if (statsEl)
    statsEl.textContent = `${fpsShow.toFixed(0)} fps  ${drs.frameMs.toFixed(1)} ms  scale ${drs.scale.toFixed(2)}  ${quality}
boxes ${surfaces.count}  edges ${world.edges.size}  reach ${world.reach}
shifts ${world.totalShifts}  sanity ${(S.sanity * 100).toFixed(0)}  light ${light.toFixed(2)}
entity ${entity.active ? `${entity.dist.toFixed(1)} m${entity.observed ? " (seen)" : ""}` : "-"}  exit ${world.exit ? (world.exitSeen ? "seen" : "placed") : `in ${Math.max(0, world.exitDueAt - now).toFixed(0)} s`}`;
  requestAnimationFrame(frame);
}

hud.show("title");
hud.ready("enter");
requestAnimationFrame(frame);
if (params.has("autostart")) beginPlay();

// test / automation hooks
Object.assign(window, {
  __br: {
    S,
    get world() {
      return world;
    },
    player,
    controls,
    camera,
    entity,
    surfaces,
    drs,
    dbg,
    begin: () => beginPlay(),
    /** Teleport + aim (yaw/pitch in radians). */
    put(x: number, z: number, yaw = controls.yaw, pitch = 0) {
      player.x = x;
      player.z = z;
      controls.yaw = yaw;
      controls.pitch = pitch;
    },
    /** Run the world's shifting logic for `seconds` with the current camera, without rendering. */
    simulate(seconds: number, yaw = controls.yaw) {
      const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const c: Camera2D = { x: player.x, z: player.z, fx: f.x, fz: f.z, halfFov: halfFov() };
      const steps = Math.round(seconds * 30);
      for (let i = 0; i < steps; i++) {
        S.clock += 1 / 30;
        world.update(S.clock, 1 / 30, c);
      }
    },
    /** Edge types in a square around the player (for diffing layouts). */
    snapshot(radius = 6) {
      const pcx = Math.floor(player.x / CELL), pcz = Math.floor(player.z / CELL);
      const out: Record<string, number> = {};
      for (let cz = pcz - radius; cz <= pcz + radius; cz++)
        for (let cx = pcx - radius; cx <= pcx + radius; cx++) for (const dir of [0, 1]) out[`${cx},${cz},${dir}`] = world.typeAt(cx, cz, dir);
      return out;
    },
    WALL_H,
    SHIFT,
  },
});
