import type { ChickenAnimationState } from "../simulation";

export const GAME_ART_ATLAS_KEY = "shouting-chickens-original-art";
export const GAME_ART_ATLAS_PATH = "assets/shouting-chickens-atlas.svg";
export const GAME_ART_ATLAS_WIDTH = 1_280;
export const GAME_ART_ATLAS_HEIGHT = 80;
export const GAME_ART_FRAME_SIZE = 80;
export const GAME_ART_ATLAS_BUDGET_BYTES = 24 * 1_024;
export const GAME_ART_FRAME_BUDGET = 16;
export const GAME_EFFECT_POOL_SIZE = 14;

export const GAME_ART_FRAMES = [
  "chicken-idle",
  "chicken-run-a",
  "chicken-run-b",
  "chicken-jump",
  "chicken-flap-a",
  "chicken-flap-b",
  "chicken-death",
  "feather",
  "spike",
  "moving-hazard",
  "microphone",
  "warning",
  "grass",
  "platform",
  "water",
  "spark",
] as const;

export type GameArtFrame = (typeof GAME_ART_FRAMES)[number];

export const GAME_ART_FRAME_RECTS = Object.freeze(
  GAME_ART_FRAMES.map((name, index) =>
    Object.freeze({
      name,
      x: index * GAME_ART_FRAME_SIZE,
      y: 0,
      width: GAME_ART_FRAME_SIZE,
      height: GAME_ART_FRAME_SIZE,
    }),
  ),
);

export const ORIGINAL_ASSET_RECORDS = Object.freeze([
  ...GAME_ART_FRAMES.map((frame) =>
    Object.freeze({
      id: `${GAME_ART_ATLAS_KEY}:${frame}`,
      component: frame,
      kind: "vector-atlas-frame",
      path: `public/${GAME_ART_ATLAS_PATH}`,
      origin: `Original ${frame} SVG paths authored for Shouting Chickens in this repository.`,
      license: "Apache-2.0",
    }),
  ),
  Object.freeze({
    id: "generated-art-fallback",
    component: "recoverable vector primitives for all atlas roles",
    kind: "canvas-vector-fallback",
    path: "src/game/createGame.ts",
    origin: "Original Canvas 2D fallback primitives authored for Shouting Chickens.",
    license: "Apache-2.0",
  }),
  Object.freeze({
    id: "procedural-backdrop",
    component: "night-sky field, soft light shapes, and layered hill silhouettes",
    kind: "phaser-vector-background",
    path: "src/game/createGame.ts",
    origin: "Original Phaser vector backdrop authored for Shouting Chickens.",
    license: "Apache-2.0",
  }),
  Object.freeze({
    id: "fixed-particle-motion",
    component: "pooled collection and impact sparkle trajectories",
    kind: "phaser-particle-animation",
    path: "src/game/createGame.ts",
    origin: "Original fixed-pool particle motion authored for Shouting Chickens.",
    license: "Apache-2.0",
  }),
  Object.freeze({
    id: "procedural-game-cues",
    component: "jump, flap, land, feather, and hazard oscillator envelopes",
    kind: "synthesized-audio",
    path: "src/game/presentation/GameAudioDirector.ts",
    origin: "Original oscillator envelopes authored for Shouting Chickens in this repository.",
    license: "Apache-2.0",
  }),
]);

const CHICKEN_FRAMES: Readonly<Record<ChickenAnimationState, readonly GameArtFrame[]>> =
  Object.freeze({
    idle: ["chicken-idle"],
    run: ["chicken-run-a", "chicken-run-b"],
    jump: ["chicken-jump"],
    flap: ["chicken-flap-a", "chicken-flap-b"],
    death: ["chicken-death"],
  });

export function selectChickenArtFrame(
  state: ChickenAnimationState,
  tick: number,
  reducedMotion: boolean,
): GameArtFrame {
  const frames = CHICKEN_FRAMES[state];
  if (reducedMotion || frames.length === 1) {
    return frames[0]!;
  }

  const frameWindow = state === "run" ? 7 : 5;
  const index = Math.floor(Math.max(0, tick) / frameWindow) % frames.length;
  return frames[index]!;
}

export function gameArtAtlasUrl(baseUrl: string, documentUrl: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(`${normalizedBase}${GAME_ART_ATLAS_PATH}`, documentUrl).href;
}
