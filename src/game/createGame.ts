import Phaser from "phaser";

const GAME_WIDTH = 432;
const GAME_HEIGHT = 768;

class BootstrapScene extends Phaser.Scene {
  constructor() {
    super("bootstrap");
  }

  create() {
    const platformColor = 0x5cb847;
    const platformEdge = 0x2d7d34;
    const waterColor = 0x1464d2;

    this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT - 78, GAME_WIDTH, 156, waterColor, 0.84);

    for (let index = 0; index < 8; index += 1) {
      const x = index * 64 - 16;
      this.add.circle(x, GAME_HEIGHT - 152, 34, index % 2 === 0 ? 0x69adff : 0xffffff, 0.92);
    }

    this.add.rectangle(90, GAME_HEIGHT - 250, 180, 34, platformColor, 0.96);
    this.add.rectangle(90, GAME_HEIGHT - 232, 180, 12, platformEdge, 0.96);
    this.add.rectangle(GAME_WIDTH - 72, GAME_HEIGHT - 318, 144, 34, platformColor, 0.96);
    this.add.rectangle(GAME_WIDTH - 72, GAME_HEIGHT - 300, 144, 12, platformEdge, 0.96);

    const chicken = this.add.container(86, GAME_HEIGHT - 304);
    chicken.add(this.add.ellipse(0, 0, 58, 70, 0xffffff));
    chicken.add(this.add.circle(8, -30, 5, 0x111827));
    chicken.add(this.add.triangle(33, -17, 0, 0, 24, 8, 0, 16, 0xf3c541));
    chicken.add(this.add.rectangle(-6, -43, 9, 15, 0xef4444));
    chicken.setAngle(-5);

    this.tweens.add({
      targets: chicken,
      y: chicken.y - 10,
      duration: 740,
      ease: "Sine.InOut",
      yoyo: true,
      repeat: -1,
    });

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 80, "React + Phaser booted", {
        color: "#d9e9f8",
        fontFamily: "system-ui, sans-serif",
        fontSize: "16px",
        fontStyle: "600",
      })
      .setOrigin(0.5)
      .setAlpha(0.72);
  }
}

export function createGame(parent: HTMLElement) {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    transparent: true,
    render: {
      antialias: true,
      pixelArt: false,
      roundPixels: true,
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: GAME_WIDTH,
      height: GAME_HEIGHT,
    },
    physics: {
      default: "arcade",
      arcade: {
        gravity: { x: 0, y: 980 },
        debug: false,
      },
    },
    scene: [BootstrapScene],
  });
}
