import {
  AUTHORED_CHUNK_TEMPLATES,
  AuthoredChunkSelector,
  type ChunkCollectibleSpec,
  type ChunkHazardSpec,
  type ChunkMechanic,
  type ChunkTemplate,
  type ChunkWarningKind,
  type VoiceSkill,
  type TraversalCapability,
} from "../content";
import { SeededRandom } from "../core";
import type { PlatformDefinition, SpikeHazardDefinition, WaterZoneDefinition } from "./course";
import {
  boundaryFitsDifficulty,
  difficultyProfileForChunk,
  difficultyProfileForLevel,
  templateFitsDifficulty,
  templateWeightForDifficulty,
  type DifficultyProfile,
} from "./DifficultyProgression";

const DEFAULT_SLOT_COUNT = 6;
const DEFAULT_RECYCLE_BEHIND_DISTANCE = 256;

export type GeneratedPlatformDefinition = PlatformDefinition &
  Readonly<{
    chunkIndex: number;
    templateId: string;
  }>;

export type GeneratedSpikeDefinition = SpikeHazardDefinition &
  Readonly<{
    kind: "spike" | "moving-spike";
    chunkIndex: number;
    templateId: string;
    motion: Readonly<{
      axis: "horizontal";
      distance: number;
      periodTicks: number;
      phaseTick: number;
      offset: number;
    }> | null;
  }>;

export type GeneratedWaterDefinition = WaterZoneDefinition &
  Readonly<{
    kind: "water";
    chunkIndex: number;
    templateId: string;
  }>;

export type GeneratedQuietZoneDefinition = Readonly<{
  id: string;
  kind: "quiet-zone";
  x: number;
  width: number;
  top: number;
  bottom: number;
  maximumLift: number;
  chunkIndex: number;
  templateId: string;
}>;

export type GeneratedCollectibleDefinition = Readonly<{
  id: string;
  kind: ChunkCollectibleSpec["kind"];
  x: number;
  y: number;
  radius: number;
  optional: true;
  path: Readonly<{
    fromPlatformId: string;
    requiredCapability: TraversalCapability;
  }>;
  chunkIndex: number;
  templateId: string;
}>;

export type GeneratedWarningDefinition = Readonly<{
  id: string;
  kind: ChunkWarningKind;
  x: number;
  y: number;
  targetId: string;
  symbol: string;
  text: string;
  chunkIndex: number;
  templateId: string;
}>;

export type GeneratedChunkPlacement = Readonly<{
  slotId: number;
  chunkIndex: number;
  templateId: string;
  originX: number;
  width: number;
  difficultyStage: DifficultyProfile["stage"];
  difficulty: number;
  worldSpeed: number;
  minimumDifficulty: number;
  maximumDifficulty: number;
  requiredCapability: TraversalCapability;
  voiceSkills: readonly VoiceSkill[];
  mechanics: readonly ChunkMechanic[];
  challengeStage: ChunkTemplate["challengeStage"];
}>;

export type GeneratedCoursePoolCapacities = Readonly<{
  chunkSlots: number;
  platforms: number;
  hazards: number;
  collectibles: number;
  warnings: number;
  total: number;
}>;

export type GeneratedCourseSnapshot = Readonly<{
  revision: number;
  chunks: readonly GeneratedChunkPlacement[];
  platforms: readonly GeneratedPlatformDefinition[];
  spikes: readonly GeneratedSpikeDefinition[];
  water: readonly GeneratedWaterDefinition[];
  quietZones: readonly GeneratedQuietZoneDefinition[];
  collectibles: readonly GeneratedCollectibleDefinition[];
  warnings: readonly GeneratedWarningDefinition[];
  poolCapacities: GeneratedCoursePoolCapacities;
  recycledChunks: number;
}>;

export type GeneratedCourseDiagnostics = Readonly<{
  firstChunkIndex: number;
  lastChunkIndex: number;
  aheadDistance: number;
  behindDistance: number;
  recycledChunks: number;
  poolCapacities: GeneratedCoursePoolCapacities;
}>;

export type GeneratedChunkCourseOptions = Readonly<{
  templates?: readonly ChunkTemplate[];
  slotCount?: number;
  repeatWindow?: number;
  recycleBehindDistance?: number;
  supportedCapabilities?: readonly TraversalCapability[];
  difficultyForChunk?: (chunkIndex: number) => number;
  progressionForChunk?: (chunkIndex: number) => DifficultyProfile;
}>;

type MutableChunkPlacement = {
  slotId: number;
  chunkIndex: number;
  template: ChunkTemplate;
  originX: number;
  progression: DifficultyProfile;
  difficulty: number;
};

function validatePositiveSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function validateNonNegativeFinite(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`);
  }
}

function validateSimulationTick(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Simulation tick must be a non-negative safe integer");
  }
}

function maximumCount(
  templates: readonly ChunkTemplate[],
  select: (template: ChunkTemplate) => readonly unknown[],
) {
  return Math.max(...templates.map((template) => select(template).length));
}

function worldEntityId(chunkIndex: number, templateId: string, entityId: string) {
  return `${chunkIndex}:${templateId}:${entityId}`;
}

export function deterministicMotionOffset(
  tick: number,
  periodTicks: number,
  distance: number,
  phaseTick: number,
) {
  validateSimulationTick(tick);
  if (
    !Number.isSafeInteger(periodTicks) ||
    periodTicks < 2 ||
    periodTicks % 2 !== 0 ||
    !Number.isFinite(distance) ||
    distance < 0 ||
    !Number.isSafeInteger(phaseTick) ||
    phaseTick < 0 ||
    phaseTick >= periodTicks
  ) {
    throw new RangeError("Moving content needs a valid even period, distance, and phase");
  }

  const cycleTick = (tick + phaseTick) % periodTicks;
  const halfPeriod = periodTicks / 2;
  const progress =
    cycleTick <= halfPeriod ? cycleTick / halfPeriod : (periodTicks - cycleTick) / halfPeriod;
  return distance * progress;
}

function movementPhaseTick(
  motionSeed: string,
  placement: MutableChunkPlacement,
  hazardId: string,
  periodTicks: number,
) {
  return new SeededRandom(
    `${motionSeed}:${placement.chunkIndex}:${placement.template.id}:${hazardId}`,
  ).integer(0, periodTicks - 1);
}

function placeHazard(
  hazard: ChunkHazardSpec,
  placement: MutableChunkPlacement,
  simulationTick: number,
  motionSeed: string,
): GeneratedSpikeDefinition | GeneratedWaterDefinition | GeneratedQuietZoneDefinition {
  const shared = {
    id: worldEntityId(placement.chunkIndex, placement.template.id, hazard.id),
    x: placement.originX + hazard.x,
    chunkIndex: placement.chunkIndex,
    templateId: placement.template.id,
  };

  if (hazard.kind === "spike") {
    return {
      ...shared,
      kind: "spike",
      width: hazard.width,
      baseTop: hazard.baseTop,
      height: hazard.height,
      motion: null,
    };
  }

  if (hazard.kind === "moving-spike") {
    const phaseTick = movementPhaseTick(
      motionSeed,
      placement,
      hazard.id,
      hazard.motion.periodTicks,
    );
    const offset = deterministicMotionOffset(
      simulationTick,
      hazard.motion.periodTicks,
      hazard.motion.distance,
      phaseTick,
    );

    return {
      ...shared,
      kind: "moving-spike",
      x: shared.x + offset,
      width: hazard.width,
      baseTop: hazard.baseTop,
      height: hazard.height,
      motion: {
        ...hazard.motion,
        phaseTick,
        offset,
      },
    };
  }

  if (hazard.kind === "quiet-zone") {
    return {
      ...shared,
      kind: "quiet-zone",
      width: hazard.width,
      top: hazard.top,
      bottom: hazard.bottom,
      maximumLift: hazard.maximumLift,
    };
  }

  return {
    ...shared,
    kind: "water",
    width: hazard.width,
    top: hazard.top,
  };
}

export class GeneratedChunkCourse {
  private readonly templates: readonly ChunkTemplate[];
  private readonly slotCount: number;
  private readonly repeatWindow: number;
  private readonly recycleBehindDistance: number;
  private readonly supportedCapabilities: readonly TraversalCapability[] | undefined;
  private readonly difficultyForChunk: (chunkIndex: number) => number;
  private readonly progressionForChunk: (chunkIndex: number) => DifficultyProfile;
  private readonly useDifficultySelectionPolicy: boolean;
  private readonly poolCapacitiesValue: GeneratedCoursePoolCapacities;
  private readonly placements: MutableChunkPlacement[] = [];

  private selector: AuthoredChunkSelector | null = null;
  private revision = 0;
  private recycledChunks = 0;
  private cachedSnapshot: GeneratedCourseSnapshot | null = null;
  private cachedSnapshotTick = -1;
  private lastSimulationTick = 0;
  private motionSeed = "sho-16-preview:preview";
  private lastSeed = "preview";
  private lastGameplayVersion = "sho-16-preview";

  constructor(options: GeneratedChunkCourseOptions = {}) {
    const usesCanonicalCatalog =
      options.templates === undefined || options.templates === AUTHORED_CHUNK_TEMPLATES;
    this.templates = options.templates ?? AUTHORED_CHUNK_TEMPLATES;
    this.slotCount = options.slotCount ?? DEFAULT_SLOT_COUNT;
    this.repeatWindow = options.repeatWindow ?? 2;
    this.recycleBehindDistance = options.recycleBehindDistance ?? DEFAULT_RECYCLE_BEHIND_DISTANCE;
    this.supportedCapabilities = options.supportedCapabilities;
    this.progressionForChunk =
      options.progressionForChunk ??
      (usesCanonicalCatalog ? difficultyProfileForChunk : () => difficultyProfileForLevel(1));
    this.difficultyForChunk =
      options.difficultyForChunk ??
      ((chunkIndex) => this.progressionForChunk(chunkIndex).difficulty);
    this.useDifficultySelectionPolicy = usesCanonicalCatalog;

    validatePositiveSafeInteger(this.slotCount, "Chunk slot count");
    validateNonNegativeFinite(this.recycleBehindDistance, "Recycle-behind distance");

    const platforms = maximumCount(this.templates, (template) => template.platforms);
    const hazards = maximumCount(this.templates, (template) => template.hazards);
    const collectibles = maximumCount(this.templates, (template) => template.collectibles);
    const warnings = maximumCount(this.templates, (template) => template.warnings);
    this.poolCapacitiesValue = Object.freeze({
      chunkSlots: this.slotCount,
      platforms: this.slotCount * platforms,
      hazards: this.slotCount * hazards,
      collectibles: this.slotCount * collectibles,
      warnings: this.slotCount * warnings,
      total: this.slotCount * (platforms + hazards + collectibles + warnings),
    });

    this.reset("preview", "sho-16-preview");
  }

  reset(seed: string, gameplayVersion: string) {
    this.selector = new AuthoredChunkSelector(this.templates, {
      seed,
      gameplayVersion,
      repeatWindow: this.repeatWindow,
      supportedCapabilities: this.supportedCapabilities,
      templateEligible: this.useDifficultySelectionPolicy
        ? (template, difficulty) =>
            templateFitsDifficulty(template, difficultyProfileForLevel(difficulty))
        : undefined,
      templateWeight: this.useDifficultySelectionPolicy
        ? (template, difficulty) =>
            templateWeightForDifficulty(template, difficultyProfileForLevel(difficulty))
        : undefined,
      transitionEligible: this.useDifficultySelectionPolicy
        ? (previous, next, difficulty) =>
            boundaryFitsDifficulty(previous, next, difficultyProfileForLevel(difficulty))
        : undefined,
    });
    this.placements.length = 0;
    this.recycledChunks = 0;
    this.lastSimulationTick = 0;
    this.motionSeed = `${gameplayVersion}:${seed}`;
    this.lastSeed = seed;
    this.lastGameplayVersion = gameplayVersion;

    let originX = 0;
    for (let slotId = 0; slotId < this.slotCount; slotId += 1) {
      const placement = this.createPlacement(slotId, slotId, originX);
      this.placements.push(placement);
      originX += placement.template.width;
    }

    this.revision += 1;
    this.cachedSnapshot = null;
    this.cachedSnapshotTick = -1;
    return this.snapshot(0);
  }

  restart() {
    return this.reset(this.lastSeed, this.lastGameplayVersion);
  }

  updateForFocus(focusWorldX: number, simulationTick = this.lastSimulationTick) {
    if (!Number.isFinite(focusWorldX)) {
      throw new RangeError("Course focus must be finite");
    }
    validateSimulationTick(simulationTick);
    this.lastSimulationTick = simulationTick;

    let changed = false;
    let first = this.placements[0];

    while (
      first &&
      first.originX + first.template.width < focusWorldX - this.recycleBehindDistance
    ) {
      const recycled = this.placements.shift();
      const last = this.placements.at(-1);

      if (!recycled || !last) {
        throw new Error("Generated course lost its fixed chunk pool");
      }

      const chunkIndex = last.chunkIndex + 1;
      const originX = last.originX + last.template.width;
      this.placements.push(this.createPlacement(recycled.slotId, chunkIndex, originX));
      this.recycledChunks += 1;
      changed = true;
      first = this.placements[0];
    }

    if (changed) {
      this.revision += 1;
      this.cachedSnapshot = null;
      this.cachedSnapshotTick = -1;
    }

    return this.snapshot(simulationTick);
  }

  snapshot(simulationTick = this.lastSimulationTick): GeneratedCourseSnapshot {
    validateSimulationTick(simulationTick);
    this.lastSimulationTick = simulationTick;

    if (this.cachedSnapshot && this.cachedSnapshotTick === simulationTick) {
      return this.cachedSnapshot;
    }

    const chunks: GeneratedChunkPlacement[] = [];
    const platforms: GeneratedPlatformDefinition[] = [];
    const spikes: GeneratedSpikeDefinition[] = [];
    const water: GeneratedWaterDefinition[] = [];
    const quietZones: GeneratedQuietZoneDefinition[] = [];
    const collectibles: GeneratedCollectibleDefinition[] = [];
    const warnings: GeneratedWarningDefinition[] = [];

    for (const placement of this.placements) {
      chunks.push(
        Object.freeze({
          slotId: placement.slotId,
          chunkIndex: placement.chunkIndex,
          templateId: placement.template.id,
          originX: placement.originX,
          width: placement.template.width,
          difficultyStage: placement.progression.stage,
          difficulty: placement.difficulty,
          worldSpeed: placement.progression.worldSpeed,
          minimumDifficulty: placement.template.minimumDifficulty,
          maximumDifficulty: placement.template.maximumDifficulty,
          requiredCapability: placement.template.requiredCapability,
          voiceSkills: Object.freeze([...placement.template.voiceSkills]),
          mechanics: Object.freeze([...placement.template.mechanics]),
          challengeStage: placement.template.challengeStage,
        }),
      );

      for (const platform of placement.template.platforms) {
        platforms.push(
          Object.freeze({
            id: worldEntityId(placement.chunkIndex, placement.template.id, platform.id),
            x: placement.originX + platform.x,
            width: platform.width,
            top: platform.top,
            chunkIndex: placement.chunkIndex,
            templateId: placement.template.id,
          }),
        );
      }

      for (const hazard of placement.template.hazards) {
        const placed = placeHazard(hazard, placement, simulationTick, this.motionSeed);
        if (hazard.kind === "spike" || hazard.kind === "moving-spike") {
          spikes.push(Object.freeze(placed as GeneratedSpikeDefinition));
        } else if (hazard.kind === "quiet-zone") {
          quietZones.push(Object.freeze(placed as GeneratedQuietZoneDefinition));
        } else {
          water.push(Object.freeze(placed as GeneratedWaterDefinition));
        }
      }

      for (const collectible of placement.template.collectibles) {
        collectibles.push(
          Object.freeze({
            id: worldEntityId(placement.chunkIndex, placement.template.id, collectible.id),
            kind: collectible.kind,
            x: placement.originX + collectible.x,
            y: collectible.y,
            radius: collectible.radius,
            optional: collectible.optional,
            path: Object.freeze({
              fromPlatformId: worldEntityId(
                placement.chunkIndex,
                placement.template.id,
                collectible.path.fromPlatformId,
              ),
              requiredCapability: collectible.path.requiredCapability,
            }),
            chunkIndex: placement.chunkIndex,
            templateId: placement.template.id,
          }),
        );
      }

      for (const warning of placement.template.warnings) {
        warnings.push(
          Object.freeze({
            id: worldEntityId(placement.chunkIndex, placement.template.id, warning.id),
            kind: warning.kind,
            x: placement.originX + warning.x,
            y: warning.y,
            targetId: worldEntityId(placement.chunkIndex, placement.template.id, warning.targetId),
            symbol: warning.symbol,
            text: warning.text,
            chunkIndex: placement.chunkIndex,
            templateId: placement.template.id,
          }),
        );
      }
    }

    this.cachedSnapshot = Object.freeze({
      revision: this.revision,
      chunks: Object.freeze(chunks),
      platforms: Object.freeze(platforms),
      spikes: Object.freeze(spikes),
      water: Object.freeze(water),
      quietZones: Object.freeze(quietZones),
      collectibles: Object.freeze(collectibles),
      warnings: Object.freeze(warnings),
      poolCapacities: this.poolCapacitiesValue,
      recycledChunks: this.recycledChunks,
    });
    this.cachedSnapshotTick = simulationTick;
    return this.cachedSnapshot;
  }

  chunkAt(worldX: number) {
    return (
      this.placements.find(
        (placement) =>
          worldX >= placement.originX && worldX < placement.originX + placement.template.width,
      ) ?? this.placements.at(-1)
    );
  }

  diagnostics(focusWorldX: number): GeneratedCourseDiagnostics {
    const first = this.placements[0];
    const last = this.placements.at(-1);

    if (!first || !last) {
      throw new Error("Generated course has no active chunk placements");
    }

    return Object.freeze({
      firstChunkIndex: first.chunkIndex,
      lastChunkIndex: last.chunkIndex,
      aheadDistance: last.originX + last.template.width - focusWorldX,
      behindDistance: focusWorldX - first.originX,
      recycledChunks: this.recycledChunks,
      poolCapacities: this.poolCapacitiesValue,
    });
  }

  poolCapacities() {
    return this.poolCapacitiesValue;
  }

  private createPlacement(slotId: number, chunkIndex: number, originX: number) {
    const selector = this.selector;
    if (!selector) {
      throw new Error("Generated course must be seeded before selecting chunks");
    }

    const difficulty = this.difficultyForChunk(chunkIndex);
    if (!Number.isSafeInteger(difficulty) || difficulty < 1) {
      throw new RangeError("Generated chunk difficulty must be a positive safe integer");
    }

    const progression = this.progressionForChunk(chunkIndex);
    if (
      !Number.isSafeInteger(progression.stage) ||
      progression.stage < 1 ||
      !Number.isFinite(progression.worldSpeed) ||
      progression.worldSpeed <= 0
    ) {
      throw new RangeError("Generated chunk progression must have a valid stage and world speed");
    }

    return {
      slotId,
      chunkIndex,
      originX,
      difficulty,
      progression,
      template: selector.next(difficulty),
    };
  }
}
