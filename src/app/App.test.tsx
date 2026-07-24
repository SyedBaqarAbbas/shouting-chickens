import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const gameMocks = vi.hoisted(() => ({
  createGame: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("../game/createGame", () => ({
  createGame: gameMocks.createGame,
}));

describe("App", () => {
  beforeEach(() => {
    gameMocks.createGame.mockReturnValue({
      destroy: gameMocks.destroy,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("mounts one game runtime and destroys it on unmount", () => {
    const { unmount } = render(<App />);

    expect(screen.getByRole("heading", { name: "Shouting Chickens" })).toBeVisible();
    expect(screen.getByTestId("game-surface")).toBeInTheDocument();
    expect(gameMocks.createGame).toHaveBeenCalledTimes(1);

    unmount();

    expect(gameMocks.destroy).toHaveBeenCalledOnce();
    expect(gameMocks.destroy).toHaveBeenCalledWith(true);
  });
});
