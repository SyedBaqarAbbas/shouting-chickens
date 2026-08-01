/* global AudioWorkletProcessor, registerProcessor */

/* global currentTime */

const MIN_DBFS = -120;
const CLIPPING_AMPLITUDE = 0.995;

class VoiceRmsProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      let squaredTotal = 0;
      let peak = 0;

      for (const candidate of channel) {
        const sample = Number.isFinite(candidate) ? Math.min(1, Math.max(-1, candidate)) : 0;
        squaredTotal += sample * sample;
        peak = Math.max(peak, Math.abs(Number.isFinite(candidate) ? candidate : 0));
      }

      const rms = Math.sqrt(squaredTotal / channel.length);
      const dbfs = rms <= 0 ? MIN_DBFS : Math.min(0, Math.max(MIN_DBFS, 20 * Math.log10(rms)));

      this.port.postMessage({
        capturedAtMs: currentTime * 1000,
        clipped: peak >= CLIPPING_AMPLITUDE,
        dbfs,
        peak,
        rms,
        type: "voice-energy",
      });
    }

    return true;
  }
}

registerProcessor("voice-rms-processor", VoiceRmsProcessor);
