import { useEffect, useState } from "react";

import { createGameRuntime } from "../game/createGame";
import { createBrowserMediaSession, type BrowserMediaSession } from "../platform/media";
import { GameExperience, type GameExperienceProps } from "./GameExperience";

export interface AppProps extends Pick<
  GameExperienceProps,
  "countdownStepMs" | "createCalibrationCapture" | "createRuntime" | "createVoiceInput"
> {
  readonly createMediaSession?: () => BrowserMediaSession;
}

function isCompactLandscape() {
  return window.innerWidth > window.innerHeight && window.innerHeight <= 540;
}

function useCompactLandscape() {
  const [landscape, setLandscape] = useState(isCompactLandscape);

  useEffect(() => {
    const updateOrientation = () => {
      setLandscape(isCompactLandscape());
    };

    window.addEventListener("resize", updateOrientation);
    return () => {
      window.removeEventListener("resize", updateOrientation);
    };
  }, []);

  return landscape;
}

export function App({
  countdownStepMs,
  createCalibrationCapture,
  createMediaSession = createBrowserMediaSession,
  createRuntime = createGameRuntime,
  createVoiceInput,
}: AppProps) {
  const [mediaSession, setMediaSession] = useState<BrowserMediaSession | null>(null);
  const landscape = useCompactLandscape();

  useEffect(() => {
    const session = createMediaSession();
    let active = true;

    queueMicrotask(() => {
      if (active) {
        setMediaSession(session);
      }
    });

    return () => {
      active = false;
      void session.close();
    };
  }, [createMediaSession]);

  return (
    <main className="app-shell">
      <section
        className="game-phone"
        aria-label="Shouting Chickens"
        data-orientation={landscape ? "landscape" : "portrait"}
      >
        {mediaSession ? (
          <GameExperience
            countdownStepMs={countdownStepMs}
            createCalibrationCapture={createCalibrationCapture}
            createRuntime={createRuntime}
            createVoiceInput={createVoiceInput}
            landscape={landscape}
            session={mediaSession}
          />
        ) : (
          <section className="flow-card" aria-labelledby="loading-title">
            <p className="flow-step">First-time setup</p>
            <h1 id="game-title">Shouting Chickens</h1>
            <h2 id="loading-title">Checking microphone support…</h2>
            <button type="button" className="primary-action" disabled>
              Enable microphone
            </button>
          </section>
        )}

        <div className="rotate-prompt" role="status" aria-live="polite" hidden={!landscape}>
          <span aria-hidden="true">↻</span>
          <strong>Rotate your device to play</strong>
          <small>The run pauses and the camera turns off while the screen is landscape.</small>
        </div>
      </section>
    </main>
  );
}
