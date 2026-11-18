import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./style.css";

import { type SplatMesh, utils as sparkUtils } from "@sparkjsdev/spark";
import * as THREE from "three";
import { Ambience } from "./audio/ambience";
import { ANCHOR_INFO, AnchorSystem, buildAnchorSplats } from "./game/anchors";
import { GameState, slide } from "./game/state";
import { Controls } from "./input/controls";
import { GAZE, LEVEL, QUALITY, type QualityName, VORTEX } from "./look";
import { Minimap } from "./render/minimap";
import { WorldFx } from "./render/modifiers";
import { Post } from "./render/post";
import { SKY_LAYER, createRenderer, createSpark, meshFromBuilder, meshesFromBuilder } from "./render/spark";
import { StabilityField } from "./render/stabilityField";
import { Hud } from "./ui/hud";
import { type ImportedScene, importSplatFile, relevel } from "./world/importScene";
import { PRESETS, presetById } from "./world/presets";
import type { AnchorKind } from "./world/presets";
import { type Level, buildSky, buildStreet } from "./world/streetGen";
import type { V3 } from "./world/splatBuilder";

const params = new URLSearchParams(location.search);
const DEBUG = params.has("debug");

// ---------------------------------------------------------------- setup
const canvas = document.createElement("canvas");
canvas.id = "view";
document.body.appendChild(canvas);
const renderer = createRenderer(canvas);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(VORTEX.fovBase, 1, 0.05, 700);
camera.layers.enable(SKY_LAYER);
camera.rotation.order = "YXZ";
scene.add(camera);

const spark = createSpark(renderer);
scene.add(spark);
const field = new StabilityField(renderer);
const fx = new WorldFx(field.texture);
const post = new Post(renderer, scene, camera);
const minimap = new Minimap(renderer, scene);
const controls = new Controls(canvas);
const ambience = new Ambience();
const anchors = new AnchorSystem();
const state = new GameState();

const touch = controls.touch;
let quality: QualityName = (params.get("quality") as QualityName) || (sparkUtils.isMobile() || touch ? "low" : "high");
if (!(quality in QUALITY)) quality = "high";

const hud = new Hud(
  {
    start: (id) => startPreset(id),
    resume: () => resume(),
    restart: () => restart(),
    quality: (q) => setQuality(q),
    importFile: (f) => void startImport(f),
    gyro: (on) => controls.enableGyro(on),
    editUndo: () => {
      if (editStage === "walkable") minimap.editPoints.splice(-2, 2);
      else undoAnchor();
    },
    editClear: () => {
      if (editStage === "walkable") minimap.editPoints.length = 0;
      else while (placed.length) undoAnchor();
    },
    editNext: () => editNext(),
    editScale: (k) => relevelImport(importFlip, importScale * k),
    editFlip: () => relevelImport(!importFlip, importScale),
    next: () => {
      const i = PRESETS.findIndex((p) => p.id === currentPresetId);
      startPreset(PRESETS[(i + 1) % PRESETS.length].id);
    },
  },
  touch,
);
hud.setQuality(quality);
document.addEventListener("hts-pause", () => pause());
controls.onPause = () => {
  if (state.phase === "playing") pause();
};

// ---------------------------------------------------------------- level
let level: Level | null = null;
let worldMeshes: SplatMesh[] = [];
let anchorMeshes: SplatMesh[] = [];
let splatCount = 0;
let currentPresetId: string | null = null;
let loadedKey = "";
let imported: ImportedScene | null = null;
let importFlip = false;
let importScale = 1;
const player = new THREE.Vector3();
let eyeY = LEVEL.eyeHeight;
let bob = 0;

function clearLevel() {
  for (const m of [...worldMeshes, ...anchorMeshes]) {
    scene.remove(m);
    if (!imported || m !== imported.mesh) m.dispose();
  }
  worldMeshes = [];
  anchorMeshes = [];
}

const nextFrame = () => new Promise((r) => setTimeout(r, 16));

async function loadPreset(id: string) {
  const preset = presetById(id);
  const key = `${preset.id}:${quality}`;
  if (key === loadedKey && level) return;
  hud.setLoading(`building ${preset.name.toLowerCase()}…`, false);
  await nextFrame();
  clearLevel();
  if (imported) {
    imported.mesh.dispose();
    imported = null;
  }
  const q = QUALITY[quality];
  const t0 = performance.now();
  const lv = buildStreet(preset, q.density);
  const anchorBuilders = lv.anchors.map((a, i) => buildAnchorSplats(a.kind, q.density, i + 1));
  const reserved = anchorBuilders.reduce((s, b) => s + b.count, 0) + lv.sky.count;
  lv.world.subsample((Number(params.get("budget")) || q.budget) - reserved);
  hud.setLoading(`packing ${(lv.world.count / 1e6).toFixed(2)}M splats…`, false);
  await nextFrame();
  const built = meshesFromBuilder(lv.world, fx, "world");
  worldMeshes = built.meshes;
  const sky = meshFromBuilder(lv.sky, fx, "sky");
  sky.layers.set(SKY_LAYER);
  worldMeshes.push(sky);
  for (let i = 0; i < lv.anchors.length; i++) {
    const a = lv.anchors[i];
    const m = meshFromBuilder(anchorBuilders[i], fx, "anchor");
    m.position.set(...a.pos);
    m.rotation.y = a.yaw;
    anchorMeshes.push(m);
  }
  for (const m of [...worldMeshes, ...anchorMeshes]) scene.add(m);
  splatCount = lv.world.count + lv.sky.count + anchorBuilders.reduce((s, b) => s + b.count, 0);
  console.info(`[hts] ${preset.name}: ${splatCount.toLocaleString()} splats in ${worldMeshes.length + anchorMeshes.length} meshes, built in ${(performance.now() - t0).toFixed(0)} ms`);

  const min = new THREE.Vector3(...lv.bounds.min), max = new THREE.Vector3(...lv.bounds.max);
  field.configure(min, max, [lv.world.pos], [lv.world.count]);
  fx.fieldMin.value.copy(field.min);
  fx.fieldSize.value.copy(field.size);
  minimap.setBounds(min, max, 0);
  anchors.reset(lv.anchors, lv.occluders);
  level = lv;
  currentPresetId = preset.id;
  loadedKey = key;
  hud.setLevelName(preset.name);
  placeAtSpawn();
  hud.setLoading(`${preset.name.toLowerCase()} · ${(splatCount / 1e6).toFixed(2)}M splats`, true);
}

function placeAtSpawn() {
  if (!level) return;
  player.set(level.spawn.x, 0, level.spawn.z);
  controls.yaw = level.spawn.yaw;
  controls.pitch = -0.03;
  eyeY = level.ground(player.x, player.z) + LEVEL.eyeHeight;
}

// ---------------------------------------------------------------- import / edit
type EditStage = "walkable" | "anchors";
let editStage: EditStage = "walkable";
const placed: { kind: AnchorKind; pos: V3; mesh: SplatMesh }[] = [];
const ANCHOR_ORDER: AnchorKind[] = ["cat", "vending", "parking", "bicycle", "lantern"];

async function startImport(file: File) {
  try {
    hud.show("title");
    hud.setLoading(`importing ${file.name}…`, false);
    controls.enabled = false;
    controls.releaseLock();
    const sc = await importSplatFile(file, (s) => hud.setLoading(s, false));
    clearLevel();
    if (imported) imported.mesh.dispose();
    imported = sc;
    importFlip = false;
    importScale = 1;
    sc.mesh.worldModifier = fx.modifier("import");
    sc.mesh.updateGenerator();
    worldMeshes = [sc.mesh];
    const sky = meshFromBuilder(buildSky(77, [0, 0, 0], [[0, -60], [0, 60]]), fx, "sky");
    sky.layers.set(SKY_LAYER);
    worldMeshes.push(sky);
    for (const m of worldMeshes) scene.add(m);
    splatCount = sc.mesh.numSplats;
    configureImported();
    currentPresetId = null;
    loadedKey = `import:${file.name}`;
    hud.setLevelName(sc.name);
    enterEdit();
  } catch (err) {
    console.error(err);
    hud.setLoading(`import failed: ${(err as Error).message}`, !!level);
    hud.toast(`import failed: ${(err as Error).message}`, 4);
  }
}

function configureImported() {
  if (!imported) return;
  const sc = imported;
  field.configure(sc.min, sc.max, [sc.sample], [sc.sampleCount]);
  fx.fieldMin.value.copy(field.min);
  fx.fieldSize.value.copy(field.size);
  minimap.setBounds(sc.min, sc.max, 0);
  level = {
    name: sc.name,
    presetId: null,
    world: null as never,
    sky: null as never,
    anchors: [],
    walkable: [sc.defaultWalkable],
    obstacles: [],
    ground: () => 0,
    spawn: { x: (sc.defaultWalkable[0] + sc.defaultWalkable[2]) / 2, z: (sc.defaultWalkable[1] + sc.defaultWalkable[5]) / 2, yaw: 0 },
    bounds: { min: sc.min.toArray() as V3, max: sc.max.toArray() as V3 },
    occluders: [],
  };
}

function relevelImport(flip: boolean, scale: number) {
  if (!imported) return;
  importFlip = flip;
  importScale = scale;
  relevel(imported, flip, scale);
  configureImported();
  minimap.editPoints.length = 0;
  hud.toast(`up axis ${flip ? "flipped" : "auto"} · scale ×${imported.scale.toFixed(2)}`);
}

function enterEdit() {
  state.phase = "edit";
  editStage = "walkable";
  minimap.editPoints.length = 0;
  minimap.setOverview(true);
  minimap.onPick = (x, z) => {
    if (editStage === "walkable") minimap.editPoints.push(x, z);
  };
  for (const p of placed) scene.remove(p.mesh);
  placed.length = 0;
  hud.show("edit");
  hud.setEdit("1 / 2 · draw the walkable area", "click / tap the overview to add polygon points (3+). flip / scale if the ground looks wrong.", "next: place anchors");
  if (level) placeAtSpawn();
}

function editNext() {
  if (!level) return;
  if (editStage === "walkable") {
    if (minimap.editPoints.length >= 6) level.walkable = [minimap.editPoints.slice()];
    const w = level.walkable[0];
    let cx = 0, cz = 0;
    for (let i = 0; i < w.length; i += 2) {
      cx += w[i];
      cz += w[i + 1];
    }
    player.set(cx / (w.length / 2), 0, cz / (w.length / 2));
    eyeY = LEVEL.eyeHeight;
    editStage = "anchors";
    minimap.setOverview(false);
    minimap.onPick = null;
    controls.enabled = true;
    hud.setEdit(
      "2 / 2 · place 5 anchors",
      touch ? "walk around, tap a surface to drop the next anchor" : "click to look around, then click a surface under the crosshair to drop the next anchor (Esc to free the mouse)",
      "start",
    );
    return;
  }
  if (placed.length < LEVEL.anchorCount) {
    hud.toast(`place ${LEVEL.anchorCount - placed.length} more anchor(s)`);
    return;
  }
  level.anchors = placed.map((p) => ({ kind: p.kind, pos: p.pos, yaw: 0 }));
  anchorMeshes = placed.map((p) => p.mesh);
  placed.length = 0;
  anchors.reset(level.anchors, []);
  minimap.editPoints.length = 0;
  beginPlay();
}

function undoAnchor() {
  const p = placed.pop();
  if (p) {
    scene.remove(p.mesh);
    p.mesh.dispose();
  }
}

const raycaster = new THREE.Raycaster();
function placeAnchorAt(ndcX: number, ndcY: number) {
  if (!imported || placed.length >= LEVEL.anchorCount) return;
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  let hit: THREE.Vector3 | null = null;
  try {
    const hits = raycaster.intersectObject(imported.mesh, false);
    if (hits.length) hit = hits[0].point.clone();
  } catch {
    /* fall through to the sample picker */
  }
  // fallback: nearest levelled splat centre within a thin cone around the ray
  if (!hit) {
    const { origin, direction } = raycaster.ray;
    const S = imported.sample;
    let bestT = Infinity;
    for (let i = 0; i < S.length; i += 3) {
      const dx = S[i] - origin.x, dy = S[i + 1] - origin.y, dz = S[i + 2] - origin.z;
      const t = dx * direction.x + dy * direction.y + dz * direction.z;
      if (t <= 0.3 || t >= bestT) continue;
      const px = dx - direction.x * t, py = dy - direction.y * t, pz = dz - direction.z * t;
      const r = Math.max(0.12, t * 0.012);
      if (px * px + py * py + pz * pz < r * r) bestT = t;
    }
    if (bestT < Infinity) hit = origin.clone().addScaledVector(direction, bestT);
  }
  if (!hit) {
    hud.toast("no surface there");
    return;
  }
  const kind = ANCHOR_ORDER[placed.length];
  const mesh = meshFromBuilder(buildAnchorSplats(kind, 1, placed.length + 1), fx, "anchor");
  mesh.position.copy(hit);
  mesh.rotation.y = controls.yaw + Math.PI;
  scene.add(mesh);
  placed.push({ kind, pos: hit.toArray() as V3, mesh });
  hud.toast(`${ANCHOR_INFO[kind].label} placed (${placed.length}/${LEVEL.anchorCount})`);
}

canvas.addEventListener("click", (e) => {
  if (state.phase === "edit" && editStage === "anchors") {
    if (touch) {
      const r = canvas.getBoundingClientRect();
      placeAnchorAt(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    } else if (document.pointerLockElement === canvas) placeAnchorAt(0, 0);
    else controls.requestLock();
    return;
  }
  if (state.phase === "playing" && !document.pointerLockElement) controls.requestLock();
});

// ---------------------------------------------------------------- phases
async function startPreset(id: string) {
  hud.show("title");
  controls.enabled = false;
  await loadPreset(id);
  beginPlay();
}

function beginPlay() {
  state.reset();
  field.reset();
  for (const m of anchorMeshes) {
    if (!scene.children.includes(m)) scene.add(m);
  }
  if (currentPresetId) placeAtSpawn();
  state.phase = "playing";
  hud.show(null);
  controls.enabled = true;
  controls.requestLock();
  ambience.start();
  hud.toast("look around. the street only holds where you look.", 3.5);
}

function pause() {
  if (state.phase !== "playing") return;
  state.phase = "paused";
  controls.enabled = false;
  controls.releaseLock();
  hud.show("pause");
}

function resume() {
  if (state.phase !== "paused") return;
  state.phase = "playing";
  hud.show(null);
  controls.enabled = true;
  controls.requestLock();
  ambience.start();
}

function restart() {
  if (currentPresetId) void startPreset(currentPresetId);
  else if (imported && level) {
    for (const a of anchors.items) a.locked = a.spotted = false;
    anchors.reset(level.anchors, []);
    placeAtSpawnImport();
    beginPlay();
  }
}

function placeAtSpawnImport() {
  if (!level) return;
  const w = level.walkable[0];
  player.set((w[0] + w[4]) / 2, 0, (w[1] + w[5]) / 2);
}

function setQuality(q: QualityName) {
  quality = q;
  resize();
  if (currentPresetId && state.phase !== "edit") {
    hud.toast(`quality: ${q} (${(QUALITY[q].budget / 1e6).toFixed(1)}M) — rebuilding`);
    void startPreset(currentPresetId);
  }
}

function win() {
  state.phase = "won";
  state.finish();
  controls.enabled = false;
  controls.releaseLock();
  hud.toast("the street holds", 3);
}

function lose() {
  state.phase = "lost";
  controls.enabled = false;
  controls.releaseLock();
}

// ---------------------------------------------------------------- resize
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[quality].pixelRatio));
  renderer.setSize(w, h, false);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  post.setSize(w, h);
  minimap.setSize();
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- debug
const dbg = { globalMelt: 0, vortexOverride: -1, timeScale: 1, freezeTimer: false, showStats: DEBUG, fps: 0 };
if (DEBUG) {
  void import("lil-gui").then(({ default: GUI }) => {
    const gui = new GUI({ title: "hold the street · debug" });
    gui.add(dbg, "globalMelt", 0, 1, 0.01).name("global melt");
    gui.add(dbg, "vortexOverride", -1, 1, 0.01).name("vortex (−1 = game)");
    gui.add(dbg, "timeScale", 0, 4, 0.1);
    gui.add(dbg, "freezeTimer");
    const m = gui.addFolder("melt");
    m.add(fx.m0.value, "x", 0, 1).name("stableAbove");
    m.add(fx.m0.value, "y", 0, 1).name("meltedBelow");
    m.add(fx.m0.value, "z", 0, 1).name("curlFreq");
    m.add(fx.m0.value, "w", 0, 8).name("curlAmp");
    m.add(fx.m1.value, "x", 0, 15).name("driftUp");
    m.add(fx.m1.value, "y", 1, 8).name("scaleMax");
    m.add(fx.m1.value, "z", 0, 8).name("stretch");
    m.add(fx.m1.value, "w", 0, 1).name("opacityMin");
    const v = gui.addFolder("vortex");
    v.add(fx.v0.value, "x", 0, 20).name("spin");
    v.add(fx.v0.value, "y", 0, 1).name("heightTwist");
    v.add(fx.v0.value, "z", 1, 60).name("falloffR");
    v.add(fx.v0.value, "w", 0, 1).name("pull");
    v.add(fx.v1.value, "y", 0, 2).name("lift");
    v.add(fx.v1.value, "z", 0, 10).name("sink");
    const h = gui.addFolder("haze");
    h.add(fx.h0.value, "x", 0, 100).name("fogStart");
    h.add(fx.h0.value, "y", 20, 200).name("fogEnd");
    h.add(fx.h0.value, "w", 10, 150).name("meltStart");
    gui.close();
  });
}
const statsEl = document.createElement("div");
statsEl.id = "stats";
statsEl.style.display = dbg.showStats ? "block" : "none";
document.body.appendChild(statsEl);

// ---------------------------------------------------------------- loop
const clock = new THREE.Timer();
let fpsAcc = 0, fpsN = 0, fpsT = 0;
let lockFlash = 0;
const camDir = new THREE.Vector3();
const vortexCenter = new THREE.Vector3();
const vortexTarget = new THREE.Vector3();

function frame(timestamp: number) {
  clock.update(timestamp);
  const rawDt = Math.min(0.1, clock.getDelta());
  const dt = rawDt * dbg.timeScale;
  const now = clock.getElapsed();
  fpsAcc += rawDt;
  fpsN++;
  if (now - fpsT > 0.5) {
    dbg.fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
    fpsT = now;
  }

  const phase = state.phase;
  const playing = phase === "playing";
  const live = playing || phase === "won" || phase === "lost" || phase === "edit" || phase === "title";

  // ---- movement
  if ((playing || (phase === "edit" && editStage === "anchors")) && level) {
    const inp = controls.sample();
    const speed = inp.run ? LEVEL.runSpeed : LEVEL.walkSpeed;
    const sy = Math.sin(controls.yaw), cy = Math.cos(controls.yaw);
    const vx = (-sy * inp.z + cy * inp.x) * speed * rawDt;
    const vz = (-cy * inp.z - sy * inp.x) * speed * rawDt;
    const moved = slide(level.walkable, level.obstacles, player.x, player.z, player.x + vx, player.z + vz);
    const dist = Math.hypot(moved.x - player.x, moved.z - player.z);
    player.x = moved.x;
    player.z = moved.z;
    bob += dist * 5.2;
    const gy = level.ground(player.x, player.z) + LEVEL.eyeHeight;
    eyeY += (gy - eyeY) * Math.min(1, rawDt * 8);
  }

  // ---- game logic
  let force = 0;
  let repairScale = 1;
  if (playing && level) {
    if (!dbg.freezeTimer) {
      const r = state.tick(dt, field.overall);
      if (r === "lost") lose();
    }
    const locked = anchors.update(dt, camera, now);
    if (locked >= 0) {
      const a = anchors.items[locked];
      field.anchors[locked].set(a.center.x, a.center.y, a.center.z, 0.01);
      ambience.chime();
      lockFlash = 1;
      const n = anchors.lockedCount;
      hud.toast(`anchor locked · ${ANCHOR_INFO[a.kind].label} · ${n}/${anchors.items.length}`);
      if (n >= anchors.items.length) win();
    }
  } else if (phase === "won") {
    state.endT += rawDt;
    force = Math.min(1, state.endT / 1.5);
    state.vortexRaw = Math.max(0, state.vortexRaw - rawDt / 2);
    if (state.endT > 3 && state.endT - rawDt <= 3) hud.showEnd(true, state.finalTime, state.finalStability, state.score);
  } else if (phase === "lost") {
    state.endT += rawDt;
    repairScale = 0;
    state.vortexPhase += rawDt * VORTEX.spinRate;
    if (state.endT > 2.5 && state.endT - rawDt <= 2.5) hud.showEnd(false, state.finalTime, state.finalStability, 0);
  } else if (phase === "title" || phase === "loading" || phase === "edit") {
    force = 1;
  }
  // anchor bubbles ease in after locking
  for (const v of field.anchors) if (v.w > 0 && v.w < 1) v.w = Math.min(1, v.w + rawDt * 0.8);

  // ---- camera
  const v = dbg.vortexOverride >= 0 ? dbg.vortexOverride : state.vortex;
  if (phase === "won" && level) {
    const t = state.endT * 0.18;
    const r = 7.5;
    camera.position.set(player.x + Math.sin(controls.yaw + t) * r, eyeY + 2.2 + Math.sin(t) * 0.6, player.z + Math.cos(controls.yaw + t) * r);
    camera.lookAt(player.x, eyeY - 0.6, player.z);
  } else {
    const bobY = Math.sin(bob) * 0.025;
    camera.position.set(player.x, eyeY + bobY, player.z);
    const roll = THREE.MathUtils.degToRad(VORTEX.maxRollDeg) * v * Math.sin(now * 0.55 + 0.4);
    const sway = v * 0.12 * Math.sin(now * 0.31);
    camera.rotation.set(controls.pitch + sway, controls.yaw + v * 0.25 * Math.sin(now * 0.2), roll);
    if (phase === "title") {
      camera.rotation.y = controls.yaw + Math.sin(now * 0.07) * 0.35;
      camera.rotation.x = -0.02;
    }
  }
  const fov = VORTEX.fovBase + (VORTEX.fovMax - VORTEX.fovBase) * v;
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
  camera.getWorldDirection(camDir);

  // ---- field + uniforms
  if (live) {
    field.step(camera.position, camDir, {
      dt: phase === "title" || phase === "edit" ? 0.016 : dt,
      floor: state.floor,
      decayRate: state.decayRate,
      force,
      repairScale,
    });
  }
  fx.stab.value = field.texture;
  fx.time.value = now;
  fx.camPos.value.copy(camera.position);
  fx.globalMelt.value = dbg.globalMelt;
  fx.vortex.value = v;
  fx.vortexPhase.value = state.vortexPhase;
  vortexTarget.set(player.x, (level?.ground(player.x, player.z) ?? 0) + 0.2, player.z);
  vortexCenter.lerp(vortexTarget, v > 0.001 ? 0.02 : 1);
  fx.center.value.copy(vortexCenter);
  for (const m of worldMeshes) m.updateVersion();
  for (let i = 0; i < anchorMeshes.length; i++) {
    const m = anchorMeshes[i];
    const a = anchors.items[i];
    const pulse = a?.locked ? 1 + 0.25 * lockFlash : 0.93 + 0.09 * Math.sin(now * 2.6 + i * 1.7);
    m.recolor.setRGB(pulse, pulse, pulse);
    m.updateVersion();
  }
  for (const p of placed) p.mesh.updateVersion();
  lockFlash = Math.max(0, lockFlash - rawDt * 1.5);

  // ---- render
  post.setVortex(v, phase === "lost" ? Math.min(1, state.endT / 3) * 0.85 : 0);
  minimap.update(rawDt, scene, player, controls.yaw, v, now);
  post.render(rawDt);
  minimap.draw(anchors.items, player, controls.yaw);

  // ---- hud + audio
  hud.update({
    locked: anchors.lockedCount,
    total: anchors.items.length || LEVEL.anchorCount,
    stability: field.overall,
    timeLeft: state.timeLeft,
    lock: playing ? anchors.progress : 0,
    aimLabel: anchors.aimed >= 0 ? ANCHOR_INFO[anchors.items[anchors.aimed].kind].label : "",
    vortex: v,
  });
  ambience.update(rawDt, v, field.overall, !playing);
  if (dbg.showStats)
    statsEl.textContent = `${dbg.fps.toFixed(0)} fps · ${(splatCount / 1e6).toFixed(2)}M splats · ${quality} · stab ${(field.overall * 100).toFixed(0)}% · floor ${(state.floor * 100).toFixed(0)}% · vortex ${v.toFixed(2)} · t ${state.time.toFixed(0)}s`;
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot
(async () => {
  state.phase = "title";
  hud.show("title");
  const first = params.get("preset") ?? PRESETS[0].id;
  hud.selectPreset(first);
  requestAnimationFrame(frame);
  await loadPreset(first);
  if (params.has("autostart")) beginPlay();
})();

// test / automation hooks
Object.assign(window, {
  __hts: {
    state,
    field,
    fx,
    anchors,
    dbg,
    camera,
    player,
    controls,
    get splatCount() {
      return splatCount;
    },
    teleport(x: number, z: number, yaw = controls.yaw, pitch = controls.pitch) {
      player.set(x, 0, z);
      controls.yaw = yaw;
      controls.pitch = pitch;
      if (level) eyeY = level.ground(x, z) + LEVEL.eyeHeight;
    },
    start: (id: string) => startPreset(id),
    begin: () => beginPlay(),
    lockAll() {
      anchors.items.forEach((a, i) => {
        a.locked = true;
        field.anchors[i].set(a.center.x, a.center.y, a.center.z, 1);
      });
      win();
    },
    gaze: GAZE,
    editNext: () => editNext(),
    editPoint: (x: number, z: number) => minimap.editPoints.push(x, z),
    placeAnchor: (nx: number, ny: number) => placeAnchorAt(nx, ny),
    get imported() {
      return imported ? { name: imported.name, scale: imported.scale, min: imported.min.toArray(), max: imported.max.toArray(), splats: imported.mesh.numSplats } : null;
    },
    /** Deterministic field simulation: run `seconds` of the stability field looking along yaw/pitch. */
    simulate(seconds: number, yaw: number, pitch = 0, timerAt?: number) {
      if (timerAt !== undefined) state.time = timerAt;
      const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      const eye = new THREE.Vector3(player.x, eyeY, player.z);
      const steps = Math.round(seconds * 30);
      for (let i = 0; i < steps; i++) field.step(eye, dir, { dt: 1 / 30, floor: state.floor, decayRate: state.decayRate, force: 0, repairScale: 1 });
      fx.stab.value = field.texture;
    },
    level: () => level,
  },
});
