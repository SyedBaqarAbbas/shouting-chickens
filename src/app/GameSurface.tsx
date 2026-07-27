import { useEffect, useRef, useState } from "react";

import {
  SystemClock,
  type CalibrationProfile,
  type ControlMode,
  type GameEventListener,
  type InputSource,
} from "../core";
import { createGameRuntime } from "../game/createGame";
import type { InputSourceFactory } from "../game/PhaserGameRuntime";
import {
  CombinedInputSource,
  KeyboardInputSource,
  OptionalInputSource,
  TouchInputSource,
} from "../game/input/BrowserInputSources";

export interface GameSurfaceProps {
  readonly activeInput: ControlMode;
  readonly blocked: boolean;
  readonly calibration: CalibrationProfile | null;
  readonly createRuntime?: typeof createGameRuntime;
  readonly landscape: boolean;
  readonly muted?: boolean;
  readonly onEvent: GameEventListener;
  readonly onReady?: () => void;
  readonly onVoiceUnavailable?: (error: unknown) => void;
  readonly pauseReasons: ReadonlySet<string>;
  readonly reducedMotion?: boolean;
  readonly restartToken: number;
  readonly screenShakeEnabled?: boolean;
  readonly voiceInput: InputSource | null;
}

const RUN_OPTIONS = {
  seed: "authored-launch",
  gameplayVersion: "sho-16-voice-aware-v1",
} as const;

export function GameSurface({
  activeInput,
  blocked,
  calibration,
  createRuntime = createGameRuntime,
  landscape,
  muted = false,
  onEvent,
  onReady,
  onVoiceUnavailable,
  pauseReasons,
  reducedMotion = false,
  restartToken,
  screenShakeEnabled = true,
  voiceInput,
}: GameSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ReturnType<typeof createGameRuntime> | null>(null);
  const mountedRef = useRef(false);
  const pausedRef = useRef(pauseReasons.size > 0);
  const restartTokenRef = useRef(restartToken);
  const [initialActiveInput] = useState(activeInput);
  const [systemReducedMotion] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  const effectiveReducedMotion = reducedMotion || systemReducedMotion;
  const onEventRef = useRef(onEvent);
  const onReadyRef = useRef(onReady);
  const onVoiceUnavailableRef = useRef(onVoiceUnavailable);
  const presentationRef = useRef({
    muted,
    reducedMotion: effectiveReducedMotion,
    screenShakeEnabled,
  });

  useEffect(() => {
    onEventRef.current = onEvent;
    onReadyRef.current = onReady;
    onVoiceUnavailableRef.current = onVoiceUnavailable;
  }, [onEvent, onReady, onVoiceUnavailable]);

  useEffect(() => {
    presentationRef.current = {
      muted,
      reducedMotion: effectiveReducedMotion,
      screenShakeEnabled,
    };
  }, [effectiveReducedMotion, muted, screenShakeEnabled]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    let fatalEventSeen = false;
    let runtime: ReturnType<typeof createRuntime> | null = null;
    let unsubscribe: () => void = () => undefined;

    // StrictMode replays effects in development. Deferring ownership prevents
    // the throwaway setup from starting and later stopping the shared voice
    // graph after the real setup has taken ownership of it.
    queueMicrotask(() => {
      if (disposed) {
        return;
      }

      const clock = new SystemClock();
      const inputSourceFactory: InputSourceFactory = (parent) => {
        const sources: InputSource[] = [
          new KeyboardInputSource(clock, window),
          new TouchInputSource(clock, parent),
        ];

        if (initialActiveInput === "voice" && voiceInput) {
          sources.push(
            new OptionalInputSource(voiceInput, (error) => {
              onVoiceUnavailableRef.current?.(error);
            }),
          );
        }

        return new CombinedInputSource(sources);
      };
      runtime = createRuntime({ clock, inputSourceFactory });
      runtimeRef.current = runtime;
      runtime.setActiveInput(initialActiveInput);
      runtime.setPresentationPreferences?.(presentationRef.current);
      unsubscribe = runtime.subscribe((event) => {
        if (event.type === "fatal-error") {
          fatalEventSeen = true;
        }
        onEventRef.current(event);
      });

      void runtime
        .mount(container)
        .then(() => {
          if (disposed || !runtime) {
            return;
          }

          mountedRef.current = true;
          runtime.startRun({
            ...RUN_OPTIONS,
            calibration,
          });

          if (pausedRef.current) {
            runtime.pause();
          }
          onReadyRef.current?.();
        })
        .catch((cause) => {
          if (!disposed && !fatalEventSeen) {
            onEventRef.current({
              error: {
                cause,
                code: "render-failed",
                message: "The game world could not be mounted",
                recoverable: true,
              },
              type: "fatal-error",
            });
          }
        });
    });

    return () => {
      disposed = true;
      mountedRef.current = false;
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
      unsubscribe();
      runtime?.destroy();
    };
  }, [calibration, createRuntime, initialActiveInput, voiceInput]);

  useEffect(() => {
    runtimeRef.current?.setActiveInput(activeInput);
  }, [activeInput]);

  useEffect(() => {
    runtimeRef.current?.setPresentationPreferences?.({
      muted,
      reducedMotion: effectiveReducedMotion,
      screenShakeEnabled,
    });
  }, [effectiveReducedMotion, muted, screenShakeEnabled]);

  useEffect(() => {
    pausedRef.current = pauseReasons.size > 0;
    const runtime = runtimeRef.current;
    if (!runtime || !mountedRef.current) {
      return;
    }

    if (pausedRef.current) {
      runtime.pause();
    } else {
      runtime.resume();
    }
  }, [pauseReasons]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (restartToken === restartTokenRef.current) {
      return;
    }

    restartTokenRef.current = restartToken;
    if (runtime && mountedRef.current) {
      runtime.restart();
      if (pausedRef.current) {
        runtime.pause();
      }
    }
  }, [restartToken]);

  return (
    <div
      ref={containerRef}
      id="game-container"
      className="game-surface"
      data-testid="game-surface"
      data-restart-token={restartToken}
      data-orientation={landscape ? "landscape" : "portrait"}
      data-blocked={blocked ? "true" : "false"}
      data-muted={muted ? "true" : "false"}
      data-reduced-motion={effectiveReducedMotion ? "true" : "false"}
      data-screen-shake-enabled={screenShakeEnabled ? "true" : "false"}
      aria-hidden={blocked}
      aria-label="Shouting Chickens game. Tap the playfield, press Space, or use Up Arrow to jump."
      inert={blocked}
      tabIndex={-1}
    />
  );
}
