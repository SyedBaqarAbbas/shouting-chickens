import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const gameMocks = vi.hoisted(() => ({
  createGameRuntime: vi.fn(),
  mount: vi.fn(),
  startRun: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("../game/createGame", () => ({
  createGameRuntime: gameMocks.createGameRuntime,
}));

describe("App", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    gameMocks.mount.mockResolvedValue(undefined);
    gameMocks.createGameRuntime.mockReturnValue({
      mount: gameMocks.mount,
      startRun: gameMocks.startRun,
      pause: gameMocks.pause,
      resume: gameMocks.resume,
      destroy: gameMocks.destroy,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("mounts one game runtime and destroys it on unmount", async () => {
    const { unmount } = render(<App />);

    expect(screen.getByRole("heading", { name: "Shouting Chickens" })).toBeVisible();
    expect(screen.getByTestId("game-surface")).toBeInTheDocument();
    expect(gameMocks.createGameRuntime).toHaveBeenCalledTimes(1);
    expect(gameMocks.mount).toHaveBeenCalledWith(screen.getByTestId("game-surface"));
    await waitFor(() => expect(gameMocks.startRun).toHaveBeenCalledOnce());

    unmount();

    expect(gameMocks.destroy).toHaveBeenCalledOnce();
  });

  it("pauses behind the rotate prompt and resumes in portrait", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 844 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 390 });
    render(<App />);

    expect(screen.getByText("Rotate your device to play")).toBeVisible();
    await waitFor(() => expect(gameMocks.pause).toHaveBeenCalledOnce());

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    window.dispatchEvent(new Event("resize"));

    await waitFor(() => expect(gameMocks.resume).toHaveBeenCalledOnce());
    expect(screen.queryByText("Rotate your device to play")).not.toBeVisible();
  });
});
