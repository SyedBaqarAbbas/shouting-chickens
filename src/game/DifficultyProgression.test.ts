import { describe, expect, it } from "vitest";

import { AUTHORED_CHUNK_TEMPLATES, AuthoredChunkSelector } from "../content";
import {
  DIFFICULTY_PROFILES,
  MAX_DIFFICULTY_WORLD_SPEED,
  boundaryFitsDifficulty,
  difficultyProfileForChunk,
  templateFitsDifficulty,
  templateWeightForDifficulty,
} from "./DifficultyProgression";
import { GeneratedChunkCourse } from "./GeneratedChunkCourse";

describe("difficulty progression policy", () => {
  it.each([
    [0, 1],
    [5, 1],
    [6, 2],
    [13, 2],
    [14, 3],
    [23, 3],
    [24, 4],
    [35, 4],
    [36, 5],
    [100_000, 5],
  ] as const)("changes chunk %i at only its documented stage boundary", (chunkIndex, stage) => {
    expect(difficultyProfileForChunk(chunkIndex).stage).toBe(stage);
  });

  it("keeps speed and traversal envelopes bounded at every stage", () => {
    expect(DIFFICULTY_PROFILES.map((profile) => profile.startsAtChunk)).toEqual([0, 6, 14, 24, 36]);
    expect(DIFFICULTY_PROFILES.at(-1)?.worldSpeed).toBe(MAX_DIFFICULTY_WORLD_SPEED);
    expect(MAX_DIFFICULTY_WORLD_SPEED).toBe(160);

    for (const profile of DIFFICULTY_PROFILES) {
      expect(profile.worldSpeed).toBeLessThanOrEqual(MAX_DIFFICULTY_WORLD_SPEED);
      expect(profile.maximumGap).toBeLessThanOrEqual(110);
      expect(profile.maximumRise).toBeLessThanOrEqual(56);
      expect(profile.maximumDrop).toBeLessThanOrEqual(90);

      const eligible = AUTHORED_CHUNK_TEMPLATES.filter(
        (template) =>
          template.minimumDifficulty <= profile.difficulty &&
          template.maximumDifficulty >= profile.difficulty &&
          templateFitsDifficulty(template, profile) &&
          templateWeightForDifficulty(template, profile) > 0,
      );
      expect(eligible.length).toBeGreaterThan(0);
      expect(
        eligible.every((previous) =>
          eligible.some((next) => boundaryFitsDifficulty(previous, next, profile)),
        ),
      ).toBe(true);
    }
  });

  it("rejects an otherwise reachable route when its landing is narrower than the stage limit", () => {
    const meadow = AUTHORED_CHUNK_TEMPLATES.find((template) => template.id === "meadow-hop")!;
    const narrowLanding = {
      ...meadow,
      platforms: meadow.platforms.map((platform) =>
        platform.id === meadow.exit.platformId ? { ...platform, width: 100 } : platform,
      ),
    };

    expect(templateFitsDifficulty(narrowLanding, DIFFICULTY_PROFILES[0]!)).toBe(false);
  });

  it("uses deterministic non-negative integer weights and excludes zero-weight candidates", () => {
    const meadow = AUTHORED_CHUNK_TEMPLATES.find((template) => template.id === "meadow-hop")!;
    const preferred = {
      ...meadow,
      id: "preferred",
    };
    const excluded = {
      ...meadow,
      id: "excluded",
    };
    const selector = new AuthoredChunkSelector([preferred, excluded], {
      gameplayVersion: "weighted-v1",
      seed: "integer-weight",
      repeatWindow: 1,
      templateWeight: (template) => (template.id === "preferred" ? 7 : 0),
    });

    expect(Array.from({ length: 20 }, () => selector.next(1).id)).toEqual(
      Array.from({ length: 20 }, () => "preferred"),
    );
    expect(() =>
      new AuthoredChunkSelector([preferred], {
        gameplayVersion: "weighted-v1",
        seed: "bad-weight",
        templateWeight: () => 0.5,
      }).next(1),
    ).toThrow("non-negative safe integers");
  });

  it("generates long deterministic weighted runs inside every traversal envelope", () => {
    const authoredBefore = JSON.stringify(AUTHORED_CHUNK_TEMPLATES);
    const first = new GeneratedChunkCourse({ slotCount: 7 });
    const replay = new GeneratedChunkCourse({
      templates: AUTHORED_CHUNK_TEMPLATES,
      slotCount: 7,
    });
    const observedTemplates = new Map<number, string>();
    let lastObservedChunkIndex = -1;
    let verifiedTransitions = 0;
    let maximumRecycledChunks = 0;
    first.reset("long-progression", "sho-17-test");
    replay.reset("long-progression", "sho-17-test");

    for (let focus = 112; focus <= 1_000_000; focus += 487) {
      const firstSnapshot = first.updateForFocus(focus, Math.floor(focus / 2));
      const replaySnapshot = replay.updateForFocus(focus, Math.floor(focus / 2));
      expect(replaySnapshot.chunks).toEqual(firstSnapshot.chunks);
      maximumRecycledChunks = Math.max(maximumRecycledChunks, firstSnapshot.recycledChunks);

      for (const placement of firstSnapshot.chunks) {
        const expected = difficultyProfileForChunk(placement.chunkIndex);
        const template = AUTHORED_CHUNK_TEMPLATES.find(
          (candidate) => candidate.id === placement.templateId,
        );
        expect(template).toBeDefined();
        expect(placement.difficultyStage).toBe(expected.stage);
        expect(placement.difficulty).toBe(expected.difficulty);
        expect(placement.worldSpeed).toBe(expected.worldSpeed);
        expect(placement.worldSpeed).toBeLessThanOrEqual(MAX_DIFFICULTY_WORLD_SPEED);
        expect(templateFitsDifficulty(template!, expected)).toBe(true);

        const previousTemplateId = observedTemplates.get(placement.chunkIndex);
        if (previousTemplateId !== undefined) {
          expect(placement.templateId).toBe(previousTemplateId);
          continue;
        }

        expect(placement.chunkIndex).toBe(lastObservedChunkIndex + 1);
        if (placement.chunkIndex > 0) {
          const selectedPreviousTemplateId = observedTemplates.get(placement.chunkIndex - 1);
          const selectedPreviousTemplate = AUTHORED_CHUNK_TEMPLATES.find(
            (candidate) => candidate.id === selectedPreviousTemplateId,
          );
          expect(selectedPreviousTemplate).toBeDefined();
          expect(boundaryFitsDifficulty(selectedPreviousTemplate!, template!, expected)).toBe(true);
          verifiedTransitions += 1;
        }
        observedTemplates.set(placement.chunkIndex, placement.templateId);
        lastObservedChunkIndex = placement.chunkIndex;
      }
    }

    expect(maximumRecycledChunks).toBeGreaterThan(1_000);
    expect(observedTemplates.size).toBe(lastObservedChunkIndex + 1);
    expect(verifiedTransitions).toBe(observedTemplates.size - 1);
    expect(JSON.stringify(AUTHORED_CHUNK_TEMPLATES)).toBe(authoredBefore);
  });
});
