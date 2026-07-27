import {
  AUTHORED_CHUNK_TEMPLATES,
  AuthoredChunkSelector,
  type ChunkCollectibleSpec,
  type ChunkHazardSpec,
  type ChunkTemplate,
  type TraversalCapability,
} from "../content";
import type { PlatformDefinition, SpikeHazardDefinition, WaterZoneDefinition } from "./course";

const DEFAULT_SLOT_COUNT = 6;
const DEFAULT_RECYCLE_BEHIND_DISTANCE = 256;

export type GeneratedPlatformDefinition = PlatformDefinition &
  Readonly<{
    chunkIndex: number;
    templateId: string;
  }>;

export type GeneratedSpikeDefinition = SpikeHazardDefinition &
  Readonly<{
    chunkIndex: number;
    templateId: string;
  }>;

export type GeneratedWaterDefinition = WaterZoneDefinition &
  Readonly<{
    chunkIndex: number;
    templateId: string;
  }>;

export type GeneratedCollectibleDefinition = Readonly<{
  id: string;
  kind: ChunkCollectibleSpec["kind"];
  x: number;
  y: number;
  radius: number;
  chunkIndex: number;
  templateId: string;
}>;

export type GeneratedChunkPlacement = Readonly<{
  slotId: number;
  chunkIndex: number;
  templateId: string;
  originX: number;
  width: number;
}>;

export type GeneratedCoursePoolCapacities = Readonly<{
  chunkSlots: number;
  platforms: number;
  hazards: number;
  collectibles: number;
  total: number;
}>;

export type GeneratedCourseSnapshot = Readonly<{
  revision: number;
  chunks: readonly GeneratedChunkPlacement[];
  platforms: readonly GeneratedPlatformDefinition[];
  spikes: readonly GeneratedSpikeDefinition[];
  water: readonly GeneratedWaterDefinition[];
  collectibles: readonly GeneratedCollectibleDefinition[];
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
}>;

type MutableChunkPlacement = {
  slotId: number;
  chunkIndex: number;
  template: ChunkTemplate;
  originX: number;
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

function maximumCount(
  templates: readonly ChunkTemplate[],
  select: (template: ChunkTemplate) => readonly unknown[],
) {
  return Math.max(...templates.map((template) => select(template).length));
}

function worldEntityId(chunkIndex: number, templateId: string, entityId: string) {
  return `${chunkIndex}:${templateId}:${entityId}`;
}

function placeHazard(
  hazard: ChunkHazardSpec,
  placement: MutableChunkPlacement,
): GeneratedSpikeDefinition | GeneratedWaterDefinition {
  const shared = {
    id: worldEntityId(placement.chunkIndex, placement.template.id, hazard.id),
    x: placement.originX + hazard.x,
    chunkIndex: placement.chunkIndex,
    templateId: placement.template.id,
  };

  return hazard.kind === "spike"
    ? {
        ...shared,
        width: hazard.width,
        baseTop: hazard.baseTop,
        height: hazard.height,
      }
    : {
        ...shared,
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
  private readonly poolCapacitiesValue: GeneratedCoursePoolCapacities;
  private readonly placements: MutableChunkPlacement[] = [];

  private selector: AuthoredChunkSelector | null = null;
  private revision = 0;
  private recycledChunks = 0;
  private cachedSnapshot: GeneratedCourseSnapshot | null = null;

  constructor(options: GeneratedChunkCourseOptions = {}) {
    this.templates = options.templates ?? AUTHORED_CHUNK_TEMPLATES;
    this.slotCount = options.slotCount ?? DEFAULT_SLOT_COUNT;
    this.repeatWindow = options.repeatWindow ?? 2;
    this.recycleBehindDistance = options.recycleBehindDistance ?? DEFAULT_RECYCLE_BEHIND_DISTANCE;
    this.supportedCapabilities = options.supportedCapabilities;
    this.difficultyForChunk = options.difficultyForChunk ?? (() => 1);

    validatePositiveSafeInteger(this.slotCount, "Chunk slot count");
    validateNonNegativeFinite(this.recycleBehindDistance, "Recycle-behind distance");

    const platforms = maximumCount(this.templates, (template) => template.platforms);
    const hazards = maximumCount(this.templates, (template) => template.hazards);
    const collectibles = maximumCount(this.templates, (template) => template.collectibles);
    this.poolCapacitiesValue = Object.freeze({
      chunkSlots: this.slotCount,
      platforms: this.slotCount * platforms,
      hazards: this.slotCount * hazards,
      collectibles: this.slotCount * collectibles,
      total: this.slotCount * (platforms + hazards + collectibles),
    });

    this.reset("preview", "sho-15-preview");
  }

  reset(seed: string, gameplayVersion: string) {
    this.selector = new AuthoredChunkSelector(this.templates, {
      seed,
      gameplayVersion,
      repeatWindow: this.repeatWindow,
      supportedCapabilities: this.supportedCapabilities,
    });
    this.placements.length = 0;
    this.recycledChunks = 0;

    let originX = 0;
    for (let slotId = 0; slotId < this.slotCount; slotId += 1) {
      const placement = this.createPlacement(slotId, slotId, originX);
      this.placements.push(placement);
      originX += placement.template.width;
    }

    this.revision += 1;
    this.cachedSnapshot = null;
    return this.snapshot();
  }

  updateForFocus(focusWorldX: number) {
    if (!Number.isFinite(focusWorldX)) {
      throw new RangeError("Course focus must be finite");
    }

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
    }

    return this.snapshot();
  }

  snapshot(): GeneratedCourseSnapshot {
    if (this.cachedSnapshot) {
      return this.cachedSnapshot;
    }

    const chunks: GeneratedChunkPlacement[] = [];
    const platforms: GeneratedPlatformDefinition[] = [];
    const spikes: GeneratedSpikeDefinition[] = [];
    const water: GeneratedWaterDefinition[] = [];
    const collectibles: GeneratedCollectibleDefinition[] = [];

    for (const placement of this.placements) {
      chunks.push(
        Object.freeze({
          slotId: placement.slotId,
          chunkIndex: placement.chunkIndex,
          templateId: placement.template.id,
          originX: placement.originX,
          width: placement.template.width,
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
        const placed = placeHazard(hazard, placement);
        if (hazard.kind === "spike") {
          spikes.push(Object.freeze(placed as GeneratedSpikeDefinition));
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
      collectibles: Object.freeze(collectibles),
      poolCapacities: this.poolCapacitiesValue,
      recycledChunks: this.recycledChunks,
    });
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

    return {
      slotId,
      chunkIndex,
      originX,
      template: selector.next(difficulty),
    };
  }
}
