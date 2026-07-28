import Phaser from "phaser";

import { SystemClock, type Clock } from "../core";
import {
  PhaserGameRuntime,
  type InputSourceFactory,
  type PhaserFrameHost,
  type PhaserMountFactory,
} from "./PhaserGameRuntime";
import {
  CombinedInputSource,
  KeyboardInputSource,
  TouchInputSource,
} from "./input/BrowserInputSources";
import { getCappedRenderResolution } from "./renderResolution";
import { type GeneratedCourseSnapshot } from "./GeneratedChunkCourse";
import {
  CHICKEN_BODY_HEIGHT,
  CHICKEN_BODY_WIDTH,
  LOGICAL_GAME_HEIGHT,
  LOGICAL_GAME_WIDTH,
  type ChickenAnimationState,
  type SimulationSnapshot,
} from "./simulation";
import { GameAudioDirector, type GameAudioDiagnostics } from "./presentation/GameAudioDirector";
import {
  GAME_ART_ATLAS_HEIGHT,
  GAME_ART_ATLAS_KEY,
  GAME_ART_ATLAS_WIDTH,
  GAME_ART_FRAME_RECTS,
  GAME_EFFECT_POOL_SIZE,
  gameArtAtlasUrl,
  selectChickenArtFrame,
  type GameArtFrame,
} from "./presentation/gameArt";

const BOOT_SCENE_KEY = "boot";
const WORLD_SCENE_KEY = "chicken-world";
const PLATFORM_HEIGHT = 42;

type PlatformView = Readonly<{
  trunk: Phaser.GameObjects.TileSprite;
  grass: Phaser.GameObjects.TileSprite;
}>;

type HazardView = Readonly<{
  spike: Phaser.GameObjects.Image;
  water: Phaser.GameObjects.TileSprite;
  quietZone: Phaser.GameObjects.Rectangle;
  quietGlyph: Phaser.GameObjects.Text;
}>;

type WarningView = Readonly<{
  panel: Phaser.GameObjects.Rectangle;
  icon: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
}>;

type EffectParticleView = {
  active: boolean;
  bornFrame: number;
  image: Phaser.GameObjects.Image;
  lifeFrames: number;
  originX: number;
  originY: number;
  velocityX: number;
  velocityY: number;
};

type CreateGameRuntimeOptions = {
  clock?: Clock;
  inputSourceFactory?: InputSourceFactory;
  phaserFactory?: PhaserMountFactory;
  renderResolution?: number;
};

class BootScene extends Phaser.Scene {
  private atlasFailed = false;

  constructor(private readonly renderResolution: number) {
    super(BOOT_SCENE_KEY);
  }

  preload() {
    this.cameras.main.setZoom(this.renderResolution);
    this.cameras.main.centerOn(LOGICAL_GAME_WIDTH / 2, LOGICAL_GAME_HEIGHT / 2);
    const track = this.add
      .rectangle(LOGICAL_GAME_WIDTH / 2, LOGICAL_GAME_HEIGHT / 2, 220, 8, 0x10233b, 0.86)
      .setStrokeStyle(1, 0xfff4ce, 0.8);
    const fill = this.add
      .rectangle(LOGICAL_GAME_WIDTH / 2 - 108, LOGICAL_GAME_HEIGHT / 2, 0, 6, 0x41c7a4)
      .setOrigin(0, 0.5);
    const loading = this.add
      .text(LOGICAL_GAME_WIDTH / 2, LOGICAL_GAME_HEIGHT / 2 - 24, "PAINTING THE COURSE", {
        color: "#fff4ce",
        fontFamily: "system-ui, sans-serif",
        fontSize: "11px",
        fontStyle: "700",
        letterSpacing: 2,
      })
      .setOrigin(0.5);

    this.load.on("progress", (progress: number) => {
      fill.displayWidth = 216 * progress;
    });
    this.load.once("complete", () => {
      track.destroy();
      fill.destroy();
      loading.destroy();
    });
    this.load.once("loaderror", () => {
      this.atlasFailed = true;
    });
    this.load.svg(GAME_ART_ATLAS_KEY, gameArtAtlasUrl(import.meta.env.BASE_URL, document.baseURI), {
      width: GAME_ART_ATLAS_WIDTH,
      height: GAME_ART_ATLAS_HEIGHT,
    });
  }

  create() {
    let atlas = this.textures.exists(GAME_ART_ATLAS_KEY)
      ? this.textures.get(GAME_ART_ATLAS_KEY)
      : null;
    if (this.atlasFailed || !atlas) {
      if (atlas) {
        this.textures.remove(GAME_ART_ATLAS_KEY);
      }
      atlas = createGeneratedFallbackAtlas(this.textures);
      this.registry.set("game-art-source", "generated-fallback");
    } else {
      this.registry.set("game-art-source", "svg-atlas");
    }

    for (const frame of GAME_ART_FRAME_RECTS) {
      if (!atlas.has(frame.name)) {
        atlas.add(frame.name, 0, frame.x, frame.y, frame.width, frame.height);
      }
    }
    this.scene.start(WORLD_SCENE_KEY);
  }
}

class ChickenWorldScene extends Phaser.Scene {
  private readonly platformViews: PlatformView[] = [];
  private readonly hazardViews: HazardView[] = [];
  private readonly collectibleViews: Phaser.GameObjects.Image[] = [];
  private readonly warningViews: WarningView[] = [];
  private readonly effectParticles: EffectParticleView[] = [];
  private readonly audio = new GameAudioDirector();
  private chicken!: Phaser.GameObjects.Sprite;
  private phaseShade!: Phaser.GameObjects.Rectangle;
  private phaseLabel!: Phaser.GameObjects.Text;
  private scoreLabel!: Phaser.GameObjects.Text;
  private courseLabel!: Phaser.GameObjects.Text;
  private inputMeterFill!: Phaser.GameObjects.Rectangle;
  private inputLevelLabel!: Phaser.GameObjects.Text;
  private inputModeLabel!: Phaser.GameObjects.Text;
  private microphoneIcon!: Phaser.GameObjects.Image;
  private impactFlash!: Phaser.GameObjects.Rectangle;
  private impactLabel!: Phaser.GameObjects.Text;
  private previousSnapshot: SimulationSnapshot | null = null;
  private renderFrame = 0;
  private impactFramesRemaining = 0;
  private lastChickenFrame: GameArtFrame = "chicken-idle";
  private staminaLabel!: Phaser.GameObjects.Text;

  constructor(
    private readonly host: PhaserFrameHost,
    private readonly renderResolution: number,
    private readonly ready: () => void,
  ) {
    super(WORLD_SCENE_KEY);
  }

  create() {
    this.configureLogicalCamera();
    this.createBackdrop();
    this.createWorldPools();
    this.createChicken();
    this.createStatusLayer();
    this.render(this.host.snapshot());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.audio.destroy());
    this.host.onSceneReady();
    this.ready();
  }

  update(_time: number, deltaMs: number) {
    this.render(this.host.advanceFrame(deltaMs));
  }

  resourceDiagnostics() {
    const course = this.requiredCourseSnapshot();
    const audio: GameAudioDiagnostics = this.audio.diagnostics();
    const atlas = this.textures.get(GAME_ART_ATLAS_KEY);
    const artObjects = [
      this.chicken,
      this.microphoneIcon,
      ...this.platformViews.flatMap((view) => [view.trunk, view.grass]),
      ...this.hazardViews.flatMap((view) => [view.spike, view.water]),
      ...this.collectibleViews,
      ...this.warningViews.map((view) => view.icon),
      ...this.effectParticles.map((view) => view.image),
    ];
    return {
      sceneObjects: this.children.getChildren().length,
      activeTimers: 0,
      pooledObjects:
        this.platformViews.length +
        this.hazardViews.length +
        this.collectibleViews.length +
        this.warningViews.length +
        this.effectParticles.length,
      renderedWarnings: this.warningViews.filter((view) => view.label.visible).length,
      renderedQuietZones: this.hazardViews.filter((view) => view.quietZone.visible).length,
      renderedCollectibles: this.collectibleViews.filter((view) => view.visible).length,
      renderedMovingHazards: course.spikes.filter(
        (hazard, index) => hazard.kind === "moving-spike" && this.hazardViews[index]?.spike.visible,
      ).length,
      activeParticles: this.effectParticles.filter((view) => view.active).length,
      artAtlasFrames: GAME_ART_FRAME_RECTS.filter((frame) => atlas.has(frame.name)).length,
      artAtlasSource: String(this.registry.get("game-art-source") ?? "unknown"),
      invalidVisibleArtObjects: artObjects.filter(
        (object) =>
          object.visible &&
          (object.texture.key !== GAME_ART_ATLAS_KEY ||
            !GAME_ART_FRAME_RECTS.some((frame) => frame.name === String(object.frame.name))),
      ).length,
      audioCueCount: audio.cueCount,
      audioState: audio.state,
      chickenArtFrame: this.lastChickenFrame,
      lastAudioCue: audio.lastCue,
    };
  }

  private configureLogicalCamera() {
    this.cameras.main.setZoom(this.renderResolution);
    this.cameras.main.centerOn(LOGICAL_GAME_WIDTH / 2, LOGICAL_GAME_HEIGHT / 2);
    this.cameras.main.roundPixels = true;
  }

  private createBackdrop() {
    this.add
      .rectangle(
        LOGICAL_GAME_WIDTH / 2,
        LOGICAL_GAME_HEIGHT / 2,
        LOGICAL_GAME_WIDTH,
        LOGICAL_GAME_HEIGHT,
        0x10233b,
        0.8,
      )
      .setDepth(-10);

    this.add.circle(72, 170, 88, 0xf7c84b, 0.13).setDepth(-9);
    this.add.circle(366, 312, 132, 0x5eb8ff, 0.11).setDepth(-9);
    this.add.ellipse(84, 524, 280, 220, 0x174a58, 0.32).setDepth(-8);
    this.add.ellipse(360, 548, 330, 250, 0x173a56, 0.38).setDepth(-8);

    this.add
      .text(LOGICAL_GAME_WIDTH / 2, 194, "TAP · SPACE · ↑", {
        color: "#fff4ce",
        fontFamily: "system-ui, sans-serif",
        fontSize: "13px",
        fontStyle: "700",
        letterSpacing: 2,
      })
      .setOrigin(0.5)
      .setAlpha(0.68);
  }

  private createWorldPools() {
    const capacities = this.requiredCourseSnapshot().poolCapacities;

    for (let index = 0; index < capacities.platforms; index += 1) {
      const trunk = this.add
        .tileSprite(0, 0, 1, 1, GAME_ART_ATLAS_KEY, "platform")
        .setOrigin(0.5, 0)
        .setDepth(3)
        .setVisible(false);

      const grass = this.add
        .tileSprite(0, 0, 1, 1, GAME_ART_ATLAS_KEY, "grass")
        .setOrigin(0.5, 0.5)
        .setDepth(4)
        .setVisible(false);

      this.platformViews.push({ trunk, grass });
    }

    for (let index = 0; index < capacities.hazards; index += 1) {
      const spikeView = this.add
        .image(0, 0, GAME_ART_ATLAS_KEY, "spike")
        .setOrigin(0.5, 1)
        .setDepth(6)
        .setVisible(false);

      const waterView = this.add
        .tileSprite(0, 0, 1, 1, GAME_ART_ATLAS_KEY, "water")
        .setOrigin(0.5, 0)
        .setDepth(1)
        .setVisible(false);

      const quietZoneView = this.add
        .rectangle(0, 0, 1, 1, 0x10233b, 0.82)
        .setOrigin(0.5, 0)
        .setStrokeStyle(3, 0xf7c84b, 0.96)
        .setDepth(5)
        .setVisible(false);

      const quietGlyph = this.add
        .text(0, 0, "RELEASE\n•••", {
          align: "center",
          color: "#fff4ce",
          fontFamily: "system-ui, sans-serif",
          fontSize: "11px",
          fontStyle: "700",
          letterSpacing: 1,
        })
        .setOrigin(0.5)
        .setDepth(6)
        .setVisible(false);

      this.hazardViews.push({
        spike: spikeView,
        water: waterView,
        quietZone: quietZoneView,
        quietGlyph,
      });
    }

    for (let index = 0; index < capacities.collectibles; index += 1) {
      this.collectibleViews.push(
        this.add.image(0, 0, GAME_ART_ATLAS_KEY, "feather").setDepth(6).setVisible(false),
      );
    }

    for (let index = 0; index < capacities.warnings; index += 1) {
      const panel = this.add
        .rectangle(0, 0, 208, 38, 0x07111f, 0.94)
        .setStrokeStyle(2, 0xfff4ce, 0.9)
        .setDepth(8)
        .setVisible(false);
      const icon = this.add
        .image(0, 0, GAME_ART_ATLAS_KEY, "warning")
        .setDisplaySize(26, 26)
        .setDepth(9)
        .setVisible(false);
      const label = this.add
        .text(0, 0, "", {
          align: "left",
          color: "#ffffff",
          fontFamily: "system-ui, sans-serif",
          fontSize: "11px",
          fontStyle: "700",
          letterSpacing: 0.8,
          wordWrap: { width: 158, useAdvancedWrap: true },
        })
        .setOrigin(0, 0.5)
        .setDepth(9)
        .setStroke("#020711", 2)
        .setVisible(false);
      this.warningViews.push({ panel, icon, label });
    }

    for (let index = 0; index < GAME_EFFECT_POOL_SIZE; index += 1) {
      this.effectParticles.push({
        active: false,
        bornFrame: 0,
        image: this.add
          .image(0, 0, GAME_ART_ATLAS_KEY, "spark")
          .setDisplaySize(16, 16)
          .setDepth(12)
          .setVisible(false),
        lifeFrames: 0,
        originX: 0,
        originY: 0,
        velocityX: 0,
        velocityY: 0,
      });
    }
  }

  private createChicken() {
    this.chicken = this.add
      .sprite(0, 0, GAME_ART_ATLAS_KEY, "chicken-idle")
      .setDisplaySize(CHICKEN_BODY_WIDTH + 38, CHICKEN_BODY_HEIGHT + 26)
      .setDepth(7);
  }

  private createStatusLayer() {
    this.scoreLabel = this.add
      .text(LOGICAL_GAME_WIDTH / 2, 244, "Score 0 · S 0 + F 0 + P 0", {
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        fontSize: "16px",
        fontStyle: "700",
      })
      .setOrigin(0.5)
      .setDepth(15)
      .setShadow(0, 2, "#020711", 8, true, true);

    this.courseLabel = this.add
      .text(LOGICAL_GAME_WIDTH / 2, 276, "Loop 1 · 0%", {
        color: "#b9d8f4",
        fontFamily: "system-ui, sans-serif",
        fontSize: "12px",
        fontStyle: "700",
        letterSpacing: 1,
      })
      .setOrigin(0.5)
      .setDepth(15);

    this.add
      .rectangle(116, 309, 200, 12, 0x07111f, 0.86)
      .setOrigin(0, 0.5)
      .setStrokeStyle(1, 0xd8e8f7, 0.72)
      .setDepth(15);

    this.inputMeterFill = this.add
      .rectangle(117, 309, 0, 10, 0xf5d567)
      .setOrigin(0, 0.5)
      .setDepth(16);

    this.inputLevelLabel = this.add
      .text(LOGICAL_GAME_WIDTH / 2, 328, "INPUT 0%", {
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        fontSize: "11px",
        fontStyle: "700",
        letterSpacing: 1,
      })
      .setOrigin(0.5)
      .setDepth(16);

    this.inputModeLabel = this.add
      .text(LOGICAL_GAME_WIDTH / 2 + 11, 348, "KEYBOARD + TOUCH", {
        color: "#f7c84b",
        fontFamily: "system-ui, sans-serif",
        fontSize: "11px",
        fontStyle: "700",
        letterSpacing: 1,
      })
      .setOrigin(0.5)
      .setDepth(16);

    this.microphoneIcon = this.add
      .image(105, 348, GAME_ART_ATLAS_KEY, "microphone")
      .setDisplaySize(24, 24)
      .setDepth(16)
      .setAlpha(0.58);

    this.impactFlash = this.add
      .rectangle(
        LOGICAL_GAME_WIDTH / 2,
        LOGICAL_GAME_HEIGHT / 2,
        LOGICAL_GAME_WIDTH - 18,
        LOGICAL_GAME_HEIGHT - 18,
        0xff6b5e,
        0,
      )
      .setStrokeStyle(7, 0xfff4ce, 0)
      .setDepth(22)
      .setVisible(false);

    this.impactLabel = this.add
      .text(LOGICAL_GAME_WIDTH / 2, 384, "", {
        align: "center",
        backgroundColor: "#10233b",
        color: "#fff4ce",
        fontFamily: "system-ui, sans-serif",
        fontSize: "14px",
        fontStyle: "700",
        letterSpacing: 1.4,
        padding: { x: 12, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(23)
      .setVisible(false);

    this.staminaLabel = this.add
      .text(LOGICAL_GAME_WIDTH / 2, 368, "LIFT STAMINA 100%", {
        color: "#b9d8f4",
        fontFamily: "system-ui, sans-serif",
        fontSize: "11px",
        fontStyle: "700",
        letterSpacing: 1,
      })
      .setOrigin(0.5)
      .setDepth(16);

    this.phaseShade = this.add
      .rectangle(
        LOGICAL_GAME_WIDTH / 2,
        LOGICAL_GAME_HEIGHT / 2,
        LOGICAL_GAME_WIDTH,
        LOGICAL_GAME_HEIGHT,
        0x07111f,
        0.7,
      )
      .setDepth(20)
      .setVisible(false);

    this.phaseLabel = this.add
      .text(LOGICAL_GAME_WIDTH / 2, LOGICAL_GAME_HEIGHT / 2, "", {
        align: "center",
        color: "#fff4ce",
        fontFamily: "system-ui, sans-serif",
        fontSize: "23px",
        fontStyle: "700",
      })
      .setOrigin(0.5)
      .setDepth(21)
      .setVisible(false);
  }

  private render(snapshot: SimulationSnapshot) {
    const hud = this.host.hudSnapshot();
    const presentation = this.host.presentationSnapshot();
    this.renderFrame += 1;

    if (this.previousSnapshot && snapshot.tick < this.previousSnapshot.tick) {
      this.resetPresentationEffects(snapshot);
    }

    this.renderGeneratedWorld(snapshot, presentation.reducedMotion);
    this.renderTransitionEffects(snapshot, presentation);
    this.audio.render(snapshot, presentation);

    const animation = snapshot.chicken.animation;
    const runBob =
      !presentation.reducedMotion && animation === "run" ? Math.sin(snapshot.tick * 0.55) * 1.8 : 0;

    this.chicken.setPosition(snapshot.chicken.x, snapshot.chicken.y + runBob);
    this.applyChickenPose(animation, snapshot.tick, presentation.reducedMotion);
    this.scoreLabel.setText(
      `Score ${snapshot.score} · S ${snapshot.scoreBreakdown.survival} + F ${snapshot.scoreBreakdown.collectibles} + P ${snapshot.scoreBreakdown.precision}`,
    );
    this.courseLabel.setText(
      snapshot.currentChunkId
        ? `STAGE ${snapshot.difficultyStage} · CHUNK ${snapshot.currentChunkIndex + 1} · ${snapshot.currentChunkId
            .replaceAll("-", " ")
            .toUpperCase()}`
        : `STAGE ${snapshot.difficultyStage} · Loop ${snapshot.loopsCompleted + 1}`,
    );
    this.inputMeterFill.displayWidth = 198 * hud.normalizedInput;
    this.inputLevelLabel.setText(`INPUT ${Math.round(hud.normalizedInput * 100)}%`);
    this.microphoneIcon.setAlpha(
      hud.activeInput === "voice" ? 1 : hud.configuredInput === "voice" ? 0.72 : 0.38,
    );
    this.inputModeLabel.setText(
      hud.activeInput === "voice"
        ? "ACTIVE: MICROPHONE"
        : hud.activeInput === "keyboard-touch"
          ? "ACTIVE: KEYBOARD + TOUCH"
          : hud.configuredInput === "voice"
            ? "READY: MICROPHONE + FALLBACK"
            : "READY: KEYBOARD + TOUCH",
    );
    this.staminaLabel.setText(
      `LIFT STAMINA ${Math.round(snapshot.liftStamina * 100)}% · ${snapshot.worldSpeed.toFixed(0)} PX/S`,
    );

    const deathHeading =
      snapshot.deathReason === "hazard"
        ? "Ouch!"
        : snapshot.deathReason === "fall"
          ? "Too far!"
          : "Splash!";
    const phaseCopy =
      snapshot.phase === "paused"
        ? "Paused"
        : snapshot.phase === "dead"
          ? `${deathHeading}\nSurvived ${(snapshot.elapsedMs / 1_000).toFixed(
              1,
            )}s · Score ${snapshot.score}\nRun complete`
          : "";

    this.phaseShade.setVisible(Boolean(phaseCopy));
    this.phaseLabel.setText(phaseCopy).setVisible(Boolean(phaseCopy));
    this.previousSnapshot = snapshot;
  }

  private renderGeneratedWorld(snapshot: SimulationSnapshot, reducedMotion: boolean) {
    const course = this.requiredCourseSnapshot();
    const distance = snapshot.distance;
    const collectedIds = new Set(snapshot.collectedCollectibleIds);

    for (let index = 0; index < this.platformViews.length; index += 1) {
      const view = this.platformViews[index];
      const platform = course.platforms[index];

      if (!view) {
        continue;
      }
      if (!platform) {
        view.trunk.setVisible(false);
        view.grass.setVisible(false);
        continue;
      }

      const x = platform.x - distance + platform.width / 2;
      view.trunk
        .setPosition(x, platform.top + 10)
        .setSize(platform.width, PLATFORM_HEIGHT)
        .setScale(1)
        .setVisible(true);
      view.grass
        .setPosition(x, platform.top)
        .setSize(platform.width, 20)
        .setScale(1)
        .setVisible(true);
    }

    const hazards = [...course.spikes, ...course.water, ...course.quietZones];

    for (let index = 0; index < this.hazardViews.length; index += 1) {
      const view = this.hazardViews[index];
      const hazard = hazards[index];

      if (!view) {
        continue;
      }
      if (!hazard) {
        view.spike.setVisible(false);
        view.water.setVisible(false);
        view.quietZone.setVisible(false);
        view.quietGlyph.setVisible(false);
        continue;
      }

      if (hazard.kind === "spike" || hazard.kind === "moving-spike") {
        view.water.setVisible(false);
        view.quietZone.setVisible(false);
        view.quietGlyph.setVisible(false);
        view.spike
          .setFrame(hazard.kind === "moving-spike" ? "moving-hazard" : "spike")
          .setPosition(hazard.x - distance + hazard.width / 2, hazard.baseTop)
          .setDisplaySize(hazard.width, hazard.height)
          .setAngle(
            hazard.kind === "moving-spike" && !reducedMotion
              ? Math.sin(snapshot.tick * 0.12) * 2
              : 0,
          )
          .setVisible(true);
      } else if (hazard.kind === "water") {
        view.spike.setVisible(false);
        view.quietZone.setVisible(false);
        view.quietGlyph.setVisible(false);
        view.water
          .setPosition(hazard.x - distance + hazard.width / 2, hazard.top)
          .setSize(hazard.width, LOGICAL_GAME_HEIGHT - hazard.top)
          .setScale(1)
          .setTilePosition(reducedMotion ? 0 : snapshot.tick * 0.55, 0)
          .setVisible(true);
      } else if (hazard.kind === "quiet-zone") {
        view.spike.setVisible(false);
        view.water.setVisible(false);
        const centerX = hazard.x - distance + hazard.width / 2;
        const centerY = hazard.top + (hazard.bottom - hazard.top) / 2;
        view.quietZone
          .setPosition(centerX, hazard.top)
          .setDisplaySize(hazard.width, hazard.bottom - hazard.top)
          .setVisible(true);
        view.quietGlyph.setPosition(centerX, centerY).setVisible(true);
      }
    }

    for (let index = 0; index < this.collectibleViews.length; index += 1) {
      const view = this.collectibleViews[index];
      const collectible = course.collectibles[index];

      if (!view) {
        continue;
      }
      if (!collectible || collectedIds.has(collectible.id)) {
        view.setVisible(false);
        continue;
      }

      const size =
        collectible.radius *
        2.8 *
        (reducedMotion ? 1 : 1 + Math.sin(snapshot.tick * 0.1 + index) * 0.05);
      view
        .setPosition(collectible.x - distance, collectible.y)
        .setDisplaySize(size, size)
        .setAngle(reducedMotion ? -18 : -18 + Math.sin(snapshot.tick * 0.12 + index) * 8)
        .setVisible(true);
    }

    for (let index = 0; index < this.warningViews.length; index += 1) {
      const view = this.warningViews[index];
      const warning = course.warnings[index];

      if (!view) {
        continue;
      }
      if (!warning) {
        view.panel.setVisible(false);
        view.icon.setVisible(false);
        view.label.setVisible(false);
        continue;
      }

      const x = warning.x - distance;
      view.panel.setPosition(x, warning.y).setVisible(true);
      view.icon.setPosition(x - 83, warning.y).setVisible(true);
      view.label
        .setPosition(x - 63, warning.y)
        .setText(`${warning.symbol} ${warning.text}`)
        .setVisible(true);
    }
  }

  private renderTransitionEffects(
    snapshot: SimulationSnapshot,
    presentation: ReturnType<PhaserFrameHost["presentationSnapshot"]>,
  ) {
    const previous = this.previousSnapshot;
    if (previous) {
      const collected = snapshot.collectedCollectibleIds.length;
      if (collected > previous.collectedCollectibleIds.length) {
        this.spawnParticles(snapshot.chicken.x + 18, snapshot.chicken.y - 8, 8);
      }
      if (snapshot.phase === "dead" && previous.phase !== "dead") {
        this.spawnParticles(snapshot.chicken.x, snapshot.chicken.y, 12);
        this.impactFramesRemaining = presentation.reducedMotion ? 10 : 28;
        this.impactLabel
          .setText(
            snapshot.deathReason === "water"
              ? "WATER SPLASH"
              : snapshot.deathReason === "fall"
                ? "MISSED LANDING"
                : "HAZARD HIT",
          )
          .setVisible(true);
        if (presentation.screenShakeEnabled && !presentation.reducedMotion) {
          this.cameras.main.shake(130, 0.0065);
        }
      }
    }

    this.renderParticles(presentation.reducedMotion);
    if (this.impactFramesRemaining > 0) {
      this.impactFramesRemaining -= 1;
      const progress = this.impactFramesRemaining / 28;
      this.impactFlash
        .setFillStyle(0xff6b5e, presentation.reducedMotion ? 0.08 : progress * 0.22)
        .setStrokeStyle(7, 0xfff4ce, presentation.reducedMotion ? 0.5 : progress)
        .setVisible(true);
    } else {
      this.impactFlash.setVisible(false);
      this.impactLabel.setVisible(false);
    }
  }

  private spawnParticles(x: number, y: number, count: number) {
    const vectors = [
      [-2.4, -2.8],
      [-1.5, -3.5],
      [-0.7, -2.2],
      [0.5, -3.8],
      [1.2, -2.4],
      [2.2, -3.1],
      [-2.1, -1.1],
      [2.4, -1.2],
      [-1.1, -4.1],
      [1.8, -4.2],
      [-2.8, -2],
      [2.9, -2],
    ] as const;

    let activated = 0;
    for (const particle of this.effectParticles) {
      if (particle.active || activated >= count) {
        continue;
      }
      const vector = vectors[activated % vectors.length]!;
      particle.active = true;
      particle.bornFrame = this.renderFrame;
      particle.lifeFrames = 30 + (activated % 4) * 3;
      particle.originX = x;
      particle.originY = y;
      particle.velocityX = vector[0];
      particle.velocityY = vector[1];
      particle.image.setVisible(true);
      activated += 1;
    }
  }

  private renderParticles(reducedMotion: boolean) {
    for (const particle of this.effectParticles) {
      if (!particle.active) {
        continue;
      }
      if (reducedMotion) {
        particle.active = false;
        particle.image.setVisible(false);
        continue;
      }

      const age = this.renderFrame - particle.bornFrame;
      if (age >= particle.lifeFrames) {
        particle.active = false;
        particle.image.setVisible(false);
        continue;
      }

      const progress = age / particle.lifeFrames;
      particle.image
        .setPosition(
          particle.originX + particle.velocityX * age,
          particle.originY + particle.velocityY * age + age * age * 0.055,
        )
        .setAngle(age * 11 * Math.sign(particle.velocityX || 1))
        .setAlpha(1 - progress)
        .setScale(0.18 + progress * 0.1)
        .setVisible(true);
    }
  }

  private resetPresentationEffects(snapshot: SimulationSnapshot) {
    for (const particle of this.effectParticles) {
      particle.active = false;
      particle.image.setVisible(false);
    }
    this.impactFramesRemaining = 0;
    this.impactFlash.setVisible(false);
    this.impactLabel.setVisible(false);
    this.audio.reset(snapshot);
  }

  private requiredCourseSnapshot(): GeneratedCourseSnapshot {
    const snapshot = this.host.courseSnapshot();
    if (!snapshot) {
      throw new Error("The Phaser scene requires a generated authored-chunk course");
    }
    return snapshot;
  }

  private applyChickenPose(animation: ChickenAnimationState, tick: number, reducedMotion: boolean) {
    const frame = selectChickenArtFrame(animation, tick, reducedMotion);
    this.lastChickenFrame = frame;
    this.chicken.setFrame(frame);
    this.chicken.setScale(1);

    switch (animation) {
      case "idle":
        this.chicken.setAngle(0);
        break;
      case "run":
        this.chicken.setAngle(reducedMotion ? 0 : Math.sin(tick * 0.55) * 1.5);
        break;
      case "jump":
        this.chicken.setAngle(reducedMotion ? 0 : -5);
        break;
      case "flap":
        this.chicken.setAngle(reducedMotion ? 0 : -3);
        break;
      case "death":
        this.chicken.setAngle(0);
        this.chicken.setScale(0.96);
        break;
    }
  }
}

function createGeneratedFallbackAtlas(textures: Phaser.Textures.TextureManager) {
  const atlas = textures.createCanvas(
    GAME_ART_ATLAS_KEY,
    GAME_ART_ATLAS_WIDTH,
    GAME_ART_ATLAS_HEIGHT,
  );
  if (!atlas) {
    throw new Error("The original art atlas and its generated fallback could not be created");
  }

  const context = atlas.context;
  context.clearRect(0, 0, GAME_ART_ATLAS_WIDTH, GAME_ART_ATLAS_HEIGHT);
  context.lineCap = "round";
  context.lineJoin = "round";

  for (let index = 0; index < GAME_ART_FRAME_RECTS.length; index += 1) {
    context.save();
    context.translate(index * 80, 0);
    drawGeneratedFallbackFrame(context, index);
    context.restore();
  }
  atlas.refresh();
  return atlas;
}

function drawGeneratedFallbackFrame(context: CanvasRenderingContext2D, index: number) {
  const ink = "#10233b";
  const cream = "#fff4ce";
  const gold = "#f7c84b";
  const coral = "#ff6b5e";
  const teal = "#41c7a4";
  const sky = "#5eb8ff";

  context.strokeStyle = ink;
  context.lineWidth = 3;

  if (index <= 6) {
    context.save();
    if (index === 6) {
      context.translate(40, 42);
      context.rotate(0.28);
      context.translate(-40, -42);
    }
    context.fillStyle = gold;
    context.beginPath();
    context.ellipse(40, 44, index === 3 ? 22 : 25, index === 3 ? 27 : 22, 0, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = cream;
    context.beginPath();
    if (index === 4) {
      context.moveTo(34, 45);
      context.quadraticCurveTo(8, 31, 14, 9);
      context.quadraticCurveTo(28, 33, 48, 35);
    } else if (index === 5) {
      context.moveTo(34, 41);
      context.quadraticCurveTo(8, 48, 13, 69);
      context.quadraticCurveTo(28, 50, 48, 49);
    } else {
      context.ellipse(29, 47, 13, 10, -0.45, 0, Math.PI * 2);
    }
    context.fill();
    context.stroke();
    context.fillStyle = teal;
    context.fillRect(23, 58, 35, 8);
    context.fillStyle = coral;
    context.beginPath();
    context.moveTo(61, 39);
    context.lineTo(76, 45);
    context.lineTo(61, 50);
    context.closePath();
    context.fill();
    context.stroke();
    context.fillStyle = coral;
    context.beginPath();
    context.arc(37, 18, 8, Math.PI, 0);
    context.fill();
    context.stroke();
    if (index === 6) {
      context.beginPath();
      context.moveTo(48, 31);
      context.lineTo(56, 39);
      context.moveTo(56, 31);
      context.lineTo(48, 39);
      context.stroke();
    } else {
      context.fillStyle = ink;
      context.beginPath();
      context.arc(52, 35, 3, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
    return;
  }

  switch (index) {
    case 7:
      context.fillStyle = cream;
      context.beginPath();
      context.moveTo(16, 64);
      context.bezierCurveTo(22, 24, 49, 8, 69, 15);
      context.bezierCurveTo(65, 45, 42, 64, 16, 64);
      context.fill();
      context.stroke();
      context.beginPath();
      context.moveTo(13, 72);
      context.lineTo(62, 20);
      context.stroke();
      break;
    case 8:
    case 9:
      context.fillStyle = index === 8 ? ink : coral;
      context.beginPath();
      context.moveTo(7, 68);
      context.lineTo(21, 25);
      context.lineTo(32, 50);
      context.lineTo(44, 10);
      context.lineTo(57, 49);
      context.lineTo(68, 24);
      context.lineTo(75, 68);
      context.closePath();
      context.fill();
      context.stroke();
      if (index === 9) {
        context.fillStyle = cream;
        context.beginPath();
        context.arc(33, 53, 6, 0, Math.PI * 2);
        context.arc(51, 53, 6, 0, Math.PI * 2);
        context.fill();
      }
      break;
    case 10:
      context.fillStyle = teal;
      context.beginPath();
      context.ellipse(40, 30, 13, 22, 0, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.beginPath();
      context.arc(40, 37, 22, 0, Math.PI);
      context.moveTo(40, 59);
      context.lineTo(40, 75);
      context.stroke();
      break;
    case 11:
      context.fillStyle = gold;
      context.beginPath();
      context.moveTo(40, 7);
      context.lineTo(75, 70);
      context.lineTo(5, 70);
      context.closePath();
      context.fill();
      context.stroke();
      context.fillStyle = ink;
      context.fillRect(37, 28, 6, 25);
      context.fillRect(37, 59, 6, 7);
      break;
    case 12:
      context.fillStyle = teal;
      context.fillRect(0, 0, 80, 80);
      context.fillStyle = gold;
      context.beginPath();
      context.moveTo(0, 24);
      for (let x = 8; x <= 80; x += 8) {
        context.lineTo(x, x % 16 === 0 ? 8 : 24);
      }
      context.lineTo(80, 80);
      context.lineTo(0, 80);
      context.fill();
      break;
    case 13:
      context.fillStyle = "#a95c38";
      context.fillRect(0, 0, 80, 80);
      context.beginPath();
      context.moveTo(0, 18);
      context.lineTo(80, 18);
      context.moveTo(0, 50);
      context.lineTo(80, 50);
      context.stroke();
      break;
    case 14:
      context.fillStyle = sky;
      context.fillRect(0, 0, 80, 80);
      context.strokeStyle = cream;
      context.lineWidth = 9;
      context.beginPath();
      context.moveTo(0, 20);
      context.bezierCurveTo(10, 8, 20, 8, 30, 20);
      context.bezierCurveTo(40, 32, 50, 32, 60, 20);
      context.bezierCurveTo(68, 10, 74, 10, 80, 10);
      context.stroke();
      break;
    case 15:
      context.fillStyle = gold;
      context.beginPath();
      for (let point = 0; point < 16; point += 1) {
        const radius = point % 2 === 0 ? 34 : 13;
        const angle = (point * Math.PI) / 8 - Math.PI / 2;
        const x = 40 + Math.cos(angle) * radius;
        const y = 40 + Math.sin(angle) * radius;
        if (point === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      }
      context.closePath();
      context.fill();
      context.stroke();
      break;
  }
}

function mountPhaserGame({ parent, renderResolution, host }: Parameters<PhaserMountFactory>[0]) {
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const worldScene = new ChickenWorldScene(host, renderResolution, markReady);
  const phaserGame = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: LOGICAL_GAME_WIDTH * renderResolution,
    height: LOGICAL_GAME_HEIGHT * renderResolution,
    audio: {
      noAudio: true,
    },
    transparent: true,
    disableContextMenu: true,
    render: {
      antialias: true,
      pixelArt: false,
      roundPixels: true,
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: LOGICAL_GAME_WIDTH * renderResolution,
      height: LOGICAL_GAME_HEIGHT * renderResolution,
      expandParent: false,
    },
    fps: {
      target: 60,
      smoothStep: true,
    },
    scene: [new BootScene(renderResolution), worldScene],
  });

  const game = {
    destroy(removeCanvas: boolean) {
      phaserGame.destroy(removeCanvas);
    },
    diagnostics() {
      return worldScene.resourceDiagnostics();
    },
  };

  return { game, ready };
}

export function createGameRuntime(options: CreateGameRuntimeOptions = {}) {
  const clock = options.clock ?? new SystemClock();
  const renderResolution =
    options.renderResolution ?? getCappedRenderResolution(window.devicePixelRatio);

  const inputSourceFactory =
    options.inputSourceFactory ??
    ((parent: HTMLElement) =>
      new CombinedInputSource([
        new KeyboardInputSource(clock, window),
        new TouchInputSource(clock, parent),
      ]));

  return new PhaserGameRuntime({
    clock,
    inputSourceFactory,
    phaserFactory: options.phaserFactory ?? mountPhaserGame,
    renderResolution,
  });
}

export { getCappedRenderResolution } from "./renderResolution";
