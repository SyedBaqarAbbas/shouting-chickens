/// <reference types="node" />

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { energyScalarFromSamples } from "../../input";

type RegisteredProcessor = new () => {
  readonly port: {
    postMessage(value: unknown): void;
  };
  process(inputs: readonly (readonly Float32Array[])[]): boolean;
};

describe("voice RMS AudioWorklet", () => {
  it("posts the same scalar contract as the analyser helper and no samples", () => {
    const posted: unknown[] = [];
    const registration: {
      name?: string;
      Processor?: RegisteredProcessor;
    } = {};
    class FakeAudioWorkletProcessor {
      readonly port = {
        postMessage(value: unknown) {
          posted.push(value);
        },
      };
    }
    const currentModuleUrl = import.meta.url;
    const script = readFileSync(
      new URL("../../../public/audio/voice-rms-processor.js", currentModuleUrl),
      "utf8",
    );

    runInNewContext(script, {
      AudioWorkletProcessor: FakeAudioWorkletProcessor,
      currentTime: 1.25,
      registerProcessor(name: string, processor: RegisteredProcessor) {
        registration.name = name;
        registration.Processor = processor;
      },
    });

    const Processor = registration.Processor;
    if (!Processor) {
      throw new Error("The worklet did not register a processor");
    }

    const samples = new Float32Array([0.25, -0.5, 0.75, -1]);
    const processor = new Processor();
    expect(processor.process([[samples]])).toBe(true);
    expect(registration.name).toBe("voice-rms-processor");
    expect(posted).toEqual([
      {
        ...energyScalarFromSamples(samples, 1_250),
        type: "voice-energy",
      },
    ]);
    expect(JSON.stringify(posted)).not.toContain("samples");
  });
});
