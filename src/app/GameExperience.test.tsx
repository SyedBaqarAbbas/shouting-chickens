import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  CalibrationProfile,
  GameEvent,
  GameEventListener,
  InputSource,
  KeyValueStorage,
  VoiceFrame,
} from "../core";
import { MemoryStorage } from "../core/storage";
import { createGameRuntime } from "../game/createGame";
import type { CalibrationCapture, CalibrationCaptureSnapshot } from "../input";
import {
  CURRENT_COPY_VERSION,
  GAME_STORAGE_PREFIX,
  LOCAL_DATA_STORAGE_KEY,
  LocalGameDataStore,
  defaultLocalGameData,
} from "../platform/persistence";
import type {
  BrowserMediaSession,
  MediaResourceStatus,
  MediaSessionSnapshot,
  MediaStateIssue,
} from "../platform/media";
import { GameExperience, type VoiceInput } from "./GameExperience";

vi.mock("../game/createGame", () => ({
  createGameRuntime: vi.fn(),
}));

const PROFILE: CalibrationProfile = {
  jumpEnterLevel: 0.51,
  jumpExitLevel: 0.31,
  liftStartLevel: 0.51,
  loudDb: -10,
  noiseFloorDb: -60,
  normalDb: -30,
  schemaVersion: 1,
};

const RUN_SUMMARY = {
  distance: 432,
  gameplayVersion: "sho-12",
  reason: "water" as const,
  runId: 1,
  score: 42,
  scoreBreakdown: {
    survival: 42,
    collectibles: 0,
    precision: 0,
    total: 42,
  },
  seed: "looping-course",
  statistics: {
    distance: 432,
    obstaclesCleared: 3,
    collectibles: 0,
    precisionLandings: 0,
    longestLiftMs: 800,
    highestDifficultyStage: 2,
  },
  survivalMs: 4_200,
};

function runSummaryWithScore(runId: number, score: number) {
  return {
    ...RUN_SUMMARY,
    runId,
    score,
    scoreBreakdown: {
      survival: score,
      collectibles: 0,
      precision: 0,
      total: score,
    },
    survivalMs: score * 100,
  };
}

class FakeMediaSession {
  private readonly listeners = new Set<() => void>();
  private snapshot: MediaSessionSnapshot = snapshotWith("idle");
  nextRequestStatus: MediaResourceStatus = "active";
  nextRequestIssue: MediaStateIssue | undefined;
  nextRequestResumeRequired = false;

  readonly close = vi.fn(async () => undefined);
  readonly requestCameraFromGesture = vi.fn(async () => this.snapshot.camera);
  readonly stopCamera = vi.fn();
  readonly requestMicrophoneFromGesture = vi.fn(async () => {
    this.setMicrophone(
      this.nextRequestStatus,
      this.nextRequestIssue,
      this.nextRequestResumeRequired,
    );
    return this.snapshot.microphone;
  });
  readonly resumeFromGesture = vi.fn(() => {
    this.setMicrophone("active");
    return Promise.resolve(this.snapshot);
  });
  readonly useFallbackInput = vi.fn(() => {
    this.setMicrophone("fallback", "player-selected-fallback");
    return Promise.resolve();
  });

  readonly getSnapshot = () => this.snapshot;
  readonly getCameraStream = () => undefined;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setMicrophone(status: MediaResourceStatus, issue?: MediaStateIssue, resumeRequired = false) {
    this.snapshot = snapshotWith(status, issue, this.snapshot.visibility, resumeRequired);
    this.publish();
  }

  setVisibility(visibility: "visible" | "hidden") {
    this.snapshot = {
      ...this.snapshot,
      visibility,
    };
    this.publish();
  }

  asSession() {
    return this as unknown as BrowserMediaSession;
  }

  private publish() {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

class FakeCalibrationCapture implements CalibrationCapture {
  private readonly listeners = new Set<() => void>();
  private snapshot: CalibrationCaptureSnapshot = captureSnapshot();
  readonly start = vi.fn(async () => undefined);
  readonly stop = vi.fn();
  readonly beginStage = vi.fn((stage: "quiet" | "normal" | "loud") => {
    this.snapshot = captureSnapshot({
      ...this.snapshot,
      clip: {
        stage: stage === "quiet" ? null : stage,
        status: stage === "quiet" ? "idle" : "recording",
        url: null,
      },
      elapsedMs: 0,
      progress: 0,
      result: null,
      sampleCount: 0,
      stage,
      status: "capturing",
    });
    this.publish();
  });
  readonly reset = vi.fn(() => {
    this.snapshot = captureSnapshot();
    this.publish();
  });

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  finalize() {
    return this.snapshot.result ?? failure("not-enough-samples");
  }

  completeStage(stage: "quiet" | "normal") {
    this.snapshot = captureSnapshot({
      completedStages: stage === "quiet" ? ["quiet"] : ["quiet", "normal"],
      clip:
        stage === "normal"
          ? { stage: "normal", status: "unavailable", url: null }
          : { stage: null, status: "idle", url: null },
      elapsedMs: 1_500,
      progress: 1,
      sampleCount: 12,
      stage,
      status: "stage-complete",
    });
    this.publish();
  }

  succeed() {
    this.snapshot = captureSnapshot({
      completedStages: ["quiet", "normal", "loud"],
      clip: { stage: "loud", status: "unavailable", url: null },
      elapsedMs: 1_500,
      progress: 1,
      result: { ok: true, profile: PROFILE },
      sampleCount: 12,
      stage: "loud",
      status: "complete",
    });
    this.publish();
  }

  fail(
    code: "not-enough-samples" | "clipped" | "quiet-normal-range" | "normal-loud-range",
    stage: "quiet" | "normal" | "loud" = "loud",
  ) {
    this.snapshot = captureSnapshot({
      clip:
        stage === "quiet"
          ? { stage: null, status: "idle", url: null }
          : { stage, status: "ready", url: `blob:failed-${stage}` },
      completedStages:
        stage === "quiet" ? [] : stage === "normal" ? ["quiet"] : ["quiet", "normal"],
      result: failure(code),
      stage,
      status: "failed",
    });
    this.publish();
  }

  setLiveLevel(level: number) {
    this.snapshot = captureSnapshot({
      ...this.snapshot,
      hasSignal: level > 0.05,
      level,
      quality: level > 0.8 ? "clipped" : "good",
    });
    this.publish();
  }

  setClipReady(stage: "normal" | "loud", url: string) {
    this.snapshot = captureSnapshot({
      ...this.snapshot,
      clip: { stage, status: "ready", url },
    });
    this.publish();
  }

  private publish() {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

class FakeVoiceInput implements InputSource {
  running = false;
  readonly start = vi.fn(async () => {
    this.running = true;
  });
  readonly stop = vi.fn(() => {
    this.running = false;
  });
  readonly resetRunState = vi.fn();
  frame: VoiceFrame | null = null;

  latest() {
    return { atMs: 0, jumpPressed: false, lift: 0 };
  }

  getLatestVoiceFrame() {
    return this.frame;
  }
}

class FakeRuntime {
  listener: GameEventListener | null = null;
  input: InputSource | null = null;
  fatalOnMount = false;
  readonly mount = vi.fn(async (container: HTMLElement) => {
    this.input = this.options.inputSourceFactory?.(container) ?? null;
    await this.input?.start();
    if (this.fatalOnMount) {
      this.emit({
        error: {
          code: "render-failed",
          message: "Synthetic renderer failure",
          recoverable: true,
        },
        type: "fatal-error",
      });
      throw new Error("Synthetic mount rejection");
    }
  });
  readonly startRun = vi.fn();
  readonly setActiveInput = vi.fn();
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly restart = vi.fn();
  readonly destroy = vi.fn(() => {
    this.input?.stop();
  });
  readonly subscribe = vi.fn((listener: GameEventListener) => {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  });

  constructor(
    private readonly options: NonNullable<Parameters<typeof createGameRuntime>[0]>,
    fatalOnMount: boolean,
  ) {
    this.fatalOnMount = fatalOnMount;
  }

  emit(event: GameEvent) {
    this.listener?.(event);
  }
}

function createRuntimeHarness(fatalOnMount = false) {
  const runtimes: FakeRuntime[] = [];
  const factory = vi.fn((options: NonNullable<Parameters<typeof createGameRuntime>[0]> = {}) => {
    const runtime = new FakeRuntime(options, fatalOnMount);
    runtimes.push(runtime);
    return runtime as unknown as ReturnType<typeof createGameRuntime>;
  });

  return {
    factory: factory as unknown as typeof createGameRuntime,
    runtimes,
  };
}

function renderHarness(
  options: {
    fatalOnMount?: boolean;
    landscape?: boolean;
    storage?: KeyValueStorage;
    strict?: boolean;
  } = {},
) {
  const session = new FakeMediaSession();
  const captures: FakeCalibrationCapture[] = [];
  const voices: FakeVoiceInput[] = [];
  const runtime = createRuntimeHarness(options.fatalOnMount);
  const createCapture = vi.fn(() => {
    const capture = new FakeCalibrationCapture();
    captures.push(capture);
    return capture;
  });
  const createVoice = vi.fn(() => {
    const voice = new FakeVoiceInput();
    voices.push(voice);
    return voice as unknown as VoiceInput;
  });
  const experience = (
    <GameExperience
      countdownStepMs={50}
      createCalibrationCapture={createCapture}
      createRuntime={runtime.factory}
      createVoiceInput={createVoice}
      landscape={options.landscape ?? false}
      session={session.asSession()}
      storage={options.storage}
    />
  );
  const view = render(options.strict ? <StrictMode>{experience}</StrictMode> : experience);

  return {
    ...view,
    captures,
    createCapture,
    createVoice,
    runtime,
    session,
    voices,
  };
}

async function enterCalibration(harness: ReturnType<typeof renderHarness>) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Enable microphone" }));
  await screen.findByRole("heading", { name: "Calibrate your comfortable range" });
  return { capture: harness.captures[0]!, user };
}

async function finishValidCalibration(harness: ReturnType<typeof renderHarness>) {
  const { capture, user } = await enterCalibration(harness);
  await user.click(screen.getByRole("button", { name: "Capture quiet" }));
  act(() => capture.completeStage("quiet"));
  await user.click(screen.getByRole("button", { name: "Next: comfortable voice" }));
  act(() => capture.completeStage("normal"));
  await user.click(screen.getByRole("button", { name: "Next: strong voice" }));
  act(() => capture.succeed());
  await user.click(screen.getByRole("button", { name: "Use this calibration" }));
  await screen.findByRole("heading", { name: "Ready to run" });
  return { capture, user, voice: harness.voices[0]! };
}

async function startRun(harness: ReturnType<typeof renderHarness>, calibrated = false) {
  const user = userEvent.setup();
  if (calibrated) {
    await finishValidCalibration(harness);
  } else {
    await user.click(screen.getByRole("button", { name: "Use keyboard or touch" }));
  }
  await user.click(screen.getByRole("button", { name: "Start run" }));
  await screen.findByText("3");
  await waitFor(() => expect(screen.getByTestId("game-surface")).toBeInTheDocument(), {
    timeout: 1_000,
  });
  await waitFor(() => expect(harness.runtime.runtimes[0]?.startRun).toHaveBeenCalledOnce());
  return user;
}

describe("GameExperience onboarding", () => {
  it("does not request on mount and provides keyboard-reachable, named choices", async () => {
    const harness = renderHarness();
    const user = userEvent.setup();

    expect(harness.session.requestMicrophoneFromGesture).not.toHaveBeenCalled();
    const heading = screen.getByRole("heading", { name: "Play with your voice—or without it" });
    await waitFor(() => expect(heading).toHaveFocus());

    await user.tab();
    expect(screen.getByRole("button", { name: "Enable microphone" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Use keyboard or touch" })).toHaveFocus();
    expect(screen.getByText(/never need to scream/i)).toBeVisible();
  });

  it("deduplicates loading and ignores a stale permission success after fallback", async () => {
    const harness = renderHarness();
    const pending = deferred<MediaSessionSnapshot["microphone"]>();
    harness.session.requestMicrophoneFromGesture.mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();

    const enable = screen.getByRole("button", { name: "Enable microphone" });
    await user.click(enable);
    expect(screen.getByRole("button", { name: "Checking microphone…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Use keyboard or touch" }));
    expect(screen.getByRole("heading", { name: "Ready to run" })).toBeVisible();

    await act(async () => pending.resolve(snapshotWith("active").microphone));
    expect(harness.session.requestMicrophoneFromGesture).toHaveBeenCalledOnce();
    expect(harness.createCapture).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Set up microphone" }));
    expect(
      await screen.findByRole("heading", { name: "Calibrate your comfortable range" }),
    ).toBeVisible();
    expect(harness.session.requestMicrophoneFromGesture).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["denied", "permission was denied"],
    ["unavailable", "No usable microphone"],
    ["unsupported", "cannot provide microphone"],
  ] as const)("recovers from %s with retry and fallback", async (status, copy) => {
    const harness = renderHarness();
    harness.session.nextRequestStatus = status;
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Enable microphone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);

    if (status !== "unsupported") {
      harness.session.nextRequestStatus = "active";
      await user.click(screen.getByRole("button", { name: "Try microphone again" }));
      expect(
        await screen.findByRole("heading", { name: "Calibrate your comfortable range" }),
      ).toBeVisible();
    } else {
      await user.click(screen.getByRole("button", { name: "Use keyboard or touch" }));
      expect(screen.getByRole("heading", { name: "Ready to run" })).toBeVisible();
    }
  });

  it("resumes an initially suspended microphone before starting calibration", async () => {
    const harness = renderHarness();
    harness.session.nextRequestStatus = "suspended";
    harness.session.nextRequestIssue = "audio-context-suspended";
    harness.session.nextRequestResumeRequired = true;
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Enable microphone" }));
    const heading = await screen.findByRole("heading", { name: "Resume microphone setup" });
    expect(heading).toHaveFocus();
    expect(harness.createCapture).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use keyboard or touch" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Resume microphone" }));
    expect(
      await screen.findByRole("heading", { name: "Calibrate your comfortable range" }),
    ).toBeVisible();
    expect(harness.session.resumeFromGesture).toHaveBeenCalledOnce();
    expect(harness.createCapture).toHaveBeenCalledOnce();
  });

  it("stops and discards calibration frames when setup audio is suspended", async () => {
    const harness = renderHarness();
    const { capture, user } = await enterCalibration(harness);
    await user.click(screen.getByRole("button", { name: "Capture quiet" }));

    act(() => harness.session.setMicrophone("suspended", "audio-context-suspended", true));
    expect(await screen.findByRole("heading", { name: "Resume microphone setup" })).toBeVisible();
    expect(capture.stop).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Resume microphone" }));
    expect(
      await screen.findByRole("heading", { name: "Calibrate your comfortable range" }),
    ).toBeVisible();
    expect(harness.captures).toHaveLength(2);
    expect(screen.getByText("0%")).toBeVisible();
  });

  it("returns a suspended ready screen only after an explicit resume gesture", async () => {
    const harness = renderHarness();
    const { user, voice } = await finishValidCalibration(harness);
    voice.stop.mockClear();

    act(() => harness.session.setMicrophone("suspended", "audio-context-suspended", true));
    expect(await screen.findByRole("heading", { name: "Resume microphone setup" })).toBeVisible();
    expect(screen.getByText(/calibration remains ready/i)).toBeVisible();
    expect(voice.stop).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Resume microphone" }));
    expect(await screen.findByRole("heading", { name: "Ready to run" })).toBeVisible();
    expect(screen.getByText(/Microphone \+ fallback controls/)).toBeVisible();
  });

  it("discards calibration and reacquires a device-lost microphone", async () => {
    const harness = renderHarness();
    const { capture, user } = await enterCalibration(harness);
    await user.click(screen.getByRole("button", { name: "Capture quiet" }));

    act(() => harness.session.setMicrophone("device-lost", "device-lost"));
    expect(await screen.findByRole("heading", { name: "Resume microphone setup" })).toBeVisible();
    expect(screen.getByText(/active microphone disconnected/i)).toBeVisible();
    expect(capture.stop).toHaveBeenCalled();

    harness.session.nextRequestStatus = "active";
    await user.click(screen.getByRole("button", { name: "Check microphone again" }));
    expect(
      await screen.findByRole("heading", { name: "Calibrate your comfortable range" }),
    ).toBeVisible();
    expect(harness.session.requestMicrophoneFromGesture).toHaveBeenCalledTimes(2);
    expect(harness.captures).toHaveLength(2);
  });

  it("reacquires an unavailable microphone and requires fresh calibration", async () => {
    const harness = renderHarness();
    const { user, voice } = await finishValidCalibration(harness);
    voice.stop.mockClear();

    act(() => harness.session.setMicrophone("unavailable", "no-device"));
    expect(await screen.findByRole("heading", { name: "Resume microphone setup" })).toBeVisible();
    expect(screen.getByText(/changed device cannot set your controls/i)).toBeVisible();
    expect(voice.stop).toHaveBeenCalledOnce();

    harness.session.nextRequestStatus = "active";
    await user.click(screen.getByRole("button", { name: "Check microphone again" }));
    expect(
      await screen.findByRole("heading", { name: "Calibrate your comfortable range" }),
    ).toBeVisible();
    expect(harness.captures).toHaveLength(2);
  });

  it("ignores a stale setup recovery after fallback is selected", async () => {
    const harness = renderHarness();
    const { user } = await enterCalibration(harness);
    act(() => harness.session.setMicrophone("device-lost", "device-lost"));
    await screen.findByRole("heading", { name: "Resume microphone setup" });

    const recovery = deferred<MediaSessionSnapshot["microphone"]>();
    harness.session.requestMicrophoneFromGesture.mockReturnValueOnce(recovery.promise);
    await user.click(screen.getByRole("button", { name: "Check microphone again" }));
    expect(screen.getByRole("button", { name: "Checking microphone…" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Use keyboard or touch" }));
    await act(async () => recovery.resolve(snapshotWith("fallback").microphone));

    expect(screen.getByRole("heading", { name: "Ready to run" })).toBeVisible();
    expect(screen.getByText("Keyboard + touch ready")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["not-enough-samples", "quiet"],
    ["clipped", "loud"],
    ["quiet-normal-range", "normal"],
    ["normal-loud-range", "loud"],
  ] as const)("shows and retries only the invalid %s calibration stage", async (code, stage) => {
    const harness = renderHarness();
    const { capture, user } = await enterCalibration(harness);
    await user.click(screen.getByRole("button", { name: "Capture quiet" }));

    act(() => capture.fail(code, stage));
    expect(screen.getByRole("alert")).toHaveTextContent("comfortable voice only");
    if (stage !== "quiet") {
      expect(screen.getByRole("button", { name: "Play recorded voice" })).toBeVisible();
    }
    await user.click(
      screen.getByRole("button", {
        name:
          stage === "quiet"
            ? "Retry quiet"
            : stage === "normal"
              ? "Retry comfortable voice"
              : "Retry strong voice",
      }),
    );

    expect(capture.reset).not.toHaveBeenCalled();
    expect(capture.beginStage).toHaveBeenLastCalledWith(stage);
    expect(screen.getByText(/Microphone recording/)).toBeVisible();
    if (stage !== "quiet") {
      expect(screen.queryByRole("button", { name: "Play recorded voice" })).toBeNull();
    }
  });

  it("shows live input, requires final confirmation, and really stops testing", async () => {
    const harness = renderHarness();
    const { capture, user } = await enterCalibration(harness);

    act(() => capture.setLiveLevel(0.62));
    expect(screen.getByRole("meter", { name: "Live microphone activity" })).toHaveValue(0.62);
    expect(screen.getByText("Microphone active. The meter is responding.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Capture quiet" }));
    act(() => capture.completeStage("quiet"));
    await user.click(screen.getByRole("button", { name: "Next: comfortable voice" }));
    act(() => capture.completeStage("normal"));
    await user.click(screen.getByRole("button", { name: "Next: strong voice" }));
    act(() => capture.succeed());

    expect(screen.getByRole("heading", { name: "Calibrate your comfortable range" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Use this calibration" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Use this calibration" }));
    const voice = harness.voices[0]!;

    expect(capture.beginStage).toHaveBeenNthCalledWith(1, "quiet");
    expect(capture.beginStage).toHaveBeenNthCalledWith(2, "normal");
    expect(capture.beginStage).toHaveBeenNthCalledWith(3, "loud");
    expect(capture.stop).toHaveBeenCalled();
    expect(screen.getByText(/Microphone \+ fallback controls/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Test your voice" }));
    await screen.findByRole("button", { name: "Stop voice test" });
    voice.stop.mockClear();
    await user.click(screen.getByRole("button", { name: "Stop voice test" }));
    expect(voice.stop).toHaveBeenCalledOnce();
    expect(screen.getByText(/Voice test is off/)).toBeVisible();
  });

  it("cancels pending playback before advancing and ignores its stale resolution", async () => {
    const pendingPlay = deferred<void>();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(pendingPlay.promise);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const harness = renderHarness();
    const { capture, user } = await enterCalibration(harness);

    await user.click(screen.getByRole("button", { name: "Capture quiet" }));
    act(() => capture.completeStage("quiet"));
    await user.click(screen.getByRole("button", { name: "Next: comfortable voice" }));
    act(() => capture.completeStage("normal"));
    act(() => capture.setClipReady("normal", "blob:test-normal"));

    await user.click(screen.getByRole("button", { name: "Play recorded voice" }));
    expect(play).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Next: strong voice" }));
    expect(pause).toHaveBeenCalled();
    expect(capture.beginStage).toHaveBeenLastCalledWith("loud");

    await act(async () => pendingPlay.resolve());
    expect(screen.queryByRole("button", { name: "Stop playback" })).toBeNull();

    play.mockRestore();
    pause.mockRestore();
  });
});

describe("GameExperience run lifecycle", () => {
  it("gives the real StrictMode runtime sole ownership of shared voice input", async () => {
    const harness = renderHarness({ strict: true });

    await startRun(harness, true);

    expect(harness.runtime.runtimes).toHaveLength(1);
    expect(harness.voices[0]?.start).toHaveBeenCalledOnce();
    expect(harness.voices[0]?.running).toBe(true);
  });

  it("ends a ready-screen voice test before the countdown and starts it once for gameplay", async () => {
    const harness = renderHarness();
    const { user, voice } = await finishValidCalibration(harness);
    await user.click(screen.getByRole("button", { name: "Test your voice" }));
    await screen.findByRole("button", { name: "Stop voice test" });

    await user.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(harness.runtime.runtimes[0]?.startRun).toHaveBeenCalledOnce());

    expect(voice.stop).toHaveBeenCalledOnce();
    expect(voice.start).toHaveBeenCalledTimes(2);
    expect(voice.running).toBe(true);
  });

  it("cancels a rotated countdown instead of starting behind the overlay", async () => {
    const harness = renderHarness();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Use keyboard or touch" }));
    await user.click(screen.getByRole("button", { name: "Start run" }));

    harness.rerender(
      <GameExperience
        countdownStepMs={5}
        createCalibrationCapture={harness.createCapture}
        createRuntime={harness.runtime.factory}
        landscape
        session={harness.session.asSession()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Ready to run" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Countdown cancelled");
    expect(harness.runtime.runtimes).toHaveLength(0);
  });

  it("cancels a voice countdown when the microphone disappears", async () => {
    const harness = renderHarness();
    const { user } = await finishValidCalibration(harness);
    await user.click(screen.getByRole("button", { name: "Start run" }));
    await screen.findByText("3");

    act(() => harness.session.setMicrophone("device-lost", "device-lost"));

    expect(await screen.findByRole("heading", { name: "Resume microphone setup" })).toBeVisible();
    expect(harness.runtime.runtimes).toHaveLength(0);
  });

  it("composes manual pause, focuses its dialog, and resumes explicitly", async () => {
    const harness = renderHarness();
    const user = await startRun(harness);
    const runtime = harness.runtime.runtimes[0]!;

    await user.click(screen.getByRole("button", { name: "Pause run" }));
    const heading = screen.getByRole("heading", { name: "Take a breath" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(runtime.pause).toHaveBeenCalled();
    expect(screen.getByTestId("game-surface")).toHaveAttribute("inert");
    expect(screen.getByRole("dialog", { name: "Take a breath" })).toHaveAttribute(
      "aria-modal",
      "true",
    );

    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Accessibility & settings" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(runtime.resume).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause run" })).toHaveFocus());
  });

  it("announces a paused phase once instead of repeating every throttled snapshot", async () => {
    const harness = renderHarness();
    await startRun(harness);
    const runtime = harness.runtime.runtimes[0]!;
    const status = document.querySelector(".accessible-game-status");
    expect(status).not.toBeNull();

    act(() =>
      runtime.emit({
        type: "snapshot",
        value: {
          distance: 10,
          elapsedMs: 1_250,
          normalizedInput: 0,
          phase: "paused",
          score: 1,
          scoreBreakdown: {
            survival: 1,
            collectibles: 0,
            precision: 0,
            total: 1,
          },
          liftStamina: 0.75,
          difficultyStage: 2,
          worldSpeed: 148,
        },
      }),
    );
    expect(status).toHaveTextContent(
      "paused. Stage 2. 1 seconds. Input quiet. Lift stamina 75 percent. Score 1: 1 survival, 0 collectible, 0 precision.",
    );

    act(() => {
      for (let score = 2; score <= 9; score += 1) {
        runtime.emit({
          type: "snapshot",
          value: {
            distance: 10,
            elapsedMs: 1_250 + score * 50,
            normalizedInput: 0,
            phase: "paused",
            score,
            scoreBreakdown: {
              survival: score,
              collectibles: 0,
              precision: 0,
              total: score,
            },
            liftStamina: 0.75,
            difficultyStage: 2,
            worldSpeed: 148,
          },
        });
      }
    });
    expect(status).toHaveTextContent(
      "paused. Stage 2. 1 seconds. Input quiet. Lift stamina 75 percent. Score 1: 1 survival, 0 collectible, 0 precision.",
    );
  });

  it("owns results focus and performs exactly one explicit restart", async () => {
    const harness = renderHarness();
    const user = await startRun(harness);
    const runtime = harness.runtime.runtimes[0]!;

    act(() => runtime.emit({ type: "ended", value: RUN_SUMMARY }));
    const heading = screen.getByRole("heading", { name: "Nice flight" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText("4.2s")).toBeVisible();
    expect(screen.getByText("Total score").nextElementSibling).toHaveTextContent("42");
    expect(screen.getByText("Survival points").nextElementSibling).toHaveTextContent("42");
    expect(screen.getByText("Collectible bonus").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Precision bonus").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Distance").nextElementSibling).toHaveTextContent("432 px");
    expect(screen.getByText("Obstacles cleared").nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText("Feathers").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Precision landings").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Longest lift").nextElementSibling).toHaveTextContent("0.8s");
    expect(screen.getByText("Ended by").nextElementSibling).toHaveTextContent("water");
    expect(screen.getByTestId("game-surface")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("dialog", { name: "Nice flight" })).toHaveAttribute(
      "aria-modal",
      "true",
    );

    await user.keyboard(" ");
    expect(runtime.restart).not.toHaveBeenCalled();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Accessibility & settings" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Restart run" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Quit to ready screen" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Restart run" }));
    await waitFor(() => expect(runtime.restart).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Pause run" })).toBeVisible();
  });

  it("closes results with Escape and returns focus to the ready screen", async () => {
    const harness = renderHarness();
    const user = await startRun(harness);
    const runtime = harness.runtime.runtimes[0]!;

    act(() => runtime.emit({ type: "ended", value: RUN_SUMMARY }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Nice flight" })).toHaveFocus());
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Ready to run" })).toHaveFocus(),
    );
    expect(screen.queryByRole("dialog", { name: "Nice flight" })).not.toBeInTheDocument();
  });

  it("keeps a restarted voice run paused when its microphone was lost on results", async () => {
    const harness = renderHarness();
    const user = await startRun(harness, true);
    const runtime = harness.runtime.runtimes[0]!;
    act(() => runtime.emit({ type: "ended", value: RUN_SUMMARY }));
    act(() => harness.session.setMicrophone("device-lost", "device-lost"));
    runtime.pause.mockClear();
    runtime.restart.mockClear();

    await user.click(screen.getByRole("button", { name: "Restart run" }));

    expect(runtime.restart).toHaveBeenCalledOnce();
    expect(runtime.pause).toHaveBeenCalled();
    expect(runtime.pause.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      runtime.restart.mock.invocationCallOrder[0]!,
    );
    expect(screen.getByRole("heading", { name: "Microphone needs attention" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Continue with keyboard or touch" }));
    await waitFor(() => expect(runtime.resume).toHaveBeenCalled());
  });

  it("keeps the same run and score state when switching an interrupted mic to fallback", async () => {
    const harness = renderHarness();
    const user = await startRun(harness, true);
    const runtime = harness.runtime.runtimes[0]!;
    runtime.startRun.mockClear();
    runtime.destroy.mockClear();

    act(() => harness.session.setMicrophone("device-lost", "device-lost"));
    expect(screen.getByRole("heading", { name: "Microphone needs attention" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue with keyboard or touch" }));

    expect(screen.getByTestId("game-surface")).toBeInTheDocument();
    expect(runtime.startRun).not.toHaveBeenCalled();
    expect(runtime.restart).not.toHaveBeenCalled();
    expect(runtime.destroy).not.toHaveBeenCalled();
    expect(runtime.setActiveInput).toHaveBeenLastCalledWith("keyboard-touch");
    expect(harness.session.useFallbackInput).toHaveBeenCalled();
  });

  it("preserves calibrated setup when quitting results to the ready screen", async () => {
    const harness = renderHarness();
    const user = await startRun(harness, true);
    const runtime = harness.runtime.runtimes[0]!;
    act(() => runtime.emit({ type: "ended", value: RUN_SUMMARY }));

    await user.click(screen.getByRole("button", { name: "Quit to ready screen" }));
    expect(screen.getByRole("heading", { name: "Ready to run" })).toBeVisible();
    expect(screen.getByText(/Microphone \+ fallback controls/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Recalibrate" })).toBeVisible();
  });

  it("requires an explicit gesture to resume suspended microphone audio", async () => {
    const harness = renderHarness();
    const user = await startRun(harness, true);
    const runtime = harness.runtime.runtimes[0]!;

    act(() => harness.session.setMicrophone("suspended", "audio-context-suspended", true));
    expect(screen.getByRole("heading", { name: "Microphone needs attention" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Resume microphone" }));

    expect(harness.session.resumeFromGesture).toHaveBeenCalledOnce();
    await waitFor(() => expect(runtime.resume).toHaveBeenCalled());
  });

  it("ignores a late resume failure after continuing a run with fallback", async () => {
    const harness = renderHarness();
    const user = await startRun(harness, true);
    const resume = deferred<MediaSessionSnapshot>();
    harness.session.resumeFromGesture.mockReturnValueOnce(resume.promise);

    act(() => harness.session.setMicrophone("suspended", "audio-context-suspended", true));
    await user.click(screen.getByRole("button", { name: "Resume microphone" }));
    await user.click(screen.getByRole("button", { name: "Continue with keyboard or touch" }));
    await act(async () => resume.reject(new Error("stale resume failure")));

    expect(screen.getByRole("button", { name: "Pause run" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(harness.session.useFallbackInput).toHaveBeenCalled();
  });

  it("catches a mount fatal event because subscription happens before mount", async () => {
    renderHarness({ fatalOnMount: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Use keyboard or touch" }));
    await user.click(screen.getByRole("button", { name: "Start run" }));

    expect(
      await screen.findByRole("heading", { name: "The course could not start" }),
    ).toBeVisible();
    expect(screen.getByText("Synthetic renderer failure")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Return to ready screen" }));
    expect(screen.getByRole("heading", { name: "Ready to run" })).toBeVisible();
  });

  it("keeps fallback sources mounted when optional voice startup fails", async () => {
    const harness = renderHarness();
    await finishValidCalibration(harness);
    harness.voices[0]!.start.mockRejectedValueOnce(new Error("voice graph failed"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start run" }));

    expect(
      await screen.findByRole("heading", { name: "Microphone needs attention" }),
    ).toBeVisible();
    expect(screen.getByTestId("game-surface")).toBeInTheDocument();
    expect(harness.runtime.runtimes[0]?.startRun).toHaveBeenCalledOnce();
    expect(screen.queryByRole("heading", { name: "The course could not start" })).toBeNull();
  });
});

describe("GameExperience local settings and statistics", () => {
  it("exposes every named preference and restores it with the fallback setup", async () => {
    const storage = new MemoryStorage();
    const harness = renderHarness({ storage });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Use keyboard or touch" }));
    await user.click(screen.getByRole("button", { name: "Accessibility & settings" }));
    const heading = screen.getByRole("heading", { name: "Accessibility & settings" });
    await waitFor(() => expect(heading).toHaveFocus());

    const inputPreference = screen.getByRole("combobox", { name: "Preferred input" });
    const closeSettings = screen.getByRole("button", { name: "Close settings" });
    await user.tab({ shift: true });
    expect(closeSettings).toHaveFocus();
    await user.tab();
    expect(inputPreference).toHaveFocus();
    expect(inputPreference).toHaveValue("keyboard-touch");
    await user.selectOptions(inputPreference, "voice");
    await user.selectOptions(inputPreference, "keyboard-touch");
    await user.click(screen.getByRole("checkbox", { name: "Prefer camera composition" }));
    await user.click(screen.getByRole("checkbox", { name: "Mute game" }));
    await user.click(screen.getByRole("checkbox", { name: "Reduce motion" }));
    await user.click(screen.getByRole("checkbox", { name: "Screen shake" }));

    expect(screen.getByRole("checkbox", { name: "Prefer camera composition" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Mute game" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Reduce motion" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Screen shake" })).not.toBeChecked();
    expect(
      screen.getByText(/Microphone samples, recordings, and camera video are never saved/),
    ).toBeVisible();

    closeSettings.focus();
    fireEvent.keyDown(closeSettings, { key: "Tab" });
    expect(inputPreference).toHaveFocus();
    fireEvent.keyDown(inputPreference, { key: "Tab", shiftKey: true });
    expect(closeSettings).toHaveFocus();
    await user.click(closeSettings);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Accessibility & settings" })).toHaveFocus(),
    );
    harness.unmount();

    const restored = renderHarness({ storage });
    expect(screen.getByRole("heading", { name: "Ready to run" })).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Accessibility & settings" }));
    expect(screen.getByRole("checkbox", { name: "Prefer camera composition" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Mute game" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Reduce motion" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Screen shake" })).not.toBeChecked();

    const persisted = new LocalGameDataStore(storage).read().data;
    expect(persisted.settings).toMatchObject({
      cameraEnabled: true,
      controlPreference: "keyboard-touch",
      copyVersion: CURRENT_COPY_VERSION,
      muted: true,
      reducedMotion: true,
      screenShakeEnabled: false,
    });
    restored.unmount();
  });

  it("persists a safely bounded manual threshold and starts a clean recalibration", async () => {
    const storage = new MemoryStorage();
    const harness = renderHarness({ storage });
    const { user } = await finishValidCalibration(harness);

    await user.click(screen.getByRole("button", { name: "Accessibility & settings" }));
    const threshold = screen.getByRole("slider", { name: "Voice jump threshold" });
    expect(threshold).toHaveValue("51");
    fireEvent.change(threshold, { target: { value: "72" } });

    expect(threshold).toHaveValue("72");
    expect(new LocalGameDataStore(storage).read().data.calibration).toMatchObject({
      jumpEnterLevel: 0.72,
      jumpExitLevel: 0.52,
      liftStartLevel: 0.72,
    });
    expect(harness.voices[0]?.stop).toHaveBeenCalled();
    expect(harness.voices).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Recalibrate microphone" }));
    expect(
      await screen.findByRole("heading", { name: "Calibrate your comfortable range" }),
    ).toBeVisible();
    expect(new LocalGameDataStore(storage).read().data.calibration).toBeNull();
    expect(harness.captures).toHaveLength(2);
  });

  it("pauses the same active run, locks unsafe settings, and restores focus on Escape", async () => {
    const harness = renderHarness();
    const user = await startRun(harness, true);
    const runtime = harness.runtime.runtimes[0]!;
    runtime.pause.mockClear();
    runtime.resume.mockClear();
    const settingsButton = screen.getByRole("button", { name: "Settings" });

    await user.click(settingsButton);

    expect(screen.getByRole("dialog", { name: "Accessibility & settings" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(
      screen.getByText(/Input preference and calibration can be changed after this run/),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Preferred input" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Voice jump threshold" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Recalibrate microphone" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Return to paused run" })).toBeVisible();
    expect(runtime.pause).toHaveBeenCalled();
    expect(harness.runtime.runtimes).toHaveLength(1);

    await user.click(screen.getByRole("checkbox", { name: "Reduce motion" }));
    expect(screen.getByTestId("game-surface")).toHaveAttribute("data-reduced-motion", "true");
    await user.keyboard("{Escape}");

    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus());
    expect(runtime.resume).toHaveBeenCalled();
    expect(runtime.startRun).toHaveBeenCalledOnce();
    expect(runtime.restart).not.toHaveBeenCalled();
    expect(harness.runtime.runtimes).toHaveLength(1);
  });

  it("resets all game-owned storage immediately and preserves unrelated origin data", async () => {
    const storage = new MemoryStorage();
    const initial = defaultLocalGameData();
    new LocalGameDataStore(storage).write({
      ...initial,
      settings: {
        ...initial.settings,
        copyVersion: CURRENT_COPY_VERSION,
        muted: true,
      },
      statistics: {
        bestDistance: 900,
        bestScore: 90,
        completedRuns: 4,
        longestSurvivalMs: 9_000,
      },
    });
    storage.set(`${GAME_STORAGE_PREFIX}future-owned.v9`, "remove");
    storage.set("unrelated.preference", "preserve");
    renderHarness({ storage });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Accessibility & settings" }));
    await user.click(screen.getByRole("button", { name: "Reset local game data" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/removes all Shouting Chickens settings/);
    await user.click(screen.getByRole("button", { name: "Confirm reset" }));

    expect(
      screen.getByRole("heading", { name: "Play with your voice—or without it" }),
    ).toBeVisible();
    expect(screen.getByText(/Local game data cleared/)).toBeVisible();
    expect(storage.keys()).toEqual(["unrelated.preference"]);
  });

  it("records a valid ended event once in local bests and ignores quit summaries", async () => {
    const storage = new MemoryStorage();
    const harness = renderHarness({ storage });
    await startRun(harness);
    const runtime = harness.runtime.runtimes[0]!;

    act(() => runtime.emit({ type: "ended", value: RUN_SUMMARY }));
    expect(screen.getByText("Local best: 42 · Finished runs: 1")).toBeVisible();
    expect(new LocalGameDataStore(storage).read().data.statistics).toMatchObject({
      bestDistance: 432,
      bestScore: 42,
      completedRuns: 1,
      longestSurvivalMs: 4_200,
    });

    act(() => runtime.emit({ type: "ended", value: RUN_SUMMARY }));
    act(() =>
      runtime.emit({
        type: "ended",
        value: runSummaryWithScore(99, 999),
      }),
    );
    expect(new LocalGameDataStore(storage).read().data.statistics).toMatchObject({
      bestScore: 42,
      completedRuns: 1,
    });

    act(() =>
      runtime.emit({
        type: "ended",
        value: { ...runSummaryWithScore(99, 999), reason: "quit" },
      }),
    );
    expect(new LocalGameDataStore(storage).read().data.statistics).toMatchObject({
      bestScore: 42,
      completedRuns: 1,
    });
  });

  it("keeps interaction events out of results and records only the matching ended run", async () => {
    const storage = new MemoryStorage();
    const harness = renderHarness({ storage });
    await startRun(harness);
    const runtime = harness.runtime.runtimes[0]!;

    act(() => {
      runtime.emit({
        type: "hazard-collision",
        value: { id: "0:moving-spike-intro:first-spike", kind: "moving-spike", tick: 42 },
      });
      runtime.emit({
        type: "collectible-collected",
        value: { id: "0:feather-path-intro:first-feather", kind: "feather", tick: 43 },
      });
    });

    expect(screen.getByTestId("game-surface")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Nice flight" })).toBeNull();
    expect(new LocalGameDataStore(storage).read().data.statistics).toEqual(
      defaultLocalGameData().statistics,
    );

    act(() => runtime.emit({ type: "ended", value: RUN_SUMMARY }));
    expect(screen.getByText("Local best: 42 · Finished runs: 1")).toBeVisible();
    expect(new LocalGameDataStore(storage).read().data.statistics).toMatchObject({
      bestScore: 42,
      completedRuns: 1,
    });
  });

  it("resets run identity for a fresh runtime after restart and return to ready", async () => {
    const storage = new MemoryStorage();
    const harness = renderHarness({ storage });
    const user = await startRun(harness);
    const firstRuntime = harness.runtime.runtimes[0]!;

    act(() => firstRuntime.emit({ type: "ended", value: RUN_SUMMARY }));
    await user.click(screen.getByRole("button", { name: "Restart run" }));
    act(() =>
      firstRuntime.emit({
        type: "ended",
        value: runSummaryWithScore(2, 50),
      }),
    );
    await user.click(screen.getByRole("button", { name: "Quit to ready screen" }));
    await user.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(harness.runtime.runtimes).toHaveLength(2));
    const freshRuntime = harness.runtime.runtimes[1]!;

    act(() =>
      freshRuntime.emit({
        type: "ended",
        value: runSummaryWithScore(1, 60),
      }),
    );

    expect(screen.getByRole("heading", { name: "Nice flight" })).toBeVisible();
    expect(new LocalGameDataStore(storage).read().data.statistics).toMatchObject({
      bestScore: 60,
      completedRuns: 3,
    });
  });

  it("realigns run identity when result settings remount the runtime", async () => {
    const storage = new MemoryStorage();
    const harness = renderHarness({ storage });
    const user = await startRun(harness, true);
    const firstRuntime = harness.runtime.runtimes[0]!;

    act(() => firstRuntime.emit({ type: "ended", value: RUN_SUMMARY }));
    await user.click(screen.getByRole("button", { name: "Restart run" }));
    act(() =>
      firstRuntime.emit({
        type: "ended",
        value: runSummaryWithScore(2, 50),
      }),
    );
    await user.click(screen.getByRole("button", { name: "Accessibility & settings" }));
    const threshold = screen.getByRole("slider", { name: "Voice jump threshold" });
    fireEvent.change(threshold, { target: { value: "72" } });
    await waitFor(() => expect(harness.runtime.runtimes).toHaveLength(2));
    const remountedRuntime = harness.runtime.runtimes[1]!;

    await user.click(screen.getByRole("button", { name: "Close settings" }));
    await user.click(screen.getByRole("button", { name: "Restart run" }));
    act(() =>
      remountedRuntime.emit({
        type: "ended",
        value: runSummaryWithScore(2, 60),
      }),
    );

    expect(screen.getByRole("heading", { name: "Nice flight" })).toBeVisible();
    expect(new LocalGameDataStore(storage).read().data.statistics).toMatchObject({
      bestScore: 60,
      completedRuns: 3,
    });
  });

  it("routes a new voice preference through permission instead of silently restarting fallback", async () => {
    const harness = renderHarness();
    const user = await startRun(harness);
    const runtime = harness.runtime.runtimes[0]!;
    act(() => runtime.emit({ type: "ended", value: RUN_SUMMARY }));

    await user.click(screen.getByRole("button", { name: "Accessibility & settings" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Preferred input" }), "voice");
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    await user.click(screen.getByRole("button", { name: "Restart run" }));

    expect(
      screen.getByRole("heading", { name: "Play with your voice—or without it" }),
    ).toBeVisible();
    expect(screen.getByText(/Voice is preferred/)).toBeVisible();
    expect(runtime.restart).not.toHaveBeenCalled();
  });

  it("guards ready-screen starts after a result changes the preference to inactive voice", async () => {
    const harness = renderHarness();
    const user = await startRun(harness);
    const runtime = harness.runtime.runtimes[0]!;
    act(() => runtime.emit({ type: "ended", value: RUN_SUMMARY }));

    await user.click(screen.getByRole("button", { name: "Accessibility & settings" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Preferred input" }), "voice");
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    await user.click(screen.getByRole("button", { name: "Quit to ready screen" }));
    await user.click(screen.getByRole("button", { name: "Start run" }));

    expect(
      screen.getByRole("heading", { name: "Play with your voice—or without it" }),
    ).toBeVisible();
    expect(screen.getByText(/Voice is preferred/)).toBeVisible();
    expect(runtime.restart).not.toHaveBeenCalled();
    expect(harness.runtime.runtimes).toHaveLength(1);
  });

  it("uses a saved derived calibration after a fresh permission gesture", async () => {
    const storage = new MemoryStorage();
    const initial = defaultLocalGameData();
    new LocalGameDataStore(storage).write({
      ...initial,
      calibration: PROFILE,
      settings: {
        ...initial.settings,
        controlPreference: "voice",
        copyVersion: CURRENT_COPY_VERSION,
      },
    });
    const harness = renderHarness({ storage });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Enable microphone" }));

    expect(await screen.findByRole("heading", { name: "Ready to run" })).toBeVisible();
    expect(harness.createCapture).not.toHaveBeenCalled();
    expect(harness.createVoice).toHaveBeenCalledWith(harness.session, PROFILE);
    expect(screen.getByText(/Microphone \+ fallback controls/)).toBeVisible();
  });

  it("announces corrupt persisted data recovery without blocking fallback play", () => {
    const storage = new MemoryStorage();
    storage.set(LOCAL_DATA_STORAGE_KEY, "{not-json");

    renderHarness({ storage });

    expect(
      screen.getByText(/Saved game data was unreadable, so safe defaults were restored/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Use keyboard or touch" })).toBeEnabled();
  });
});

function snapshotWith(
  microphoneStatus: MediaResourceStatus,
  issue?: MediaStateIssue,
  visibility: "visible" | "hidden" = "visible",
  resumeRequired = false,
): MediaSessionSnapshot {
  return {
    audioContext: microphoneStatus === "active" ? "running" : "none",
    camera: {
      canFallback: false,
      canRetry: false,
      ignoredPreferences: [],
      kind: "camera",
      status: "idle",
    },
    microphone: {
      canFallback: !["fallback", "closed", "requesting"].includes(microphoneStatus),
      canRetry: ["denied", "unavailable", "device-lost", "fallback"].includes(microphoneStatus),
      ignoredPreferences: [],
      issue,
      kind: "microphone",
      status: microphoneStatus,
    },
    resumeRequired,
    visibility,
  };
}

function captureSnapshot(
  overrides: Partial<CalibrationCaptureSnapshot> = {},
): CalibrationCaptureSnapshot {
  return {
    clip: { stage: null, status: "idle", url: null },
    completedStages: [],
    elapsedMs: 0,
    hasSignal: false,
    level: 0,
    progress: 0,
    quality: "weak",
    result: null,
    sampleCount: 0,
    stage: "quiet",
    status: "idle",
    targetDurationMs: 1_500,
    targetSamples: 12,
    ...overrides,
  };
}

function failure(
  code: "not-enough-samples" | "clipped" | "quiet-normal-range" | "normal-loud-range",
) {
  return {
    code,
    guidance: "Use a comfortable voice only—do not shout.",
    message: `Synthetic ${code} failure.`,
    ok: false as const,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}
