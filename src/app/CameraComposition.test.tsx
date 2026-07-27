import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  MediaResourceState,
  MediaResourceStatus,
  MediaSessionSnapshot,
  MediaStateIssue,
} from "../platform/media";
import { CameraComposition, type CameraSession } from "./CameraComposition";

function resourceState(
  kind: "camera" | "microphone",
  status: MediaResourceStatus,
  issue?: MediaStateIssue,
): MediaResourceState {
  return {
    canFallback: kind === "microphone",
    canRetry: status === "denied" || status === "unavailable",
    ignoredPreferences: [],
    issue,
    kind,
    status,
  };
}

class FakeCameraSession implements CameraSession {
  readonly cameraStream = {} as MediaStream;
  readonly requestCameraFromGesture = vi.fn(() => {
    if (this.requestError) {
      throw this.requestError;
    }

    this.setCamera(resourceState("camera", "requesting"));

    if (this.pendingRequest) {
      return this.pendingRequest;
    }

    this.setCamera(this.nextCameraState);
    return Promise.resolve(this.nextCameraState);
  });
  readonly stopCamera = vi.fn(() => {
    this.setCamera(resourceState("camera", "idle"));
  });

  nextCameraState: MediaResourceState;
  pendingRequest?: Promise<MediaResourceState>;
  requestError?: Error;
  private readonly listeners = new Set<() => void>();
  private snapshot: MediaSessionSnapshot;

  constructor(nextCameraState = resourceState("camera", "active")) {
    this.nextCameraState = nextCameraState;
    this.snapshot = this.createSnapshot(resourceState("camera", "idle"));
  }

  readonly getCameraStream = () =>
    this.snapshot.camera.status === "active" || this.snapshot.camera.status === "suspended"
      ? this.cameraStream
      : undefined;

  readonly getSnapshot = () => this.snapshot;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setCamera(camera: MediaResourceState) {
    this.snapshot = this.createSnapshot(camera);
    for (const listener of this.listeners) {
      listener();
    }
  }

  private createSnapshot(camera: MediaResourceState): MediaSessionSnapshot {
    return {
      audioContext: "running",
      camera,
      microphone: resourceState("microphone", "active"),
      resumeRequired: camera.status === "suspended",
      visibility: "visible",
    };
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("CameraComposition", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("starts disabled without requesting a camera", () => {
    const session = new FakeCameraSession();

    render(<CameraComposition session={session} />);

    expect(screen.getByRole("button", { name: "Camera off · Enable" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("status")).toHaveTextContent(/Camera off/);
    expect(screen.queryByTestId("camera-video")).not.toBeInTheDocument();
    expect(session.requestCameraFromGesture).not.toHaveBeenCalled();
  });

  it("surfaces a saved preference without auto-prompting and reports explicit changes", async () => {
    const user = userEvent.setup();
    const session = new FakeCameraSession();
    const onPreferenceChange = vi.fn();

    render(
      <CameraComposition onPreferenceChange={onPreferenceChange} preferred session={session} />,
    );

    expect(screen.getByRole("button", { name: "Camera preferred · Enable" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(/Camera is preferred/);
    expect(session.requestCameraFromGesture).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Camera preferred · Enable" }));
    expect(onPreferenceChange).toHaveBeenLastCalledWith(true);
    await user.click(await screen.findByRole("button", { name: "Camera on · Turn off" }));
    expect(onPreferenceChange).toHaveBeenLastCalledWith(false);
  });

  it("shows loading and then attaches an allowed synthetic stream", async () => {
    const user = userEvent.setup();
    const session = new FakeCameraSession();
    const request = deferred<MediaResourceState>();
    session.pendingRequest = request.promise;

    render(<CameraComposition session={session} />);
    await user.click(screen.getByRole("button", { name: "Camera off · Enable" }));

    expect(screen.getByRole("button", { name: "Starting camera…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Starting camera…");

    const active = resourceState("camera", "active");
    session.setCamera(active);
    request.resolve(active);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Camera on · Turn off" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    const video = screen.getByTestId<HTMLVideoElement>("camera-video");
    expect(video.srcObject).toBe(session.cameraStream);
    expect(video.muted).toBe(true);
    expect(video).toHaveAttribute("playsinline");
  });

  it.each([
    ["denied", "permission-denied", /permission was denied/],
    ["unavailable", "no-device", /Camera is unavailable/],
    ["unsupported", "api-unavailable", /Camera is unavailable/],
  ] as const)("keeps the fallback playable when camera is %s", async (status, issue, copy) => {
    const user = userEvent.setup();
    const session = new FakeCameraSession(resourceState("camera", status, issue));

    render(<CameraComposition session={session} />);
    await user.click(screen.getByRole("button", { name: "Camera off · Enable" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(copy));
    expect(
      screen.getByRole("button", {
        name: status === "denied" ? "Camera denied · Retry" : "Camera unavailable · Retry",
      }),
    ).toBeEnabled();
    expect(screen.queryByTestId("camera-video")).not.toBeInTheDocument();
    expect(session.getSnapshot().microphone.status).toBe("active");
  });

  it("turns off only the video resource and reports a stopped state", async () => {
    const user = userEvent.setup();
    const session = new FakeCameraSession();

    render(<CameraComposition session={session} />);
    await user.click(screen.getByRole("button", { name: "Camera off · Enable" }));
    await screen.findByRole("button", { name: "Camera on · Turn off" });
    await user.click(screen.getByRole("button", { name: "Camera on · Turn off" }));

    expect(session.stopCamera).toHaveBeenCalledOnce();
    expect(session.getSnapshot().microphone.status).toBe("active");
    expect(screen.getByRole("status")).toHaveTextContent(/Camera stopped/);
    expect(screen.queryByTestId("camera-video")).not.toBeInTheDocument();
  });

  it("uses the fallback while an active camera is suspended or lost", async () => {
    const user = userEvent.setup();
    const session = new FakeCameraSession();

    render(<CameraComposition session={session} />);
    await user.click(screen.getByRole("button", { name: "Camera off · Enable" }));
    await screen.findByTestId("camera-video");

    session.setCamera(resourceState("camera", "suspended", "backgrounded"));
    await waitFor(() => {
      expect(screen.queryByTestId("camera-video")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Camera paused · Turn off" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    session.setCamera(resourceState("camera", "device-lost", "device-lost"));
    await waitFor(() => {
      expect(screen.queryByTestId("camera-video")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Camera unavailable · Retry" })).toBeEnabled();
    });
  });

  it("stops capture and falls back if inline video playback fails", async () => {
    const user = userEvent.setup();
    const session = new FakeCameraSession();
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new Error("Synthetic playback failure"),
    );

    render(<CameraComposition session={session} />);
    await user.click(screen.getByRole("button", { name: "Camera off · Enable" }));

    await waitFor(() => expect(session.stopCamera).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Camera unavailable · Retry" })).toBeEnabled();
    expect(screen.queryByTestId("camera-video")).not.toBeInTheDocument();
  });

  it("recovers from a synchronous gesture lifecycle error", async () => {
    const user = userEvent.setup();
    const session = new FakeCameraSession();
    session.requestError = new Error("Synthetic gesture expired");

    render(<CameraComposition session={session} />);
    await user.click(screen.getByRole("button", { name: "Camera off · Enable" }));

    expect(screen.getByRole("button", { name: "Camera unavailable · Retry" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(/Camera is unavailable/);
  });

  it("stops an active camera behind the shared landscape pause", async () => {
    const user = userEvent.setup();
    const session = new FakeCameraSession();
    const { rerender } = render(<CameraComposition session={session} />);
    await user.click(screen.getByRole("button", { name: "Camera off · Enable" }));
    await screen.findByTestId("camera-video");

    rerender(<CameraComposition session={session} hidden />);

    await waitFor(() => expect(session.stopCamera).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("camera-video")).not.toBeInTheDocument();

    rerender(<CameraComposition session={session} />);
    expect(screen.getByRole("button", { name: "Camera off · Enable" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(/Camera stopped/);
  });

  it("hides controls behind the shared landscape pause layer", () => {
    const session = new FakeCameraSession();

    render(<CameraComposition session={session} hidden />);

    expect(
      screen.getByRole("button", { name: "Camera off · Enable", hidden: true }),
    ).not.toBeVisible();
  });
});
