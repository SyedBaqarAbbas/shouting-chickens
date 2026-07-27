import { describe, expect, it } from "vitest";

import {
  AUTHORED_CHUNK_TEMPLATES,
  AuthoredChunkSelector,
  ChunkCatalogValidationError,
  MINIMUM_WARNING_LEAD,
  areChunkBoundariesCompatible,
  isTraversalReachable,
  measureCollectiblePath,
  measureChunkTransition,
  validateChunkCatalog,
  type ChunkTemplate,
} from "./chunks";

function selectSequence(seed: string, gameplayVersion: string, length: number, difficulty = 1) {
  const selector = new AuthoredChunkSelector(AUTHORED_CHUNK_TEMPLATES, {
    seed,
    gameplayVersion,
    repeatWindow: 2,
  });

  return Array.from({ length }, () => selector.next(difficulty));
}

describe("authored chunk catalog", () => {
  it("declares valid traversal, content, and difficulty contracts for every template", () => {
    expect(() => validateChunkCatalog(AUTHORED_CHUNK_TEMPLATES)).not.toThrow();

    for (const template of AUTHORED_CHUNK_TEMPLATES) {
      expect(template).toMatchObject({
        id: expect.any(String),
        width: expect.any(Number),
        minimumDifficulty: expect.any(Number),
        maximumDifficulty: expect.any(Number),
        challengeStage: expect.stringMatching(/^(introduction|advanced)$/),
        mechanics: expect.any(Array),
        requiresIntroductions: expect.any(Array),
        voiceSkills: expect.any(Array),
        entry: { platformId: expect.any(String) },
        exit: { platformId: expect.any(String) },
        requiredCapability: expect.stringMatching(/^(run|jump|lift)$/),
        platforms: expect.any(Array),
        hazards: expect.any(Array),
        collectibles: expect.any(Array),
        warnings: expect.any(Array),
        route: expect.any(Array),
      });

      for (const transition of template.route) {
        const measurement = measureChunkTransition(template, transition);
        expect(measurement).not.toBeNull();
        expect(isTraversalReachable(measurement!)).toBe(true);
      }
    }
  });

  it("keeps voice-expression skills separate from physical traversal capabilities", () => {
    const physicalCapabilities = new Set(["run", "jump", "lift"]);
    const voiceSkills = new Set(["release", "pulse-chain", "sustained-lift"]);

    for (const template of AUTHORED_CHUNK_TEMPLATES) {
      expect(physicalCapabilities.has(template.requiredCapability)).toBe(true);
      for (const skill of template.voiceSkills) {
        expect(voiceSkills.has(skill)).toBe(true);
        expect(physicalCapabilities.has(skill)).toBe(false);
      }
    }
  });

  it("publishes text-and-symbol warnings for every voice-aware mechanic", () => {
    const mechanicTemplates = AUTHORED_CHUNK_TEMPLATES.filter(
      (template) => template.mechanics.length > 0,
    );

    expect(mechanicTemplates.length).toBeGreaterThan(0);
    for (const template of mechanicTemplates) {
      expect(template.warnings.length).toBeGreaterThan(0);
      for (const warning of template.warnings) {
        expect(warning.symbol.trim()).not.toBe("");
        expect(warning.text).toMatch(/[a-z]/i);
      }
    }
  });

  it("authors a safe introduction and a gated harder variant for every mechanic", () => {
    const mechanics = [
      "quiet-tunnel",
      "sustained-lift-gap",
      "precision-islands",
      "spike-sequence",
      "moving-hazard",
      "feather-path",
    ] as const;

    for (const mechanic of mechanics) {
      const introduction = AUTHORED_CHUNK_TEMPLATES.find(
        (template) =>
          template.challengeStage === "introduction" && template.mechanics.includes(mechanic),
      );
      const advanced = AUTHORED_CHUNK_TEMPLATES.find(
        (template) =>
          template.challengeStage === "advanced" && template.mechanics.includes(mechanic),
      );

      expect(introduction, `${mechanic} introduction`).toBeDefined();
      expect(advanced, `${mechanic} advanced variant`).toBeDefined();
      expect(advanced?.requiresIntroductions).toContain(mechanic);
      expect(advanced!.minimumDifficulty).toBeGreaterThan(introduction!.minimumDifficulty);
    }
  });

  it("keeps every introduction and advanced feather reachable on an optional route", () => {
    const featherTemplates = AUTHORED_CHUNK_TEMPLATES.filter((template) =>
      template.mechanics.includes("feather-path"),
    );

    expect(featherTemplates.map((template) => template.challengeStage).sort()).toEqual([
      "advanced",
      "introduction",
    ]);
    for (const template of featherTemplates) {
      expect(template.collectibles.length).toBeGreaterThan(0);
      for (const collectible of template.collectibles) {
        const path = measureCollectiblePath(template, collectible);
        expect(collectible.optional).toBe(true);
        expect(path).not.toBeNull();
        expect(isTraversalReachable(path!)).toBe(true);
        expect(template.route).not.toContainEqual(
          expect.objectContaining({
            fromPlatformId: collectible.id,
          }),
        );
        expect(template.route).not.toContainEqual(
          expect.objectContaining({
            toPlatformId: collectible.id,
          }),
        );
      }
    }
  });

  it("places every warning at least one reaction lead before its target", () => {
    for (const template of AUTHORED_CHUNK_TEMPLATES) {
      for (const warning of template.warnings) {
        const target = [...template.platforms, ...template.hazards, ...template.collectibles].find(
          (entity) => entity.id === warning.targetId,
        )!;

        expect(target.x - warning.x).toBeGreaterThanOrEqual(MINIMUM_WARNING_LEAD);
      }
    }
  });

  it("produces an identical long sequence for the same gameplay version and seed", () => {
    const first = selectSequence("same-seed", "content-v1", 500);
    const second = selectSequence("same-seed", "content-v1", 500);

    expect(second.map((chunk) => chunk.id)).toEqual(first.map((chunk) => chunk.id));
    expect(selectSequence("other-seed", "content-v1", 64).map((chunk) => chunk.id)).not.toEqual(
      first.slice(0, 64).map((chunk) => chunk.id),
    );
    expect(selectSequence("same-seed", "content-v2", 64).map((chunk) => chunk.id)).not.toEqual(
      first.slice(0, 64).map((chunk) => chunk.id),
    );
  });

  it("selects only eligible, supported, compatible chunks without configured repeats", () => {
    const selector = new AuthoredChunkSelector(AUTHORED_CHUNK_TEMPLATES, {
      seed: "jump-only",
      gameplayVersion: "content-v1",
      repeatWindow: 2,
      supportedCapabilities: ["run", "jump"],
    });
    const sequence = Array.from({ length: 400 }, () => selector.next(1));

    for (let index = 0; index < sequence.length; index += 1) {
      const template = sequence[index]!;
      expect(template.minimumDifficulty).toBeLessThanOrEqual(1);
      expect(template.maximumDifficulty).toBeGreaterThanOrEqual(1);
      expect(template.requiredCapability).not.toBe("lift");

      const previous = sequence[index - 1];
      if (previous) {
        expect(areChunkBoundariesCompatible(previous, template)).toBe(true);
        expect(template.id).not.toBe(previous.id);
      }

      const twoBack = sequence[index - 2];
      if (twoBack) {
        expect(template.id).not.toBe(twoBack.id);
      }
    }
  });

  it("satisfies repeatability and reachability across a property-style seed matrix", () => {
    for (let difficulty = 1; difficulty <= 5; difficulty += 1) {
      for (let seedIndex = 0; seedIndex < 30; seedIndex += 1) {
        const seed = `property-${difficulty}-${seedIndex}`;
        const first = selectSequence(seed, "property-v1", 100, difficulty);
        const replay = selectSequence(seed, "property-v1", 100, difficulty);

        expect(replay.map((chunk) => chunk.id)).toEqual(first.map((chunk) => chunk.id));

        for (let index = 0; index < first.length; index += 1) {
          const template = first[index]!;
          expect(template.minimumDifficulty).toBeLessThanOrEqual(difficulty);
          expect(template.maximumDifficulty).toBeGreaterThanOrEqual(difficulty);

          const previous = first[index - 1];
          if (previous) {
            expect(areChunkBoundariesCompatible(previous, template)).toBe(true);
            expect(template.id).not.toBe(previous.id);
          }

          const twoBack = first[index - 2];
          if (twoBack) {
            expect(template.id).not.toBe(twoBack.id);
          }
        }
      }
    }
  });

  it("never selects an advanced mechanic before its safe introduction", () => {
    for (let seedIndex = 0; seedIndex < 40; seedIndex += 1) {
      const selector = new AuthoredChunkSelector(AUTHORED_CHUNK_TEMPLATES, {
        seed: `ordering-${seedIndex}`,
        gameplayVersion: "content-v2",
        repeatWindow: 2,
      });
      const introduced = new Set<string>();
      let advancedCount = 0;

      for (let index = 0; index < 300; index += 1) {
        const selected = selector.next(5);

        if (selected.challengeStage === "advanced") {
          advancedCount += 1;
          for (const required of selected.requiresIntroductions) {
            expect(introduced.has(required)).toBe(true);
          }
        } else {
          for (const mechanic of selected.mechanics) {
            introduced.add(mechanic);
          }
        }
      }

      expect(advancedCount).toBeGreaterThan(0);
    }
  });

  it.each([
    {
      name: "missing entry",
      mutate: (template: ChunkTemplate): ChunkTemplate => ({
        ...template,
        id: "missing-entry",
        entry: { platformId: "not-a-platform" },
      }),
      expectedIssue: /entry references a missing platform/,
    },
    {
      name: "impossible internal transition",
      mutate: (template: ChunkTemplate): ChunkTemplate => ({
        ...template,
        id: "impossible-route",
        platforms: [
          { id: "approach", x: 0, width: 220, top: 584 },
          { id: "landing", x: 500, width: 400, top: 584 },
        ],
        entry: { platformId: "approach" },
        exit: { platformId: "landing" },
        route: [
          {
            fromPlatformId: "approach",
            toPlatformId: "landing",
            requiredCapability: "lift",
          },
        ],
        requiredCapability: "lift",
      }),
      expectedIssue: /route approach -> landing is impossible/,
    },
    {
      name: "invalid collectible",
      mutate: (template: ChunkTemplate): ChunkTemplate => ({
        ...template,
        id: "bad-collectible",
        collectibles: [
          {
            id: "outside",
            kind: "feather",
            x: template.width + 20,
            y: 500,
            radius: 10,
            optional: true,
            path: {
              fromPlatformId: template.entry.platformId,
              requiredCapability: "jump",
            },
          },
        ],
      }),
      expectedIssue: /collectible "outside" has invalid geometry/,
    },
  ])("rejects $name before selection or runtime", ({ mutate, expectedIssue }) => {
    const invalid = mutate(AUTHORED_CHUNK_TEMPLATES[0]!);

    expect(() => validateChunkCatalog([invalid])).toThrow(ChunkCatalogValidationError);

    try {
      validateChunkCatalog([invalid]);
      throw new Error("Expected invalid catalog to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ChunkCatalogValidationError);
      expect((error as ChunkCatalogValidationError).issues).toContainEqual(
        expect.stringMatching(expectedIssue),
      );
    }
  });

  it("rejects duplicate template and entity ids with actionable validation issues", () => {
    const duplicateTemplate = AUTHORED_CHUNK_TEMPLATES[0]!;
    const duplicateEntity: ChunkTemplate = {
      ...AUTHORED_CHUNK_TEMPLATES[1]!,
      id: "duplicate-entity",
      collectibles: [
        {
          id: AUTHORED_CHUNK_TEMPLATES[1]!.platforms[0]!.id,
          kind: "feather",
          x: 200,
          y: 500,
          radius: 10,
          optional: true,
          path: {
            fromPlatformId: AUTHORED_CHUNK_TEMPLATES[1]!.entry.platformId,
            requiredCapability: "jump",
          },
        },
      ],
    };

    expect(() =>
      validateChunkCatalog([duplicateTemplate, duplicateTemplate, duplicateEntity]),
    ).toThrow(/duplicated/);
    expect(() => validateChunkCatalog([duplicateEntity])).toThrow(/reuses entity id/);
  });

  it("rejects advanced content without a catalogued introduction", () => {
    const advanced = AUTHORED_CHUNK_TEMPLATES.find(
      (template) => template.id === "quiet-tunnel-advanced",
    )!;

    expect(() => validateChunkCatalog([advanced])).toThrow(
      /requires a missing quiet-tunnel introduction/,
    );
  });

  it("rejects a warning that appears too late to react to its target", () => {
    const source = AUTHORED_CHUNK_TEMPLATES.find(
      (template) => template.id === "moving-spike-intro",
    )!;
    const target = source.hazards.find((hazard) => hazard.id === source.warnings[0]!.targetId)!;
    const lateWarning: ChunkTemplate = {
      ...source,
      id: "late-moving-warning",
      warnings: [
        {
          ...source.warnings[0]!,
          x: target.x - MINIMUM_WARNING_LEAD + 1,
        },
      ],
    };

    expect(() => validateChunkCatalog([lateWarning])).toThrow(/is not readable without color/);
  });

  it("rejects an internally reachable chunk whose exit cannot reach any next entry", () => {
    const impossibleBoundary: ChunkTemplate = {
      id: "one-way-climb",
      width: 900,
      minimumDifficulty: 1,
      maximumDifficulty: 1,
      challengeStage: "introduction",
      mechanics: [],
      requiresIntroductions: [],
      voiceSkills: [],
      entry: { platformId: "entry" },
      exit: { platformId: "exit" },
      requiredCapability: "lift",
      platforms: [
        { id: "entry", x: 0, width: 300, top: 584 },
        { id: "middle", x: 350, width: 250, top: 500 },
        { id: "exit", x: 650, width: 250, top: 410 },
      ],
      hazards: [],
      collectibles: [],
      warnings: [],
      route: [
        {
          fromPlatformId: "entry",
          toPlatformId: "middle",
          requiredCapability: "lift",
        },
        {
          fromPlatformId: "middle",
          toPlatformId: "exit",
          requiredCapability: "lift",
        },
      ],
    };

    expect(() => validateChunkCatalog([impossibleBoundary])).toThrow(
      'Chunk "one-way-climb" has no reachable successor at difficulty 1',
    );
  });

  it("fails explicitly when difficulty or supported capabilities leave no eligible chunk", () => {
    const selector = new AuthoredChunkSelector(AUTHORED_CHUNK_TEMPLATES, {
      seed: "none",
      gameplayVersion: "content-v1",
      supportedCapabilities: ["run"],
    });

    expect(() => selector.next(99)).toThrow(
      "No reachable authored chunk is eligible at difficulty 99",
    );
    expect(
      () =>
        new AuthoredChunkSelector(AUTHORED_CHUNK_TEMPLATES, {
          seed: "",
          gameplayVersion: "content-v1",
        }),
    ).toThrow("must not be empty");
  });
});
