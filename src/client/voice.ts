// Browser voice capture (REQUIREMENTS.md §9.6): AudioWorklet mono capture,
// downsampled to 24 kHz 16-bit PCM. The key never reaches the browser; the
// WAV is posted to /api/transcribe, which forwards it server-side.

import { encodeWav, VOICE_SAMPLE_RATE } from '../shared/voice';

// Runs in the worklet thread: nearest-neighbour downsampling from the
// context rate to 24 kHz, then float → int16. Loaded from a Blob URL so no
// extra build step is needed.
const WORKLET_SOURCE = `
class IcCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const inputRate = options.processorOptions?.inputRate ?? sampleRate;
    this.ratio = inputRate / ${VOICE_SAMPLE_RATE};
    this.pos = 0;
  }
  process(inputs) {
    const channel = inputs[0] ? inputs[0][0] : null;
    if (!channel) return true;
    const out = new Int16Array(Math.ceil((channel.length - this.pos) / this.ratio) + 1);
    let n = 0;
    while (this.pos < channel.length) {
      const s = Math.max(-1, Math.min(1, channel[Math.floor(this.pos)]));
      out[n++] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
      this.pos += this.ratio;
    }
    this.pos -= channel.length;
    this.port.postMessage(out.subarray(0, n), [out.buffer]);
    return true;
  }
}
registerProcessor('ic-capture', IcCapture);
`;

let workletUrl: string | null = null;
let sharedContext: AudioContext | null = null;

/** Create (or reuse) the AudioContext. Call inside a tap handler so iOS
 *  unlocks audio (§4.4); later captures reuse the running context. */
export function ensureAudioContext(): AudioContext {
  if (!sharedContext) sharedContext = new AudioContext();
  void sharedContext.resume().catch(() => {});
  return sharedContext;
}

export type VoiceCapture = {
  /** Stop the mic and return everything captured so far as 24 kHz int16 PCM. */
  stop: () => Int16Array;
};

export async function startCapture(onLevel: (peak: number) => void): Promise<VoiceCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const ctx = ensureAudioContext();
  await ctx.resume().catch(() => {});
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  }
  await ctx.audioWorklet.addModule(workletUrl);
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'ic-capture', {
    processorOptions: { inputRate: ctx.sampleRate },
  });
  // Keep the graph alive without feeding the mic back to the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);

  const chunks: Int16Array[] = [];
  let total = 0;
  let lastLevelAt = 0;
  node.port.onmessage = (event: MessageEvent<Int16Array>) => {
    const chunk = event.data;
    const copy = Int16Array.from(chunk);
    chunks.push(copy);
    total += copy.length;
    const now = performance.now();
    if (now - lastLevelAt > 100) {
      lastLevelAt = now;
      let peak = 0;
      for (let i = 0; i < copy.length; i += 4) {
        const v = Math.abs(copy[i]) / 32768;
        if (v > peak) peak = v;
      }
      onLevel(Math.min(1, peak));
    }
  };

  return {
    stop: () => {
      try {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        sink.disconnect();
      } catch {
        // Already torn down.
      }
      for (const track of stream.getTracks()) track.stop();
      const pcm = new Int16Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        pcm.set(chunk, offset);
        offset += chunk.length;
      }
      return pcm;
    },
  };
}

/** 2-second mic check for the briefing (§4.4). Rejects when the mic is denied. */
export async function checkMic(onLevel: (peak: number) => void): Promise<void> {
  const capture = await startCapture(onLevel);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  capture.stop();
}

/** Wrap captured PCM as a WAV, ready to POST to /api/transcribe. */
export function captureToWav(pcm: Int16Array): Uint8Array {
  return encodeWav(pcm, VOICE_SAMPLE_RATE);
}
