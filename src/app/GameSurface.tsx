import { useEffect, useRef } from "react";

import { createGame } from "../game/createGame";

export function GameSurface() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const game = createGame(container);

    return () => {
      game.destroy(true);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      id="game-container"
      className="game-surface"
      data-testid="game-surface"
      aria-label="Shouting Chickens game canvas"
    />
  );
}
