import { useEffect, useRef, useState } from "react";

import { createGameRuntime } from "../game/createGame";

const RUN_OPTIONS = {
  seed: "foundation-world",
  calibration: null,
  gameplayVersion: "sho-9",
} as const;

function isCompactLandscape() {
  return window.innerWidth > window.innerHeight && window.innerHeight <= 540;
}

export function GameSurface() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [landscape, setLandscape] = useState(isCompactLandscape);
  const [mountFailed, setMountFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const runtime = createGameRuntime();
    let disposed = false;
    let mounted = false;
    let landscapeNow = isCompactLandscape();

    const applyOrientation = () => {
      landscapeNow = isCompactLandscape();
      setLandscape(landscapeNow);

      if (!mounted) {
        return;
      }

      if (landscapeNow) {
        runtime.pause();
      } else {
        runtime.resume();
      }
    };

    window.addEventListener("resize", applyOrientation);

    void runtime
      .mount(container)
      .then(() => {
        if (disposed) {
          return;
        }

        mounted = true;
        runtime.startRun(RUN_OPTIONS);

        if (landscapeNow) {
          runtime.pause();
        }
      })
      .catch(() => {
        if (!disposed) {
          setMountFailed(true);
        }
      });

    return () => {
      disposed = true;
      window.removeEventListener("resize", applyOrientation);
      runtime.destroy();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      id="game-container"
      className="game-surface"
      data-testid="game-surface"
      data-orientation={landscape ? "landscape" : "portrait"}
      aria-label="Shouting Chickens game canvas"
      tabIndex={0}
    >
      <div className="rotate-prompt" role="status" aria-live="polite" hidden={!landscape}>
        <span aria-hidden="true">↻</span>
        <strong>Rotate your device to play</strong>
        <small>The run is paused while the screen is landscape.</small>
      </div>

      {mountFailed ? (
        <p className="game-mount-error" role="alert">
          The game could not start. Refresh to try again.
        </p>
      ) : null}
    </div>
  );
}
