export type MediaKind = "microphone" | "camera";

export type MediaResourceStatus =
  | "idle"
  | "requesting"
  | "active"
  | "suspended"
  | "unsupported"
  | "denied"
  | "unavailable"
  | "device-lost"
  | "fallback"
  | "closed";

export type MediaStateIssue =
  | "api-unavailable"
  | "insecure-context"
  | "audio-context-unavailable"
  | "permission-denied"
  | "no-device"
  | "device-busy"
  | "constraints-unsatisfied"
  | "request-aborted"
  | "unknown"
  | "device-lost"
  | "backgrounded"
  | "paused"
  | "track-muted"
  | "audio-context-suspended"
  | "audio-context-closed"
  | "player-selected-fallback"
  | "session-closed";

export type IgnoredMediaPreference =
  | "mono"
  | "echo-cancellation"
  | "noise-suppression"
  | "automatic-gain-control-off"
  | "front-camera"
  | "720p"
  | "30fps-cap";

export interface MediaResourceState {
  readonly kind: MediaKind;
  readonly status: MediaResourceStatus;
  readonly issue?: MediaStateIssue;
  readonly ignoredPreferences: readonly IgnoredMediaPreference[];
  readonly canRetry: boolean;
  readonly canFallback: boolean;
}

export type ManagedAudioContextState = "unavailable" | "none" | "running" | "suspended" | "closed";

export interface MediaSessionSnapshot {
  readonly microphone: MediaResourceState;
  readonly camera: MediaResourceState;
  readonly visibility: "visible" | "hidden";
  readonly audioContext: ManagedAudioContextState;
  readonly resumeRequired: boolean;
}

export interface MicrophoneAudioGraph {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
}

export interface MediaSessionDependencies {
  readonly mediaDevices?: MediaDevices;
  readonly document?: Document;
  readonly createAudioContext?: () => AudioContext;
  readonly isSecureContext: boolean;
  readonly isUserActivationActive?: () => boolean;
}

interface TrackListeners {
  readonly ended: EventListener;
  readonly mute: EventListener;
  readonly unmute: EventListener;
}

interface CameraResource {
  readonly generation: number;
  readonly stream: MediaStream;
  readonly tracks: readonly MediaStreamTrack[];
  readonly listeners: ReadonlyMap<MediaStreamTrack, TrackListeners>;
  readonly ignoredPreferences: readonly IgnoredMediaPreference[];
}

interface MicrophoneResource extends CameraResource {
  readonly context: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
  readonly nodes: Set<AudioNode>;
  readonly contextStateListener: EventListener;
}

const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    autoGainControl: false,
    channelCount: { ideal: 1 },
    echoCancellation: true,
    noiseSuppression: true,
  },
  video: false,
};

const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: "user" },
    frameRate: { ideal: 30 },
    height: { ideal: 720 },
    width: { ideal: 1280 },
  },
};

export class MediaGestureRequiredError extends Error {
  constructor() {
    super("This media action must be started from an active user gesture.");
    this.name = "MediaGestureRequiredError";
  }
}

export class MediaSessionClosedError extends Error {
  constructor() {
    super("The media session has already been closed.");
    this.name = "MediaSessionClosedError";
  }
}

export class BrowserMediaSession {
  private readonly dependencies: MediaSessionDependencies;
  private readonly listeners = new Set<() => void>();
  private microphoneState: MediaResourceState;
  private cameraState: MediaResourceState;
  private snapshotValue: MediaSessionSnapshot;
  private microphoneResource?: MicrophoneResource;
  private cameraResource?: CameraResource;
  private readonly pendingMicrophoneContexts = new Map<number, AudioContext>();
  private microphoneRequest?: Promise<MediaResourceState>;
  private cameraRequest?: Promise<MediaResourceState>;
  private microphoneGeneration = 0;
  private cameraGeneration = 0;
  private closed = false;
  private closePromise?: Promise<void>;

  private readonly handleVisibilityChange = () => {
    if (this.closed) {
      return;
    }

    if (this.visibility === "hidden") {
      void this.suspendResources("backgrounded");
      return;
    }

    this.restoreVisibleCamera();
    this.publish();
  };

  private readonly handleDeviceChange = () => {
    void this.reconcileActiveDevices();
  };

  constructor(dependencies: MediaSessionDependencies) {
    this.dependencies = dependencies;
    this.microphoneState = this.initialState("microphone");
    this.cameraState = this.initialState("camera");
    this.snapshotValue = this.buildSnapshot();

    dependencies.document?.addEventListener("visibilitychange", this.handleVisibilityChange);
    dependencies.mediaDevices?.addEventListener("devicechange", this.handleDeviceChange);
  }

  readonly getSnapshot = (): MediaSessionSnapshot => this.snapshotValue;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.closed) {
      return () => undefined;
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getMicrophoneAudioGraph(): MicrophoneAudioGraph | undefined {
    const resource = this.microphoneResource;
    if (!resource) {
      return undefined;
    }

    return {
      context: resource.context,
      source: resource.source,
      stream: resource.stream,
    };
  }

  getCameraStream(): MediaStream | undefined {
    return this.cameraResource?.stream;
  }

  registerMicrophoneNode(node: AudioNode): () => void {
    const resource = this.microphoneResource;
    if (!resource) {
      throw new Error("A microphone must be active before registering an audio node.");
    }

    resource.nodes.add(node);
    let registered = true;

    return () => {
      if (!registered) {
        return;
      }

      registered = false;
      if (resource.nodes.delete(node)) {
        disconnectNode(node);
      }
    };
  }

  requestMicrophoneFromGesture(): Promise<MediaResourceState> {
    this.assertOpen();

    if (this.microphoneRequest) {
      return this.microphoneRequest;
    }

    if (this.microphoneState.status === "active" || this.microphoneState.status === "suspended") {
      return Promise.resolve(this.microphoneState);
    }

    this.assertUserGesture();
    const unsupported = this.unsupportedState("microphone");
    if (unsupported) {
      this.setMicrophoneState(unsupported);
      return Promise.resolve(unsupported);
    }

    const generation = ++this.microphoneGeneration;
    this.releaseMicrophoneResource();
    this.setMicrophoneState(createState("microphone", "requesting"));

    const request = this.acquireMicrophone(generation);
    this.microphoneRequest = request;
    void request.then(
      () => {
        if (this.microphoneRequest === request) {
          this.microphoneRequest = undefined;
        }
      },
      () => {
        if (this.microphoneRequest === request) {
          this.microphoneRequest = undefined;
        }
      },
    );

    return request;
  }

  requestCameraFromGesture(): Promise<MediaResourceState> {
    this.assertOpen();

    if (this.cameraRequest) {
      return this.cameraRequest;
    }

    if (this.cameraState.status === "active" || this.cameraState.status === "suspended") {
      return Promise.resolve(this.cameraState);
    }

    this.assertUserGesture();
    const unsupported = this.unsupportedState("camera");
    if (unsupported) {
      this.setCameraState(unsupported);
      return Promise.resolve(unsupported);
    }

    const generation = ++this.cameraGeneration;
    this.releaseCameraResource();
    this.setCameraState(createState("camera", "requesting"));

    const request = this.acquireCamera(generation);
    this.cameraRequest = request;
    void request.then(
      () => {
        if (this.cameraRequest === request) {
          this.cameraRequest = undefined;
        }
      },
      () => {
        if (this.cameraRequest === request) {
          this.cameraRequest = undefined;
        }
      },
    );

    return request;
  }

  async suspend(): Promise<void> {
    this.assertOpen();
    await this.suspendResources("paused");
  }

  async resumeFromGesture(): Promise<MediaSessionSnapshot> {
    this.assertOpen();

    if (!this.snapshotValue.resumeRequired) {
      return this.snapshotValue;
    }

    this.assertUserGesture();
    if (this.visibility === "hidden") {
      return this.snapshotValue;
    }

    const microphone = this.microphoneResource;
    const microphoneGeneration = microphone?.generation;
    let audioRunning = microphone === undefined;

    if (microphone) {
      if (microphone.context.state === "running") {
        audioRunning = true;
      } else if (microphone.context.state !== "closed") {
        try {
          await microphone.context.resume();
          audioRunning = isAudioContextRunning(microphone.context);
        } catch {
          audioRunning = false;
        }
      }

      if (
        this.closed ||
        isDocumentHidden(this.dependencies.document) ||
        this.microphoneResource !== microphone ||
        microphone.generation !== microphoneGeneration
      ) {
        return this.snapshotValue;
      }

      const microphoneMuted = microphone.tracks.some((track) => track.muted);
      audioRunning =
        audioRunning &&
        !microphoneMuted &&
        microphone.tracks.every((track) => track.readyState === "live");
      setTracksEnabled(microphone.tracks, audioRunning);
      this.microphoneState = audioRunning
        ? createState("microphone", "active", undefined, microphone.ignoredPreferences)
        : createState(
            "microphone",
            "suspended",
            microphoneMuted ? "track-muted" : "audio-context-suspended",
            microphone.ignoredPreferences,
          );
    }

    if (this.closed || isDocumentHidden(this.dependencies.document)) {
      return this.snapshotValue;
    }

    this.restoreVisibleCamera(true);
    this.publish();
    return this.snapshotValue;
  }

  async useFallbackInput(): Promise<void> {
    this.assertOpen();
    ++this.microphoneGeneration;
    this.microphoneRequest = undefined;
    const closing = this.releaseMicrophoneResource();
    this.setMicrophoneState(createState("microphone", "fallback", "player-selected-fallback"));
    await closing;
  }

  stopCamera(): void {
    this.assertOpen();
    ++this.cameraGeneration;
    this.cameraRequest = undefined;
    this.releaseCameraResource();
    this.setCameraState(this.initialState("camera"));
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closed = true;
    ++this.microphoneGeneration;
    ++this.cameraGeneration;
    this.microphoneRequest = undefined;
    this.cameraRequest = undefined;

    this.dependencies.document?.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.dependencies.mediaDevices?.removeEventListener("devicechange", this.handleDeviceChange);

    const microphoneClosing = this.releaseMicrophoneResource();
    this.releaseCameraResource();
    this.microphoneState = createState("microphone", "closed", "session-closed");
    this.cameraState = createState("camera", "closed", "session-closed");
    this.publish();
    this.listeners.clear();

    this.closePromise = microphoneClosing;
    return this.closePromise;
  }

  private async acquireMicrophone(generation: number): Promise<MediaResourceState> {
    const mediaDevices = this.dependencies.mediaDevices;
    const createAudioContext = this.dependencies.createAudioContext;

    if (!mediaDevices || !createAudioContext) {
      const state =
        this.unsupportedState("microphone") ??
        createState("microphone", "unsupported", "audio-context-unavailable");
      this.publishMicrophoneIfCurrent(generation, state);
      return state;
    }

    let context: AudioContext;
    try {
      context = createAudioContext();
    } catch {
      const state = createState("microphone", "unsupported", "audio-context-unavailable");
      this.publishMicrophoneIfCurrent(generation, state);
      return state;
    }
    this.pendingMicrophoneContexts.set(generation, context);

    const resumeAttempt =
      context.state === "suspended"
        ? resumeContext(context)
        : Promise.resolve(context.state === "running");

    let stream: MediaStream;
    try {
      const streamRequest = mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS);
      stream = await streamRequest;
    } catch (error) {
      this.pendingMicrophoneContexts.delete(generation);
      await closeContext(context);
      const state = stateFromRequestError("microphone", error);
      if (!this.isMicrophoneGenerationCurrent(generation)) {
        return this.microphoneState;
      }
      this.publishMicrophoneIfCurrent(generation, state);
      return state;
    }

    if (!this.isMicrophoneGenerationCurrent(generation)) {
      this.pendingMicrophoneContexts.delete(generation);
      stopStream(stream);
      await closeContext(context);
      return this.microphoneState;
    }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      this.pendingMicrophoneContexts.delete(generation);
      stopStream(stream);
      await closeContext(context);
      const state = createState("microphone", "unavailable", "no-device");
      this.publishMicrophoneIfCurrent(generation, state);
      return state;
    }
    if (audioTracks.every((track) => track.readyState === "ended")) {
      this.pendingMicrophoneContexts.delete(generation);
      stopStream(stream);
      await closeContext(context);
      const state = createState("microphone", "device-lost", "device-lost");
      this.publishMicrophoneIfCurrent(generation, state);
      return state;
    }

    let source: MediaStreamAudioSourceNode;
    try {
      source = context.createMediaStreamSource(stream);
    } catch {
      this.pendingMicrophoneContexts.delete(generation);
      stopStream(stream);
      await closeContext(context);
      const state = createState("microphone", "unavailable", "unknown");
      this.publishMicrophoneIfCurrent(generation, state);
      return state;
    }

    const tracks = stream.getTracks();
    const ignoredPreferences = inspectMicrophonePreferences(audioTracks[0]);
    const contextStateListener = () => {
      this.handleAudioContextStateChange(generation);
    };
    context.addEventListener("statechange", contextStateListener);

    const resource: MicrophoneResource = {
      context,
      contextStateListener,
      generation,
      ignoredPreferences,
      listeners: new Map(),
      nodes: new Set([source]),
      source,
      stream,
      tracks,
    };
    this.microphoneResource = resource;
    this.pendingMicrophoneContexts.delete(generation);
    this.attachTrackListeners("microphone", resource);

    void resumeAttempt.then((resumed) => {
      this.handleInitialAudioResume(generation, resumed);
    });
    const shouldSuspend = this.visibility === "hidden" || context.state !== "running";
    setTracksEnabled(tracks, !shouldSuspend);
    const state = shouldSuspend
      ? createState(
          "microphone",
          "suspended",
          this.visibility === "hidden" ? "backgrounded" : "audio-context-suspended",
          ignoredPreferences,
        )
      : createState("microphone", "active", undefined, ignoredPreferences);
    this.setMicrophoneState(state);
    return state;
  }

  private async acquireCamera(generation: number): Promise<MediaResourceState> {
    const mediaDevices = this.dependencies.mediaDevices;
    if (!mediaDevices) {
      const state =
        this.unsupportedState("camera") ?? createState("camera", "unsupported", "api-unavailable");
      this.publishCameraIfCurrent(generation, state);
      return state;
    }

    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    } catch (error) {
      const state = stateFromRequestError("camera", error);
      if (!this.isCameraGenerationCurrent(generation)) {
        return this.cameraState;
      }
      this.publishCameraIfCurrent(generation, state);
      return state;
    }

    if (!this.isCameraGenerationCurrent(generation)) {
      stopStream(stream);
      return this.cameraState;
    }

    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length === 0) {
      stopStream(stream);
      const state = createState("camera", "unavailable", "no-device");
      this.publishCameraIfCurrent(generation, state);
      return state;
    }
    if (videoTracks.every((track) => track.readyState === "ended")) {
      stopStream(stream);
      const state = createState("camera", "device-lost", "device-lost");
      this.publishCameraIfCurrent(generation, state);
      return state;
    }

    const tracks = stream.getTracks();
    const ignoredPreferences = inspectCameraPreferences(videoTracks[0]);
    const resource: CameraResource = {
      generation,
      ignoredPreferences,
      listeners: new Map(),
      stream,
      tracks,
    };
    this.cameraResource = resource;
    this.attachTrackListeners("camera", resource);

    const shouldSuspend = this.visibility === "hidden";
    setTracksEnabled(tracks, !shouldSuspend);
    const state = shouldSuspend
      ? createState("camera", "suspended", "backgrounded", ignoredPreferences)
      : createState("camera", "active", undefined, ignoredPreferences);
    this.setCameraState(state);
    return state;
  }

  private attachTrackListeners(kind: MediaKind, resource: CameraResource): void {
    const mutableListeners = resource.listeners as Map<MediaStreamTrack, TrackListeners>;

    for (const track of resource.tracks) {
      const listeners: TrackListeners = {
        ended: () => {
          this.handleTrackEnded(kind, resource.generation);
        },
        mute: () => {
          this.handleTrackMuted(kind, resource.generation);
        },
        unmute: () => {
          this.handleTrackUnmuted(kind, resource.generation);
        },
      };
      track.addEventListener("ended", listeners.ended);
      track.addEventListener("mute", listeners.mute);
      track.addEventListener("unmute", listeners.unmute);
      mutableListeners.set(track, listeners);
    }
  }

  private handleTrackEnded(kind: MediaKind, generation: number): void {
    if (this.closed) {
      return;
    }

    if (kind === "microphone" && this.microphoneResource?.generation === generation) {
      ++this.microphoneGeneration;
      void this.releaseMicrophoneResource();
      this.setMicrophoneState(createState("microphone", "device-lost", "device-lost"));
    } else if (kind === "camera" && this.cameraResource?.generation === generation) {
      ++this.cameraGeneration;
      this.releaseCameraResource();
      this.setCameraState(createState("camera", "device-lost", "device-lost"));
    }
  }

  private handleTrackMuted(kind: MediaKind, generation: number): void {
    if (this.closed) {
      return;
    }

    if (kind === "microphone" && this.microphoneResource?.generation === generation) {
      this.setMicrophoneState(
        createState(
          "microphone",
          "suspended",
          "track-muted",
          this.microphoneResource.ignoredPreferences,
        ),
      );
    } else if (kind === "camera" && this.cameraResource?.generation === generation) {
      this.setCameraState(
        createState("camera", "suspended", "track-muted", this.cameraResource.ignoredPreferences),
      );
    }
  }

  private handleTrackUnmuted(kind: MediaKind, generation: number): void {
    if (this.closed || this.visibility === "hidden") {
      return;
    }

    if (
      kind === "microphone" &&
      this.microphoneResource?.generation === generation &&
      this.microphoneResource.context.state === "running"
    ) {
      setTracksEnabled(this.microphoneResource.tracks, true);
      this.setMicrophoneState(
        createState("microphone", "active", undefined, this.microphoneResource.ignoredPreferences),
      );
    } else if (kind === "camera" && this.cameraResource?.generation === generation) {
      setTracksEnabled(this.cameraResource.tracks, true);
      this.setCameraState(
        createState("camera", "active", undefined, this.cameraResource.ignoredPreferences),
      );
    }
  }

  private handleAudioContextStateChange(generation: number): void {
    const resource = this.microphoneResource;
    if (this.closed || !resource || resource.generation !== generation) {
      return;
    }

    if (resource.context.state === "closed") {
      ++this.microphoneGeneration;
      void this.releaseMicrophoneResource();
      this.setMicrophoneState(createState("microphone", "unavailable", "audio-context-closed"));
      return;
    }

    if (resource.context.state !== "running") {
      setTracksEnabled(resource.tracks, false);
      this.setMicrophoneState(
        createState(
          "microphone",
          "suspended",
          this.visibility === "hidden" ? "backgrounded" : "audio-context-suspended",
          resource.ignoredPreferences,
        ),
      );
    }
  }

  private handleInitialAudioResume(generation: number, resumed: boolean): void {
    const resource = this.microphoneResource;
    if (
      !resumed ||
      this.closed ||
      this.visibility === "hidden" ||
      !resource ||
      resource.generation !== generation ||
      resource.context.state !== "running" ||
      resource.tracks.some((track) => track.readyState !== "live" || track.muted) ||
      this.microphoneState.status === "active"
    ) {
      return;
    }

    setTracksEnabled(resource.tracks, true);
    this.setMicrophoneState(
      createState("microphone", "active", undefined, resource.ignoredPreferences),
    );
  }

  private suspendResources(issue: "backgrounded" | "paused"): Promise<void> {
    let audioSuspension = Promise.resolve();
    const microphone = this.microphoneResource;
    if (microphone) {
      setTracksEnabled(microphone.tracks, false);
      this.microphoneState = createState(
        "microphone",
        "suspended",
        issue,
        microphone.ignoredPreferences,
      );
      if (microphone.context.state === "running") {
        audioSuspension = suspendContext(microphone.context);
      }
    }

    const camera = this.cameraResource;
    if (camera) {
      setTracksEnabled(camera.tracks, false);
      this.cameraState = createState("camera", "suspended", issue, camera.ignoredPreferences);
    }

    this.publish();
    return audioSuspension;
  }

  private restoreVisibleCamera(includePaused = false): void {
    const camera = this.cameraResource;
    if (
      !camera ||
      this.visibility === "hidden" ||
      this.cameraState.status !== "suspended" ||
      (this.cameraState.issue !== "backgrounded" &&
        (!includePaused || this.cameraState.issue !== "paused"))
    ) {
      return;
    }

    setTracksEnabled(camera.tracks, true);
    this.cameraState = createState("camera", "active", undefined, camera.ignoredPreferences);
  }

  private async reconcileActiveDevices(): Promise<void> {
    if (this.closed) {
      return;
    }

    const microphone = this.microphoneResource;
    const camera = this.cameraResource;
    const microphoneGeneration = microphone?.generation;
    const cameraGeneration = camera?.generation;

    if (microphone?.tracks.some((track) => track.readyState === "ended")) {
      this.handleTrackEnded("microphone", microphone.generation);
    }
    if (camera?.tracks.some((track) => track.readyState === "ended")) {
      this.handleTrackEnded("camera", camera.generation);
    }

    const enumerateDevices = this.dependencies.mediaDevices?.enumerateDevices;
    if (!enumerateDevices || (!microphone && !camera)) {
      return;
    }

    let devices: MediaDeviceInfo[];
    try {
      devices = await enumerateDevices.call(this.dependencies.mediaDevices);
    } catch {
      return;
    }

    if (this.closed) {
      return;
    }

    const audioInputIds = new Set(
      devices
        .filter((device) => device.kind === "audioinput")
        .map((device) => device.deviceId)
        .filter((deviceId) => deviceId.length > 0),
    );
    const videoInputIds = new Set(
      devices
        .filter((device) => device.kind === "videoinput")
        .map((device) => device.deviceId)
        .filter((deviceId) => deviceId.length > 0),
    );
    const currentMicrophone = this.microphoneResource;
    if (
      currentMicrophone &&
      currentMicrophone.generation === microphoneGeneration &&
      audioInputIds.size > 0 &&
      resourceDeviceMissing(currentMicrophone, audioInputIds)
    ) {
      this.handleTrackEnded("microphone", currentMicrophone.generation);
    }

    const currentCamera = this.cameraResource;
    if (
      currentCamera &&
      currentCamera.generation === cameraGeneration &&
      videoInputIds.size > 0 &&
      resourceDeviceMissing(currentCamera, videoInputIds)
    ) {
      this.handleTrackEnded("camera", currentCamera.generation);
    }
  }

  private releaseMicrophoneResource(): Promise<void> {
    const resource = this.microphoneResource;
    this.microphoneResource = undefined;
    const contextsToClose = [...this.pendingMicrophoneContexts.values()];
    this.pendingMicrophoneContexts.clear();

    if (resource) {
      resource.context.removeEventListener("statechange", resource.contextStateListener);
      detachTrackListeners(resource);
      for (const node of resource.nodes) {
        disconnectNode(node);
      }
      resource.nodes.clear();
      stopStream(resource.stream);
      contextsToClose.push(resource.context);
    }

    return Promise.allSettled(contextsToClose.map(closeContext)).then(() => undefined);
  }

  private releaseCameraResource(): void {
    const resource = this.cameraResource;
    this.cameraResource = undefined;
    if (!resource) {
      return;
    }

    detachTrackListeners(resource);
    stopStream(resource.stream);
  }

  private publishMicrophoneIfCurrent(generation: number, state: MediaResourceState): void {
    if (this.isMicrophoneGenerationCurrent(generation)) {
      this.setMicrophoneState(state);
    }
  }

  private publishCameraIfCurrent(generation: number, state: MediaResourceState): void {
    if (this.isCameraGenerationCurrent(generation)) {
      this.setCameraState(state);
    }
  }

  private isMicrophoneGenerationCurrent(generation: number): boolean {
    return !this.closed && this.microphoneGeneration === generation;
  }

  private isCameraGenerationCurrent(generation: number): boolean {
    return !this.closed && this.cameraGeneration === generation;
  }

  private initialState(kind: MediaKind): MediaResourceState {
    return this.unsupportedState(kind) ?? createState(kind, "idle");
  }

  private unsupportedState(kind: MediaKind): MediaResourceState | undefined {
    if (!this.dependencies.isSecureContext) {
      return createState(kind, "unsupported", "insecure-context");
    }
    if (!this.dependencies.mediaDevices) {
      return createState(kind, "unsupported", "api-unavailable");
    }
    if (kind === "microphone" && !this.dependencies.createAudioContext) {
      return createState(kind, "unsupported", "audio-context-unavailable");
    }
    return undefined;
  }

  private assertUserGesture(): void {
    if (this.dependencies.isUserActivationActive && !this.dependencies.isUserActivationActive()) {
      throw new MediaGestureRequiredError();
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new MediaSessionClosedError();
    }
  }

  private setMicrophoneState(state: MediaResourceState): void {
    this.microphoneState = state;
    this.publish();
  }

  private setCameraState(state: MediaResourceState): void {
    this.cameraState = state;
    this.publish();
  }

  private publish(): void {
    this.snapshotValue = this.buildSnapshot();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One UI subscriber must not block cleanup or other subscribers.
      }
    }
  }

  private buildSnapshot(): MediaSessionSnapshot {
    const microphone = this.microphoneState;
    const camera = this.cameraState;
    const visibility = this.visibility;
    const context = this.microphoneResource?.context;
    const audioContext: ManagedAudioContextState =
      this.microphoneState.issue === "audio-context-closed"
        ? "closed"
        : this.microphoneState.issue === "audio-context-unavailable"
          ? "unavailable"
          : context
            ? context.state === "running"
              ? "running"
              : context.state === "closed"
                ? "closed"
                : "suspended"
            : this.closed
              ? "closed"
              : this.dependencies.createAudioContext
                ? "none"
                : "unavailable";

    return Object.freeze({
      audioContext,
      camera,
      microphone,
      resumeRequired:
        visibility === "visible" &&
        ((microphone.status === "suspended" && microphone.issue !== "track-muted") ||
          (camera.status === "suspended" && camera.issue !== "track-muted")),
      visibility,
    });
  }

  private get visibility(): "visible" | "hidden" {
    return this.dependencies.document?.visibilityState === "hidden" ? "hidden" : "visible";
  }
}

export function createBrowserMediaSession(): BrowserMediaSession {
  const browserNavigator = typeof navigator === "undefined" ? undefined : navigator;
  const browserDocument = typeof document === "undefined" ? undefined : document;
  const scope = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextConstructor =
    typeof AudioContext === "undefined" ? scope.webkitAudioContext : AudioContext;
  const userActivation = browserNavigator?.userActivation;

  return new BrowserMediaSession({
    createAudioContext: AudioContextConstructor ? () => new AudioContextConstructor() : undefined,
    document: browserDocument,
    isSecureContext:
      typeof globalThis.isSecureContext === "boolean" ? globalThis.isSecureContext : false,
    isUserActivationActive: userActivation ? () => userActivation.isActive : undefined,
    mediaDevices: browserNavigator?.mediaDevices,
  });
}

function createState(
  kind: MediaKind,
  status: MediaResourceStatus,
  issue?: MediaStateIssue,
  ignoredPreferences: readonly IgnoredMediaPreference[] = [],
): MediaResourceState {
  const canRetry = ["denied", "unavailable", "device-lost", "fallback"].includes(status);
  const canFallback =
    kind === "microphone" && !["requesting", "fallback", "closed"].includes(status);

  return Object.freeze({
    canFallback,
    canRetry,
    ignoredPreferences: Object.freeze([...ignoredPreferences]),
    issue,
    kind,
    status,
  });
}

function stateFromRequestError(kind: MediaKind, error: unknown): MediaResourceState {
  const name = errorName(error);

  if (name === "NotAllowedError" || name === "SecurityError") {
    return createState(kind, "denied", "permission-denied");
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return createState(kind, "unavailable", "no-device");
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return createState(kind, "unavailable", "device-busy");
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return createState(kind, "unavailable", "constraints-unsatisfied");
  }
  if (name === "AbortError") {
    return createState(kind, "unavailable", "request-aborted");
  }
  return createState(kind, "unavailable", "unknown");
}

function errorName(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
  ) {
    return error.name;
  }
  return undefined;
}

function inspectMicrophonePreferences(
  track: MediaStreamTrack | undefined,
): readonly IgnoredMediaPreference[] {
  if (!track) {
    return ["mono", "echo-cancellation", "noise-suppression", "automatic-gain-control-off"];
  }

  const settings = track.getSettings();
  const ignored: IgnoredMediaPreference[] = [];
  if (settings.channelCount !== 1) {
    ignored.push("mono");
  }
  if (settings.echoCancellation !== true) {
    ignored.push("echo-cancellation");
  }
  if (settings.noiseSuppression !== true) {
    ignored.push("noise-suppression");
  }
  if (settings.autoGainControl !== false) {
    ignored.push("automatic-gain-control-off");
  }
  return ignored;
}

function inspectCameraPreferences(
  track: MediaStreamTrack | undefined,
): readonly IgnoredMediaPreference[] {
  if (!track) {
    return ["front-camera", "720p", "30fps-cap"];
  }

  const settings = track.getSettings();
  const ignored: IgnoredMediaPreference[] = [];
  if (settings.facingMode !== "user") {
    ignored.push("front-camera");
  }
  if (settings.width !== 1280 || settings.height !== 720) {
    ignored.push("720p");
  }
  if (settings.frameRate === undefined || settings.frameRate > 30) {
    ignored.push("30fps-cap");
  }
  return ignored;
}

function resourceDeviceMissing(resource: CameraResource, deviceIds: ReadonlySet<string>): boolean {
  const resourceDeviceIds = resource.tracks
    .map((track) => track.getSettings().deviceId)
    .filter((deviceId): deviceId is string => typeof deviceId === "string" && deviceId.length > 0);

  return (
    resourceDeviceIds.length > 0 && resourceDeviceIds.every((deviceId) => !deviceIds.has(deviceId))
  );
}

function detachTrackListeners(resource: CameraResource): void {
  for (const [track, listeners] of resource.listeners) {
    track.removeEventListener("ended", listeners.ended);
    track.removeEventListener("mute", listeners.mute);
    track.removeEventListener("unmute", listeners.unmute);
  }
}

function setTracksEnabled(tracks: readonly MediaStreamTrack[], enabled: boolean): void {
  for (const track of tracks) {
    track.enabled = enabled;
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Continue releasing all owned tracks.
    }
  }
}

function disconnectNode(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // Continue releasing the rest of the audio graph.
  }
}

async function closeContext(context: AudioContext): Promise<void> {
  if (context.state === "closed") {
    return;
  }

  try {
    await context.close();
  } catch {
    // Cleanup is best-effort and must stay idempotent.
  }
}

function isAudioContextRunning(context: AudioContext): boolean {
  return context.state === "running";
}

function isDocumentHidden(documentPort: Document | undefined): boolean {
  return documentPort?.visibilityState === "hidden";
}

async function resumeContext(context: AudioContext): Promise<boolean> {
  try {
    await context.resume();
    return isAudioContextRunning(context);
  } catch {
    return false;
  }
}

async function suspendContext(context: AudioContext): Promise<void> {
  try {
    await context.suspend();
  } catch {
    // State still reports suspension to the app so recovery remains explicit.
  }
}
