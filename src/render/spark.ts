// Renderer + Spark setup and conversion of procedurally built splats into
// chunked SplatMeshes (chunks keep fp16 packed centres precise over a 120 m
// street). Every mesh gets the shared dyno world modifier.

import { PackedSplats, SparkRenderer, SplatMesh, utils } from "@sparkjsdev/spark";
import * as THREE from "three";
import { CLEAR_COLOR } from "../look";
import type { SplatBuilder } from "../world/splatBuilder";
import type { ModifierKind, WorldFx } from "./modifiers";

export const SKY_LAYER = 1;
export const MINIMAP_LAYER = 2;

export function createRenderer(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: new URLSearchParams(location.search).has("capture"),
  });
  renderer.setClearColor(CLEAR_COLOR, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

export function createSpark(renderer: THREE.WebGLRenderer) {
  return new SparkRenderer({
    renderer,
    // radial sort is stable under the rapid rotations of the vortex
    sortRadial: true,
    maxStdDev: Math.sqrt(7),
    // melted smoke splats grow 4x: cap their screen footprint and drop the
    // faintest fragments to keep overdraw in check
    maxPixelRadius: 320,
    minAlpha: 1.5 / 255,
  });
}

/** Pack splats [from, to) of a builder into a PackedSplats, offset by `origin`. */
function packRange(b: SplatBuilder, idx: Uint32Array, from: number, to: number, origin: THREE.Vector3) {
  const n = to - from;
  const cap = Math.max(2048, Math.ceil(n / 2048) * 2048);
  const arr = new Uint32Array(cap * 4);
  const { pos, scale, quat, rgba } = b;
  for (let k = 0; k < n; k++) {
    const i = idx[from + k];
    utils.setPackedSplat(
      arr,
      k,
      pos[i * 3] - origin.x,
      pos[i * 3 + 1] - origin.y,
      pos[i * 3 + 2] - origin.z,
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

export interface BuiltMeshes {
  meshes: SplatMesh[];
  count: number;
}

/**
 * Split a builder into XZ chunks of `chunk` metres, one SplatMesh per chunk,
 * each positioned at its chunk centre.
 */
export function meshesFromBuilder(b: SplatBuilder, fx: WorldFx, kind: ModifierKind, chunk = 32): BuiltMeshes {
  const n = b.count;
  const keys = new Int32Array(n);
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(b.pos[i * 3] / chunk);
    const cz = Math.floor(b.pos[i * 3 + 2] / chunk);
    const key = (cx + 512) * 1024 + (cz + 512);
    keys[i] = key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // counting sort by chunk
  const starts = new Map<number, number>();
  let acc = 0;
  for (const [k, c] of counts) {
    starts.set(k, acc);
    acc += c;
  }
  const fill = new Map(starts);
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    const p = fill.get(k)!;
    idx[p] = i;
    fill.set(k, p + 1);
  }
  const meshes: SplatMesh[] = [];
  for (const [k, c] of counts) {
    const cx = Math.floor(k / 1024) - 512, cz = (k % 1024) - 512;
    const origin = new THREE.Vector3((cx + 0.5) * chunk, 0, (cz + 0.5) * chunk);
    const s = starts.get(k)!;
    const packed = packRange(b, idx, s, s + c, origin);
    const mesh = new SplatMesh({ packedSplats: packed, raycastable: false });
    mesh.position.copy(origin);
    mesh.worldModifier = fx.modifier(kind);
    mesh.updateGenerator();
    meshes.push(mesh);
  }
  return { meshes, count: n };
}

/** A single mesh at a given transform (anchors, sky). */
export function meshFromBuilder(b: SplatBuilder, fx: WorldFx, kind: ModifierKind, origin = new THREE.Vector3()): SplatMesh {
  const idx = new Uint32Array(b.count);
  for (let i = 0; i < b.count; i++) idx[i] = i;
  const packed = packRange(b, idx, 0, b.count, origin);
  const mesh = new SplatMesh({ packedSplats: packed, raycastable: false });
  mesh.position.copy(origin);
  mesh.worldModifier = fx.modifier(kind);
  mesh.updateGenerator();
  return mesh;
}
