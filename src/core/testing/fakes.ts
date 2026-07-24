import {
  type AudioContextPort,
  type AudioContextState,
  type MediaCapabilities,
  type MediaGateway,
  type MediaKind,
  type MediaReadyState,
  type MediaStreamPort,
  type MediaTrackPort,
} from "../contracts";

export class FakeMediaTrack implements MediaTrackPort {
  private readonly endedListeners = new Set<() => void>();
  private currentState: MediaReadyState = "live";

  constructor(
    readonly id: string,
    readonly kind: MediaKind,
  ) {}

  get readyState() {
    return this.currentState;
  }

  stop() {
    this.end();
  }

  end() {
    if (this.currentState === "ended") {
      return;
    }

    this.currentState = "ended";

    for (const listener of [...this.endedListeners]) {
      listener();
    }
  }

  onEnded(listener: () => void) {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }
}

export class FakeMediaStream implements MediaStreamPort {
  constructor(private readonly tracks: readonly MediaTrackPort[]) {}

  getTracks(kind?: MediaKind) {
    return kind ? this.tracks.filter((track) => track.kind === kind) : [...this.tracks];
  }
}

export class FakeAudioContext implements AudioContextPort {
  private currentState: AudioContextState = "suspended";
  resumeCount = 0;
  closeCount = 0;

  get state() {
    return this.currentState;
  }

  async resume() {
    if (this.currentState === "closed") {
      throw new Error("Cannot resume a closed audio context");
    }

    this.resumeCount += 1;
    this.currentState = "running";
  }

  async close() {
    if (this.currentState === "closed") {
      return;
    }

    this.closeCount += 1;
    this.currentState = "closed";
  }
}

export class FakeMediaGateway implements MediaGateway {
  readonly microphoneTrack = new FakeMediaTrack("fake-microphone", "microphone");
  readonly cameraTrack = new FakeMediaTrack("fake-camera", "camera");
  readonly audioContext = new FakeAudioContext();
  microphoneRequestCount = 0;
  cameraRequestCount = 0;
  private microphoneFailure: Error | null = null;
  private cameraFailure: Error | null = null;

  constructor(
    private readonly available: MediaCapabilities = {
      microphone: true,
      camera: true,
      audioContext: true,
    },
  ) {}

  capabilities() {
    return { ...this.available };
  }

  failNextMicrophoneRequest(error: Error) {
    this.microphoneFailure = error;
  }

  failNextCameraRequest(error: Error) {
    this.cameraFailure = error;
  }

  async requestMicrophone() {
    this.microphoneRequestCount += 1;

    if (this.microphoneFailure) {
      const error = this.microphoneFailure;
      this.microphoneFailure = null;
      throw error;
    }

    if (!this.available.microphone) {
      throw new Error("Microphone is unavailable");
    }

    return new FakeMediaStream([this.microphoneTrack]);
  }

  async requestCamera() {
    this.cameraRequestCount += 1;

    if (this.cameraFailure) {
      const error = this.cameraFailure;
      this.cameraFailure = null;
      throw error;
    }

    if (!this.available.camera) {
      throw new Error("Camera is unavailable");
    }

    return new FakeMediaStream([this.cameraTrack]);
  }

  createAudioContext() {
    if (!this.available.audioContext) {
      throw new Error("Audio context is unavailable");
    }

    return this.audioContext;
  }
}
