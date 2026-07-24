import { describe, expect, it, vi } from "vitest";

import { JsonStore, MemoryStorage } from "../storage";
import { FakeMediaGateway } from "./fakes";

describe("MemoryStorage and JsonStore", () => {
  it("stores validated data without depending on browser storage", () => {
    const storage = new MemoryStorage();
    const store = new JsonStore(
      storage,
      "profile",
      (value): value is { schemaVersion: 1; name: string } =>
        typeof value === "object" &&
        value !== null &&
        "schemaVersion" in value &&
        value.schemaVersion === 1 &&
        "name" in value &&
        typeof value.name === "string",
    );

    store.write({ schemaVersion: 1, name: "local" });
    expect(store.read()).toEqual({ schemaVersion: 1, name: "local" });

    storage.set("profile", "{not-json");
    expect(store.read()).toBeNull();
  });
});

describe("FakeMediaGateway", () => {
  it("tracks independent microphone and camera requests", async () => {
    const media = new FakeMediaGateway();

    const microphone = await media.requestMicrophone();
    const camera = await media.requestCamera();

    expect(microphone.getTracks("microphone")).toEqual([media.microphoneTrack]);
    expect(camera.getTracks("camera")).toEqual([media.cameraTrack]);
    expect(media.microphoneRequestCount).toBe(1);
    expect(media.cameraRequestCount).toBe(1);
  });

  it("ends tracks and closes audio idempotently", async () => {
    const media = new FakeMediaGateway();
    const ended = vi.fn();
    media.microphoneTrack.onEnded(ended);

    media.microphoneTrack.stop();
    media.microphoneTrack.stop();
    await media.audioContext.resume();
    await media.audioContext.close();
    await media.audioContext.close();

    expect(ended).toHaveBeenCalledOnce();
    expect(media.microphoneTrack.readyState).toBe("ended");
    expect(media.audioContext.resumeCount).toBe(1);
    expect(media.audioContext.closeCount).toBe(1);
  });

  it("can inject a one-shot media failure", async () => {
    const media = new FakeMediaGateway();
    media.failNextCameraRequest(new Error("denied"));

    await expect(media.requestCamera()).rejects.toThrow("denied");
    await expect(media.requestCamera()).resolves.toBeDefined();
  });

  it("creates fresh resources after stopped tracks and closed audio contexts", async () => {
    const media = new FakeMediaGateway();
    const firstMicrophone = media.microphoneTrack;
    const firstAudioContext = media.audioContext;

    firstMicrophone.stop();
    await firstAudioContext.close();

    const restartedMicrophone = await media.requestMicrophone();
    const restartedAudioContext = media.createAudioContext();

    expect(media.microphoneTrack).not.toBe(firstMicrophone);
    expect(restartedMicrophone.getTracks("microphone")).toEqual([media.microphoneTrack]);
    expect(media.microphoneTrack.readyState).toBe("live");
    expect(restartedAudioContext).not.toBe(firstAudioContext);
    expect(restartedAudioContext.state).toBe("suspended");
  });
});
