// BACKROOMS — every tunable constant lives here: world scale, observer-driven
// regeneration, lighting, fog, palette, gameplay timings and quality presets.

/** Size of one maze cell (m). Corridors are CELL - WALL_T wide. */
export const CELL = 3.0;
/** Ceiling height (m). */
export const WALL_H = 2.7;
/** Wall thickness (m). */
export const WALL_T = 0.2;
/** Cells kept alive around the player in each direction. */
export const ACTIVE_R = 13;
/** Toroidal grid texture size (cells) that mirrors the world to the GPU. */
export const GRID_N = 64;
/** World units per texture tile. */
export const TILE = { wall: 1.06, carpet: 0.8, ceiling: 1.2, grime: 7.3 };

export const PLAYER = {
  eye: 1.62,
  radius: 0.3,
  walk: 2.1,
  run: 3.8,
  staminaDrain: 1 / 5.5,
  staminaRegen: 1 / 9,
  bobFreq: 1.85,
};

/** Observer-dependent regeneration: the core of the game. */
export const SHIFT = {
  /** Seconds something must be unseen before it may change. */
  unseenDelay: 1.05,
  /** Mutation hazard rate (1/s) once eligible. */
  rate: 1.8,
  /** Re-arm window: keeps re-rolling while it stays unseen. */
  reArm: [4, 9] as const,
  /** Distance (cells) inside which nothing ever changes. */
  safeCells: 1.2,
  /** Visible but beyond this (cells, in the haze) the maze slowly reforms in view. */
  farCells: 5.2,
  /** Hazard rate (1/s per edge) for in-view reforming in the haze. */
  farRate: 0.06,
  /** Dissolve duration (s) for in-view reforming. */
  dissolve: 1.1,
  /** Edges beyond this distance (cells) count as invisible (lost in the fog). */
  sightCells: 11.5,
  /** Extra horizontal margin (deg) on the view frustum test. */
  fovMargin: 12,
  /** Seconds an exit must be unseen before it can vanish. */
  exitUnseen: 5.5,
  /** Region (5x5 cells) re-theme when unseen this long (s). */
  regionUnseen: 9,
  /** Minimum reachable cells around the player before walls get opened. */
  minReach: 16,
};

/** Fluorescent lighting (linear HDR). */
export const LIGHT = {
  color: [1.0, 0.955, 0.84] as const,
  intensity: 2.5,
  /** Diffuse bounce strength (cheap GI). */
  bounce: 0.26,
  bounceColor: [1.0, 0.88, 0.55] as const,
  ambient: [0.022, 0.018, 0.009] as const,
  /** Panel emission (HDR) for bloom. */
  emit: 6.0,
};

export const FOG = {
  color: [0.06, 0.05, 0.022] as const,
  density: 0.042,
};

/** sRGB-designed base colours (converted to linear in the texture shaders). */
export const PALETTE = {
  wallpaper: [0.8, 0.71, 0.4] as const,
  wallInk: [0.66, 0.56, 0.27] as const,
  carpet: [0.56, 0.47, 0.25] as const,
  carpetAlt: [0.5, 0.41, 0.2] as const,
  ceiling: [0.84, 0.82, 0.76] as const,
  tbar: [0.88, 0.87, 0.83] as const,
  door: [0.36, 0.4, 0.37] as const,
};

export const GAME = {
  /** Seconds before an exit can appear (level 0). */
  exitDelay: 70,
  exitDelayJitter: 30,
  /** Seconds before the entity starts hunting (level 0). */
  entityDelay: 55,
  entitySpeed: 3.0,
  entityKill: 0.95,
  sanityDrain: 0.28,
  sanityDarkMul: 2.3,
  sanityWatchMul: 3.2,
  almond: 34,
};

export type QualityName = "low" | "medium" | "high" | "ultra";
export const QUALITY: Record<QualityName, { tex: number; maxScale: number; minScale: number; bloom: boolean; aniso: number; dust: number; label: string }> = {
  low: { tex: 1024, maxScale: 0.7, minScale: 0.45, bloom: false, aniso: 4, dust: 2500, label: "low" },
  medium: { tex: 1024, maxScale: 1.0, minScale: 0.55, bloom: true, aniso: 8, dust: 6000, label: "medium" },
  high: { tex: 2048, maxScale: 1.25, minScale: 0.6, bloom: true, aniso: 16, dust: 10000, label: "high" },
  ultra: { tex: 2048, maxScale: 2.0, minScale: 0.75, bloom: true, aniso: 16, dust: 16000, label: "ultra" },
};
