import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type {
  BrowserMediaSession,
  MediaResourceState,
  MediaSessionSnapshot,
} from "../platform/media";

export type CameraSession = Pick<
  BrowserMediaSession,
  "getCameraStream" | "getSnapshot" | "requestCameraFromGesture" | "stopCamera" | "subscribe"
>;

export type CameraUiState =
  "disabled" | "loading" | "active" | "paused" | "denied" | "unavailable" | "stopped";

interface CameraCompositionProps {
  readonly hidden?: boolean;
  readonly session: CameraSession | null;
}

const NO_SESSION_SNAPSHOT: MediaSessionSnapshot = Object.freeze({
  audioContext: "unavailable",
  camera: Object.freeze({
    canFallback: false,
    canRetry: false,
    ignoredPreferences: Object.freeze([]),
    issue: "api-unavailable",
    kind: "camera",
    status: "unsupported",
  }),
  microphone: Object.freeze({
    canFallback: true,
    canRetry: false,
    ignoredPreferences: Object.freeze([]),
    issue: "api-unavailable",
    kind: "microphone",
    status: "unsupported",
  }),
  resumeRequired: false,
  visibility: "visible",
});

const subscribeToNothing = () => () => undefined;
const getNoSessionSnapshot = () => NO_SESSION_SNAPSHOT;

function useMediaSnapshot(session: CameraSession | null): MediaSessionSnapshot {
  return useSyncExternalStore(
    session?.subscribe ?? subscribeToNothing,
    session?.getSnapshot ?? getNoSessionSnapshot,
    session?.getSnapshot ?? getNoSessionSnapshot,
  );
}

function uiStateFor(
  selection: "disabled" | "enabled" | "stopped",
  camera: MediaResourceState,
): CameraUiState {
  if (selection === "disabled") {
    return "disabled";
  }
  if (selection === "stopped") {
    return "stopped";
  }

  switch (camera.status) {
    case "requesting":
      return "loading";
    case "active":
      return "active";
    case "suspended":
      return "paused";
    case "denied":
      return "denied";
    case "unsupported":
    case "unavailable":
    case "device-lost":
    case "fallback":
    case "closed":
      return "unavailable";
    case "idle":
      return "loading";
  }
}

function statusCopy(state: CameraUiState): string {
  switch (state) {
    case "disabled":
      return "Camera off. The original game background is active.";
    case "loading":
      return "Starting camera…";
    case "active":
      return "Camera on. Video stays on-device and is never recorded.";
    case "paused":
      return "Camera paused. The original game background is active.";
    case "denied":
      return "Camera permission was denied. You can keep playing or try again.";
    case "unavailable":
      return "Camera is unavailable. The game still works with its original background.";
    case "stopped":
      return "Camera stopped. The original game background is active.";
  }
}

function buttonCopy(state: CameraUiState): string {
  switch (state) {
    case "active":
      return "Camera on · Turn off";
    case "paused":
      return "Camera paused · Turn off";
    case "loading":
      return "Starting camera…";
    case "denied":
      return "Camera denied · Retry";
    case "unavailable":
      return "Camera unavailable · Retry";
    case "disabled":
    case "stopped":
      return "Camera off · Enable";
  }
}

function compactButtonCopy(state: CameraUiState): string {
  switch (state) {
    case "active":
      return "Camera on";
    case "paused":
      return "Camera paused";
    case "loading":
      return "Starting…";
    case "denied":
    case "unavailable":
      return "Retry camera";
    case "disabled":
    case "stopped":
      return "Camera";
  }
}

export function CameraComposition({ hidden = false, session }: CameraCompositionProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [selection, setSelection] = useState<"disabled" | "enabled" | "stopped">("disabled");
  const [lifecycleFailed, setLifecycleFailed] = useState(false);
  const snapshot = useMediaSnapshot(session);
  const sessionState = uiStateFor(selection, snapshot.camera);
  const state = lifecycleFailed ? "unavailable" : sessionState;
  const stream = session && state === "active" ? session.getCameraStream() : undefined;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) {
      return;
    }

    video.srcObject = stream;
    let active = true;
    const handlePlaybackFailure = () => {
      if (!active) {
        return;
      }

      try {
        session?.stopCamera();
      } catch {
        // The session may have closed while playback was settling.
      }
      setLifecycleFailed(true);
    };

    try {
      void video.play().catch(handlePlaybackFailure);
    } catch {
      handlePlaybackFailure();
    }

    return () => {
      active = false;
      video.pause();
      video.srcObject = null;
    };
  }, [session, stream]);

  useEffect(() => {
    if (
      !hidden ||
      !session ||
      (sessionState !== "loading" && sessionState !== "active" && sessionState !== "paused")
    ) {
      return;
    }

    let active = true;
    queueMicrotask(() => {
      if (!active) {
        return;
      }

      try {
        session.stopCamera();
        setLifecycleFailed(false);
        setSelection("stopped");
      } catch {
        setLifecycleFailed(true);
      }
    });

    return () => {
      active = false;
    };
  }, [hidden, session, sessionState]);

  const handleCameraAction = () => {
    if (!session || state === "loading") {
      return;
    }

    if (state === "active" || state === "paused") {
      try {
        session.stopCamera();
        setLifecycleFailed(false);
        setSelection("stopped");
      } catch {
        setLifecycleFailed(true);
      }
      return;
    }

    setLifecycleFailed(false);
    setSelection("enabled");
    try {
      void session.requestCameraFromGesture().catch(() => {
        setLifecycleFailed(true);
      });
    } catch {
      setLifecycleFailed(true);
    }
  };

  return (
    <>
      <div className="camera-backdrop" data-camera-state={state} aria-hidden="true">
        <div className="camera-placeholder">
          <div className="camera-grid" />
          <div className="camera-orb camera-orb--sun" />
          <div className="camera-orb camera-orb--sky" />
          <div className="camera-horizon" />
        </div>

        {stream ? (
          <video
            ref={videoRef}
            className="camera-video"
            data-testid="camera-video"
            autoPlay
            muted
            playsInline
          />
        ) : null}

        <div className="camera-vignette" />
      </div>

      <div className="camera-control" hidden={hidden}>
        <button
          className="camera-toggle"
          type="button"
          aria-label={buttonCopy(state)}
          aria-describedby="camera-status"
          aria-pressed={state === "active" || state === "paused"}
          disabled={!session || state === "loading"}
          onClick={handleCameraAction}
        >
          <span className="camera-toggle__icon" aria-hidden="true">
            {state === "active" || state === "paused" ? "●" : "◉"}
          </span>
          <span className="camera-toggle__label" aria-hidden="true">
            {buttonCopy(state)}
          </span>
          <span className="camera-toggle__label camera-toggle__label--compact" aria-hidden="true">
            {compactButtonCopy(state)}
          </span>
        </button>
        <p
          id="camera-status"
          className="camera-status"
          role="status"
          aria-live="polite"
          data-camera-state={state}
        >
          {statusCopy(state)}
        </p>
      </div>
    </>
  );
}
