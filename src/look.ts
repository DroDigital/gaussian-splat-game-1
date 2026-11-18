// ALL visual constants for HOLD THE STREET live here: palette, haze, melt
// curves, vortex shape, gaze cone, post grade. Colours are sRGB 0..1 (Spark
// stores splat colours as sRGB, like trained 3DGS scenes).

export type RGB = readonly [number, number, number];

export const PALETTE = {
  // Overcast sky + haze
  sky: [0.8, 0.815, 0.825] as RGB,
  skyTop: [0.74, 0.76, 0.78] as RGB,
  haze: [0.88, 0.89, 0.895] as RGB,
  smoke: [0.84, 0.845, 0.85] as RGB, // what melting splats fade towards

  // Ground
  asphalt: [0.37, 0.375, 0.38] as RGB,
  asphaltDark: [0.29, 0.295, 0.3] as RGB,
  asphaltPatch: [0.32, 0.325, 0.33] as RGB,
  roadLine: [0.86, 0.86, 0.84] as RGB,
  manhole: [0.27, 0.27, 0.27] as RGB,
  manholeRim: [0.42, 0.41, 0.39] as RGB,
  curb: [0.66, 0.65, 0.62] as RGB,
  gutter: [0.52, 0.52, 0.5] as RGB,
  stepStone: [0.6, 0.59, 0.56] as RGB,

  // Walls
  blockWall: [0.66, 0.65, 0.61] as RGB,
  blockMortar: [0.55, 0.545, 0.52] as RGB,
  wallCap: [0.6, 0.59, 0.56] as RGB,
  facades: [
    [0.86, 0.82, 0.73], // beige
    [0.9, 0.89, 0.85], // off-white
    [0.82, 0.78, 0.7], // sand
    [0.92, 0.91, 0.88], // white
    [0.76, 0.75, 0.72], // light grey
    [0.84, 0.8, 0.74], // cream
  ] as RGB[],
  facadeTrim: [0.38, 0.37, 0.36] as RGB,
  roofTile: [0.28, 0.3, 0.33] as RGB,
  roofFlat: [0.5, 0.5, 0.49] as RGB,
  window: [0.13, 0.15, 0.17] as RGB,
  windowSky: [0.42, 0.46, 0.5] as RGB,
  windowFrosted: [0.72, 0.74, 0.74] as RGB,
  windowFrame: [0.72, 0.72, 0.7] as RGB,
  curtain: [0.84, 0.8, 0.7] as RGB,
  door: [0.3, 0.26, 0.22] as RGB,
  doorMetal: [0.48, 0.49, 0.5] as RGB,
  awnings: [
    [0.13, 0.33, 0.62],
    [0.16, 0.4, 0.68],
    [0.1, 0.28, 0.52],
  ] as RGB[],
  awningStripe: [0.85, 0.87, 0.9] as RGB,
  balcony: [0.7, 0.7, 0.68] as RGB,
  railing: [0.35, 0.36, 0.37] as RGB,
  acUnit: [0.86, 0.85, 0.81] as RGB,
  acGrille: [0.28, 0.29, 0.3] as RGB,
  laundry: [
    [0.85, 0.85, 0.82],
    [0.55, 0.65, 0.8],
    [0.8, 0.55, 0.5],
  ] as RGB[],

  // Street furniture
  pole: [0.6, 0.6, 0.58] as RGB,
  wire: [0.1, 0.1, 0.11] as RGB,
  transformer: [0.5, 0.52, 0.52] as RGB,
  signRed: [0.78, 0.14, 0.13] as RGB,
  signBlue: [0.12, 0.3, 0.66] as RGB,
  signYellow: [0.95, 0.78, 0.12] as RGB,
  signWhite: [0.94, 0.94, 0.92] as RGB,
  mirrorPole: [0.92, 0.48, 0.12] as RGB,
  mirror: [0.75, 0.78, 0.8] as RGB,
  vendBody: [0.9, 0.9, 0.88] as RGB,
  vendLit: [0.98, 0.98, 0.96] as RGB,
  vendDark: [0.2, 0.2, 0.22] as RGB,
  drinks: [
    [0.85, 0.15, 0.12],
    [0.15, 0.4, 0.8],
    [0.95, 0.75, 0.1],
    [0.2, 0.65, 0.3],
    [0.95, 0.95, 0.95],
    [0.55, 0.3, 0.15],
  ] as RGB[],
  pot: [0.62, 0.36, 0.24] as RGB,
  potBlue: [0.25, 0.38, 0.55] as RGB,
  bin: [0.25, 0.45, 0.3] as RGB,
  bike: [0.18, 0.2, 0.22] as RGB,
  station: [0.7, 0.7, 0.69] as RGB,
  stationGlass: [0.32, 0.36, 0.4] as RGB,
  bark: [0.3, 0.26, 0.2] as RGB,

  // Foliage: deliberately saturated against the desaturated street
  greens: [
    [0.18, 0.42, 0.1],
    [0.26, 0.52, 0.14],
    [0.13, 0.33, 0.08],
    [0.34, 0.56, 0.18],
    [0.22, 0.47, 0.17],
    [0.42, 0.6, 0.22],
  ] as RGB[],

  // Anchors read "slightly brighter" than everything else
  anchorBoost: 1.12,
  cat: [0.93, 0.62, 0.3] as RGB,
  catWhite: [0.95, 0.94, 0.9] as RGB,
  lantern: [0.98, 0.9, 0.7] as RGB,
  lanternWood: [0.55, 0.32, 0.18] as RGB,
  shrineRed: [0.85, 0.2, 0.12] as RGB,
} as const;

/** Background/clear colour of the canvas (sRGB). */
export const CLEAR_COLOR = 0xcdd0d2;

export const HAZE = {
  /** Distance (m) where colour starts blending to haze. */
  fogStart: 22,
  /** Distance (m) where the street is fully swallowed. */
  fogEnd: 115,
  /** Max fog blend (keep a hint of silhouette). */
  fogMax: 0.94,
  /** Melt is added beyond this distance so the street never visibly ends. */
  meltStart: 60,
  meltEnd: 105,
  meltMax: 0.85,
};

export const MELT = {
  /** Stability (0..1) above which a splat is fully photographic. */
  stableAbove: 0.92,
  /** Stability at which melt is complete. */
  meltedBelow: 0.12,
  /** Curl-noise spatial frequency (1/m). */
  curlFreq: 0.22,
  /** Curl-noise displacement (m) at full melt. */
  curlAmp: 2.6,
  /** Upward drift (m) at full melt. */
  driftUp: 5.5,
  /** Sideways wind drift (m) at full melt. */
  wind: [1.6, 0, 0.7] as const,
  /** Scale multiplier at full melt (spec: up to 4x). */
  scaleMax: 4.0,
  /** Extra stretch along drift direction at full melt. */
  stretch: 2.6,
  /** Opacity multiplier at full melt (splats get bigger AND more transparent). */
  opacityMin: 0.08,
  /** How strongly colour moves to smoke grey at full melt. */
  greyMix: 0.88,
  /** Drift animation speed. */
  flowSpeed: 0.35,
};

export const VORTEX = {
  /** Base swirl angle (rad) at the axis. */
  spin: 7.0,
  /** Extra twist per metre of height (rad/m). */
  heightTwist: 0.16,
  /** Radius scale for the angular falloff (m). */
  falloffR: 16,
  /** How much far splats are pulled inward (0..1). */
  pull: 0.55,
  pullR: 26,
  /** Bowl lift: outer rings rise by r * lift. */
  lift: 0.55,
  /** Centre sink depth (m). */
  sink: 3.5,
  /** Continuous rotation speed (rad/s) at full vortex. */
  spinRate: 0.9,
  /** Melt added by the vortex. */
  meltAdd: 0.55,
  /** Seconds for the vortex to go 0 -> 1 when stability stays low. */
  rampUp: 14,
  /** Seconds to unwind 1 -> 0 when stability recovers. */
  rampDown: 6,
  /** Overall stability that triggers the vortex. */
  trigger: 0.15,
  /** Camera roll at full vortex (deg). */
  maxRollDeg: 25,
  fovBase: 70,
  fovMax: 90,
};

export const GAZE = {
  coneDeg: 25,
  rangeM: 15,
  /** Stability repaired per second at the centre of the cone. */
  repairRate: 1.1,
  /** Close bubble around the player that is always partly repaired (m). */
  nearRadius: 3.0,
  nearStrength: 0.55,
  /** Exponential approach rate of unobserved stability to the floor (1/s). */
  decayRate: 0.38,
  /** Floor of unobserved stability at t=0 and how it collapses over the timer. */
  floorStart: 0.42,
  floorPow: 1.15,
  /** Anchor bubble radius (m). */
  anchorRadius: 6,
  /** Seconds of gaze to lock an anchor. */
  lockSeconds: 1.5,
  /** Half-angle (deg) the crosshair must be within to lock. */
  lockAngleDeg: 7,
  lockRangeM: 16,
  /** Spotting: anchors seen within this half-angle/range get a minimap marker. */
  spotAngleDeg: 28,
  spotRangeM: 24,
};

export const LEVEL = {
  durationS: 180,
  anchorCount: 5,
  walkSpeed: 1.4,
  runSpeed: 2.5,
  eyeHeight: 1.6,
};

export const FIELD = {
  /** Stability grid resolution (voxels). Stored as NY slices tiled in X. */
  nx: 128,
  nz: 128,
  ny: 8,
  /** Vertical extent of the field (m above the lowest ground). */
  height: 18,
  /** Readback interval for the overall stability score (s). */
  readbackInterval: 0.2,
};

export const POST = {
  bloomIntensity: 0.55,
  bloomThreshold: 0.78,
  bloomSmoothing: 0.25,
  grain: 0.055,
  /** Lifted blacks, low contrast, desaturation. */
  lift: 0.07,
  contrast: 0.88,
  saturation: 0.82,
  vignette: 0.28,
};

export const QUALITY = {
  high: { budget: 1_500_000, density: 1.0, pixelRatio: 1.5 },
  low: { budget: 500_000, density: 0.4, pixelRatio: 1.0 },
} as const;
export type QualityName = keyof typeof QUALITY;

export const MINIMAP = {
  sizeCss: 220,
  targetPx: 320,
  fps: 10,
  border: "#46d36a",
  grid: [0.16, 0.165, 0.17] as RGB,
  gridLine: [0.27, 0.28, 0.29] as RGB,
  tiltDeg: 34,
};
