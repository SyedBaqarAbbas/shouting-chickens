import { useEffect, useState } from "react";

import { createBrowserMediaSession, type BrowserMediaSession } from "../platform/media";
import { CameraComposition } from "./CameraComposition";
import { GameSurface } from "./GameSurface";

interface AppProps {
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

export function App({ createMediaSession = createBrowserMediaSession }: AppProps) {
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
        aria-labelledby="game-title"
        data-orientation={landscape ? "landscape" : "portrait"}
      >
        <CameraComposition session={mediaSession} hidden={landscape} />

        <header className="game-heading">
          <p className="eyebrow">Voice-controlled platformer</p>
          <h1 id="game-title">Shouting Chickens</h1>
        </header>

        <GameSurface landscape={landscape} />

        <footer className="bootstrap-note">
          <span className="status-dot" aria-hidden="true" />
          <span>Deterministic 60 Hz world</span>
        </footer>

        <div className="rotate-prompt" role="status" aria-live="polite" hidden={!landscape}>
          <span aria-hidden="true">↻</span>
          <strong>Rotate your device to play</strong>
          <small>The run pauses and the camera turns off while the screen is landscape.</small>
        </div>
      </section>
    </main>
  );
}
