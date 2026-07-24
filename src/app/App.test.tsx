import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserMediaSession, MediaSessionSnapshot } from "../platform/media";
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

function fakeManagedMediaSession() {
  const close = vi.fn(async () => undefined);
  const snapshot: MediaSessionSnapshot = {
    audioContext: "none",
    camera: {
      canFallback: false,
      canRetry: false,
      ignoredPreferences: [],
      kind: "camera",
      status: "idle",
    },
    microphone: {
      canFallback: true,
      canRetry: false,
      ignoredPreferences: [],
      kind: "microphone",
      status: "idle",
    },
    resumeRequired: false,
    visibility: "visible",
  };
  const value = {
    close,
    getCameraStream: () => undefined,
    getSnapshot: () => snapshot,
    requestCameraFromGesture: async () => snapshot.camera,
    stopCamera: () => undefined,
    subscribe: () => () => undefined,
  } as unknown as BrowserMediaSession;

  return { close, value };
}

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

  it("owns and closes every media session created during StrictMode remounts", async () => {
    const sessions: ReturnType<typeof fakeManagedMediaSession>[] = [];
    const createMediaSession = vi.fn(() => {
      const session = fakeManagedMediaSession();
      sessions.push(session);
      return session.value;
    });

    const { unmount } = render(
      <StrictMode>
        <App createMediaSession={createMediaSession} />
      </StrictMode>,
    );

    await waitFor(() => expect(createMediaSession).toHaveBeenCalledTimes(2));
    expect(sessions[0]?.close).toHaveBeenCalledOnce();

    unmount();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.close).toHaveBeenCalledOnce();
    expect(sessions[1]?.close).toHaveBeenCalledOnce();
  });
});
