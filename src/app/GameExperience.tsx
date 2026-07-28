import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  SystemClock,
  type CalibrationProfile,
  type ControlMode,
  type GameEvent,
  type KeyValueStorage,
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
import {
  CURRENT_COPY_VERSION,
  MAX_MANUAL_THRESHOLD,
  MIN_MANUAL_THRESHOLD,
  LocalGameDataStore,
  createBrowserLocalGameDataStore,
  isValidCompletedLocalRun,
  withManualJumpThreshold,
  type GameSettings,
  type LocalGameData,
} from "../platform/persistence";
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
  | "settings"
  | "runtime-error";
type SetupScreen = "permission" | "calibration" | "ready";
type SettingsReturnScreen = "permission" | "ready" | "playing" | "results";

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
  readonly onPwaUpdateHostChange?: (host: HTMLElement | null) => void;
  readonly onRunActivityChange?: (active: boolean) => void;
  readonly session: BrowserMediaSession;
  readonly storage?: KeyValueStorage;
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
  onPwaUpdateHostChange,
  onRunActivityChange,
  session,
  storage,
}: GameExperienceProps) {
  const localDataStore = useMemo(
    () => (storage ? new LocalGameDataStore(storage) : createBrowserLocalGameDataStore()),
    [storage],
  );
  const initialLocalData = useMemo(() => localDataStore.read(), [localDataStore]);
  const media = useMediaSnapshot(session);
  const [screen, setScreen] = useState<Screen>(() =>
    initialScreenForLocalData(initialLocalData.data),
  );
  const [requestingMicrophone, setRequestingMicrophone] = useState(false);
  const [inputMode, setInputMode] = useState<ControlMode>(
    initialLocalData.data.settings.controlPreference,
  );
  const [profile, setProfile] = useState<CalibrationProfile | null>(
    initialLocalData.data.calibration,
  );
  const [localData, setLocalData] = useState<LocalGameData>(initialLocalData.data);
  const [storageNotice, setStorageNotice] = useState(
    initialLocalData.recovered
      ? "Saved game data was unreadable, so safe defaults were restored."
      : "",
  );
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
  const [settingsReturnScreen, setSettingsReturnScreen] =
    useState<SettingsReturnScreen>("permission");
  const settingsFocusLabel = useRef("");
  const restoreSettingsFocus = useRef(false);
  const flowDialogRef = useRef<HTMLElement>(null);
  const restorePauseFocus = useRef(false);
  const expectedRunId = useRef(1);
  const recordedRunId = useRef<number | null>(null);
  const setupRequiresCalibration = useRef(true);
  const mounted = useRef(true);
  const calibrationRef = useRef<CalibrationCapture | null>(null);
  const voiceInputRef = useRef<VoiceInput | null>(null);
  const localDataRef = useRef(initialLocalData.data);
  const lastAnnouncement = useRef({
    atMs: Number.NEGATIVE_INFINITY,
    band: "",
    phase: "",
    second: -1,
  });

  const commitLocalData = useCallback(
    (next: LocalGameData) => {
      const saved = localDataStore.write(next);
      localDataRef.current = saved;
      setLocalData(saved);
      return saved;
    },
    [localDataStore],
  );

  const updateSettings = useCallback(
    (patch: Partial<GameSettings>) =>
      commitLocalData({
        ...localDataRef.current,
        settings: {
          ...localDataRef.current.settings,
          ...patch,
        },
      }),
    [commitLocalData],
  );

  const saveCalibration = useCallback(
    (nextProfile: CalibrationProfile | null) =>
      commitLocalData({
        ...localDataRef.current,
        calibration: nextProfile,
      }),
    [commitLocalData],
  );

  useEffect(() => {
    calibrationRef.current = calibration;
    voiceInputRef.current = voiceInput;
  }, [calibration, voiceInput]);

  const runActive =
    screen === "countdown" ||
    screen === "playing" ||
    (screen === "settings" && settingsReturnScreen === "playing");

  useEffect(() => {
    onRunActivityChange?.(runActive);
  }, [onRunActivityChange, runActive]);

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

  useEffect(() => {
    if (screen === "settings" || !restoreSettingsFocus.current) {
      return;
    }
    restoreSettingsFocus.current = false;
    const label = settingsFocusLabel.current;
    queueMicrotask(() => {
      if (!mounted.current) {
        return;
      }
      const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) =>
          (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === label,
      );
      button?.focus();
    });
  }, [screen]);

  useEffect(() => {
    if (screen !== "playing" || manualPaused || !restorePauseFocus.current) {
      return;
    }
    restorePauseFocus.current = false;
    queueMicrotask(() => {
      if (mounted.current) {
        document.querySelector<HTMLButtonElement>('button[aria-label="Pause run"]')?.focus();
      }
    });
  }, [manualPaused, screen]);

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

        if (profile) {
          voiceInput?.stop();
          const nextVoiceInput = createVoiceInput(session, profile);
          setVoiceInput(nextVoiceInput);
          setInputMode("voice");
          updateSettings({
            controlPreference: "voice",
            copyVersion: CURRENT_COPY_VERSION,
          });
          setVoiceProcessingFailed(false);
          setFlowError("");
          setScreen("ready");
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
  }, [
    beginCalibration,
    createVoiceInput,
    profile,
    requestingMicrophone,
    session,
    updateSettings,
    voiceInput,
  ]);

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
    setInputMode("keyboard-touch");
    updateSettings({
      controlPreference: "keyboard-touch",
      copyVersion: CURRENT_COPY_VERSION,
    });
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
  }, [calibration, session, updateSettings, voiceInput]);

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
    updateSettings({ controlPreference: "keyboard-touch" });
    setVoiceProcessingFailed(false);
    setTestingVoice(false);
    setTestFrame(null);
    setFlowError("");

    try {
      void session.useFallbackInput().catch(() => undefined);
    } catch {
      // Keyboard and touch are already active and independent of media cleanup.
    }
  }, [session, updateSettings, voiceInput]);

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
      commitLocalData({
        ...localDataRef.current,
        calibration: nextProfile,
        settings: {
          ...localDataRef.current.settings,
          controlPreference: "voice",
          copyVersion: CURRENT_COPY_VERSION,
        },
      });
      setProfile(nextProfile);
      setVoiceInput(nextVoiceInput);
      setInputMode("voice");
      setVoiceProcessingFailed(false);
      setFlowError("");
      setScreen("ready");
    },
    [calibration, commitLocalData, createVoiceInput, session, voiceInput],
  );

  const recalibrate = useCallback(() => {
    const generation = ++operationGeneration.current;
    ++voiceTestGeneration.current;
    voiceInput?.stop();
    setVoiceInput(null);
    setProfile(null);
    saveCalibration(null);
    setTestingVoice(false);
    if (media.microphone.status === "active") {
      void beginCalibration(generation);
    } else {
      updateSettings({ controlPreference: "voice" });
      setFlowError("Enable the microphone to create a fresh calibration.");
      setScreen("permission");
    }
  }, [beginCalibration, media.microphone.status, saveCalibration, updateSettings, voiceInput]);

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
    if (localDataRef.current.settings.controlPreference === "voice" && inputMode !== "voice") {
      setFlowError("Voice is preferred. Enable the microphone before starting the next run.");
      setScreen("permission");
      return;
    }
    ++voiceTestGeneration.current;
    voiceInput?.stop();
    setTestingVoice(false);
    setTestFrame(null);
    setFlowError("");
    expectedRunId.current = 1;
    recordedRunId.current = null;
    setCountdown(3);
    setScreen("countdown");
  }, [inputMode, voiceInput]);

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
    if (screen === "settings" && settingsReturnScreen === "playing") {
      reasons.add("settings");
    }
    return reasons;
  }, [landscape, manualPaused, media.visibility, mediaPause, screen, settingsReturnScreen]);

  const handleGameEvent = useCallback(
    (event: GameEvent) => {
      if (event.type === "fatal-error") {
        setRuntimeError(event.error.message);
        setScreen("runtime-error");
        return;
      }

      if (event.type === "ended") {
        if (event.value.runId !== expectedRunId.current) {
          return;
        }
        const validCompletedRun = isValidCompletedLocalRun(event.value);
        if (validCompletedRun && recordedRunId.current === event.value.runId) {
          return;
        }
        if (validCompletedRun) {
          recordedRunId.current = event.value.runId;
          const current = localDataRef.current;
          commitLocalData({
            ...current,
            statistics: {
              bestDistance: Math.max(current.statistics.bestDistance, event.value.distance),
              bestScore: Math.max(current.statistics.bestScore, event.value.score),
              completedRuns: current.statistics.completedRuns + 1,
              longestSurvivalMs: Math.max(
                current.statistics.longestSurvivalMs,
                event.value.survivalMs,
              ),
            },
          });
        }
        setSummary(event.value);
        setScreen("results");
        setLiveStatus(
          `Run ended. Survived ${(event.value.survivalMs / 1_000).toFixed(1)} seconds.`,
        );
        return;
      }

      if (event.type !== "snapshot") {
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
          `${event.value.phase}. Stage ${event.value.difficultyStage}. ${second} seconds. Input ${band}. Lift stamina ${Math.round(event.value.liftStamina * 100)} percent. Score ${event.value.score}: ${event.value.scoreBreakdown.survival} survival, ${event.value.scoreBreakdown.collectibles} collectible, ${event.value.scoreBreakdown.precision} precision.`,
        );
      }
    },
    [commitLocalData],
  );

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
    if (localDataRef.current.settings.controlPreference === "voice" && inputMode !== "voice") {
      setSummary(null);
      setFlowError("Voice is preferred. Enable the microphone before starting the next run.");
      setScreen("permission");
      return;
    }
    expectedRunId.current += 1;
    recordedRunId.current = null;
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
  }, [inputMode]);

  const resumeManualRun = useCallback(() => {
    restorePauseFocus.current = true;
    setManualPaused(false);
  }, []);

  const quitToReady = useCallback(() => {
    setSummary(null);
    setManualPaused(false);
    setRuntimeError("");
    setScreen("ready");
  }, []);

  const openSettings = useCallback(() => {
    if (
      screen !== "permission" &&
      screen !== "ready" &&
      screen !== "playing" &&
      screen !== "results"
    ) {
      return;
    }
    const activeElement = document.activeElement;
    settingsFocusLabel.current =
      activeElement instanceof HTMLButtonElement
        ? (activeElement.getAttribute("aria-label") ?? activeElement.textContent?.trim() ?? "")
        : "";
    restoreSettingsFocus.current = false;
    setSettingsReturnScreen(screen);
    setScreen("settings");
  }, [screen]);

  const closeSettings = useCallback(() => {
    restoreSettingsFocus.current = true;
    const destination = settingsReturnScreen;
    if (
      destination === "ready" &&
      localDataRef.current.settings.controlPreference === "voice" &&
      inputMode !== "voice"
    ) {
      setFlowError("Voice is preferred. Enable the microphone before the next run.");
      setScreen("permission");
      return;
    }
    setScreen(destination);
  }, [inputMode, settingsReturnScreen]);

  const changeSettings = useCallback(
    (patch: Partial<GameSettings>) => {
      const next = updateSettings(patch);
      if (patch.controlPreference === "keyboard-touch" && inputMode !== "keyboard-touch") {
        ++operationGeneration.current;
        ++voiceTestGeneration.current;
        voiceInput?.stop();
        setVoiceInput(null);
        setInputMode("keyboard-touch");
        setTestingVoice(false);
        setTestFrame(null);
        try {
          void session.useFallbackInput().catch(() => undefined);
        } catch {
          // Fallback controls do not depend on successful media cleanup.
        }
      } else if (
        patch.controlPreference === "voice" &&
        profile &&
        media.microphone.status === "active" &&
        settingsReturnScreen !== "playing"
      ) {
        voiceInput?.stop();
        const nextVoiceInput = createVoiceInput(session, profile);
        setVoiceInput(nextVoiceInput);
        setInputMode("voice");
      }
      return next;
    },
    [
      createVoiceInput,
      inputMode,
      media.microphone.status,
      profile,
      session,
      settingsReturnScreen,
      updateSettings,
      voiceInput,
    ],
  );

  const changeManualThreshold = useCallback(
    (threshold: number) => {
      if (!profile || settingsReturnScreen === "playing") {
        return;
      }
      const adjusted = withManualJumpThreshold(profile, threshold);
      saveCalibration(adjusted);
      setProfile(adjusted);
      if (inputMode === "voice" && media.microphone.status === "active") {
        voiceInput?.stop();
        setVoiceInput(createVoiceInput(session, adjusted));
      }
      setLiveStatus(`Voice threshold set to ${Math.round(adjusted.jumpEnterLevel * 100)}%.`);
    },
    [
      createVoiceInput,
      inputMode,
      media.microphone.status,
      profile,
      saveCalibration,
      session,
      settingsReturnScreen,
      voiceInput,
    ],
  );

  const resetLocalData = useCallback(() => {
    ++operationGeneration.current;
    ++countdownGeneration.current;
    ++voiceTestGeneration.current;
    calibration?.stop();
    voiceInput?.stop();
    try {
      session.stopCamera();
    } catch {
      // The session may already be idle or closed.
    }
    try {
      void session.useFallbackInput().catch(() => undefined);
    } catch {
      // Reset remains complete even when browser media cleanup rejects.
    }

    const reset = localDataStore.reset();
    localDataRef.current = reset;
    setLocalData(reset);
    setProfile(null);
    setCalibration(null);
    setVoiceInput(null);
    setInputMode("keyboard-touch");
    setTestingVoice(false);
    setTestFrame(null);
    setSummary(null);
    setManualPaused(false);
    setFlowError("");
    setRuntimeError("");
    setStorageNotice("Local game data cleared. Safe defaults were restored.");
    setupReturnScreen.current = "permission";
    setupRequiresCalibration.current = true;
    setSetupCalibrationRequired(true);
    setScreen("permission");
  }, [calibration, localDataStore, session, voiceInput]);

  const keepGameMounted =
    screen === "playing" ||
    screen === "results" ||
    screen === "runtime-error" ||
    (screen === "settings" &&
      (settingsReturnScreen === "playing" || settingsReturnScreen === "results"));
  const gameBlocked = screen !== "playing" || pauseReasons.size > 0;

  return (
    <div
      className="experience-root"
      data-muted={localData.settings.muted ? "true" : "false"}
      data-reduced-motion={localData.settings.reducedMotion ? "true" : "false"}
      data-run-active={runActive ? "true" : "false"}
      data-screen-shake-enabled={localData.settings.screenShakeEnabled ? "true" : "false"}
    >
      <CameraComposition
        session={session}
        hidden={landscape || screen !== "playing" || pauseReasons.size > 0}
        preferred={localData.settings.cameraEnabled}
        onPreferenceChange={(cameraEnabled) => {
          updateSettings({ cameraEnabled });
        }}
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
          muted={localData.settings.muted}
          onEvent={handleGameEvent}
          onReady={() => {
            expectedRunId.current = 1;
            recordedRunId.current = null;
          }}
          onVoiceUnavailable={() => {
            setVoiceProcessingFailed(true);
            setFlowError("Voice input stopped. The run is paused; retry or use fallback controls.");
          }}
          pauseReasons={pauseReasons}
          reducedMotion={localData.settings.reducedMotion}
          restartToken={restartToken}
          screenShakeEnabled={localData.settings.screenShakeEnabled}
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
          {storageNotice ? (
            <p className="storage-notice" role="status">
              {storageNotice}
            </p>
          ) : null}
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
            <button type="button" className="secondary-action" onClick={openSettings}>
              Accessibility &amp; settings
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
          <p className="control-help control-help--left">
            Fallback always works: Space / ↑, or tap and hold the playfield.
          </p>
          <dl className="best-stats" aria-label="Saved local run statistics">
            <div>
              <dt>Best score</dt>
              <dd>{localData.statistics.bestScore}</dd>
            </div>
            <div>
              <dt>Best survival</dt>
              <dd>{(localData.statistics.longestSurvivalMs / 1_000).toFixed(1)}s</dd>
            </div>
            <div>
              <dt>Finished runs</dt>
              <dd>{localData.statistics.completedRuns}</dd>
            </div>
          </dl>
          {storageNotice ? (
            <p className="storage-notice" role="status">
              {storageNotice}
            </p>
          ) : null}
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
            <button type="button" className="secondary-action" onClick={openSettings}>
              Accessibility &amp; settings
            </button>
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
          <button
            type="button"
            className="pause-button"
            onClick={() => changeSettings({ muted: !localData.settings.muted })}
            aria-label={localData.settings.muted ? "Unmute game" : "Mute game"}
            aria-pressed={localData.settings.muted}
          >
            {localData.settings.muted ? "Sound off" : "Sound on"}
          </button>
          <button type="button" className="pause-button" onClick={openSettings}>
            Settings
          </button>
        </div>
      ) : null}

      {screen === "playing" && manualPaused ? (
        <section
          ref={flowDialogRef}
          className="flow-card flow-card--modal"
          role="dialog"
          aria-labelledby="pause-title"
          aria-modal="true"
          onKeyDown={(event) => containDialogFocus(event, flowDialogRef.current, resumeManualRun)}
        >
          <p className="flow-step">Run paused</p>
          <h2 id="pause-title" ref={screenHeadingRef} tabIndex={-1}>
            Take a breath
          </h2>
          <p>
            The timer and course are frozen. Other pause reasons must also clear before play
            resumes.
          </p>
          <div className="flow-actions">
            <button type="button" className="primary-action" onClick={resumeManualRun}>
              Resume run
            </button>
            <button
              type="button"
              className="secondary-action"
              onClick={() => changeSettings({ muted: !localData.settings.muted })}
              aria-pressed={localData.settings.muted}
            >
              {localData.settings.muted ? "Unmute game" : "Mute game"}
            </button>
            <button type="button" className="secondary-action" onClick={openSettings}>
              Accessibility &amp; settings
            </button>
          </div>
        </section>
      ) : null}

      {screen === "playing" && mediaPause && !manualPaused ? (
        <section
          ref={flowDialogRef}
          className="flow-card flow-card--modal"
          role="dialog"
          aria-labelledby="media-title"
          aria-modal="true"
          onKeyDown={(event) => containDialogFocus(event, flowDialogRef.current)}
        >
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
          ref={flowDialogRef}
          className="flow-card flow-card--modal"
          role="dialog"
          aria-labelledby="results-title"
          aria-modal="true"
          onKeyDown={(event) => containDialogFocus(event, flowDialogRef.current, quitToReady)}
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
              <dt>Total score</dt>
              <dd>{summary.score}</dd>
            </div>
            <div>
              <dt>Survival points</dt>
              <dd>{summary.scoreBreakdown.survival}</dd>
            </div>
            <div>
              <dt>Collectible bonus</dt>
              <dd>{summary.scoreBreakdown.collectibles}</dd>
            </div>
            <div>
              <dt>Precision bonus</dt>
              <dd>{summary.scoreBreakdown.precision}</dd>
            </div>
            <div>
              <dt>Distance</dt>
              <dd>{summary.statistics.distance.toFixed(0)} px</dd>
            </div>
            <div>
              <dt>Obstacles cleared</dt>
              <dd>{summary.statistics.obstaclesCleared}</dd>
            </div>
            <div>
              <dt>Feathers</dt>
              <dd>{summary.statistics.collectibles}</dd>
            </div>
            <div>
              <dt>Precision landings</dt>
              <dd>{summary.statistics.precisionLandings}</dd>
            </div>
            <div>
              <dt>Longest lift</dt>
              <dd>{(summary.statistics.longestLiftMs / 1_000).toFixed(1)}s</dd>
            </div>
            <div>
              <dt>Ended by</dt>
              <dd>{summary.reason}</dd>
            </div>
          </dl>
          <p className="best-result" role="status">
            Local best: {localData.statistics.bestScore} · Finished runs:{" "}
            {localData.statistics.completedRuns}
          </p>
          <div className="flow-actions">
            <button type="button" className="primary-action" onClick={restartRun}>
              Restart run
            </button>
            <button type="button" className="secondary-action" onClick={quitToReady}>
              Quit to ready screen
            </button>
            <button type="button" className="secondary-action" onClick={openSettings}>
              Accessibility &amp; settings
            </button>
          </div>
          <div className="pwa-update-slot" ref={onPwaUpdateHostChange} />
        </section>
      ) : null}

      {screen === "settings" ? (
        <SettingsPanel
          data={localData}
          headingRef={screenHeadingRef}
          onChange={changeSettings}
          onClose={closeSettings}
          onRecalibrate={recalibrate}
          onReset={resetLocalData}
          onThresholdChange={changeManualThreshold}
          onUpdateHostChange={onPwaUpdateHostChange}
          runActive={settingsReturnScreen === "playing"}
        />
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

      <p
        className="accessible-game-status"
        role="status"
        aria-live="polite"
        aria-hidden={screen === "settings" ? true : undefined}
      >
        {liveStatus}
      </p>

      <footer className="bootstrap-note" aria-hidden={screen === "settings" ? true : undefined}>
        <span className="status-dot" aria-hidden="true" />
        <span>
          {inputMode === "voice" ? "Microphone + fallback ready" : "Keyboard + touch ready"}
        </span>
      </footer>
    </div>
  );
}

function containDialogFocus(
  event: React.KeyboardEvent<HTMLElement>,
  panel: HTMLElement | null,
  onEscape?: () => void,
) {
  if (event.key === "Escape") {
    if (onEscape) {
      event.preventDefault();
      onEscape();
    }
    return;
  }
  if (event.key !== "Tab" || !panel) {
    return;
  }

  const focusable = [
    ...panel.querySelectorAll<HTMLElement>("button, input, select, [tabindex]"),
  ].filter(
    (element) =>
      !element.hasAttribute("disabled") && !element.hasAttribute("hidden") && element.tabIndex >= 0,
  );
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    panel.focus();
    return;
  }

  const active = document.activeElement;
  const activeIsFocusable = active instanceof HTMLElement && focusable.includes(active);
  if (event.shiftKey && (!activeIsFocusable || active === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!activeIsFocusable || active === last)) {
    event.preventDefault();
    first.focus();
  }
}

interface SettingsPanelProps {
  readonly data: LocalGameData;
  readonly headingRef: React.RefObject<HTMLHeadingElement | null>;
  readonly onChange: (patch: Partial<GameSettings>) => LocalGameData;
  readonly onClose: () => void;
  readonly onRecalibrate: () => void;
  readonly onReset: () => void;
  readonly onThresholdChange: (threshold: number) => void;
  readonly onUpdateHostChange?: (host: HTMLElement | null) => void;
  readonly runActive: boolean;
}

function SettingsPanel({
  data,
  headingRef,
  onChange,
  onClose,
  onRecalibrate,
  onReset,
  onThresholdChange,
  onUpdateHostChange,
  runActive,
}: SettingsPanelProps) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const thresholdPercent = Math.round(
    (data.calibration?.jumpEnterLevel ?? MIN_MANUAL_THRESHOLD) * 100,
  );

  return (
    <section
      ref={panelRef}
      className="flow-card flow-card--settings"
      role="dialog"
      aria-labelledby="settings-title"
      aria-modal="true"
      onKeyDown={(event) => containDialogFocus(event, panelRef.current, onClose)}
    >
      <p className="flow-step">{runActive ? "Run paused" : "Local preferences"}</p>
      <h2 id="settings-title" ref={headingRef} tabIndex={-1}>
        Accessibility &amp; settings
      </h2>
      <p className="settings-intro">
        These settings and derived statistics stay in this browser. Microphone samples, recordings,
        and camera video are never saved here.
      </p>

      <fieldset className="settings-group">
        <legend>Controls</legend>
        <label className="setting-row setting-row--stacked">
          <span>
            Preferred input
            <small>Keyboard, touch, and pause remain available in every mode.</small>
          </span>
          <select
            aria-label="Preferred input"
            value={data.settings.controlPreference}
            disabled={runActive}
            onChange={(event) => {
              onChange({ controlPreference: event.target.value as ControlMode });
            }}
          >
            <option value="keyboard-touch">Keyboard + touch</option>
            <option value="voice">Voice + fallback</option>
          </select>
        </label>
        {runActive ? (
          <p className="settings-help" id="active-run-settings-help">
            Input preference and calibration can be changed after this run.
          </p>
        ) : null}
        {data.calibration ? (
          <label className="setting-row setting-row--stacked">
            <span>
              Voice jump threshold: {thresholdPercent}%
              <small id="threshold-help">
                Lower is more sensitive. Safe adjustment is {MIN_MANUAL_THRESHOLD * 100}%–
                {MAX_MANUAL_THRESHOLD * 100}%.
              </small>
            </span>
            <input
              type="range"
              aria-label="Voice jump threshold"
              aria-describedby="threshold-help"
              min={MIN_MANUAL_THRESHOLD * 100}
              max={MAX_MANUAL_THRESHOLD * 100}
              step={1}
              value={thresholdPercent}
              disabled={runActive}
              onChange={(event) => {
                onThresholdChange(Number(event.target.value) / 100);
              }}
            />
          </label>
        ) : (
          <p className="settings-help">No derived voice calibration is saved.</p>
        )}
        <button
          type="button"
          className="secondary-action"
          disabled={runActive}
          onClick={onRecalibrate}
        >
          {data.calibration ? "Recalibrate microphone" : "Calibrate microphone"}
        </button>
      </fieldset>

      <fieldset className="settings-group">
        <legend>Presentation</legend>
        <SettingCheckbox
          checked={data.settings.cameraEnabled}
          description="Remember the preference only. The camera still starts from its own button and explicit gesture."
          label="Prefer camera composition"
          onChange={(cameraEnabled) => onChange({ cameraEnabled })}
        />
        <SettingCheckbox
          checked={data.settings.muted}
          description="Mute game sound. Voice input and private calibration review stay under your control."
          label="Mute game"
          onChange={(muted) => onChange({ muted })}
        />
        <SettingCheckbox
          checked={data.settings.reducedMotion}
          description="Remove interface transitions and continuous character bobbing or flapping."
          label="Reduce motion"
          onChange={(reducedMotion) => onChange({ reducedMotion })}
        />
        <SettingCheckbox
          checked={data.settings.screenShakeEnabled}
          description="Allow impact shake feedback when an effect supports it."
          label="Screen shake"
          onChange={(screenShakeEnabled) => onChange({ screenShakeEnabled })}
        />
      </fieldset>

      <section className="settings-group" aria-labelledby="statistics-title">
        <h3 id="statistics-title">Local run statistics</h3>
        <dl className="settings-stats">
          <div>
            <dt>Best score</dt>
            <dd>{data.statistics.bestScore}</dd>
          </div>
          <div>
            <dt>Best distance</dt>
            <dd>{Math.round(data.statistics.bestDistance)}</dd>
          </div>
          <div>
            <dt>Best survival</dt>
            <dd>{(data.statistics.longestSurvivalMs / 1_000).toFixed(1)}s</dd>
          </div>
          <div>
            <dt>Finished runs</dt>
            <dd>{data.statistics.completedRuns}</dd>
          </div>
        </dl>
        <p className="settings-help">
          Only valid runs that reach a local results screen can update these bests.
        </p>
      </section>

      <section className="settings-group settings-danger" aria-labelledby="local-data-title">
        <h3 id="local-data-title">Local data</h3>
        <p className="settings-help">
          Data schema {data.schemaVersion} · safety copy {data.settings.copyVersion}
        </p>
        {confirmingReset ? (
          <div className="reset-confirmation" role="alert">
            <p>This removes all Shouting Chickens settings, calibration, and scores now.</p>
            <div className="flow-actions flow-actions--inline">
              <button type="button" className="danger-action" onClick={onReset}>
                Confirm reset
              </button>
              <button
                type="button"
                className="secondary-action"
                onClick={() => setConfirmingReset(false)}
              >
                Keep my data
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="secondary-action"
            onClick={() => setConfirmingReset(true)}
          >
            Reset local game data
          </button>
        )}
      </section>

      <button type="button" className="primary-action" onClick={onClose}>
        {runActive ? "Return to paused run" : "Close settings"}
      </button>
      <div className="pwa-update-slot" ref={onUpdateHostChange} />
    </section>
  );
}

interface SettingCheckboxProps {
  readonly checked: boolean;
  readonly description: string;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}

function SettingCheckbox({ checked, description, label, onChange }: SettingCheckboxProps) {
  return (
    <label className="setting-row">
      <span>
        {label}
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
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

function initialScreenForLocalData(data: LocalGameData): Screen {
  return data.settings.copyVersion >= CURRENT_COPY_VERSION &&
    data.settings.controlPreference === "keyboard-touch"
    ? "ready"
    : "permission";
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
