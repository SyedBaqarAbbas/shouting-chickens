import { SeededRandom } from "../core";

export type TraversalCapability = "run" | "jump" | "lift";

/**
 * Voice skills describe how a player expresses an intent. They deliberately do
 * not participate in physical reachability, which is governed exclusively by
 * TraversalCapability.
 */
export type VoiceSkill = "release" | "pulse-chain" | "sustained-lift";

export type ChunkMechanic =
  | "quiet-tunnel"
  | "sustained-lift-gap"
  | "precision-islands"
  | "spike-sequence"
  | "moving-hazard"
  | "feather-path";

export type ChunkChallengeStage = "introduction" | "advanced";

export type ChunkWarningKind =
  | "release"
  | "sustained-lift"
  | "pulse-chain"
  | "spikes"
  | "moving-hazard"
  | "optional-collectible";

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

export type ChunkMovingSpikeHazardSpec = Readonly<{
  id: string;
  kind: "moving-spike";
  x: number;
  width: number;
  baseTop: number;
  height: number;
  motion: Readonly<{
    axis: "horizontal";
    distance: number;
    periodTicks: number;
  }>;
}>;

export type ChunkQuietZoneSpec = Readonly<{
  id: string;
  kind: "quiet-zone";
  x: number;
  width: number;
  top: number;
  bottom: number;
  maximumLift: number;
}>;

export type ChunkWaterHazardSpec = Readonly<{
  id: string;
  kind: "water";
  x: number;
  width: number;
  top: number;
}>;

export type ChunkHazardSpec =
  ChunkSpikeHazardSpec | ChunkMovingSpikeHazardSpec | ChunkQuietZoneSpec | ChunkWaterHazardSpec;

export type ChunkCollectibleSpec = Readonly<{
  id: string;
  kind: "feather";
  x: number;
  y: number;
  radius: number;
  optional: true;
  path: Readonly<{
    fromPlatformId: string;
    requiredCapability: TraversalCapability;
  }>;
}>;

export type ChunkWarningSpec = Readonly<{
  id: string;
  kind: ChunkWarningKind;
  x: number;
  y: number;
  targetId: string;
  symbol: string;
  text: string;
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
  challengeStage: ChunkChallengeStage;
  mechanics: readonly ChunkMechanic[];
  requiresIntroductions: readonly ChunkMechanic[];
  voiceSkills: readonly VoiceSkill[];
  entry: TraversalAnchor;
  exit: TraversalAnchor;
  requiredCapability: TraversalCapability;
  platforms: readonly ChunkPlatformSpec[];
  hazards: readonly ChunkHazardSpec[];
  collectibles: readonly ChunkCollectibleSpec[];
  warnings: readonly ChunkWarningSpec[];
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

export const MINIMUM_WARNING_LEAD = 40;

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

const VOICE_SKILLS: readonly VoiceSkill[] = Object.freeze([
  "release",
  "pulse-chain",
  "sustained-lift",
]);

const CHUNK_MECHANICS: readonly ChunkMechanic[] = Object.freeze([
  "quiet-tunnel",
  "sustained-lift-gap",
  "precision-islands",
  "spike-sequence",
  "moving-hazard",
  "feather-path",
]);

const WARNING_KINDS: readonly ChunkWarningKind[] = Object.freeze([
  "release",
  "sustained-lift",
  "pulse-chain",
  "spikes",
  "moving-hazard",
  "optional-collectible",
]);

function isCapability(value: unknown): value is TraversalCapability {
  return value === "run" || value === "jump" || value === "lift";
}

function isVoiceSkill(value: unknown): value is VoiceSkill {
  return VOICE_SKILLS.includes(value as VoiceSkill);
}

function isChunkMechanic(value: unknown): value is ChunkMechanic {
  return CHUNK_MECHANICS.includes(value as ChunkMechanic);
}

function isWarningKind(value: unknown): value is ChunkWarningKind {
  return WARNING_KINDS.includes(value as ChunkWarningKind);
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

export function measureCollectiblePath(
  template: ChunkTemplate,
  collectible: ChunkCollectibleSpec,
): TraversalMeasurement | null {
  const from = platformById(template, collectible.path.fromPlatformId);
  if (!from) {
    return null;
  }

  return {
    horizontalGap: Math.max(0, from.x - collectible.x, collectible.x - (from.x + from.width)),
    verticalRise: Math.max(0, from.top - collectible.y - collectible.radius - 54),
    verticalDrop: 0,
    requiredCapability: collectible.path.requiredCapability,
  };
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
  if (template.challengeStage !== "introduction" && template.challengeStage !== "advanced") {
    errors.push(`${prefix} has an invalid challenge stage`);
  }
  if (
    template.mechanics.some((mechanic) => !isChunkMechanic(mechanic)) ||
    new Set(template.mechanics).size !== template.mechanics.length
  ) {
    errors.push(`${prefix} has invalid or repeated mechanic metadata`);
  }
  if (
    template.requiresIntroductions.some((mechanic) => !isChunkMechanic(mechanic)) ||
    new Set(template.requiresIntroductions).size !== template.requiresIntroductions.length
  ) {
    errors.push(`${prefix} has invalid or repeated introduction requirements`);
  }
  if (
    template.voiceSkills.some((skill) => !isVoiceSkill(skill)) ||
    new Set(template.voiceSkills).size !== template.voiceSkills.length
  ) {
    errors.push(`${prefix} has invalid or repeated voice-skill metadata`);
  }
  if (
    template.challengeStage === "advanced" &&
    template.mechanics.some((mechanic) => !template.requiresIntroductions.includes(mechanic))
  ) {
    errors.push(`${prefix} must require a safe introduction for every advanced mechanic`);
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

    let hasInvalidGeometry: boolean;
    if (hazard.kind === "spike") {
      hasInvalidGeometry =
        !Number.isFinite(hazard.baseTop) || !Number.isFinite(hazard.height) || hazard.height <= 0;
    } else if (hazard.kind === "moving-spike") {
      hasInvalidGeometry =
        !Number.isFinite(hazard.baseTop) ||
        !Number.isFinite(hazard.height) ||
        hazard.height <= 0 ||
        hazard.motion.axis !== "horizontal" ||
        !Number.isFinite(hazard.motion.distance) ||
        hazard.motion.distance <= 0 ||
        hazard.x + hazard.width + hazard.motion.distance > template.width ||
        !Number.isSafeInteger(hazard.motion.periodTicks) ||
        hazard.motion.periodTicks < 2 ||
        hazard.motion.periodTicks % 2 !== 0;
    } else if (hazard.kind === "quiet-zone") {
      hasInvalidGeometry =
        !Number.isFinite(hazard.top) ||
        !Number.isFinite(hazard.bottom) ||
        hazard.bottom <= hazard.top ||
        !Number.isFinite(hazard.maximumLift) ||
        hazard.maximumLift < 0 ||
        hazard.maximumLift > 1;
    } else {
      hasInvalidGeometry = !Number.isFinite(hazard.top);
    }

    if (hasInvalidGeometry) {
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

    const pickupPath = measureCollectiblePath(template, collectible);
    if (
      collectible.optional !== true ||
      !isCapability(collectible.path.requiredCapability) ||
      !pickupPath ||
      !isTraversalReachable(pickupPath)
    ) {
      errors.push(
        `${prefix} collectible "${collectible.id}" needs an optional reachable pickup path`,
      );
    }
  }

  for (const warning of template.warnings) {
    registerEntity(warning.id, "warning");
    const target =
      template.platforms.find((candidate) => candidate.id === warning.targetId) ??
      template.hazards.find((candidate) => candidate.id === warning.targetId) ??
      template.collectibles.find((candidate) => candidate.id === warning.targetId);
    if (
      !isWarningKind(warning.kind) ||
      !Number.isFinite(warning.x) ||
      warning.x < 0 ||
      warning.x > template.width ||
      !Number.isFinite(warning.y) ||
      warning.y < 0 ||
      warning.y > 768 ||
      !target ||
      target.x - warning.x < MINIMUM_WARNING_LEAD ||
      !isNonEmptyId(warning.symbol) ||
      !/[a-z]/i.test(warning.text)
    ) {
      errors.push(`${prefix} warning "${warning.id}" is not readable without color`);
    }
  }

  const expectedWarnings: Readonly<Partial<Record<ChunkMechanic, ChunkWarningKind>>> =
    Object.freeze({
      "quiet-tunnel": "release",
      "sustained-lift-gap": "sustained-lift",
      "precision-islands": "pulse-chain",
      "spike-sequence": "spikes",
      "moving-hazard": "moving-hazard",
      "feather-path": "optional-collectible",
    });

  for (const mechanic of template.mechanics) {
    const expectedWarning = expectedWarnings[mechanic];
    if (expectedWarning && !template.warnings.some((warning) => warning.kind === expectedWarning)) {
      errors.push(`${prefix} does not declare a readable warning for ${mechanic}`);
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
    for (const requiredIntroduction of template.requiresIntroductions) {
      const hasIntroduction = templates.some(
        (candidate) =>
          candidate.challengeStage === "introduction" &&
          candidate.mechanics.includes(requiredIntroduction),
      );

      if (!hasIntroduction) {
        errors.push(
          `Chunk "${template.id}" requires a missing ${requiredIntroduction} introduction`,
        );
      }
    }
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
  private readonly introducedMechanics = new Set<ChunkMechanic>();
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
          template.requiresIntroductions.every((mechanic) =>
            this.introducedMechanics.has(mechanic),
          ) &&
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
    if (selected.challengeStage === "introduction") {
      for (const mechanic of selected.mechanics) {
        this.introducedMechanics.add(mechanic);
      }
    }
    this.recentTemplateIds.push(selected.id);
    if (this.recentTemplateIds.length > this.repeatWindow) {
      this.recentTemplateIds.shift();
    }

    return selected;
  }
}

function optionalFeather(
  id: string,
  x: number,
  y: number,
  radius: number,
  fromPlatformId: string,
  requiredCapability: TraversalCapability,
): ChunkCollectibleSpec {
  return Object.freeze({
    id,
    kind: "feather",
    x,
    y,
    radius,
    optional: true,
    path: Object.freeze({
      fromPlatformId,
      requiredCapability,
    }),
  });
}

const AUTHORED_TEMPLATES = [
  {
    id: "meadow-hop",
    width: 900,
    minimumDifficulty: 1,
    maximumDifficulty: 3,
    challengeStage: "introduction",
    mechanics: [],
    requiresIntroductions: [],
    voiceSkills: [],
    entry: { platformId: "approach" },
    exit: { platformId: "landing" },
    requiredCapability: "jump",
    platforms: [
      { id: "approach", x: 0, width: 350, top: 584 },
      { id: "landing", x: 430, width: 470, top: 584 },
    ],
    hazards: [{ id: "pond", kind: "water", x: 350, width: 250, top: 704 }],
    collectibles: [optionalFeather("feather", 500, 520, 10, "landing", "jump")],
    warnings: [],
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
    challengeStage: "introduction",
    mechanics: [],
    requiresIntroductions: [],
    voiceSkills: [],
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
    collectibles: [optionalFeather("feather", 525, 490, 10, "middle", "jump")],
    warnings: [],
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
    challengeStage: "introduction",
    mechanics: ["sustained-lift-gap"],
    requiresIntroductions: [],
    voiceSkills: ["sustained-lift"],
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
      optionalFeather("low-feather", 520, 456, 10, "middle", "lift"),
      optionalFeather("high-feather", 790, 430, 10, "high-landing", "lift"),
    ],
    warnings: [
      {
        id: "hold-warning",
        kind: "sustained-lift",
        x: 382,
        y: 442,
        targetId: "middle",
        symbol: "↥",
        text: "HOLD LIFT",
      },
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
    challengeStage: "introduction",
    mechanics: ["spike-sequence"],
    requiresIntroductions: [],
    voiceSkills: [],
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
    collectibles: [optionalFeather("feather", 530, 500, 10, "runway", "jump")],
    warnings: [
      {
        id: "spike-warning",
        kind: "spikes",
        x: 430,
        y: 492,
        targetId: "spike",
        symbol: "!",
        text: "SPIKES — PULSE",
      },
    ],
    route: [],
  },
  {
    id: "gentle-drop",
    width: 900,
    minimumDifficulty: 1,
    maximumDifficulty: 4,
    challengeStage: "introduction",
    mechanics: [],
    requiresIntroductions: [],
    voiceSkills: [],
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
    collectibles: [optionalFeather("feather", 535, 456, 10, "middle", "jump")],
    warnings: [],
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
    challengeStage: "advanced",
    mechanics: ["sustained-lift-gap"],
    requiresIntroductions: ["sustained-lift-gap"],
    voiceSkills: ["sustained-lift"],
    entry: { platformId: "approach" },
    exit: { platformId: "landing" },
    requiredCapability: "lift",
    platforms: [
      { id: "approach", x: 0, width: 360, top: 520 },
      { id: "landing", x: 470, width: 430, top: 520 },
    ],
    hazards: [{ id: "pond", kind: "water", x: 360, width: 250, top: 704 }],
    collectibles: [
      optionalFeather("first-feather", 490, 450, 10, "landing", "lift"),
      optionalFeather("second-feather", 555, 430, 10, "landing", "lift"),
    ],
    warnings: [
      {
        id: "long-hold-warning",
        kind: "sustained-lift",
        x: 400,
        y: 428,
        targetId: "landing",
        symbol: "↥",
        text: "HOLD LIFT · RELEASE TO LAND",
      },
    ],
    route: [
      {
        fromPlatformId: "approach",
        toPlatformId: "landing",
        requiredCapability: "lift",
      },
    ],
  },
  {
    id: "quiet-tunnel-intro",
    width: 900,
    minimumDifficulty: 1,
    maximumDifficulty: 5,
    challengeStage: "introduction",
    mechanics: ["quiet-tunnel"],
    requiresIntroductions: [],
    voiceSkills: ["release"],
    entry: { platformId: "runway" },
    exit: { platformId: "runway" },
    requiredCapability: "run",
    platforms: [{ id: "runway", x: 0, width: 900, top: 584 }],
    hazards: [
      {
        id: "release-zone",
        kind: "quiet-zone",
        x: 390,
        width: 210,
        top: 426,
        bottom: 584,
        maximumLift: 0.16,
      },
    ],
    collectibles: [],
    warnings: [
      {
        id: "release-warning",
        kind: "release",
        x: 330,
        y: 414,
        targetId: "release-zone",
        symbol: "↓",
        text: "RELEASE · STAY QUIET",
      },
    ],
    route: [],
  },
  {
    id: "quiet-tunnel-advanced",
    width: 900,
    minimumDifficulty: 2,
    maximumDifficulty: 5,
    challengeStage: "advanced",
    mechanics: ["quiet-tunnel"],
    requiresIntroductions: ["quiet-tunnel"],
    voiceSkills: ["release"],
    entry: { platformId: "runway" },
    exit: { platformId: "runway" },
    requiredCapability: "run",
    platforms: [{ id: "runway", x: 0, width: 900, top: 584 }],
    hazards: [
      {
        id: "long-release-zone",
        kind: "quiet-zone",
        x: 300,
        width: 390,
        top: 426,
        bottom: 584,
        maximumLift: 0.1,
      },
    ],
    collectibles: [],
    warnings: [
      {
        id: "long-release-warning",
        kind: "release",
        x: 250,
        y: 414,
        targetId: "long-release-zone",
        symbol: "↓",
        text: "LONG QUIET TUNNEL · RELEASE",
      },
    ],
    route: [],
  },
  {
    id: "precision-islands-intro",
    width: 900,
    minimumDifficulty: 1,
    maximumDifficulty: 5,
    challengeStage: "introduction",
    mechanics: ["precision-islands"],
    requiresIntroductions: [],
    voiceSkills: ["pulse-chain"],
    entry: { platformId: "approach" },
    exit: { platformId: "landing" },
    requiredCapability: "jump",
    platforms: [
      { id: "approach", x: 0, width: 300, top: 584 },
      { id: "island", x: 370, width: 160, top: 584 },
      { id: "landing", x: 600, width: 300, top: 584 },
    ],
    hazards: [
      { id: "first-gap", kind: "water", x: 300, width: 70, top: 704 },
      { id: "second-gap", kind: "water", x: 530, width: 70, top: 704 },
    ],
    collectibles: [],
    warnings: [
      {
        id: "pulse-warning",
        kind: "pulse-chain",
        x: 260,
        y: 484,
        targetId: "first-gap",
        symbol: "••",
        text: "PULSE · RELEASE · PULSE",
      },
    ],
    route: [
      {
        fromPlatformId: "approach",
        toPlatformId: "island",
        requiredCapability: "jump",
      },
      {
        fromPlatformId: "island",
        toPlatformId: "landing",
        requiredCapability: "jump",
      },
    ],
  },
  {
    id: "precision-islands-advanced",
    width: 900,
    minimumDifficulty: 2,
    maximumDifficulty: 5,
    challengeStage: "advanced",
    mechanics: ["precision-islands"],
    requiresIntroductions: ["precision-islands"],
    voiceSkills: ["pulse-chain"],
    entry: { platformId: "approach" },
    exit: { platformId: "landing" },
    requiredCapability: "jump",
    platforms: [
      { id: "approach", x: 0, width: 250, top: 584 },
      { id: "first-island", x: 320, width: 120, top: 564 },
      { id: "second-island", x: 510, width: 120, top: 584 },
      { id: "landing", x: 700, width: 200, top: 564 },
    ],
    hazards: [
      { id: "first-gap", kind: "water", x: 250, width: 70, top: 704 },
      { id: "second-gap", kind: "water", x: 440, width: 70, top: 704 },
      { id: "third-gap", kind: "water", x: 630, width: 70, top: 704 },
    ],
    collectibles: [],
    warnings: [
      {
        id: "chain-warning",
        kind: "pulse-chain",
        x: 210,
        y: 472,
        targetId: "first-gap",
        symbol: "•••",
        text: "THREE SEPARATE PULSES",
      },
    ],
    route: [
      {
        fromPlatformId: "approach",
        toPlatformId: "first-island",
        requiredCapability: "jump",
      },
      {
        fromPlatformId: "first-island",
        toPlatformId: "second-island",
        requiredCapability: "jump",
      },
      {
        fromPlatformId: "second-island",
        toPlatformId: "landing",
        requiredCapability: "jump",
      },
    ],
  },
  {
    id: "spike-sequence-advanced",
    width: 900,
    minimumDifficulty: 2,
    maximumDifficulty: 5,
    challengeStage: "advanced",
    mechanics: ["spike-sequence"],
    requiresIntroductions: ["spike-sequence"],
    voiceSkills: ["pulse-chain"],
    entry: { platformId: "runway" },
    exit: { platformId: "runway" },
    requiredCapability: "jump",
    platforms: [{ id: "runway", x: 0, width: 900, top: 584 }],
    hazards: [
      {
        id: "first-spike",
        kind: "spike",
        x: 350,
        width: 42,
        baseTop: 584,
        height: 38,
      },
      {
        id: "second-spike",
        kind: "spike",
        x: 690,
        width: 42,
        baseTop: 584,
        height: 38,
      },
    ],
    collectibles: [],
    warnings: [
      {
        id: "sequence-warning",
        kind: "spikes",
        x: 270,
        y: 492,
        targetId: "first-spike",
        symbol: "!!",
        text: "TWO SPIKES · TWO PULSES",
      },
    ],
    route: [],
  },
  {
    id: "moving-spike-intro",
    width: 900,
    minimumDifficulty: 1,
    maximumDifficulty: 5,
    challengeStage: "introduction",
    mechanics: ["moving-hazard"],
    requiresIntroductions: [],
    voiceSkills: [],
    entry: { platformId: "runway" },
    exit: { platformId: "runway" },
    requiredCapability: "jump",
    platforms: [{ id: "runway", x: 0, width: 900, top: 584 }],
    hazards: [
      {
        id: "moving-spike",
        kind: "moving-spike",
        x: 430,
        width: 42,
        baseTop: 584,
        height: 38,
        motion: {
          axis: "horizontal",
          distance: 120,
          periodTicks: 120,
        },
      },
    ],
    collectibles: [],
    warnings: [
      {
        id: "moving-warning",
        kind: "moving-hazard",
        x: 350,
        y: 492,
        targetId: "moving-spike",
        symbol: "↔",
        text: "MOVING SPIKE · WATCH THEN PULSE",
      },
    ],
    route: [],
  },
  {
    id: "moving-spike-advanced",
    width: 900,
    minimumDifficulty: 2,
    maximumDifficulty: 5,
    challengeStage: "advanced",
    mechanics: ["moving-hazard"],
    requiresIntroductions: ["moving-hazard"],
    voiceSkills: ["pulse-chain"],
    entry: { platformId: "runway" },
    exit: { platformId: "runway" },
    requiredCapability: "jump",
    platforms: [{ id: "runway", x: 0, width: 900, top: 584 }],
    hazards: [
      {
        id: "first-moving-spike",
        kind: "moving-spike",
        x: 310,
        width: 40,
        baseTop: 584,
        height: 38,
        motion: {
          axis: "horizontal",
          distance: 80,
          periodTicks: 96,
        },
      },
      {
        id: "second-moving-spike",
        kind: "moving-spike",
        x: 650,
        width: 40,
        baseTop: 584,
        height: 38,
        motion: {
          axis: "horizontal",
          distance: 90,
          periodTicks: 144,
        },
      },
    ],
    collectibles: [],
    warnings: [
      {
        id: "moving-pair-warning",
        kind: "moving-hazard",
        x: 230,
        y: 492,
        targetId: "first-moving-spike",
        symbol: "↔↔",
        text: "MOVING PAIR · SEPARATE PULSES",
      },
    ],
    route: [],
  },
  {
    id: "feather-path-intro",
    width: 900,
    minimumDifficulty: 1,
    maximumDifficulty: 5,
    challengeStage: "introduction",
    mechanics: ["feather-path"],
    requiresIntroductions: [],
    voiceSkills: [],
    entry: { platformId: "runway" },
    exit: { platformId: "runway" },
    requiredCapability: "run",
    platforms: [{ id: "runway", x: 0, width: 900, top: 584 }],
    hazards: [],
    collectibles: [
      optionalFeather("first-feather", 450, 490, 12, "runway", "jump"),
      optionalFeather("second-feather", 650, 490, 12, "runway", "jump"),
    ],
    warnings: [
      {
        id: "optional-warning",
        kind: "optional-collectible",
        x: 350,
        y: 426,
        targetId: "first-feather",
        symbol: "✦",
        text: "OPTIONAL FEATHER ARC",
      },
    ],
    route: [],
  },
  {
    id: "feather-path-advanced",
    width: 900,
    minimumDifficulty: 2,
    maximumDifficulty: 5,
    challengeStage: "advanced",
    mechanics: ["feather-path"],
    requiresIntroductions: ["feather-path"],
    voiceSkills: [],
    entry: { platformId: "runway" },
    exit: { platformId: "runway" },
    requiredCapability: "run",
    platforms: [{ id: "runway", x: 0, width: 900, top: 584 }],
    hazards: [],
    collectibles: [
      optionalFeather("low-feather", 370, 500, 11, "runway", "jump"),
      optionalFeather("middle-feather", 460, 450, 11, "runway", "lift"),
      optionalFeather("high-feather", 550, 440, 11, "runway", "lift"),
      optionalFeather("exit-feather", 780, 490, 11, "runway", "jump"),
    ],
    warnings: [
      {
        id: "optional-arc-warning",
        kind: "optional-collectible",
        x: 270,
        y: 404,
        targetId: "low-feather",
        symbol: "✦",
        text: "OPTIONAL HIGH FEATHER ARC",
      },
    ],
    route: [],
  },
] as const satisfies readonly ChunkTemplate[];

export const AUTHORED_CHUNK_TEMPLATES: readonly ChunkTemplate[] = Object.freeze(
  AUTHORED_TEMPLATES.map((template) => Object.freeze(template)),
);

validateChunkCatalog(AUTHORED_CHUNK_TEMPLATES);
