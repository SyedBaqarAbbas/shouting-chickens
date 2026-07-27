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

const BOOT_SCENE_KEY = "boot";
const WORLD_SCENE_KEY = "chicken-world";
const PLATFORM_HEIGHT = 42;

type PlatformView = Readonly<{
  trunk: Phaser.GameObjects.Rectangle;
  grass: Phaser.GameObjects.Rectangle;
}>;

type HazardView = Readonly<{
  spike: Phaser.GameObjects.Triangle;
  water: Phaser.GameObjects.Rectangle;
  quietZone: Phaser.GameObjects.Rectangle;
}>;

type CreateGameRuntimeOptions = {
  clock?: Clock;
  inputSourceFactory?: InputSourceFactory;
  phaserFactory?: PhaserMountFactory;
  renderResolution?: number;
};

class BootScene extends Phaser.Scene {
  constructor() {
    super(BOOT_SCENE_KEY);
  }

  create() {
    this.scene.start(WORLD_SCENE_KEY);
  }
}

class ChickenWorldScene extends Phaser.Scene {
  private readonly platformViews: PlatformView[] = [];
  private readonly hazardViews: HazardView[] = [];
  private readonly collectibleViews: Phaser.GameObjects.Arc[] = [];
  private readonly warningViews: Phaser.GameObjects.Text[] = [];
  private chicken!: Phaser.GameObjects.Container;
  private chickenWing!: Phaser.GameObjects.Ellipse;
  private phaseShade!: Phaser.GameObjects.Rectangle;
  private phaseLabel!: Phaser.GameObjects.Text;
  private scoreLabel!: Phaser.GameObjects.Text;
  private courseLabel!: Phaser.GameObjects.Text;
  private inputMeterFill!: Phaser.GameObjects.Rectangle;
  private inputLevelLabel!: Phaser.GameObjects.Text;
  private inputModeLabel!: Phaser.GameObjects.Text;

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
    this.host.onSceneReady();
    this.ready();
  }

  update(_time: number, deltaMs: number) {
    this.render(this.host.advanceFrame(deltaMs));
  }

  resourceDiagnostics() {
    const course = this.requiredCourseSnapshot();
    return {
      sceneObjects: this.children.getChildren().length,
      activeTimers: 0,
      pooledObjects:
        this.platformViews.length +
        this.hazardViews.length +
        this.collectibleViews.length +
        this.warningViews.length,
      renderedWarnings: this.warningViews.filter((view) => view.visible).length,
      renderedQuietZones: this.hazardViews.filter((view) => view.quietZone.visible).length,
      renderedCollectibles: this.collectibleViews.filter((view) => view.visible).length,
      renderedMovingHazards: course.spikes.filter(
        (hazard, index) => hazard.kind === "moving-spike" && this.hazardViews[index]?.spike.visible,
      ).length,
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
        0x132438,
        0.72,
      )
      .setDepth(-10);

    this.add.circle(72, 170, 88, 0xffda70, 0.08).setDepth(-9);
    this.add.circle(366, 312, 132, 0x67c8ff, 0.08).setDepth(-9);

    this.add
      .text(LOGICAL_GAME_WIDTH / 2, 194, "TAP · SPACE · ↑", {
        color: "#d8e8f7",
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
        .rectangle(0, 0, 1, 1, 0xa96527)
        .setOrigin(0.5, 0)
        .setDepth(3)
        .setVisible(false);

      const grass = this.add
        .rectangle(0, 0, 1, 1, 0x2b9b42)
        .setOrigin(0.5, 0.5)
        .setDepth(4)
        .setVisible(false);

      this.platformViews.push({ trunk, grass });
    }

    for (let index = 0; index < capacities.hazards; index += 1) {
      const spikeView = this.add
        .triangle(0, 0, 0, 1, 0.5, 0, 1, 1, 0xf1f5f9)
        .setOrigin(0.5, 1)
        .setStrokeStyle(3, 0xbdc8d4)
        .setDepth(6)
        .setVisible(false);

      const waterView = this.add
        .rectangle(0, 0, 1, 1, 0x0756b8, 0.96)
        .setOrigin(0.5, 0)
        .setStrokeStyle(8, 0x91c9ff, 0.92)
        .setDepth(1)
        .setVisible(false);

      const quietZoneView = this.add
        .rectangle(0, 0, 1, 1, 0x09111e, 0.72)
        .setOrigin(0.5, 0)
        .setStrokeStyle(3, 0xf5d567, 0.9)
        .setDepth(5)
        .setVisible(false);

      this.hazardViews.push({
        spike: spikeView,
        water: waterView,
        quietZone: quietZoneView,
      });
    }

    for (let index = 0; index < capacities.collectibles; index += 1) {
      this.collectibleViews.push(
        this.add
          .circle(0, 0, 1, 0xf5d567)
          .setStrokeStyle(3, 0xfff3b0, 0.9)
          .setDepth(6)
          .setVisible(false),
      );
    }

    for (let index = 0; index < capacities.warnings; index += 1) {
      this.warningViews.push(
        this.add
          .text(0, 0, "", {
            align: "center",
            backgroundColor: "#07111f",
            color: "#ffffff",
            fontFamily: "system-ui, sans-serif",
            fontSize: "11px",
            fontStyle: "700",
            letterSpacing: 1,
            padding: { x: 7, y: 5 },
            wordWrap: { width: 210, useAdvancedWrap: true },
          })
          .setOrigin(0.5)
          .setDepth(8)
          .setStroke("#020711", 2)
          .setVisible(false),
      );
    }
  }

  private createChicken() {
    const body = this.add
      .ellipse(0, 0, CHICKEN_BODY_WIDTH + 12, CHICKEN_BODY_HEIGHT + 10, 0xfffcf2)
      .setStrokeStyle(2, 0xe3e8ee);
    const eye = this.add.circle(9, -17, 4, 0x0b1320);
    const beak = this.add.triangle(35, -8, 0, 0, 22, 8, 0, 16, 0xf5c84c);
    const comb = this.add.rectangle(-5, -35, 9, 16, 0xec4b55).setOrigin(0.5, 1);
    const legLeft = this.add.rectangle(-10, 34, 4, 16, 0xf5c84c);
    const legRight = this.add.rectangle(8, 34, 4, 16, 0xf5c84c);

    this.chickenWing = this.add.ellipse(-10, 8, 24, 28, 0xe6ebf1).setOrigin(0.55, 0.2);
    this.chicken = this.add.container(0, 0, [
      legLeft,
      legRight,
      body,
      this.chickenWing,
      eye,
      beak,
      comb,
    ]);
    this.chicken.setDepth(7);
  }

  private createStatusLayer() {
    this.scoreLabel = this.add
      .text(LOGICAL_GAME_WIDTH / 2, 244, "Survived 0.0s · 0", {
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        fontSize: "24px",
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
      .text(LOGICAL_GAME_WIDTH / 2, 348, "KEYBOARD + TOUCH", {
        color: "#f5d567",
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
        0x020711,
        0.72,
      )
      .setDepth(20)
      .setVisible(false);

    this.phaseLabel = this.add
      .text(LOGICAL_GAME_WIDTH / 2, LOGICAL_GAME_HEIGHT / 2, "", {
        align: "center",
        color: "#f8fbff",
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
    this.renderGeneratedWorld(snapshot);

    const animation = snapshot.chicken.animation;
    const runBob =
      !presentation.reducedMotion && animation === "run" ? Math.sin(snapshot.tick * 0.55) * 1.8 : 0;

    this.chicken.setPosition(snapshot.chicken.x, snapshot.chicken.y + runBob);
    this.applyChickenPose(animation, snapshot.tick, presentation.reducedMotion);
    this.sound.mute = presentation.muted;
    this.scoreLabel.setText(
      `Survived ${(snapshot.elapsedMs / 1_000).toFixed(1)}s · ${snapshot.score}`,
    );
    this.courseLabel.setText(
      snapshot.currentChunkId
        ? `CHUNK ${snapshot.currentChunkIndex + 1} · ${snapshot.currentChunkId
            .replaceAll("-", " ")
            .toUpperCase()}`
        : `Loop ${snapshot.loopsCompleted + 1}`,
    );
    this.inputMeterFill.displayWidth = 198 * hud.normalizedInput;
    this.inputLevelLabel.setText(`INPUT ${Math.round(hud.normalizedInput * 100)}%`);
    this.inputModeLabel.setText(
      hud.activeInput === "voice"
        ? "ACTIVE: MICROPHONE"
        : hud.activeInput === "keyboard-touch"
          ? "ACTIVE: KEYBOARD + TOUCH"
          : hud.configuredInput === "voice"
            ? "READY: MICROPHONE + FALLBACK"
            : "READY: KEYBOARD + TOUCH",
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
  }

  private renderGeneratedWorld(snapshot: SimulationSnapshot) {
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
        .setDisplaySize(platform.width, PLATFORM_HEIGHT)
        .setVisible(true);
      view.grass.setPosition(x, platform.top).setDisplaySize(platform.width, 20).setVisible(true);
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
        continue;
      }

      if (hazard.kind === "spike" || hazard.kind === "moving-spike") {
        view.water.setVisible(false);
        view.quietZone.setVisible(false);
        view.spike
          .setPosition(hazard.x - distance + hazard.width / 2, hazard.baseTop)
          .setDisplaySize(hazard.width, hazard.height)
          .setVisible(true);
      } else if (hazard.kind === "water") {
        view.spike.setVisible(false);
        view.quietZone.setVisible(false);
        view.water
          .setPosition(hazard.x - distance + hazard.width / 2, hazard.top)
          .setDisplaySize(hazard.width, LOGICAL_GAME_HEIGHT - hazard.top)
          .setVisible(true);
      } else if (hazard.kind === "quiet-zone") {
        view.spike.setVisible(false);
        view.water.setVisible(false);
        view.quietZone
          .setPosition(hazard.x - distance + hazard.width / 2, hazard.top)
          .setDisplaySize(hazard.width, hazard.bottom - hazard.top)
          .setVisible(true);
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

      view
        .setPosition(collectible.x - distance, collectible.y)
        .setDisplaySize(collectible.radius * 2, collectible.radius * 2)
        .setVisible(true);
    }

    for (let index = 0; index < this.warningViews.length; index += 1) {
      const view = this.warningViews[index];
      const warning = course.warnings[index];

      if (!view) {
        continue;
      }
      if (!warning) {
        view.setVisible(false);
        continue;
      }

      view
        .setPosition(warning.x - distance, warning.y)
        .setText(`${warning.symbol} ${warning.text}`)
        .setVisible(true);
    }
  }

  private requiredCourseSnapshot(): GeneratedCourseSnapshot {
    const snapshot = this.host.courseSnapshot();
    if (!snapshot) {
      throw new Error("The Phaser scene requires a generated authored-chunk course");
    }
    return snapshot;
  }

  private applyChickenPose(animation: ChickenAnimationState, tick: number, reducedMotion: boolean) {
    this.chicken.setScale(1);

    switch (animation) {
      case "idle":
        this.chicken.setAngle(0);
        this.chickenWing.setAngle(8);
        break;
      case "run":
        this.chicken.setAngle(reducedMotion ? 0 : Math.sin(tick * 0.55) * 2);
        this.chickenWing.setAngle(12);
        break;
      case "jump":
        this.chicken.setAngle(-8);
        this.chickenWing.setAngle(-14);
        break;
      case "flap":
        this.chicken.setAngle(-4);
        this.chickenWing.setAngle(reducedMotion ? -8 : tick % 6 < 3 ? -34 : 20);
        break;
      case "death":
        this.chicken.setAngle(82);
        this.chickenWing.setAngle(34);
        this.chicken.setScale(0.94);
        break;
    }
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
    scene: [new BootScene(), worldScene],
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
