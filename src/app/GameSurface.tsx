import { useEffect, useRef, useState } from "react";

import { createGameRuntime } from "../game/createGame";

const RUN_OPTIONS = {
  seed: "foundation-world",
  calibration: null,
  gameplayVersion: "sho-9",
} as const;

interface GameSurfaceProps {
  readonly landscape: boolean;
}

export function GameSurface({ landscape }: GameSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ReturnType<typeof createGameRuntime> | null>(null);
  const mountedRef = useRef(false);
  const landscapeRef = useRef(landscape);
  const [mountFailed, setMountFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const runtime = createGameRuntime();
    runtimeRef.current = runtime;
    let disposed = false;

    void runtime
      .mount(container)
      .then(() => {
        if (disposed) {
          return;
        }

        mountedRef.current = true;
        runtime.startRun(RUN_OPTIONS);

        if (landscapeRef.current) {
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
      mountedRef.current = false;
      runtimeRef.current = null;
      runtime.destroy();
    };
  }, []);

  useEffect(() => {
    landscapeRef.current = landscape;
    const runtime = runtimeRef.current;

    if (!runtime || !mountedRef.current) {
      return;
    }

    if (landscape) {
      runtime.pause();
    } else {
      runtime.resume();
    }
  }, [landscape]);

  return (
    <div
      ref={containerRef}
      id="game-container"
      className="game-surface"
      data-testid="game-surface"
      data-orientation={landscape ? "landscape" : "portrait"}
      aria-label="Shouting Chickens game. Tap, press Space, or use Up Arrow to jump."
      tabIndex={0}
    >
      {mountFailed ? (
        <p className="game-mount-error" role="alert">
          The game could not start. Refresh to try again.
        </p>
      ) : null}
    </div>
  );
}
