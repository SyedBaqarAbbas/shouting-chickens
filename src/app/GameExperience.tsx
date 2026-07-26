import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  SystemClock,
  type CalibrationProfile,
  type ControlMode,
  type GameEvent,
  type RunSummary,
  type VoiceFrame,
} from "../core";
import { createGameRuntime } from "../game/createGame";
import {
  BrowserCalibrationCapture,
  calibrationFailureMessage,
  type CalibrationCapture,
  type CalibrationCaptureSnapshot,
  type CalibrationStage,
} from "../input";
import { BrowserVoiceInputSource } from "../platform/audio";
import type { BrowserMediaSession, MediaSessionSnapshot } from "../platform/media";
import { CameraComposition } from "./CameraComposition";
import { GameSurface } from "./GameSurface";

type Screen =
  | "permission"
  | "calibration"
  | "media-setup"
  | "ready"
  | "countdown"
  | "playing"
  | "results"
  | "runtime-error";
type SetupScreen = "permission" | "calibration" | "ready";

export type VoiceInput = BrowserVoiceInputSource;

export interface GameExperienceProps {
  readonly countdownStepMs?: number;
  readonly createCalibrationCapture?: (session: BrowserMediaSession) => CalibrationCapture;
  readonly createRuntime?: typeof createGameRuntime;
  readonly createVoiceInput?: (
    session: BrowserMediaSession,
    profile: CalibrationProfile,
  ) => VoiceInput;
  readonly landscape: boolean;
  readonly session: BrowserMediaSession;
}

const STAGE_COPY: Record<
  CalibrationStage,
  { action: string; heading: string; instruction: string; next?: string }
> = {
  quiet: {
    action: "Capture quiet",
    heading: "1 of 3 · Quiet",
    instruction: "Stay comfortably quiet and let the microphone hear your room.",
    next: "Next: comfortable voice",
  },
  normal: {
    action: "Capture comfortable voice",
    heading: "2 of 3 · Comfortable voice",
    instruction: "Say “cluck” a few times in the voice you would normally use.",
    next: "Next: strong voice",
  },
  loud: {
    action: "Capture strong voice",
    heading: "3 of 3 · Strong voice",
    instruction: "Use a clear, strong voice—but never a painful shout.",
  },
};

function useMediaSnapshot(session: BrowserMediaSession): MediaSessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

function useCalibrationSnapshot(capture: CalibrationCapture): CalibrationCaptureSnapshot {
  return useSyncExternalStore(capture.subscribe, capture.getSnapshot, capture.getSnapshot);
}

function useFocusOnScreen(focusKey: string) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [focusKey]);

  return headingRef;
}

export function GameExperience({
  countdownStepMs = 1_000,
  createCalibrationCapture = (session) => new BrowserCalibrationCapture(session),
  createRuntime = createGameRuntime,
  createVoiceInput = (session, profile) =>
    new BrowserVoiceInputSource(session, new SystemClock(), profile),
  landscape,
  session,
}: GameExperienceProps) {
  const media = useMediaSnapshot(session);
  const [screen, setScreen] = useState<Screen>("permission");
  const [requestingMicrophone, setRequestingMicrophone] = useState(false);
  const [inputMode, setInputMode] = useState<ControlMode>("keyboard-touch");
  const [profile, setProfile] = useState<CalibrationProfile | null>(null);
  const [calibration, setCalibration] = useState<CalibrationCapture | null>(null);
  const [voiceInput, setVoiceInput] = useState<VoiceInput | null>(null);
  const [countdown, setCountdown] = useState(3);
  const [manualPaused, setManualPaused] = useState(false);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [restartToken, setRestartToken] = useState(0);
  const [runtimeError, setRuntimeError] = useState("");
  const [flowError, setFlowError] = useState("");
  const [voiceProcessingFailed, setVoiceProcessingFailed] = useState(false);
  const [liveStatus, setLiveStatus] = useState("Ready for onboarding.");
  const [testingVoice, setTestingVoice] = useState(false);
  const [testFrame, setTestFrame] = useState<VoiceFrame | null>(null);
  const [setupCalibrationRequired, setSetupCalibrationRequired] = useState(true);
  const operationGeneration = useRef(0);
  const countdownGeneration = useRef(0);
  const voiceTestGeneration = useRef(0);
  const setupReturnScreen = useRef<SetupScreen>("permission");
  const setupRequiresCalibration = useRef(true);
  const mounted = useRef(true);
  const calibrationRef = useRef<CalibrationCapture | null>(null);
  const voiceInputRef = useRef<VoiceInput | null>(null);
  const lastAnnouncement = useRef({
    atMs: Number.NEGATIVE_INFINITY,
    band: "",
    phase: "",
    second: -1,
  });

  useEffect(() => {
    calibrationRef.current = calibration;
    voiceInputRef.current = voiceInput;
  }, [calibration, voiceInput]);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      operationGeneration.current += 1;
      countdownGeneration.current += 1;
      voiceTestGeneration.current += 1;
      calibrationRef.current?.stop();
      voiceInputRef.current?.stop();
    };
  }, []);

  const beginCalibration = useCallback(
    async (generation: number) => {
      const nextCapture = createCalibrationCapture(session);

      try {
        await nextCapture.start();
      } catch {
        nextCapture.stop();
        if (mounted.current && generation === operationGeneration.current) {
          setFlowError(
            "Microphone processing could not start. Try again or use keyboard and touch.",
          );
        }
        return;
      }

      if (!mounted.current || generation !== operationGeneration.current) {
        nextCapture.stop();
        return;
      }

      calibration?.stop();
      setCalibration(nextCapture);
      setFlowError("");
      setScreen("calibration");
    },
    [calibration, createCalibrationCapture, session],
  );

  const requestMicrophone = useCallback(() => {
    if (requestingMicrophone) {
      return;
    }

    const generation = ++operationGeneration.current;
    setRequestingMicrophone(true);
    setFlowError("");

    let request: Promise<ReturnType<BrowserMediaSession["getSnapshot"]>["microphone"]>;
    try {
      request = session.requestMicrophoneFromGesture();
    } catch {
      setRequestingMicrophone(false);
      setFlowError("The browser did not accept the microphone request. Try again.");
      return;
    }

    void request.then(
      async (state) => {
        if (!mounted.current || generation !== operationGeneration.current) {
          return;
        }

        setRequestingMicrophone(false);
        if (state.status === "suspended") {
          setFlowError("");
          return;
        }
        if (state.status !== "active") {
          setFlowError(permissionFailureCopy(state.status));
          return;
        }

        await beginCalibration(generation);
      },
      () => {
        if (mounted.current && generation === operationGeneration.current) {
          setRequestingMicrophone(false);
          setFlowError("Microphone access failed. Try again or use keyboard and touch.");
        }
      },
    );
  }, [beginCalibration, requestingMicrophone, session]);

  useEffect(() => {
    if (!isSetupMicrophoneInterruption(screen, inputMode, media.microphone.status)) {
      return;
    }

    setupReturnScreen.current = screen;
    const requiresCalibration = screen !== "ready" || media.microphone.status !== "suspended";
    setupRequiresCalibration.current = requiresCalibration;
    operationGeneration.current += 1;
    voiceTestGeneration.current += 1;
    if (screen === "calibration") {
      calibration?.stop();
    }
    if (screen === "ready") {
      voiceInput?.stop();
    }

    queueMicrotask(() => {
      if (
        !mounted.current ||
        !isSetupMicrophoneInterruption(screen, inputMode, media.microphone.status)
      ) {
        return;
      }

      setRequestingMicrophone(false);
      setTestingVoice(false);
      setTestFrame(null);
      setSetupCalibrationRequired(requiresCalibration);
      if (screen === "calibration") {
        setCalibration(null);
      }
      if (screen === "ready" && setupRequiresCalibration.current) {
        setProfile(null);
        setVoiceInput(null);
      }
      setFlowError("");
      setScreen("media-setup");
    });
  }, [calibration, inputMode, media.microphone.status, screen, voiceInput]);

  useEffect(() => {
    if (screen !== "media-setup" || media.microphone.status !== "active") {
      return;
    }

    const generation = ++operationGeneration.current;
    const destination = setupReturnScreen.current;
    queueMicrotask(() => {
      if (!mounted.current || generation !== operationGeneration.current) {
        return;
      }

      setRequestingMicrophone(false);
      setFlowError("");
      if (destination === "ready" && !setupRequiresCalibration.current) {
        setScreen("ready");
      } else {
        void beginCalibration(generation);
      }
    });
  }, [beginCalibration, media.microphone.status, screen]);

  const chooseFallback = useCallback(() => {
    ++operationGeneration.current;
    ++countdownGeneration.current;
    ++voiceTestGeneration.current;
    calibration?.stop();
    voiceInput?.stop();
    setCalibration(null);
    setVoiceInput(null);
    setProfile(null);
    setInputMode("keyboard-touch");
    setTestingVoice(false);
    setTestFrame(null);
    setRequestingMicrophone(false);
    setManualPaused(false);
    setVoiceProcessingFailed(false);
    setFlowError("");
    setupReturnScreen.current = "permission";
    setupRequiresCalibration.current = true;
    setSetupCalibrationRequired(true);

    let fallback: Promise<void>;
    try {
      fallback = session.useFallbackInput();
    } catch {
      fallback = Promise.resolve();
    }
    void fallback.catch(() => undefined);
    setScreen("ready");
  }, [calibration, session, voiceInput]);

  const resumeSetupMicrophone = useCallback(() => {
    if (requestingMicrophone) {
      return;
    }

    const generation = ++operationGeneration.current;
    setRequestingMicrophone(true);
    setFlowError("");
    let recovery: Promise<MediaSessionSnapshot | MediaSessionSnapshot["microphone"]>;
    try {
      recovery =
        media.resumeRequired || media.microphone.status === "suspended"
          ? session.resumeFromGesture()
          : session.requestMicrophoneFromGesture();
    } catch {
      setRequestingMicrophone(false);
      setFlowError("The microphone is still paused. Try again or use fallback controls.");
      return;
    }

    void recovery.then(
      (result) => {
        if (!mounted.current || generation !== operationGeneration.current) {
          return;
        }

        setRequestingMicrophone(false);
        const microphone = "microphone" in result ? result.microphone : result;
        if (microphone.status !== "active") {
          setFlowError(
            microphone.issue === "track-muted"
              ? "Unmute the microphone in the browser or operating system, or use fallback controls."
              : permissionFailureCopy(microphone.status),
          );
        }
      },
      () => {
        if (mounted.current && generation === operationGeneration.current) {
          setRequestingMicrophone(false);
          setFlowError("The microphone is still paused. Try again or use fallback controls.");
        }
      },
    );
  }, [media.microphone.status, media.resumeRequired, requestingMicrophone, session]);

  const continueRunWithFallback = useCallback(() => {
    ++operationGeneration.current;
    ++voiceTestGeneration.current;
    voiceInput?.stop();
    setInputMode("keyboard-touch");
    setVoiceProcessingFailed(false);
    setTestingVoice(false);
    setTestFrame(null);
    setFlowError("");

    try {
      void session.useFallbackInput().catch(() => undefined);
    } catch {
      // Keyboard and touch are already active and independent of media cleanup.
    }
  }, [session, voiceInput]);

  const completeCalibration = useCallback(
    (nextProfile: CalibrationProfile) => {
      const generation = ++operationGeneration.current;
      ++voiceTestGeneration.current;
      calibration?.stop();
      setCalibration(null);
      voiceInput?.stop();

      if (!mounted.current || generation !== operationGeneration.current) {
        return;
      }

      const nextVoiceInput = createVoiceInput(session, nextProfile);
      setProfile(nextProfile);
      setVoiceInput(nextVoiceInput);
      setInputMode("voice");
      setVoiceProcessingFailed(false);
      setFlowError("");
      setScreen("ready");
    },
    [calibration, createVoiceInput, session, voiceInput],
  );

  const recalibrate = useCallback(() => {
    const generation = ++operationGeneration.current;
    ++voiceTestGeneration.current;
    voiceInput?.stop();
    setVoiceInput(null);
    setTestingVoice(false);
    void beginCalibration(generation);
  }, [beginCalibration, voiceInput]);

  const toggleVoiceTest = useCallback(() => {
    if (!voiceInput) {
      return;
    }

    if (testingVoice) {
      ++voiceTestGeneration.current;
      voiceInput.stop();
      setTestingVoice(false);
      setTestFrame(null);
      return;
    }

    const generation = ++voiceTestGeneration.current;
    setFlowError("");
    let start: Promise<void>;
    try {
      start = voiceInput.start();
    } catch {
      setFlowError("Voice input could not start. Recalibrate or use keyboard and touch.");
      return;
    }
    void start.then(
      () => {
        if (mounted.current && generation === voiceTestGeneration.current) {
          setTestingVoice(true);
        }
      },
      () => {
        if (mounted.current && generation === voiceTestGeneration.current) {
          setFlowError("Voice input could not start. Recalibrate or use keyboard and touch.");
        }
      },
    );
  }, [testingVoice, voiceInput]);

  useEffect(() => {
    if (!testingVoice || !voiceInput) {
      return;
    }

    const interval = window.setInterval(() => {
      setTestFrame(voiceInput.getLatestVoiceFrame());
    }, 200);
    return () => {
      window.clearInterval(interval);
    };
  }, [testingVoice, voiceInput]);

  const startCountdown = useCallback(() => {
    ++voiceTestGeneration.current;
    voiceInput?.stop();
    setTestingVoice(false);
    setTestFrame(null);
    setFlowError("");
    setCountdown(3);
    setScreen("countdown");
  }, [voiceInput]);

  useEffect(() => {
    if (screen !== "countdown") {
      return;
    }

    const generation = ++countdownGeneration.current;
    const interval = window.setInterval(() => {
      if (
        generation !== countdownGeneration.current ||
        landscape ||
        session.getSnapshot().visibility === "hidden"
      ) {
        return;
      }

      setCountdown((current) => {
        if (current > 1) {
          return current - 1;
        }

        window.clearInterval(interval);
        if (generation === countdownGeneration.current) {
          setScreen("playing");
          setLiveStatus("Run started.");
        }
        return 0;
      });
    }, countdownStepMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [countdownStepMs, landscape, screen, session]);

  useEffect(() => {
    if (
      screen === "countdown" &&
      (landscape ||
        media.visibility === "hidden" ||
        (inputMode === "voice" && media.microphone.status !== "active"))
    ) {
      const generation = ++countdownGeneration.current;
      queueMicrotask(() => {
        if (mounted.current && generation === countdownGeneration.current) {
          setScreen("ready");
          setFlowError("Countdown cancelled while the game was paused. Start again when ready.");
        }
      });
    }
  }, [inputMode, landscape, media.microphone.status, media.visibility, screen]);

  const mediaPause =
    inputMode === "voice" &&
    screen === "playing" &&
    (media.microphone.status !== "active" || media.resumeRequired || voiceProcessingFailed);
  const screenHeadingRef = useFocusOnScreen(
    `${screen}:${manualPaused ? "manual" : mediaPause ? "media" : "base"}`,
  );

  const pauseReasons = useMemo(() => {
    const reasons = new Set<string>();
    if (manualPaused) {
      reasons.add("manual");
    }
    if (landscape) {
      reasons.add("landscape");
    }
    if (media.visibility === "hidden") {
      reasons.add("hidden");
    }
    if (mediaPause) {
      reasons.add("media");
    }
    return reasons;
  }, [landscape, manualPaused, media.visibility, mediaPause]);

  const handleGameEvent = useCallback((event: GameEvent) => {
    if (event.type === "fatal-error") {
      setRuntimeError(event.error.message);
      setScreen("runtime-error");
      return;
    }

    if (event.type === "ended") {
      setSummary(event.value);
      setScreen("results");
      setLiveStatus(`Run ended. Survived ${(event.value.survivalMs / 1_000).toFixed(1)} seconds.`);
      return;
    }

    const second = Math.floor(event.value.elapsedMs / 1_000);
    const band =
      event.value.normalizedInput < 0.15
        ? "quiet"
        : event.value.normalizedInput < 0.7
          ? "active"
          : "strong";
    const bandCanAnnounce =
      band !== lastAnnouncement.current.band &&
      event.value.elapsedMs - lastAnnouncement.current.atMs >= 1_000;
    const phaseChanged = event.value.phase !== lastAnnouncement.current.phase;
    if (second !== lastAnnouncement.current.second || bandCanAnnounce || phaseChanged) {
      lastAnnouncement.current = {
        atMs: event.value.elapsedMs,
        band,
        phase: event.value.phase,
        second,
      };
      setLiveStatus(
        `${event.value.phase}. ${second} seconds. Input ${band}. Score ${event.value.score}.`,
      );
    }
  }, []);

  const retryInterruptedMicrophone = useCallback(() => {
    const generation = ++operationGeneration.current;
    setFlowError("");

    let request: ReturnType<BrowserMediaSession["requestMicrophoneFromGesture"]>;
    try {
      request = session.requestMicrophoneFromGesture();
    } catch {
      setFlowError("The microphone could not be retried. Use keyboard and touch instead.");
      return;
    }
    void request.then(
      async (state) => {
        if (
          !mounted.current ||
          generation !== operationGeneration.current ||
          state.status !== "active"
        ) {
          if (mounted.current && generation === operationGeneration.current) {
            setFlowError(permissionFailureCopy(state.status));
          }
          return;
        }

        try {
          await voiceInput?.start();
          if (mounted.current && generation === operationGeneration.current) {
            setVoiceProcessingFailed(false);
          }
        } catch {
          if (mounted.current && generation === operationGeneration.current) {
            setFlowError("Voice processing could not resume. Use keyboard and touch instead.");
          }
        }
      },
      () => {
        if (mounted.current && generation === operationGeneration.current) {
          setFlowError("The microphone could not be retried. Use keyboard and touch instead.");
        }
      },
    );
  }, [session, voiceInput]);

  const resumeMedia = useCallback(() => {
    const generation = ++operationGeneration.current;
    setFlowError("");
    let resume: ReturnType<BrowserMediaSession["resumeFromGesture"]>;
    try {
      resume = session.resumeFromGesture();
    } catch {
      setFlowError("The microphone is still paused. Try again from this button.");
      return;
    }
    void resume.then(
      (snapshot) => {
        if (
          mounted.current &&
          generation === operationGeneration.current &&
          snapshot.microphone.status !== "active"
        ) {
          setFlowError("The microphone is still paused. Try again or use fallback controls.");
        }
      },
      () => {
        if (mounted.current && generation === operationGeneration.current) {
          setFlowError("The microphone is still paused. Try again or use fallback controls.");
        }
      },
    );
  }, [session]);

  const restartRun = useCallback(() => {
    setSummary(null);
    setManualPaused(false);
    setRestartToken((value) => value + 1);
    lastAnnouncement.current = {
      atMs: Number.NEGATIVE_INFINITY,
      band: "",
      phase: "",
      second: -1,
    };
    setScreen("playing");
    setLiveStatus("Run restarted.");
  }, []);

  const quitToReady = useCallback(() => {
    setSummary(null);
    setManualPaused(false);
    setRuntimeError("");
    setScreen("ready");
  }, []);

  const keepGameMounted =
    screen === "playing" || screen === "results" || screen === "runtime-error";
  const gameBlocked = screen !== "playing" || pauseReasons.size > 0;

  return (
    <>
      <CameraComposition
        session={session}
        hidden={landscape || screen !== "playing" || pauseReasons.size > 0}
      />

      <header className="game-heading" aria-hidden={screen === "playing" ? undefined : true}>
        <p className="eyebrow">Voice-controlled platformer</p>
        <h1 id="game-title">Shouting Chickens</h1>
      </header>

      {keepGameMounted ? (
        <GameSurface
          activeInput={inputMode}
          blocked={gameBlocked}
          calibration={profile}
          createRuntime={createRuntime}
          landscape={landscape}
          onEvent={handleGameEvent}
          onVoiceUnavailable={() => {
            setVoiceProcessingFailed(true);
            setFlowError("Voice input stopped. The run is paused; retry or use fallback controls.");
          }}
          pauseReasons={pauseReasons}
          restartToken={restartToken}
          voiceInput={voiceInput}
        />
      ) : null}

      {screen === "permission" ? (
        <section className="flow-card" aria-labelledby="permission-title">
          <p className="flow-step">First-time setup</p>
          <h2 id="permission-title" ref={screenHeadingRef} tabIndex={-1}>
            Play with your voice—or without it
          </h2>
          <p>
            The microphone turns comfortable voice pulses into jumps and lift. Audio stays on this
            device and is never uploaded. Calibration can keep one brief recording in this tab so
            you can play it back before continuing.
          </p>
          <p className="safe-copy">
            You never need to scream. We calibrate to your comfortable range.
          </p>
          {flowError || media.microphone.status === "unsupported" ? (
            <p className="flow-alert" role="alert">
              {flowError || permissionFailureCopy("unsupported")}
            </p>
          ) : null}
          <div className="flow-actions">
            <button
              type="button"
              className="primary-action"
              onClick={requestMicrophone}
              disabled={requestingMicrophone || media.microphone.status === "unsupported"}
            >
              {media.microphone.status === "unsupported"
                ? "Microphone unavailable"
                : requestingMicrophone
                  ? "Checking microphone…"
                  : media.microphone.status === "denied" ||
                      media.microphone.status === "unavailable"
                    ? "Try microphone again"
                    : "Enable microphone"}
            </button>
            <button type="button" className="secondary-action" onClick={chooseFallback}>
              Use keyboard or touch
            </button>
          </div>
          <p className="control-help">Fallback: press Space / ↑, or tap and hold the playfield.</p>
        </section>
      ) : null}

      {screen === "media-setup" ? (
        <section className="flow-card" aria-labelledby="setup-media-title">
          <p className="flow-step">Microphone paused</p>
          <h2 id="setup-media-title" ref={screenHeadingRef} tabIndex={-1}>
            Resume microphone setup
          </h2>
          <p>{mediaInterruptionCopy(media)}</p>
          <p className="safe-copy">
            {setupCalibrationRequired
              ? "Calibration is discarded while input is interrupted, so disabled-track samples or a changed device cannot set your controls."
              : "Voice processing stopped safely. Your calibration remains ready after microphone audio resumes."}
          </p>
          {flowError ? (
            <p className="flow-alert" role="alert">
              {flowError}
            </p>
          ) : null}
          <div className="flow-actions">
            <button
              type="button"
              className="primary-action"
              onClick={resumeSetupMicrophone}
              disabled={requestingMicrophone}
            >
              {requestingMicrophone
                ? "Checking microphone…"
                : media.resumeRequired
                  ? "Resume microphone"
                  : "Check microphone again"}
            </button>
            <button type="button" className="secondary-action" onClick={chooseFallback}>
              Use keyboard or touch
            </button>
          </div>
        </section>
      ) : null}

      {screen === "calibration" && calibration ? (
        <CalibrationPanel
          capture={calibration}
          headingRef={screenHeadingRef}
          onComplete={completeCalibration}
          onFallback={chooseFallback}
        />
      ) : null}

      {screen === "ready" ? (
        <section className="flow-card" aria-labelledby="ready-title">
          <p className="flow-step">Setup complete</p>
          <h2 id="ready-title" ref={screenHeadingRef} tabIndex={-1}>
            Ready to run
          </h2>
          <p>
            Active input:{" "}
            <strong>
              {inputMode === "voice" ? "Microphone + fallback controls" : "Keyboard + touch"}
            </strong>
          </p>
          {flowError ? (
            <p className="flow-alert" role="alert">
              {flowError}
            </p>
          ) : null}
          {inputMode === "voice" && voiceInput ? (
            <div className="voice-test">
              <button type="button" className="secondary-action" onClick={toggleVoiceTest}>
                {testingVoice ? "Stop voice test" : "Test your voice"}
              </button>
              <p aria-live="polite">
                {testingVoice
                  ? voiceTestCopy(testFrame)
                  : "Voice test is off. Testing does not start the run."}
              </p>
            </div>
          ) : null}
          <div className="flow-actions">
            <button type="button" className="primary-action" onClick={startCountdown}>
              Start run
            </button>
            {inputMode === "voice" ? (
              <button type="button" className="secondary-action" onClick={recalibrate}>
                Recalibrate
              </button>
            ) : (
              <button type="button" className="secondary-action" onClick={requestMicrophone}>
                Set up microphone
              </button>
            )}
          </div>
        </section>
      ) : null}

      {screen === "countdown" ? (
        <section className="flow-card flow-card--countdown" aria-labelledby="countdown-title">
          <p className="flow-step">Run starting</p>
          <h2 id="countdown-title" ref={screenHeadingRef} tabIndex={-1}>
            Get ready
          </h2>
          <output className="countdown-number" aria-live="assertive">
            {countdown}
          </output>
          <p>
            {inputMode === "voice"
              ? "A comfortable pulse jumps. Hold your voice briefly for lift."
              : "Press Space / ↑ or tap. Hold briefly for lift."}
          </p>
          <button
            type="button"
            className="secondary-action"
            onClick={() => {
              ++countdownGeneration.current;
              setScreen("ready");
            }}
          >
            Cancel
          </button>
        </section>
      ) : null}

      {screen === "playing" && pauseReasons.size === 0 ? (
        <div className="play-controls">
          <button
            type="button"
            className="pause-button"
            onClick={() => setManualPaused(true)}
            aria-label="Pause run"
          >
            <span aria-hidden="true">Ⅱ</span> Pause
          </button>
        </div>
      ) : null}

      {screen === "playing" && manualPaused ? (
        <section className="flow-card flow-card--modal" role="dialog" aria-labelledby="pause-title">
          <p className="flow-step">Run paused</p>
          <h2 id="pause-title" ref={screenHeadingRef} tabIndex={-1}>
            Take a breath
          </h2>
          <p>
            The timer and course are frozen. Other pause reasons must also clear before play
            resumes.
          </p>
          <button type="button" className="primary-action" onClick={() => setManualPaused(false)}>
            Resume run
          </button>
        </section>
      ) : null}

      {screen === "playing" && mediaPause && !manualPaused ? (
        <section className="flow-card flow-card--modal" role="dialog" aria-labelledby="media-title">
          <p className="flow-step">Input paused</p>
          <h2 id="media-title" ref={screenHeadingRef} tabIndex={-1}>
            Microphone needs attention
          </h2>
          <p>{mediaInterruptionCopy(media)}</p>
          {flowError ? (
            <p className="flow-alert" role="alert">
              {flowError}
            </p>
          ) : null}
          <div className="flow-actions">
            {media.resumeRequired && !voiceProcessingFailed ? (
              <button type="button" className="primary-action" onClick={resumeMedia}>
                Resume microphone
              </button>
            ) : (
              <button type="button" className="primary-action" onClick={retryInterruptedMicrophone}>
                Try microphone again
              </button>
            )}
            <button type="button" className="secondary-action" onClick={continueRunWithFallback}>
              Continue with keyboard or touch
            </button>
          </div>
        </section>
      ) : null}

      {screen === "results" && summary ? (
        <section
          className="flow-card flow-card--modal"
          role="dialog"
          aria-labelledby="results-title"
        >
          <p className="flow-step">Run complete</p>
          <h2 id="results-title" ref={screenHeadingRef} tabIndex={-1}>
            Nice flight
          </h2>
          <dl className="results-grid">
            <div>
              <dt>Survived</dt>
              <dd>{(summary.survivalMs / 1_000).toFixed(1)}s</dd>
            </div>
            <div>
              <dt>Score</dt>
              <dd>{summary.score}</dd>
            </div>
            <div>
              <dt>Ended by</dt>
              <dd>{summary.reason}</dd>
            </div>
          </dl>
          <div className="flow-actions">
            <button type="button" className="primary-action" onClick={restartRun}>
              Restart run
            </button>
            <button type="button" className="secondary-action" onClick={quitToReady}>
              Quit to ready screen
            </button>
          </div>
        </section>
      ) : null}

      {screen === "runtime-error" ? (
        <section className="flow-card flow-card--modal" role="alert" aria-labelledby="error-title">
          <p className="flow-step">Game error</p>
          <h2 id="error-title" ref={screenHeadingRef} tabIndex={-1}>
            The course could not start
          </h2>
          <p>{runtimeError || "The game renderer stopped unexpectedly."}</p>
          <button type="button" className="primary-action" onClick={quitToReady}>
            Return to ready screen
          </button>
        </section>
      ) : null}

      <p className="accessible-game-status" role="status" aria-live="polite">
        {liveStatus}
      </p>

      <footer className="bootstrap-note">
        <span className="status-dot" aria-hidden="true" />
        <span>
          {inputMode === "voice" ? "Microphone + fallback ready" : "Keyboard + touch ready"}
        </span>
      </footer>
    </>
  );
}

interface CalibrationPanelProps {
  readonly capture: CalibrationCapture;
  readonly headingRef: React.RefObject<HTMLHeadingElement | null>;
  readonly onComplete: (profile: CalibrationProfile) => void;
  readonly onFallback: () => void;
}

function CalibrationPanel({ capture, headingRef, onComplete, onFallback }: CalibrationPanelProps) {
  const snapshot = useCalibrationSnapshot(capture);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playbackGeneration = useRef(0);
  const playbackRequested = useRef(false);
  const [playingClip, setPlayingClip] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const copy = STAGE_COPY[snapshot.stage];
  const activity = activityLabel(snapshot.level);
  const clipPending = snapshot.clip.status === "recording" || snapshot.clip.status === "processing";
  const canReviewClip =
    snapshot.stage !== "quiet" &&
    (snapshot.status === "stage-complete" ||
      snapshot.status === "complete" ||
      snapshot.status === "failed") &&
    snapshot.clip.stage === snapshot.stage;

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      playbackGeneration.current += 1;
      if (audio && (playbackRequested.current || !audio.paused)) {
        audio.pause();
      }
      playbackRequested.current = false;
    };
  }, [snapshot.clip.url]);

  const stopPlayback = () => {
    playbackGeneration.current += 1;
    const audio = audioRef.current;
    if (audio) {
      if (playbackRequested.current || playingClip || !audio.paused) {
        audio.pause();
      }
      audio.currentTime = 0;
    }
    playbackRequested.current = false;
    setPlayingClip(false);
  };

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (playingClip) {
      stopPlayback();
      return;
    }

    setPlaybackError("");
    audio.currentTime = 0;
    const generation = ++playbackGeneration.current;
    playbackRequested.current = true;
    void audio.play().then(
      () => {
        if (generation === playbackGeneration.current) {
          setPlayingClip(true);
        }
      },
      () => {
        if (generation === playbackGeneration.current) {
          playbackRequested.current = false;
          setPlayingClip(false);
          setPlaybackError("This browser could not play the calibration clip.");
        }
      },
    );
  };

  const beginCurrentOrNext = () => {
    stopPlayback();
    setPlaybackError("");
    if (snapshot.status === "stage-complete") {
      const next =
        snapshot.stage === "quiet" ? "normal" : snapshot.stage === "normal" ? "loud" : null;
      if (next) {
        capture.beginStage(next);
      }
      return;
    }

    capture.beginStage(snapshot.stage);
  };

  const useCalibration = () => {
    if (!snapshot.result?.ok) {
      return;
    }
    stopPlayback();
    onComplete(snapshot.result.profile);
  };

  return (
    <section className="flow-card flow-card--calibration" aria-labelledby="calibration-title">
      <p className="flow-step">Voice calibration</p>
      <h2 id="calibration-title" ref={headingRef} tabIndex={-1}>
        Calibrate your comfortable range
      </h2>
      <ol className="calibration-steps" aria-label="Calibration steps">
        {(["quiet", "normal", "loud"] as const).map((stage, index) => (
          <li
            key={stage}
            className={
              snapshot.completedStages.includes(stage)
                ? "calibration-step calibration-step--complete"
                : snapshot.stage === stage
                  ? "calibration-step calibration-step--current"
                  : "calibration-step"
            }
            aria-current={snapshot.stage === stage ? "step" : undefined}
          >
            <span aria-hidden="true">
              {snapshot.completedStages.includes(stage) ? "✓" : index + 1}
            </span>
            {stage === "quiet" ? "Quiet" : stage === "normal" ? "Comfortable" : "Strong"}
          </li>
        ))}
      </ol>
      <h3>{copy.heading}</h3>
      <p>{copy.instruction}</p>
      <p className="safe-copy">Never force your voice or use a painful shout.</p>

      <div className="calibration-meter">
        <div
          className={`calibration-microphone calibration-microphone--${activity.toLowerCase()}`}
          aria-hidden="true"
        >
          <svg viewBox="0 0 32 32" focusable="false">
            <rect x="11" y="3" width="10" height="17" rx="5" />
            <path d="M7 15v1a9 9 0 0 0 18 0v-1M16 25v4M11 29h10" />
          </svg>
        </div>
        <span className="calibration-mic-status" role="status">
          {microphoneStatusCopy(snapshot)}
        </span>
        <meter
          aria-label="Live microphone activity"
          aria-valuetext={activity}
          min={0}
          max={1}
          low={0.15}
          high={0.75}
          optimum={0.5}
          value={snapshot.level}
        />
        <div className="calibration-progress-label">
          <span>Capture progress</span>
          <span>{Math.round(snapshot.progress * 100)}%</span>
        </div>
        <progress
          aria-label={`${snapshot.stage} calibration progress`}
          max={1}
          value={snapshot.progress}
        />
      </div>

      {snapshot.result && !snapshot.result.ok ? (
        <p className="flow-alert" role="alert">
          {calibrationFailureMessage(snapshot.result)}
        </p>
      ) : null}

      {canReviewClip ? (
        <div className="calibration-playback">
          <audio
            ref={audioRef}
            src={snapshot.clip.url ?? undefined}
            onEnded={() => {
              playbackGeneration.current += 1;
              playbackRequested.current = false;
              setPlayingClip(false);
            }}
            preload="metadata"
          />
          {snapshot.clip.status === "ready" && snapshot.clip.url ? (
            <button type="button" className="secondary-action" onClick={togglePlayback}>
              {playingClip ? "Stop playback" : "Play recorded voice"}
            </button>
          ) : snapshot.clip.status === "processing" ? (
            <p role="status">Preparing your private playback…</p>
          ) : snapshot.clip.status === "unavailable" || snapshot.clip.status === "failed" ? (
            <p>Playback is unavailable here. The live meter still calibrated your voice.</p>
          ) : null}
          {playbackError ? (
            <p className="flow-alert" role="alert">
              {playbackError}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flow-actions">
        {snapshot.status === "failed" ? (
          <button
            type="button"
            className="primary-action"
            onClick={() => {
              stopPlayback();
              setPlaybackError("");
              capture.beginStage(snapshot.stage);
            }}
          >
            Retry{" "}
            {snapshot.stage === "quiet"
              ? "quiet"
              : snapshot.stage === "normal"
                ? "comfortable voice"
                : "strong voice"}
          </button>
        ) : snapshot.status === "complete" ? (
          <button
            type="button"
            className="primary-action"
            onClick={useCalibration}
            disabled={clipPending}
          >
            {clipPending ? "Preparing playback…" : "Use this calibration"}
          </button>
        ) : (
          <button
            type="button"
            className="primary-action"
            onClick={beginCurrentOrNext}
            disabled={snapshot.status === "capturing" || clipPending}
          >
            {snapshot.status === "capturing"
              ? `Recording… ${Math.round(snapshot.progress * 100)}%`
              : snapshot.status === "stage-complete"
                ? clipPending
                  ? "Preparing playback…"
                  : copy.next
                : copy.action}
          </button>
        )}
        <button
          type="button"
          className="secondary-action"
          onClick={() => {
            stopPlayback();
            onFallback();
          }}
        >
          Use keyboard or touch
        </button>
      </div>
    </section>
  );
}

function permissionFailureCopy(status: MediaSessionSnapshot["microphone"]["status"]): string {
  if (status === "denied") {
    return "Microphone permission was denied. Change the browser permission and retry, or use fallback controls.";
  }
  if (status === "unsupported") {
    return "This browser cannot provide microphone input here. Keyboard and touch still work.";
  }
  if (status === "suspended") {
    return "Microphone audio is paused. Resume it from the visible button, or use fallback controls.";
  }
  return "No usable microphone is available. Check the device and retry, or use fallback controls.";
}

function isSetupScreen(screen: Screen): screen is SetupScreen {
  return screen === "permission" || screen === "calibration" || screen === "ready";
}

function isSetupMicrophoneInterruption(
  screen: Screen,
  inputMode: ControlMode,
  status: MediaSessionSnapshot["microphone"]["status"],
): screen is SetupScreen {
  if (!isSetupScreen(screen) || status === "active" || status === "requesting") {
    return false;
  }

  if (screen === "permission") {
    return status === "suspended";
  }

  return screen === "calibration" || inputMode === "voice";
}

function mediaInterruptionCopy(media: MediaSessionSnapshot): string {
  if (media.resumeRequired) {
    return "The browser suspended microphone audio. Resume it from this button to continue.";
  }
  if (media.microphone.status === "device-lost") {
    return "The active microphone disconnected. Reconnect it and retry, or continue with fallback controls.";
  }
  if (media.microphone.issue === "track-muted") {
    return "The microphone was muted by the browser or operating system.";
  }
  return "Voice input is unavailable. Retry the microphone or continue with fallback controls.";
}

function qualityLabel(quality: CalibrationCaptureSnapshot["quality"]): string {
  switch (quality) {
    case "weak":
      return "Weak";
    case "good":
      return "Good";
    case "clipped":
      return "Clipped";
  }
}

function activityLabel(level: number): "Quiet" | "Low" | "Medium" | "Strong" {
  if (level < 0.08) {
    return "Quiet";
  }
  if (level < 0.35) {
    return "Low";
  }
  if (level < 0.72) {
    return "Medium";
  }
  return "Strong";
}

function microphoneStatusCopy(snapshot: CalibrationCaptureSnapshot): string {
  if (snapshot.status === "capturing") {
    return `Microphone recording ${snapshot.stage === "quiet" ? "room sound" : snapshot.stage === "normal" ? "your comfortable voice" : "your strong voice"}.`;
  }
  if (snapshot.status === "failed") {
    return "Microphone active. Only this step needs another try.";
  }
  if (snapshot.status === "stage-complete" || snapshot.status === "complete") {
    return "Capture complete. Microphone is still active.";
  }
  return snapshot.hasSignal
    ? "Microphone active. The meter is responding."
    : "Microphone active. Make a comfortable sound to check the meter.";
}

function voiceTestCopy(frame: VoiceFrame | null): string {
  if (!frame) {
    return "Listening… Make a comfortable voice pulse.";
  }

  return `Signal quality: ${qualityLabel(frame.signalQuality)}. Input ${Math.round(
    frame.normalizedLevel * 100,
  )}%.`;
}
