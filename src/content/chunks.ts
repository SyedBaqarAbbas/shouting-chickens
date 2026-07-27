import { SeededRandom } from "../core";

export type TraversalCapability = "run" | "jump" | "lift";

export type TraversalAnchor = Readonly<{
  platformId: string;
}>;

export type ChunkPlatformSpec = Readonly<{
  id: string;
  x: number;
  width: number;
  top: number;
}>;

export type ChunkSpikeHazardSpec = Readonly<{
  id: string;
  kind: "spike";
  x: number;
  width: number;
  baseTop: number;
  height: number;
}>;

export type ChunkWaterHazardSpec = Readonly<{
  id: string;
  kind: "water";
  x: number;
  width: number;
  top: number;
}>;

export type ChunkHazardSpec = ChunkSpikeHazardSpec | ChunkWaterHazardSpec;

export type ChunkCollectibleSpec = Readonly<{
  id: string;
  kind: "feather";
  x: number;
  y: number;
  radius: number;
}>;

export type ChunkTransitionSpec = Readonly<{
  fromPlatformId: string;
  toPlatformId: string;
  requiredCapability: TraversalCapability;
}>;

export type ChunkTemplate = Readonly<{
  id: string;
  width: number;
  minimumDifficulty: number;
  maximumDifficulty: number;
  entry: TraversalAnchor;
  exit: TraversalAnchor;
  requiredCapability: TraversalCapability;
  platforms: readonly ChunkPlatformSpec[];
  hazards: readonly ChunkHazardSpec[];
  collectibles: readonly ChunkCollectibleSpec[];
  route: readonly ChunkTransitionSpec[];
}>;

export type TraversalMeasurement = Readonly<{
  horizontalGap: number;
  verticalRise: number;
  verticalDrop: number;
  requiredCapability: TraversalCapability;
}>;

export const TRAVERSAL_LIMITS: Readonly<
  Record<
    TraversalCapability,
    Readonly<{
      maximumGap: number;
      maximumRise: number;
      maximumDrop: number;
    }>
  >
> = Object.freeze({
  run: Object.freeze({
    maximumGap: 0,
    maximumRise: 0,
    maximumDrop: 36,
  }),
  jump: Object.freeze({
    maximumGap: 110,
    maximumRise: 56,
    maximumDrop: 90,
  }),
  lift: Object.freeze({
    maximumGap: 140,
    maximumRise: 90,
    maximumDrop: 120,
  }),
});

const CAPABILITY_RANK: Readonly<Record<TraversalCapability, number>> = Object.freeze({
  run: 0,
  jump: 1,
  lift: 2,
});

const DEFAULT_SUPPORTED_CAPABILITIES: readonly TraversalCapability[] = Object.freeze([
  "run",
  "jump",
  "lift",
]);

function isCapability(value: unknown): value is TraversalCapability {
  return value === "run" || value === "jump" || value === "lift";
}

function isNonEmptyId(value: string) {
  return value.trim().length > 0;
}

function platformById(template: ChunkTemplate, id: string) {
  return template.platforms.find((platform) => platform.id === id);
}

function measurePlatforms(
  from: ChunkPlatformSpec,
  to: ChunkPlatformSpec,
  requiredCapability: TraversalCapability,
): TraversalMeasurement {
  const verticalDelta = from.top - to.top;

  return {
    horizontalGap: Math.max(0, to.x - (from.x + from.width)),
    verticalRise: Math.max(0, verticalDelta),
    verticalDrop: Math.max(0, -verticalDelta),
    requiredCapability,
  };
}

export function isTraversalReachable(measurement: TraversalMeasurement) {
  const limits = TRAVERSAL_LIMITS[measurement.requiredCapability];

  return (
    measurement.horizontalGap <= limits.maximumGap &&
    measurement.verticalRise <= limits.maximumRise &&
    measurement.verticalDrop <= limits.maximumDrop
  );
}

export function measureChunkTransition(
  template: ChunkTemplate,
  transition: ChunkTransitionSpec,
): TraversalMeasurement | null {
  const from = platformById(template, transition.fromPlatformId);
  const to = platformById(template, transition.toPlatformId);

  return from && to ? measurePlatforms(from, to, transition.requiredCapability) : null;
}

export function measureBoundaryTransition(
  previous: ChunkTemplate,
  next: ChunkTemplate,
): TraversalMeasurement | null {
  const from = platformById(previous, previous.exit.platformId);
  const nextEntry = platformById(next, next.entry.platformId);

  if (!from || !nextEntry) {
    return null;
  }

  const to = {
    ...nextEntry,
    x: previous.width + nextEntry.x,
  };

  return measurePlatforms(from, to, next.requiredCapability);
}

export function areChunkBoundariesCompatible(previous: ChunkTemplate, next: ChunkTemplate) {
  const measurement = measureBoundaryTransition(previous, next);
  return measurement !== null && isTraversalReachable(measurement);
}

function supportsCapability(
  supportedCapabilities: ReadonlySet<TraversalCapability>,
  requiredCapability: TraversalCapability,
) {
  return supportedCapabilities.has(requiredCapability);
}

function hasRouteFromEntryToExit(template: ChunkTemplate) {
  const reachable = new Set([template.entry.platformId]);
  let changed = true;

  while (changed) {
    changed = false;

    for (const transition of template.route) {
      if (reachable.has(transition.fromPlatformId) && !reachable.has(transition.toPlatformId)) {
        reachable.add(transition.toPlatformId);
        changed = true;
      }
    }
  }

  return reachable.has(template.exit.platformId);
}

function validateTemplate(template: ChunkTemplate, errors: string[]) {
  const prefix = template.id ? `Chunk "${template.id}"` : "Chunk";

  if (!isNonEmptyId(template.id)) {
    errors.push("Every chunk needs a non-empty id");
  }
  if (!Number.isFinite(template.width) || template.width <= 0) {
    errors.push(`${prefix} needs a positive finite width`);
  }
  if (
    !Number.isInteger(template.minimumDifficulty) ||
    !Number.isInteger(template.maximumDifficulty) ||
    template.minimumDifficulty < 1 ||
    template.maximumDifficulty < template.minimumDifficulty
  ) {
    errors.push(`${prefix} has an invalid difficulty range`);
  }
  if (!isCapability(template.requiredCapability)) {
    errors.push(`${prefix} has an invalid required capability`);
  }
  if (template.platforms.length === 0) {
    errors.push(`${prefix} needs at least one platform`);
  }

  const entityIds = new Set<string>();
  const registerEntity = (id: string, kind: string) => {
    if (!isNonEmptyId(id)) {
      errors.push(`${prefix} has a ${kind} without an id`);
    } else if (entityIds.has(id)) {
      errors.push(`${prefix} reuses entity id "${id}"`);
    }
    entityIds.add(id);
  };

  for (const platform of template.platforms) {
    registerEntity(platform.id, "platform");
    if (
      !Number.isFinite(platform.x) ||
      !Number.isFinite(platform.width) ||
      platform.width <= 0 ||
      platform.x < 0 ||
      platform.x + platform.width > template.width ||
      !Number.isFinite(platform.top)
    ) {
      errors.push(`${prefix} platform "${platform.id}" is outside its finite bounds`);
    }
  }

  for (const hazard of template.hazards) {
    registerEntity(hazard.id, "hazard");
    if (
      !Number.isFinite(hazard.x) ||
      !Number.isFinite(hazard.width) ||
      hazard.width <= 0 ||
      hazard.x < 0 ||
      hazard.x + hazard.width > template.width
    ) {
      errors.push(`${prefix} hazard "${hazard.id}" is outside its finite bounds`);
    }

    if (
      (hazard.kind === "spike" &&
        (!Number.isFinite(hazard.baseTop) ||
          !Number.isFinite(hazard.height) ||
          hazard.height <= 0)) ||
      (hazard.kind === "water" && !Number.isFinite(hazard.top))
    ) {
      errors.push(`${prefix} hazard "${hazard.id}" has invalid geometry`);
    }
  }

  for (const collectible of template.collectibles) {
    registerEntity(collectible.id, "collectible");
    if (
      !Number.isFinite(collectible.x) ||
      !Number.isFinite(collectible.y) ||
      !Number.isFinite(collectible.radius) ||
      collectible.radius <= 0 ||
      collectible.x - collectible.radius < 0 ||
      collectible.x + collectible.radius > template.width
    ) {
      errors.push(`${prefix} collectible "${collectible.id}" has invalid geometry`);
    }
  }

  const entry = platformById(template, template.entry.platformId);
  const exit = platformById(template, template.exit.platformId);
  if (!entry) {
    errors.push(`${prefix} entry references a missing platform`);
  } else if (entry.x > 112 || entry.x + entry.width < 112) {
    errors.push(`${prefix} entry does not support the starting traversal anchor`);
  }
  if (!exit) {
    errors.push(`${prefix} exit references a missing platform`);
  }

  for (const transition of template.route) {
    if (!isCapability(transition.requiredCapability)) {
      errors.push(`${prefix} route has an invalid required capability`);
      continue;
    }

    const measurement = measureChunkTransition(template, transition);
    if (!measurement) {
      errors.push(
        `${prefix} route ${transition.fromPlatformId} -> ${transition.toPlatformId} references a missing platform`,
      );
    } else if (!isTraversalReachable(measurement)) {
      errors.push(
        `${prefix} route ${transition.fromPlatformId} -> ${transition.toPlatformId} is impossible`,
      );
    }

    if (
      CAPABILITY_RANK[transition.requiredCapability] > CAPABILITY_RANK[template.requiredCapability]
    ) {
      errors.push(`${prefix} understates its required capability`);
    }
  }

  if (entry && exit && !hasRouteFromEntryToExit(template)) {
    errors.push(`${prefix} has no declared route from entry to exit`);
  }
}

export class ChunkCatalogValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Authored chunk validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ChunkCatalogValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

export function validateChunkCatalog(templates: readonly ChunkTemplate[]) {
  const errors: string[] = [];

  if (templates.length === 0) {
    errors.push("The authored chunk catalog must not be empty");
  }

  const templateIds = new Set<string>();
  for (const template of templates) {
    if (templateIds.has(template.id)) {
      errors.push(`Chunk id "${template.id}" is duplicated`);
    }
    templateIds.add(template.id);
    validateTemplate(template, errors);
  }

  for (const template of templates) {
    for (
      let difficulty = template.minimumDifficulty;
      difficulty <= template.maximumDifficulty;
      difficulty += 1
    ) {
      const hasSuccessor = templates.some(
        (candidate) =>
          candidate.minimumDifficulty <= difficulty &&
          candidate.maximumDifficulty >= difficulty &&
          areChunkBoundariesCompatible(template, candidate),
      );

      if (!hasSuccessor) {
        errors.push(
          `Chunk "${template.id}" has no reachable successor at difficulty ${difficulty}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new ChunkCatalogValidationError(errors);
  }
}

export type AuthoredChunkSelectorOptions = Readonly<{
  gameplayVersion: string;
  seed: string;
  repeatWindow?: number;
  supportedCapabilities?: readonly TraversalCapability[];
}>;

export class AuthoredChunkSelector {
  private readonly random: SeededRandom;
  private readonly repeatWindow: number;
  private readonly supportedCapabilities: ReadonlySet<TraversalCapability>;
  private readonly recentTemplateIds: string[] = [];
  private previous: ChunkTemplate | null = null;

  constructor(
    private readonly templates: readonly ChunkTemplate[],
    options: AuthoredChunkSelectorOptions,
  ) {
    validateChunkCatalog(templates);

    if (options.seed.trim().length === 0 || options.gameplayVersion.trim().length === 0) {
      throw new TypeError("Gameplay version and seed must not be empty");
    }

    const repeatWindow = options.repeatWindow ?? 2;
    if (!Number.isSafeInteger(repeatWindow) || repeatWindow < 0) {
      throw new RangeError("Repeat window must be a non-negative safe integer");
    }

    const supported = options.supportedCapabilities ?? DEFAULT_SUPPORTED_CAPABILITIES;
    if (supported.length === 0 || supported.some((capability) => !isCapability(capability))) {
      throw new TypeError("At least one supported traversal capability is required");
    }

    this.random = new SeededRandom(`${options.gameplayVersion}:${options.seed}`);
    this.repeatWindow = repeatWindow;
    this.supportedCapabilities = new Set(supported);
  }

  next(difficulty: number) {
    if (!Number.isSafeInteger(difficulty) || difficulty < 1) {
      throw new RangeError("Chunk difficulty must be a positive safe integer");
    }

    const eligible = this.templates
      .filter(
        (template) =>
          template.minimumDifficulty <= difficulty &&
          template.maximumDifficulty >= difficulty &&
          supportsCapability(this.supportedCapabilities, template.requiredCapability) &&
          (this.previous === null || areChunkBoundariesCompatible(this.previous, template)),
      )
      .slice()
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

    if (eligible.length === 0) {
      const previous = this.previous ? ` after "${this.previous.id}"` : "";
      throw new Error(
        `No reachable authored chunk is eligible at difficulty ${difficulty}${previous}`,
      );
    }

    const withoutRecentRepeats = eligible.filter(
      (template) => !this.recentTemplateIds.includes(template.id),
    );
    const candidates = withoutRecentRepeats.length > 0 ? withoutRecentRepeats : eligible;
    const selected = this.random.pick(candidates);

    this.previous = selected;
    this.recentTemplateIds.push(selected.id);
    if (this.recentTemplateIds.length > this.repeatWindow) {
      this.recentTemplateIds.shift();
    }

    return selected;
  }
}

const AUTHORED_TEMPLATES = [
  {
    id: "meadow-hop",
    width: 900,
    minimumDifficulty: 1,
    maximumDifficulty: 3,
    entry: { platformId: "approach" },
    exit: { platformId: "landing" },
    requiredCapability: "jump",
    platforms: [
      { id: "approach", x: 0, width: 350, top: 584 },
      { id: "landing", x: 430, width: 470, top: 584 },
    ],
    hazards: [{ id: "pond", kind: "water", x: 350, width: 250, top: 704 }],
    collectibles: [{ id: "feather", kind: "feather", x: 500, y: 520, radius: 10 }],
    route: [
      {
        fromPlatformId: "approach",
        toPlatformId: "landing",
        requiredCapability: "jump",
      },
    ],
  },
  {
    id: "stepping-rise",
    width: 900,
    minimumDifficulty: 1,
    maximumDifficulty: 4,
    entry: { platformId: "approach" },
    exit: { platformId: "high-landing" },
    requiredCapability: "jump",
    platforms: [
      { id: "approach", x: 0, width: 330, top: 584 },
      { id: "middle", x: 410, width: 220, top: 550 },
      { id: "high-landing", x: 710, width: 190, top: 520 },
    ],
    hazards: [
      { id: "first-pond", kind: "water", x: 330, width: 230, top: 704 },
      { id: "second-pond", kind: "water", x: 630, width: 270, top: 704 },
    ],
    collectibles: [{ id: "feather", kind: "feather", x: 525, y: 490, radius: 10 }],
    route: [
      {
        fromPlatformId: "approach",
        toPlatformId: "middle",
        requiredCapability: "jump",
      },
      {
        fromPlatformId: "middle",
        toPlatformId: "high-landing",
        requiredCapability: "jump",
      },
    ],
  },
  {
    id: "lift-terraces",
    width: 900,
    minimumDifficulty: 1,
    maximumDifficulty: 5,
    entry: { platformId: "approach" },
    exit: { platformId: "high-landing" },
    requiredCapability: "lift",
    platforms: [
      { id: "approach", x: 0, width: 330, top: 550 },
      { id: "middle", x: 430, width: 200, top: 520 },
      { id: "high-landing", x: 720, width: 180, top: 494 },
    ],
    hazards: [
      { id: "first-pond", kind: "water", x: 330, width: 230, top: 704 },
      { id: "second-pond", kind: "water", x: 630, width: 270, top: 704 },
    ],
    collectibles: [
      { id: "low-feather", kind: "feather", x: 520, y: 456, radius: 10 },
      { id: "high-feather", kind: "feather", x: 790, y: 430, radius: 10 },
    ],
    route: [
      {
        fromPlatformId: "approach",
        toPlatformId: "middle",
        requiredCapability: "lift",
      },
      {
        fromPlatformId: "middle",
        toPlatformId: "high-landing",
        requiredCapability: "lift",
      },
    ],
  },
  {
    id: "spike-straight",
    width: 900,
    minimumDifficulty: 1,
    maximumDifficulty: 5,
    entry: { platformId: "runway" },
    exit: { platformId: "runway" },
    requiredCapability: "jump",
    platforms: [{ id: "runway", x: 0, width: 900, top: 584 }],
    hazards: [
      {
        id: "spike",
        kind: "spike",
        x: 510,
        width: 46,
        baseTop: 584,
        height: 38,
      },
    ],
    collectibles: [{ id: "feather", kind: "feather", x: 530, y: 500, radius: 10 }],
    route: [],
  },
  {
    id: "gentle-drop",
    width: 900,
    minimumDifficulty: 1,
    maximumDifficulty: 4,
    entry: { platformId: "high-approach" },
    exit: { platformId: "low-landing" },
    requiredCapability: "jump",
    platforms: [
      { id: "high-approach", x: 0, width: 350, top: 494 },
      { id: "middle", x: 430, width: 210, top: 520 },
      { id: "low-landing", x: 720, width: 180, top: 550 },
    ],
    hazards: [
      { id: "first-pond", kind: "water", x: 350, width: 230, top: 704 },
      { id: "second-pond", kind: "water", x: 640, width: 260, top: 704 },
    ],
    collectibles: [{ id: "feather", kind: "feather", x: 535, y: 456, radius: 10 }],
    route: [
      {
        fromPlatformId: "high-approach",
        toPlatformId: "middle",
        requiredCapability: "jump",
      },
      {
        fromPlatformId: "middle",
        toPlatformId: "low-landing",
        requiredCapability: "jump",
      },
    ],
  },
  {
    id: "high-gap",
    width: 900,
    minimumDifficulty: 2,
    maximumDifficulty: 5,
    entry: { platformId: "approach" },
    exit: { platformId: "landing" },
    requiredCapability: "lift",
    platforms: [
      { id: "approach", x: 0, width: 360, top: 520 },
      { id: "landing", x: 470, width: 430, top: 520 },
    ],
    hazards: [{ id: "pond", kind: "water", x: 360, width: 250, top: 704 }],
    collectibles: [
      { id: "first-feather", kind: "feather", x: 490, y: 450, radius: 10 },
      { id: "second-feather", kind: "feather", x: 555, y: 430, radius: 10 },
    ],
    route: [
      {
        fromPlatformId: "approach",
        toPlatformId: "landing",
        requiredCapability: "lift",
      },
    ],
  },
] as const satisfies readonly ChunkTemplate[];

export const AUTHORED_CHUNK_TEMPLATES: readonly ChunkTemplate[] = Object.freeze(
  AUTHORED_TEMPLATES.map((template) => Object.freeze(template)),
);

validateChunkCatalog(AUTHORED_CHUNK_TEMPLATES);
