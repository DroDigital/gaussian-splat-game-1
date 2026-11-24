# THE BACKROOMS

A fully procedural Backrooms horror game for the web and desktop. Endless
mono-yellow offices, damp carpet and buzzing fluorescent panels. Corridors form
as you walk into them, and **anything you are not looking at may change**. Turn
around and the hallway you just came through is gone.

Find an **EXIT** and keep it in sight. Something follows you, and it only moves
while you aren't watching it.

```bash
npm install
npm run dev        # http://localhost:5173 — zero assets, everything is generated
npm run build      # static site in dist/ (index.html = Backrooms, street.html = Hold the Street)
npm run desktop    # build + run the desktop app (Electron)
```

## Desktop builds (macOS · Windows · Linux)

The game ships as an Electron app. Electron bundles its own Chromium, so you get the
same WebGL2 path on every OS. The app:

- prefers the discrete GPU and ignores GPU blocklists,
- serves the build over a privileged `app://` origin,
- toggles fullscreen with **F11** or **Alt+Enter**,
- adds *quit to desktop* to the menus.

```bash
npm run dist:linux   # release/backrooms-<v>-linux-x86_64.AppImage + .tar.gz
npm run dist:win     # release/backrooms-<v>-win-x64.exe (NSIS installer) + portable .exe
npm run dist:mac     # release/backrooms-<v>-mac-{arm64,x64}.dmg + .zip
```

Each platform builds best on its own OS. `.github/workflows/desktop.yml` builds
all three natively on GitHub Actions: on demand, on changes to the desktop
packaging, and on `v*` tags, which also attach the builds to a draft release.

Cross-building from Linux also works for most targets: the Windows portable
`.exe` and `.zip` with `-c.win.signAndEditExecutable=false`, and the macOS `.zip`.
The Windows NSIS installer needs Wine there, and the macOS `.dmg` needs macOS.

Builds are unsigned. On macOS, right-click the app and choose **Open** the first
time. On Windows, choose **More info → Run anyway**. Add `CSC_LINK` /
`CSC_KEY_PASSWORD` secrets to sign in CI.

Set `BR_UNCAPPED=1` to disable vsync for benchmarking. `BR_SCREENSHOT=out.png`
is a smoke-test hook: it captures the window after load, then quits.

## How to play

| | Desktop | Mobile |
|---|---|---|
| walk / run | WASD · Shift | left virtual stick |
| look | mouse (pointer lock) | drag the right side |
| pause | Esc | `II` |

- **Look away and it changes.** Anything unseen for about a second, and more than a
  few metres away, is regenerated. That covers walls, doorways, half walls, windows,
  lights and pillars, and whole 15 m regions get re-themed: maze, pillar hall,
  corridors, dark zone or big empty room.
- **What you watch stays.** Watched geometry is locked. Within about 3.5 m of you,
  nothing ever changes, so you can never be sealed in.
- **The far end never holds still.** Walls deep in the haze fade out and in while
  you look at them.
- **The exit appears after a while.** It hums, so follow the sound. Once you see it,
  keep it in view: looked away from for more than about 5 s, it can vanish. Walk into
  the door to escape to the next, darker level.
- **Sanity drains slowly.** It drains faster in the dark and while you look at the
  thing. Almond water restores it. Low sanity makes reality less stable: faster
  shifting, warping, brownouts and heartbeat.
- **Stamina** (the camcorder battery) limits running.

## Performance

- **One shading pass per pixel.** A depth pre-pass means the expensive surface
  shader runs once per pixel, whatever the maze depth.
- **Lighting from a 64×64 grid texture.** All lighting comes from one small
  texture that mirrors the world: per-cell wall types, lights and flicker. The
  shader evaluates the 9 nearest fluorescent panels, with wall occlusion and
  analytic AO, from 9 texel fetches. There are no shadow maps and no per-light
  draws.
- **Instanced walls.** Walls are a single instanced draw, rebuilt without
  allocations when the maze changes.
- **Cheap CPU work.** The per-frame update (visibility ray casts + regeneration)
  costs about 0.3 ms, and the instance rebuild about 0.1 ms.
- **Adaptive resolution.** Render scale drops when frames run long and creeps back
  with headroom. HOLD THE STREET uses this too.
- **Quality presets:** `low · medium · high · ultra`. They set texture size
  (1024/2048), the render-scale range, bloom, specular and dust count. The default
  is `high`, or `low` on touch devices; your choice is remembered.

## How it works

- `src/backrooms/world.ts` — the infinite cell grid (3 m cells) and its
  observer-dependent regeneration:
  - Visibility is a view-cone test plus a DDA ray cast through the wall grid.
  - Edges and cells re-roll from versioned hashes.
  - A connectivity guard keeps a path open around you.
  - It also handles exit placement, the BFS flow field the entity follows, and
    collision.
- `src/backrooms/textures.ts` — GPU-synthesised, seamlessly tiling 2048² textures:
  - wallpaper: printed diamond motif, banding, roll seams, paper grain
  - carpet: cut-pile tufts in two yarns
  - ceiling: acoustic tiles with fissures, pinholes and T-bar grid
  - a world-space grime map
  Each has albedo + roughness and a derived normal map.
- `src/backrooms/surfaces.ts` — instanced walls + infinite floor/ceiling, all
  shaded by one shader: fluorescent lights with flicker, light blocked by walls,
  cheap bounce, specular, AO, water-damage tide lines, damp carpet, stained or
  missing ceiling tiles, dissolve, and fog.
- `src/backrooms/splats.ts` — Gaussian splats via Spark: dust motes, the entity (a
  writhing smoke silhouette animated by dyno modifiers) and almond-water bottles.
- `src/backrooms/entity.ts` — moves only when unobserved (on screen and in line of
  sight), and paths through real openings.
- `src/backrooms/post.ts` — camcorder look: HDR bloom, ACES, barrel distortion,
  chromatic aberration, sanity warp, grain, tracking static.
- `src/backrooms/audio.ts` — generated sound: ballast hum that follows nearby
  lights, flicker crackle, footsteps, a thud when the maze rearranges behind you,
  HRTF breathing, exit hum and heartbeat.
- `electron/` — the desktop shell (`main.cjs`, sandboxed `preload.cjs`).
  `scripts/make_icon.py` draws the app icon.

URL parameters: `?debug` (2D map of the shifting grid, stats, lil-gui),
`?quality=`, `?seed=`, `?level=`, `?autostart`, `?tex=` (texture size).

---

# HOLD THE STREET

The original Gaussian-splat game, served at `street.html`. A quiet Tokyo-style back
street on an overcast day, rendered as 3D Gaussian splats with
[Spark](https://sparkjs.dev). It is photographic where you look and tears apart
into smoke where you don't. Find five anchors and lock each by looking at it for
1.5 s. If overall stability falls under 15 %, the street twists into a vortex.

It has three procedural presets — Back Alley, Station Approach and Hillside Steps
— and it can import `.spz` / `.ply` / `.splat` / `.ksplat` / `.sog` captures,
with auto-levelling and a walkable area you draw yourself. All per-splat effects
are Spark dyno modifiers. A GPU stability field drives them, and a `geo_splats`
minimap viewer shows the street from above. Parameters: `?debug`,
`?quality=high|low`, `?preset=alley|station|hillside`, `?budget=N`. Visual
constants live in `src/look.ts`, generation in `src/world/`, rendering in
`src/render/`.
