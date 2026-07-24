import { describe, expect, it, vi } from "vitest";

import {
  BrowserMediaSession,
  MediaGestureRequiredError,
  MediaSessionClosedError,
  type MediaSessionDependencies,
} from "./BrowserMediaSession";

class FakeTrack extends EventTarget {
  enabled = true;
  muted = false;
  readyState: MediaStreamTrackState = "live";
  readonly stop = vi.fn(() => {
    this.readyState = "ended";
  });
  readonly getSettings: ReturnType<typeof vi.fn<() => MediaTrackSettings>>;

  constructor(
    readonly kind: "audio" | "video",
    settings: MediaTrackSettings,
  ) {
    super();
    this.getSettings = vi.fn(() => ({ ...settings }));
  }

  end(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }

  mute(): void {
    this.muted = true;
    this.dispatchEvent(new Event("mute"));
  }

  unmute(): void {
    this.muted = false;
    this.dispatchEvent(new Event("unmute"));
  }
}

class FakeStream {
  constructor(readonly tracks: readonly FakeTrack[]) {}

  getTracks(): MediaStreamTrack[] {
    return this.tracks.map(asMediaStreamTrack);
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "audio").map(asMediaStreamTrack);
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "video").map(asMediaStreamTrack);
  }
}

class FakeMediaDevices extends EventTarget {
  readonly getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>();
  readonly enumerateDevices = vi.fn<() => Promise<MediaDeviceInfo[]>>().mockResolvedValue([]);

  changeDevices(): void {
    this.dispatchEvent(new Event("devicechange"));
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";

  setVisibility(visibility: DocumentVisibilityState): void {
    this.visibilityState = visibility;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

class FakeAudioNode {
  readonly disconnect = vi.fn();
}

class FakeAudioContext extends EventTarget {
  state: AudioContextState = "suspended";
  readonly source = new FakeAudioNode();
  readonly resume = vi.fn(async () => {
    this.state = "running";
    this.dispatchEvent(new Event("statechange"));
  });
  readonly suspend = vi.fn(async () => {
    this.state = "suspended";
    this.dispatchEvent(new Event("statechange"));
  });
  readonly close = vi.fn(async () => {
    this.state = "closed";
    this.dispatchEvent(new Event("statechange"));
  });
  readonly createMediaStreamSource = vi.fn(
    (): MediaStreamAudioSourceNode => this.source as unknown as MediaStreamAudioSourceNode,
  );

  transitionTo(state: AudioContextState): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

interface Harness {
  readonly cameraStream: FakeStream;
  readonly cameraTrack: FakeTrack;
  readonly contexts: FakeAudioContext[];
  readonly devices: FakeMediaDevices;
  readonly document: FakeDocument;
  readonly microphoneStream: FakeStream;
  readonly microphoneTrack: FakeTrack;
  readonly session: BrowserMediaSession;
  setActivation(active: boolean): void;
}

function createHarness(
  options: {
    readonly createAudioContext?: () => FakeAudioContext;
  } = {},
): Harness {
  const devices = new FakeMediaDevices();
  const document = new FakeDocument();
  const contexts: FakeAudioContext[] = [];
  const microphoneTrack = createMicrophoneTrack();
  const cameraTrack = createCameraTrack();
  const microphoneStream = new FakeStream([microphoneTrack]);
  const cameraStream = new FakeStream([cameraTrack]);
  let activation = true;

  devices.getUserMedia.mockImplementation(async (constraints) => {
    if (constraints.audio !== false) {
      return asMediaStream(microphoneStream);
    }
    return asMediaStream(cameraStream);
  });

  const dependencies: MediaSessionDependencies = {
    createAudioContext: () => {
      const context = options.createAudioContext?.() ?? new FakeAudioContext();
      contexts.push(context);
      return asAudioContext(context);
    },
    document: document as unknown as Document,
    isSecureContext: true,
    isUserActivationActive: () => activation,
    mediaDevices: devices as unknown as MediaDevices,
  };

  return {
    cameraStream,
    cameraTrack,
    contexts,
    devices,
    document,
    microphoneStream,
    microphoneTrack,
    session: new BrowserMediaSession(dependencies),
    setActivation(active: boolean) {
      activation = active;
    },
  };
}

describe("BrowserMediaSession", () => {
  it("does not request media on construction and keeps snapshots stable", () => {
    const harness = createHarness();

    expect(harness.devices.getUserMedia).not.toHaveBeenCalled();
    expect(harness.session.getSnapshot()).toBe(harness.session.getSnapshot());
    expect(harness.session.getSnapshot()).toMatchObject({
      audioContext: "none",
      camera: { status: "idle" },
      microphone: { status: "idle" },
      resumeRequired: false,
      visibility: "visible",
    });
  });

  it("requests microphone and camera separately with preferred constraints", async () => {
    const harness = createHarness();

    const microphone = await harness.session.requestMicrophoneFromGesture();
    const camera = await harness.session.requestCameraFromGesture();

    expect(harness.devices.getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: {
        autoGainControl: false,
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    expect(harness.devices.getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: false,
      video: {
        facingMode: { ideal: "user" },
        frameRate: { ideal: 30 },
        height: { ideal: 720 },
        width: { ideal: 1280 },
      },
    });
    expect(microphone).toMatchObject({
      ignoredPreferences: [],
      status: "active",
    });
    expect(camera).toMatchObject({
      ignoredPreferences: [],
      status: "active",
    });
    expect(harness.session.getMicrophoneAudioGraph()).toMatchObject({
      stream: asMediaStream(harness.microphoneStream),
    });
    expect(harness.session.getCameraStream()).toBe(asMediaStream(harness.cameraStream));
  });

  it("stops only video when optional camera composition is turned off", async () => {
    const harness = createHarness();

    await harness.session.requestMicrophoneFromGesture();
    await harness.session.requestCameraFromGesture();
    harness.session.stopCamera();

    expect(harness.cameraTrack.stop).toHaveBeenCalledOnce();
    expect(harness.microphoneTrack.stop).not.toHaveBeenCalled();
    expect(harness.contexts[0]?.close).not.toHaveBeenCalled();
    expect(harness.session.getSnapshot()).toMatchObject({
      camera: { status: "idle" },
      microphone: { status: "active" },
    });
  });

  it("reports ignored browser media preferences without failing capture", async () => {
    const harness = createHarness();
    harness.microphoneTrack.getSettings.mockReturnValue({
      autoGainControl: true,
      channelCount: 2,
      echoCancellation: false,
      noiseSuppression: false,
    });
    harness.cameraTrack.getSettings.mockReturnValue({
      facingMode: "environment",
      frameRate: 60,
      height: 480,
      width: 640,
    });

    await harness.session.requestMicrophoneFromGesture();
    await harness.session.requestCameraFromGesture();

    expect(harness.session.getSnapshot().microphone.ignoredPreferences).toEqual([
      "mono",
      "echo-cancellation",
      "noise-suppression",
      "automatic-gain-control-off",
    ]);
    expect(harness.session.getSnapshot().camera.ignoredPreferences).toEqual([
      "front-camera",
      "720p",
      "30fps-cap",
    ]);
  });

  it("keeps an active microphone when optional camera permission is denied", async () => {
    const harness = createHarness();
    harness.devices.getUserMedia.mockImplementation(async (constraints) => {
      if (constraints.audio !== false) {
        return asMediaStream(harness.microphoneStream);
      }
      throw namedError("NotAllowedError");
    });

    await harness.session.requestMicrophoneFromGesture();
    const camera = await harness.session.requestCameraFromGesture();

    expect(camera).toMatchObject({
      canRetry: true,
      issue: "permission-denied",
      status: "denied",
    });
    expect(harness.session.getSnapshot().microphone.status).toBe("active");
    expect(harness.microphoneTrack.stop).not.toHaveBeenCalled();
  });

  it.each([
    ["NotAllowedError", "denied", "permission-denied"],
    ["SecurityError", "denied", "permission-denied"],
    ["NotFoundError", "unavailable", "no-device"],
    ["DevicesNotFoundError", "unavailable", "no-device"],
    ["NotReadableError", "unavailable", "device-busy"],
    ["TrackStartError", "unavailable", "device-busy"],
    ["OverconstrainedError", "unavailable", "constraints-unsatisfied"],
    ["ConstraintNotSatisfiedError", "unavailable", "constraints-unsatisfied"],
    ["AbortError", "unavailable", "request-aborted"],
    ["UnexpectedError", "unavailable", "unknown"],
  ] as const)("maps %s failures to a recoverable state", async (name, status, issue) => {
    const harness = createHarness();
    harness.devices.getUserMedia.mockRejectedValueOnce(namedError(name));

    const state = await harness.session.requestMicrophoneFromGesture();

    expect(state).toMatchObject({ canRetry: true, issue, status });
    expect(harness.contexts[0]?.close).toHaveBeenCalledOnce();
  });

  it("rejects streams that do not contain a live track of the requested kind", async () => {
    const microphoneHarness = createHarness();
    const wrongMicrophoneTrack = createCameraTrack("wrong-video");
    microphoneHarness.devices.getUserMedia.mockResolvedValueOnce(
      asMediaStream(new FakeStream([wrongMicrophoneTrack])),
    );

    const microphone = await microphoneHarness.session.requestMicrophoneFromGesture();

    expect(microphone).toMatchObject({
      issue: "no-device",
      status: "unavailable",
    });
    expect(wrongMicrophoneTrack.stop).toHaveBeenCalledOnce();
    expect(microphoneHarness.contexts[0]?.close).toHaveBeenCalledOnce();

    const cameraHarness = createHarness();
    const wrongCameraTrack = createMicrophoneTrack("wrong-audio");
    cameraHarness.devices.getUserMedia.mockResolvedValueOnce(
      asMediaStream(new FakeStream([wrongCameraTrack])),
    );

    const camera = await cameraHarness.session.requestCameraFromGesture();

    expect(camera).toMatchObject({
      issue: "no-device",
      status: "unavailable",
    });
    expect(wrongCameraTrack.stop).toHaveBeenCalledOnce();
  });

  it("distinguishes unsupported APIs, insecure contexts, and missing audio support", () => {
    const insecure = new BrowserMediaSession({
      isSecureContext: false,
    });
    const noApi = new BrowserMediaSession({
      isSecureContext: true,
    });
    const noAudio = new BrowserMediaSession({
      isSecureContext: true,
      mediaDevices: new FakeMediaDevices() as unknown as MediaDevices,
    });

    expect(insecure.getSnapshot()).toMatchObject({
      camera: { issue: "insecure-context", status: "unsupported" },
      microphone: { issue: "insecure-context", status: "unsupported" },
    });
    expect(noApi.getSnapshot()).toMatchObject({
      camera: { issue: "api-unavailable", status: "unsupported" },
      microphone: { issue: "api-unavailable", status: "unsupported" },
    });
    expect(noAudio.getSnapshot()).toMatchObject({
      camera: { status: "idle" },
      microphone: {
        issue: "audio-context-unavailable",
        status: "unsupported",
      },
    });
  });

  it("requires an observable user gesture and deduplicates an in-flight prompt", async () => {
    const harness = createHarness();
    const pending = deferred<MediaStream>();
    harness.devices.getUserMedia.mockReturnValueOnce(pending.promise);
    harness.setActivation(false);

    expect(() => harness.session.requestMicrophoneFromGesture()).toThrow(MediaGestureRequiredError);
    expect(harness.devices.getUserMedia).not.toHaveBeenCalled();

    harness.setActivation(true);
    const first = harness.session.requestMicrophoneFromGesture();
    const second = harness.session.requestMicrophoneFromGesture();

    expect(first).toBe(second);
    expect(harness.devices.getUserMedia).toHaveBeenCalledOnce();

    pending.resolve(asMediaStream(harness.microphoneStream));
    await expect(first).resolves.toMatchObject({ status: "active" });
  });

  it("suspends hidden resources, restores camera, and gesture-resumes audio", async () => {
    const harness = createHarness();
    await harness.session.requestMicrophoneFromGesture();
    await harness.session.requestCameraFromGesture();
    const context = requireContext(harness);

    harness.document.setVisibility("hidden");

    expect(harness.session.getSnapshot()).toMatchObject({
      camera: { issue: "backgrounded", status: "suspended" },
      microphone: { issue: "backgrounded", status: "suspended" },
      resumeRequired: false,
      visibility: "hidden",
    });
    expect(harness.cameraTrack.enabled).toBe(false);
    expect(harness.microphoneTrack.enabled).toBe(false);
    expect(context.suspend).toHaveBeenCalledOnce();

    harness.document.setVisibility("visible");

    expect(harness.session.getSnapshot()).toMatchObject({
      camera: { status: "active" },
      microphone: { status: "suspended" },
      resumeRequired: true,
      visibility: "visible",
    });
    expect(harness.cameraTrack.enabled).toBe(true);
    expect(harness.microphoneTrack.enabled).toBe(false);
    expect(context.resume).toHaveBeenCalledOnce();

    harness.setActivation(false);
    await expect(
      Promise.resolve().then(() => harness.session.resumeFromGesture()),
    ).rejects.toBeInstanceOf(MediaGestureRequiredError);
    expect(context.resume).toHaveBeenCalledOnce();

    harness.setActivation(true);
    await harness.session.resumeFromGesture();

    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(harness.microphoneTrack.enabled).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      microphone: { status: "active" },
      resumeRequired: false,
    });
  });

  it("keeps a rejected audio resume recoverable instead of changing permission state", async () => {
    const harness = createHarness();
    await harness.session.requestMicrophoneFromGesture();
    const context = requireContext(harness);
    await harness.session.suspend();
    expect(context.suspend).toHaveBeenCalledOnce();
    context.resume.mockRejectedValueOnce(namedError("NotAllowedError"));

    await harness.session.resumeFromGesture();

    expect(harness.session.getSnapshot()).toMatchObject({
      microphone: {
        issue: "audio-context-suspended",
        status: "suspended",
      },
      resumeRequired: true,
    });
    expect(harness.microphoneTrack.enabled).toBe(false);

    await harness.session.resumeFromGesture();
    expect(harness.session.getSnapshot().microphone.status).toBe("active");
  });

  it("does not resurrect microphone resources when close overtakes resume", async () => {
    const harness = createHarness();
    await harness.session.requestMicrophoneFromGesture();
    const context = requireContext(harness);
    await harness.session.suspend();
    const resumed = deferred<void>();
    context.resume.mockImplementationOnce(async () => {
      await resumed.promise;
      if (context.state !== "closed") {
        context.transitionTo("running");
      }
    });

    const resume = harness.session.resumeFromGesture();
    const close = harness.session.close();
    resumed.resolve();
    await Promise.all([resume, close]);

    expect(harness.session.getSnapshot()).toMatchObject({
      camera: { status: "closed" },
      microphone: { status: "closed" },
    });
    expect(harness.microphoneTrack.enabled).toBe(false);
    expect(harness.microphoneTrack.stop).toHaveBeenCalledOnce();
  });

  it("does not overwrite device loss when an earlier resume settles", async () => {
    const harness = createHarness();
    await harness.session.requestMicrophoneFromGesture();
    const context = requireContext(harness);
    await harness.session.suspend();
    const resumed = deferred<void>();
    context.resume.mockImplementationOnce(async () => {
      await resumed.promise;
      if (context.state !== "closed") {
        context.transitionTo("running");
      }
    });

    const resume = harness.session.resumeFromGesture();
    harness.microphoneTrack.end();
    resumed.resolve();
    await resume;

    expect(harness.session.getSnapshot().microphone).toMatchObject({
      issue: "device-lost",
      status: "device-lost",
    });
    expect(harness.microphoneTrack.enabled).toBe(false);
  });

  it("does not re-enable microphone capture when the page hides during resume", async () => {
    const harness = createHarness();
    await harness.session.requestMicrophoneFromGesture();
    const context = requireContext(harness);
    await harness.session.suspend();
    const resumed = deferred<void>();
    context.resume.mockImplementationOnce(async () => {
      await resumed.promise;
      context.transitionTo("running");
    });

    const resume = harness.session.resumeFromGesture();
    harness.document.setVisibility("hidden");
    resumed.resolve();
    await resume;

    expect(harness.session.getSnapshot()).toMatchObject({
      microphone: { issue: "backgrounded", status: "suspended" },
      visibility: "hidden",
    });
    expect(harness.microphoneTrack.enabled).toBe(false);
  });

  it("resumes an explicitly paused camera without requiring microphone resources", async () => {
    const harness = createHarness();
    await harness.session.requestCameraFromGesture();

    await harness.session.suspend();

    expect(harness.session.getSnapshot()).toMatchObject({
      camera: { issue: "paused", status: "suspended" },
      resumeRequired: true,
    });
    expect(harness.cameraTrack.enabled).toBe(false);

    await harness.session.resumeFromGesture();

    expect(harness.session.getSnapshot()).toMatchObject({
      camera: { status: "active" },
      resumeRequired: false,
    });
    expect(harness.cameraTrack.enabled).toBe(true);
  });

  it("reacts to interrupted and unexpectedly closed audio contexts", async () => {
    const harness = createHarness();
    await harness.session.requestMicrophoneFromGesture();
    const context = requireContext(harness);

    context.transitionTo("interrupted");

    expect(harness.session.getSnapshot()).toMatchObject({
      audioContext: "suspended",
      microphone: {
        issue: "audio-context-suspended",
        status: "suspended",
      },
      resumeRequired: true,
    });
    expect(harness.microphoneTrack.enabled).toBe(false);

    await harness.session.resumeFromGesture();
    context.transitionTo("closed");

    expect(harness.session.getSnapshot()).toMatchObject({
      audioContext: "closed",
      microphone: {
        issue: "audio-context-closed",
        status: "unavailable",
      },
    });
    expect(harness.microphoneTrack.stop).toHaveBeenCalledOnce();
  });

  it("waits for a muted track to recover instead of treating it as gesture-resumable", async () => {
    const harness = createHarness();
    await harness.session.requestMicrophoneFromGesture();
    harness.microphoneTrack.mute();

    expect(harness.session.getSnapshot()).toMatchObject({
      microphone: { issue: "track-muted", status: "suspended" },
      resumeRequired: false,
    });

    await harness.session.resumeFromGesture();
    expect(harness.session.getSnapshot().microphone).toMatchObject({
      issue: "track-muted",
      status: "suspended",
    });

    harness.microphoneTrack.unmute();
    expect(harness.session.getSnapshot().microphone.status).toBe("active");
  });

  it("marks only the ended resource as device-lost", async () => {
    const harness = createHarness();
    await harness.session.requestMicrophoneFromGesture();
    await harness.session.requestCameraFromGesture();
    const context = requireContext(harness);

    harness.microphoneTrack.end();

    expect(harness.session.getSnapshot()).toMatchObject({
      camera: { status: "active" },
      microphone: {
        canRetry: true,
        issue: "device-lost",
        status: "device-lost",
      },
    });
    expect(harness.microphoneTrack.stop).toHaveBeenCalledOnce();
    expect(harness.cameraTrack.stop).not.toHaveBeenCalled();
    expect(context.source.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("uses conservative device-change reconciliation", async () => {
    const harness = createHarness();
    await harness.session.requestMicrophoneFromGesture();

    harness.devices.enumerateDevices.mockResolvedValueOnce([]);
    harness.devices.changeDevices();
    await flushAsyncEvents();
    expect(harness.session.getSnapshot().microphone.status).toBe("active");

    harness.devices.enumerateDevices.mockRejectedValueOnce(namedError("NotAllowedError"));
    harness.devices.changeDevices();
    await flushAsyncEvents();
    expect(harness.session.getSnapshot().microphone.status).toBe("active");

    harness.devices.enumerateDevices.mockResolvedValueOnce([
      mediaDevice("mic-1", "audioinput"),
      mediaDevice("camera-2", "videoinput"),
    ]);
    harness.devices.changeDevices();
    await flushAsyncEvents();
    expect(harness.session.getSnapshot().microphone.status).toBe("active");

    harness.devices.enumerateDevices.mockResolvedValueOnce([mediaDevice("mic-2", "audioinput")]);
    harness.devices.changeDevices();
    await flushAsyncEvents();
    expect(harness.session.getSnapshot().microphone).toMatchObject({
      issue: "device-lost",
      status: "device-lost",
    });
  });

  it("does not apply stale device enumeration to a retried stream", async () => {
    const harness = createHarness();
    await harness.session.requestMicrophoneFromGesture();
    const enumeration = deferred<MediaDeviceInfo[]>();
    harness.devices.enumerateDevices.mockReturnValueOnce(enumeration.promise);
    harness.devices.changeDevices();

    const currentTrack = createMicrophoneTrack("mic-current");
    const currentStream = new FakeStream([currentTrack]);
    await harness.session.useFallbackInput();
    harness.devices.getUserMedia.mockResolvedValueOnce(asMediaStream(currentStream));
    await harness.session.requestMicrophoneFromGesture();

    enumeration.resolve([mediaDevice("different-mic", "audioinput")]);
    await flushAsyncEvents();

    expect(harness.session.getSnapshot().microphone.status).toBe("active");
    expect(currentTrack.stop).not.toHaveBeenCalled();
  });

  it("supports fallback selection and a later retry", async () => {
    const harness = createHarness();
    harness.devices.getUserMedia.mockRejectedValueOnce(namedError("NotAllowedError"));

    await harness.session.requestMicrophoneFromGesture();
    await harness.session.useFallbackInput();

    expect(harness.session.getSnapshot().microphone).toMatchObject({
      canRetry: true,
      issue: "player-selected-fallback",
      status: "fallback",
    });

    const retried = await harness.session.requestMicrophoneFromGesture();
    expect(retried.status).toBe("active");
    expect(harness.devices.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("stops stale streams when fallback and retry overtake a pending prompt", async () => {
    const harness = createHarness();
    const firstPrompt = deferred<MediaStream>();
    const staleTrack = createMicrophoneTrack("stale-mic");
    const staleStream = new FakeStream([staleTrack]);
    const currentTrack = createMicrophoneTrack("current-mic");
    const currentStream = new FakeStream([currentTrack]);
    harness.devices.getUserMedia
      .mockReturnValueOnce(firstPrompt.promise)
      .mockResolvedValueOnce(asMediaStream(currentStream));

    const staleRequest = harness.session.requestMicrophoneFromGesture();
    await harness.session.useFallbackInput();
    const currentRequest = harness.session.requestMicrophoneFromGesture();
    await expect(currentRequest).resolves.toMatchObject({ status: "active" });

    firstPrompt.resolve(asMediaStream(staleStream));
    await expect(staleRequest).resolves.toMatchObject({ status: "active" });

    expect(staleTrack.stop).toHaveBeenCalledOnce();
    expect(currentTrack.stop).not.toHaveBeenCalled();
    expect(harness.session.getMicrophoneAudioGraph()?.stream).toBe(asMediaStream(currentStream));
    expect(harness.contexts[0]?.close).toHaveBeenCalledOnce();
  });

  it("cleans every owned resource exactly once", async () => {
    const harness = createHarness();
    const removeDocumentListener = vi.spyOn(harness.document, "removeEventListener");
    const removeDeviceListener = vi.spyOn(harness.devices, "removeEventListener");
    await harness.session.requestMicrophoneFromGesture();
    await harness.session.requestCameraFromGesture();
    const context = requireContext(harness);
    const processor = new FakeAudioNode();
    const unregisterProcessor = harness.session.registerMicrophoneNode(
      processor as unknown as AudioNode,
    );
    const notification = vi.fn();
    harness.session.subscribe(() => {
      throw new Error("subscriber failed");
    });
    harness.session.subscribe(notification);

    const firstClose = harness.session.close();
    const secondClose = harness.session.close();
    await Promise.all([firstClose, secondClose]);

    expect(firstClose).toBe(secondClose);
    expect(harness.microphoneTrack.stop).toHaveBeenCalledOnce();
    expect(harness.cameraTrack.stop).toHaveBeenCalledOnce();
    expect(context.source.disconnect).toHaveBeenCalledOnce();
    expect(processor.disconnect).toHaveBeenCalledOnce();
    unregisterProcessor();
    expect(processor.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(removeDocumentListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(removeDeviceListener).toHaveBeenCalledWith("devicechange", expect.any(Function));
    expect(notification).toHaveBeenCalledOnce();
    expect(harness.session.getSnapshot()).toMatchObject({
      audioContext: "closed",
      camera: { status: "closed" },
      microphone: { status: "closed" },
    });
    expect(() => harness.session.requestCameraFromGesture()).toThrow(MediaSessionClosedError);
  });

  it("stops media that arrives after close without publishing stale state", async () => {
    const harness = createHarness();
    const microphonePrompt = deferred<MediaStream>();
    const cameraPrompt = deferred<MediaStream>();
    harness.devices.getUserMedia.mockImplementation((constraints) =>
      constraints.audio !== false ? microphonePrompt.promise : cameraPrompt.promise,
    );
    const listener = vi.fn();
    harness.session.subscribe(listener);

    const microphoneRequest = harness.session.requestMicrophoneFromGesture();
    const cameraRequest = harness.session.requestCameraFromGesture();
    await harness.session.close();
    const notificationsAfterClose = listener.mock.calls.length;

    expect(harness.contexts[0]?.close).toHaveBeenCalledOnce();
    microphonePrompt.resolve(asMediaStream(harness.microphoneStream));
    cameraPrompt.resolve(asMediaStream(harness.cameraStream));
    await Promise.all([microphoneRequest, cameraRequest]);

    expect(harness.microphoneTrack.stop).toHaveBeenCalledOnce();
    expect(harness.cameraTrack.stop).toHaveBeenCalledOnce();
    expect(harness.contexts[0]?.close).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(notificationsAfterClose);
    expect(harness.session.getSnapshot()).toMatchObject({
      camera: { status: "closed" },
      microphone: { status: "closed" },
    });
  });

  it("closes a provisional audio context without waiting for prompt or resume", async () => {
    const audioResume = deferred<void>();
    const context = new FakeAudioContext();
    context.resume.mockImplementationOnce(async () => {
      await audioResume.promise;
      if (context.state !== "closed") {
        context.transitionTo("running");
      }
    });
    const harness = createHarness({
      createAudioContext: () => context,
    });
    const microphonePrompt = deferred<MediaStream>();
    harness.devices.getUserMedia.mockReturnValueOnce(microphonePrompt.promise);

    const request = harness.session.requestMicrophoneFromGesture();
    await harness.session.close();

    expect(context.close).toHaveBeenCalledOnce();
    microphonePrompt.resolve(asMediaStream(harness.microphoneStream));
    await expect(request).resolves.toMatchObject({ status: "closed" });
    expect(harness.microphoneTrack.stop).toHaveBeenCalledOnce();

    audioResume.resolve();
    await flushAsyncEvents();
    expect(harness.session.getSnapshot().microphone.status).toBe("closed");
  });

  it("continues cleanup when individual browser resources reject or throw", async () => {
    const harness = createHarness();
    const secondTrack = createMicrophoneTrack("mic-2");
    const stream = new FakeStream([harness.microphoneTrack, secondTrack]);
    harness.devices.getUserMedia.mockResolvedValueOnce(asMediaStream(stream));
    await harness.session.requestMicrophoneFromGesture();
    const context = requireContext(harness);
    const throwingNode = new FakeAudioNode();
    throwingNode.disconnect.mockImplementation(() => {
      throw new Error("disconnect failed");
    });
    harness.session.registerMicrophoneNode(throwingNode as unknown as AudioNode);
    harness.microphoneTrack.stop.mockImplementation(() => {
      throw new Error("stop failed");
    });
    context.close.mockRejectedValueOnce(new Error("close failed"));

    await expect(harness.session.close()).resolves.toBeUndefined();

    expect(throwingNode.disconnect).toHaveBeenCalledOnce();
    expect(context.source.disconnect).toHaveBeenCalledOnce();
    expect(harness.microphoneTrack.stop).toHaveBeenCalledOnce();
    expect(secondTrack.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });
});

function createMicrophoneTrack(deviceId = "mic-1"): FakeTrack {
  return new FakeTrack("audio", {
    autoGainControl: false,
    channelCount: 1,
    deviceId,
    echoCancellation: true,
    noiseSuppression: true,
  });
}

function createCameraTrack(deviceId = "camera-1"): FakeTrack {
  return new FakeTrack("video", {
    deviceId,
    facingMode: "user",
    frameRate: 30,
    height: 720,
    width: 1280,
  });
}

function asMediaStream(stream: FakeStream): MediaStream {
  return stream as unknown as MediaStream;
}

function asMediaStreamTrack(track: FakeTrack): MediaStreamTrack {
  return track as unknown as MediaStreamTrack;
}

function asAudioContext(context: FakeAudioContext): AudioContext {
  return context as unknown as AudioContext;
}

function requireContext(harness: Harness): FakeAudioContext {
  const context = harness.contexts[0];
  if (!context) {
    throw new Error("Expected an AudioContext to be created.");
  }
  return context;
}

function namedError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function mediaDevice(deviceId: string, kind: MediaDeviceKind): MediaDeviceInfo {
  return {
    deviceId,
    groupId: "",
    kind,
    label: "",
    toJSON: () => ({}),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    reject(reason?: unknown) {
      rejectPromise?.(reason);
    },
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
}

async function flushAsyncEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
