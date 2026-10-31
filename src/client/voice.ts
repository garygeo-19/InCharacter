// Browser voice capture (REQUIREMENTS.md §9.6): AudioWorklet mono capture,
// downsampled to 24 kHz 16-bit PCM. The key never reaches the browser; the
// WAV is posted to /api/transcribe, which forwards it server-side.

import { PcmChunker } from '../shared/chunks';
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

export async function startCapture(
  onLevel: (peak: number) => void,
  onSamples?: (samples: Int16Array) => void,
): Promise<VoiceCapture> {
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
    try {
      onSamples?.(copy);
    } catch {
      // A chunking hiccup must never break capture; the full PCM is kept.
    }
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

/**
 * Chunked capture (owner fix 31 Oct 2026): like startCapture, but every
 * ~20 s of PCM (cut at the quietest 80 ms frame in the last 3 s) is
 * delivered to onChunk while recording continues. stop() tears down the
 * mic and returns the tail PCM (null when nothing is left); chunks
 * already delivered are not repeated.
 */
export async function startChunkedCapture(
  onLevel: (peak: number) => void,
  onChunk: (pcm: Int16Array) => void,
): Promise<{ stop: () => Int16Array | null }> {
  const chunker = new PcmChunker(VOICE_SAMPLE_RATE);
  const capture = await startCapture(onLevel, (samples) => {
    for (const cut of chunker.push(samples)) onChunk(cut);
  });
  return {
    stop: () => {
      // Discards the full assembly (the delivered heads plus the tail);
      // the tail is what the caller still needs.
      capture.stop();
      return chunker.flush();
    },
  };
}

// --- Student question playback (REQUIREMENTS.md §4.6) ----------------------
// One shared HTMLAudioElement plays every question. Start class unlocks it
// inside its tap handler (§4.4) by playing a short silent sound, so later
// play() calls outside a gesture work in iOS Safari; the question view
// mounts this same element (QuestionAudioSlot in Teach.tsx).

let questionAudioEl: HTMLAudioElement | null = null;
let silentUrl: string | null = null;

export function sharedQuestionAudio(): HTMLAudioElement {
  if (!questionAudioEl) questionAudioEl = new Audio();
  questionAudioEl.preload = 'auto';
  return questionAudioEl;
}

/** Call inside the Start-class tap handler (§4.4), next to ensureAudioContext. */
export function unlockAudioPlayback(): void {
  try {
    const el = sharedQuestionAudio();
    if (!silentUrl) {
      const wav = encodeWav(new Int16Array(800), 8000);
      silentUrl = URL.createObjectURL(new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }));
    }
    el.src = silentUrl;
    void el.play().catch(() => {
      // Locked or headless: questions fall back to the caption.
    });
  } catch {
    // No audio in this environment.
  }
}

export type QuestionPlayHandlers = {
  onEnded: () => void;
  onError: () => void;
};

/**
 * Play a question mp3 on the shared element. Returns a cleanup that
 * removes the listeners and pauses. A play() rejection reports onError
 * (caption fallback); it never throws.
 */
export function playSharedQuestion(url: string, handlers: QuestionPlayHandlers): () => void {
  const el = sharedQuestionAudio();
  const onEnded = () => handlers.onEnded();
  const onError = () => handlers.onError();
  el.addEventListener('ended', onEnded);
  el.addEventListener('error', onError);
  try {
    if (el.getAttribute('src') !== url) el.setAttribute('src', url);
    el.currentTime = 0;
    void el.play().catch(onError);
  } catch {
    onError();
  }
  return () => {
    el.removeEventListener('ended', onEnded);
    el.removeEventListener('error', onError);
    el.pause();
  };
}

/** Replay the current question: restart the sound, nothing else. */
export function replaySharedQuestion(onError: () => void): void {
  try {
    const el = sharedQuestionAudio();
    el.currentTime = 0;
    void el.play().catch(onError);
  } catch {
    onError();
  }
}
