// Chunked transcription upload (owner fix 31 Oct 2026): a 117 s recording
// takes ~50 s in one request but ~8 s as six 20 s WAVs in parallel, so the
// client cuts ~20 s PCM chunks while the learner talks and POSTs each to
// /api/transcribe in the background. Pure helpers, so they run in the
// browser and under Vitest.

import type { Line } from './types';

/** Nominal chunk length: ~20 s of PCM per /api/transcribe call. */
export const CHUNK_SECONDS = 20;
/** Cut at most this far before the 20 s mark, at the quietest frame. */
export const CHUNK_CUTBACK_SECONDS = 3;
/** Frame size for the quiet search: 80 ms. */
export const QUIET_FRAME_SECONDS = 0.08;

export function chunkSamples(sampleRate: number): {
  want: number;
  back: number;
  frame: number;
} {
  return {
    want: Math.round(CHUNK_SECONDS * sampleRate),
    back: Math.round(CHUNK_CUTBACK_SECONDS * sampleRate),
    frame: Math.max(1, Math.round(QUIET_FRAME_SECONDS * sampleRate)),
  };
}

/**
 * Earliest cut point (in samples) for buffered PCM, or null when fewer
 * than 20 s are buffered. The cut is the start of the quietest 80 ms
 * frame in the last 3 s before the 20 s mark, so words aren't split.
 * Ties keep the earliest frame (deterministic).
 */
export function findChunkCut(pcm: Int16Array, sampleRate = 24000): number | null {
  const { want, back, frame } = chunkSamples(sampleRate);
  if (pcm.length < want) return null;
  const windowStart = want - back;
  let best = windowStart;
  let bestEnergy = Infinity;
  for (let start = windowStart; start + frame <= want; start += frame) {
    let energy = 0;
    for (let i = start; i < start + frame; i++) {
      const v = pcm[i] / 32768;
      energy += v * v;
    }
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = start;
    }
  }
  return best;
}

/** Accumulates worklet PCM and emits cut chunks. The tail stays buffered. */
export class PcmChunker {
  private parts: Int16Array[] = [];
  private total = 0;

  constructor(private sampleRate = 24000) {}

  /** Feed captured samples; returns zero or more completed chunks. */
  push(samples: Int16Array): Int16Array[] {
    const out: Int16Array[] = [];
    if (samples.length > 0) {
      this.parts.push(samples.slice());
      this.total += samples.length;
    }
    const { want } = chunkSamples(this.sampleRate);
    while (this.total >= want) {
      const flat = this.concat();
      const cut = findChunkCut(flat, this.sampleRate) ?? flat.length;
      out.push(flat.slice(0, cut));
      const rest = flat.slice(cut);
      this.parts = rest.length > 0 ? [rest] : [];
      this.total = rest.length;
    }
    return out;
  }

  /** Whatever is left (the final, usually short chunk); null when empty. */
  flush(): Int16Array | null {
    if (this.total === 0) return null;
    const flat = this.concat();
    this.parts = [];
    this.total = 0;
    return flat.slice();
  }

  private concat(): Int16Array {
    const flat = new Int16Array(this.total);
    let offset = 0;
    for (const part of this.parts) {
      flat.set(part, offset);
      offset += part.length;
    }
    return flat;
  }
}

type ChunkLine = {
  text: string;
  source?: Line['source'];
  startMs?: number;
  endMs?: number;
};

/**
 * The leading run of chunks whose transcription has returned: chunk 0, 1,
 * … up to (not including) the first chunk still pending (null/undefined).
 * A later chunk that returns first waits here until the earlier ones are
 * shown. Used for live captions; the final transcript still joins every
 * chunk once all succeed.
 */
export function visibleChunkPrefix<T extends ChunkLine>(results: (T[] | null | undefined)[]): T[][] {
  const out: T[][] = [];
  for (const r of results) {
    if (r == null) break;
    out.push(r);
  }
  return out;
}

/**
 * Join per-chunk transcript lines in chunk order (chunks may finish out
 * of order; the caller awaits them into index order first). Lines are
 * renumbered from 1. Chunk-relative startMs/endMs are kept as-is.
 */
export function joinChunkLines<T extends ChunkLine>(chunks: T[][]): Line[] {
  const lines: Line[] = [];
  for (const chunk of chunks) {
    for (const item of chunk) {
      lines.push({
        n: lines.length + 1,
        text: item.text,
        source: item.source ?? 'voice',
        ...(item.startMs !== undefined ? { startMs: item.startMs } : {}),
        ...(item.endMs !== undefined ? { endMs: item.endMs } : {}),
      });
    }
  }
  return lines;
}
