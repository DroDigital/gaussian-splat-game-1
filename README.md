# HOLD THE STREET

A Gaussian-splat exploration game for the web. A quiet Tokyo-style back street on
an overcast day, rendered as 3D Gaussian splats with [Spark](https://sparkjs.dev)
— photographic where you look, tearing apart into smoke where you don't.

Find the five **anchors** (a cat, a lit vending machine, a parking sign, a
bicycle, a shrine lantern). Look at one for 1.5 s to lock it; a locked anchor
permanently stabilises a 6 m bubble around it. If overall stability falls under
15 % the street twists into a **vortex** — if it completes, the street is lost.

```bash
npm install
npm run dev      # zero external assets: the street is generated procedurally
npm run build    # static site in dist/
```

## Controls

| | Desktop | Mobile |
|---|---|---|
| walk | WASD (Shift = run, 2.5 m/s) | left virtual stick |
| look | mouse (pointer lock) | drag right side · optional gyro (pause menu) |
| pause | Esc | `II` button |

## Levels

Three procedural presets — **Back Alley**, **Station Approach**, **Hillside
Steps** — each an L-shaped ~120 m street, plus any imported capture.

**Import**: title screen / pause menu file picker, or drag & drop a `.spz`,
`.ply`, `.splat`, `.ksplat` or `.sog` (Polycam, Postshot, Luma, …). The ground
is auto-levelled (best up-axis by "lowest dense layer" score, then a RANSAC
plane fit), the scene is scaled to metres (heuristic, with ±/flip controls),
then you draw the walkable polygon on the overview and tap/click 5 surfaces to
place the anchors.

## URL parameters

- `?debug` — lil-gui (global melt slider, vortex override, melt / vortex / haze
  shape) and a stats line (fps, splat count, stability, floor, vortex).
- `?quality=high|low` — 1.5 M or 500 k splats (default: low on touch devices).
- `?preset=alley|station|hillside`, `?autostart`.
- `?budget=N` — force a splat budget (testing).

## How it works

- `src/look.ts` — every visual constant: palette, haze, melt curves, vortex
  shape, gaze cone, post grade, quality budgets.
- `src/world/streetGen.ts` + `splatBuilder.ts` — procedural splats: asphalt with
  edge lines / manholes / gutters, curbs, block walls, 2–4 storey façades with
  windows, blue awnings, balconies, AC units, laundry, potted plants, utility
  poles with sagging wires, signs, a curve mirror, vending machines, foliage
  spilling over walls, and a few thousand huge low-opacity sky splats. Surface
  splats are oriented and flattened along the surface normal.
- `src/render/spark.ts` — `SparkRenderer` + chunked `SplatMesh`es built from
  `PackedSplats` (32 m chunks keep fp16 packed centres precise).
- `src/render/modifiers.ts` — **all per-splat effects are Spark dyno
  modifiers** (one `worldModifier` graph per mesh, shared uniforms): stability
  sampling, curl-noise melt with upward drift, 4× growth, stretch along drift,
  fade to smoke grey; distance haze + extra melt beyond 60 m; the vortex
  (`uVortex`, `uAxis`, `uCenter`: angle grows with height and falls off with
  radius, spiral pull inward, bowl lift). No per-frame CPU loop over splats.
- `src/render/stabilityField.ts` — stability per voxel (128×8×128 grid tiled
  into a 2D atlas), ping-ponged on the GPU each frame: 25° gaze cone within
  15 m repairs, everything else decays toward a floor that collapses over the
  3-minute timer; locked anchors pin a 6 m bubble at 1. A tiny reduction pass is
  read back asynchronously (`readRenderTargetPixelsAsync`) for the score.
- `src/render/minimap.ts` — the `geo_splats` viewer: a second `SparkRenderer`
  renders the live splats top-down into an offscreen target at 10 Hz over a dark
  grid floor; the grid tilts and swirls during the vortex.
- `src/render/post.ts` — pmndrs `postprocessing`: subtle bloom, grain, vignette
  and an overcast grade (lifted blacks, low contrast, desaturated except greens).
- `src/audio/ambience.ts` — generated Web Audio: wind, a distant train, cicadas,
  and a low rumble that rises with the vortex.
