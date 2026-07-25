import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserMediaSession, MediaSessionSnapshot } from "../platform/media";
import { App } from "./App";

const expectedVersion = process.env.APP_VERSION?.trim() || "0.1.0";
const expectedCommitSha = process.env.COMMIT_SHA?.trim() || "development";
const expectedShortCommitSha =
  expectedCommitSha === "development" ? expectedCommitSha : expectedCommitSha.slice(0, 7);

vi.mock("../game/createGame", () => ({
  createGameRuntime: vi.fn(),
}));

function fakeManagedMediaSession() {
  const close = vi.fn(async () => undefined);
  const requestMicrophoneFromGesture = vi.fn();
  const useFallbackInput = vi.fn(async () => undefined);
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
    requestMicrophoneFromGesture,
    resumeFromGesture: async () => snapshot,
    stopCamera: () => undefined,
    subscribe: () => () => undefined,
    useFallbackInput,
  } as unknown as BrowserMediaSession;

  return { close, requestMicrophoneFromGesture, useFallbackInput, value };
}

describe("App media ownership", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  });

  it("renders a null-session capability check and never requests media on mount", async () => {
    const session = fakeManagedMediaSession();
    render(<App createMediaSession={() => session.value} />);

    expect(screen.getByRole("heading", { name: "Checking microphone support…" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Enable microphone" })).toBeDisabled();
    expect(session.requestMicrophoneFromGesture).not.toHaveBeenCalled();
    expect(session.useFallbackInput).not.toHaveBeenCalled();

    await screen.findByRole("heading", { name: "Play with your voice—or without it" });
    expect(session.requestMicrophoneFromGesture).not.toHaveBeenCalled();
  });

  it("keeps immutable release identity and local privacy/support links visible", () => {
    const session = fakeManagedMediaSession();
    render(<App createMediaSession={() => session.value} />);

    const release = screen.getByRole("contentinfo", { name: "Release information" });
    expect(release).toHaveTextContent(
      `Version ${expectedVersion} · build ${expectedShortCommitSha}`,
    );
    const commitAbbreviation = release.querySelector("abbr");
    expect(commitAbbreviation).toHaveTextContent(expectedShortCommitSha);
    expect(commitAbbreviation).toHaveAttribute("title", expectedCommitSha);
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "./privacy/");
    expect(screen.getByRole("link", { name: "Support" })).toHaveAttribute("href", "./support/");
  });

  it("shows the rotate guidance without starting a hidden run", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 844 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 390 });
    const session = fakeManagedMediaSession();
    render(<App createMediaSession={() => session.value} />);

    expect(screen.getByText("Rotate your device to play")).toBeVisible();
    await screen.findByRole("heading", { name: "Play with your voice—or without it" });
    expect(screen.queryByTestId("game-surface")).not.toBeInTheDocument();
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
