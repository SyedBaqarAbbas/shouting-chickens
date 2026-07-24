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
import {
  COURSE_LENGTH,
  LOOPING_COURSE_PLATFORMS,
  LOOPING_COURSE_SPIKES,
  LOOPING_COURSE_WATER,
  projectLoopingWorldX,
} from "./course";
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
  private readonly platformViews: Phaser.GameObjects.Rectangle[] = [];
  private readonly spikeViews: Phaser.GameObjects.Triangle[] = [];
  private readonly waterViews: Phaser.GameObjects.Rectangle[] = [];
  private chicken!: Phaser.GameObjects.Container;
  private chickenWing!: Phaser.GameObjects.Ellipse;
  private phaseShade!: Phaser.GameObjects.Rectangle;
  private phaseLabel!: Phaser.GameObjects.Text;
  private scoreLabel!: Phaser.GameObjects.Text;
  private courseLabel!: Phaser.GameObjects.Text;

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
    this.createWater();
    this.createPlatforms();
    this.createSpikes();
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
    return {
      sceneObjects: this.children.getChildren().length,
      activeTimers: 0,
      pooledObjects: this.platformViews.length + this.spikeViews.length + this.waterViews.length,
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

  private createWater() {
    for (const zone of LOOPING_COURSE_WATER) {
      const water = this.add
        .rectangle(
          zone.x + zone.width / 2,
          zone.top,
          zone.width,
          LOGICAL_GAME_HEIGHT - zone.top,
          0x0756b8,
          0.96,
        )
        .setOrigin(0.5, 0)
        .setStrokeStyle(8, 0x91c9ff, 0.92)
        .setDepth(1);

      water.setData("worldX", zone.x + zone.width / 2);
      this.waterViews.push(water);
    }
  }

  private createPlatforms() {
    for (const platform of LOOPING_COURSE_PLATFORMS) {
      const trunk = this.add
        .rectangle(
          platform.x + platform.width / 2,
          platform.top + 10,
          platform.width,
          PLATFORM_HEIGHT,
          0xa96527,
        )
        .setOrigin(0.5, 0)
        .setDepth(3);

      const grass = this.add
        .rectangle(platform.x + platform.width / 2, platform.top, platform.width, 20, 0x2b9b42)
        .setOrigin(0.5, 0.5)
        .setDepth(4);

      trunk.setData("worldX", platform.x + platform.width / 2);
      grass.setData("worldX", platform.x + platform.width / 2);
      this.platformViews.push(trunk, grass);
    }
  }

  private createSpikes() {
    for (const spike of LOOPING_COURSE_SPIKES) {
      const spikeView = this.add
        .triangle(
          spike.x + spike.width / 2,
          spike.baseTop,
          0,
          spike.height,
          spike.width / 2,
          0,
          spike.width,
          spike.height,
          0xf1f5f9,
        )
        .setOrigin(0.5, 1)
        .setStrokeStyle(3, 0xbdc8d4)
        .setDepth(6);

      spikeView.setData("worldX", spike.x + spike.width / 2);
      this.spikeViews.push(spikeView);
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
    for (const view of [...this.platformViews, ...this.spikeViews, ...this.waterViews]) {
      view.x = projectLoopingWorldX(
        Number(view.getData("worldX")),
        snapshot.distance,
        COURSE_LENGTH,
      );
    }

    const animation = snapshot.chicken.animation;
    const runBob = animation === "run" ? Math.sin(snapshot.tick * 0.55) * 1.8 : 0;

    this.chicken.setPosition(snapshot.chicken.x, snapshot.chicken.y + runBob);
    this.applyChickenPose(animation, snapshot.tick);
    this.scoreLabel.setText(
      `Survived ${(snapshot.elapsedMs / 1_000).toFixed(1)}s · ${snapshot.score}`,
    );
    this.courseLabel.setText(
      `Loop ${snapshot.loopsCompleted + 1} · ${Math.floor(
        (snapshot.courseDistance / COURSE_LENGTH) * 100,
      )}%`,
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
            )}s · Score ${snapshot.score}\nTap / Space / ↑ to restart`
          : "";

    this.phaseShade.setVisible(Boolean(phaseCopy));
    this.phaseLabel.setText(phaseCopy).setVisible(Boolean(phaseCopy));
  }

  private applyChickenPose(animation: ChickenAnimationState, tick: number) {
    this.chicken.setScale(1);

    switch (animation) {
      case "idle":
        this.chicken.setAngle(0);
        this.chickenWing.setAngle(8);
        break;
      case "run":
        this.chicken.setAngle(Math.sin(tick * 0.55) * 2);
        this.chickenWing.setAngle(12);
        break;
      case "jump":
        this.chicken.setAngle(-8);
        this.chickenWing.setAngle(-14);
        break;
      case "flap":
        this.chicken.setAngle(-4);
        this.chickenWing.setAngle(tick % 6 < 3 ? -34 : 20);
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
