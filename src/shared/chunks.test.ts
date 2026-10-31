// Chunked transcription upload (owner fix 31 Oct 2026): cut-point choice
// and in-order join.
import { describe, expect, it } from 'vitest';
import {
  CHUNK_SECONDS,
  findChunkCut,
  joinChunkLines,
  PcmChunker,
} from './chunks';

const RATE = 24000;

function loud(length: number, amp = 10000): Int16Array {
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) out[i] = i % 2 === 0 ? amp : -amp;
  return out;
}

describe('findChunkCut', () => {
  it('returns null below 20 s', () => {
    expect(findChunkCut(new Int16Array(RATE * 19), RATE)).toBeNull();
  });

  it('cuts at the quietest 80 ms frame in the last 3 s before the 20 s mark', () => {
    const pcm = loud(RATE * CHUNK_SECONDS);
    // A silent 80 ms gap starting 1 s before the 20 s mark.
    const gapStart = RATE * 19;
    pcm.fill(0, gapStart, gapStart + Math.round(0.08 * RATE));
    // A louder decoy earlier (outside the last 3 s) must not win.
    expect(findChunkCut(pcm, RATE)).toBe(gapStart);
  });

  it('ignores quiet audio before the last 3 s', () => {
    const pcm = loud(RATE * CHUNK_SECONDS);
    // Silence at 10 s: outside the search window, so the cut stays in the
    // last 3 s (here every frame is equally loud → earliest frame wins).
    pcm.fill(0, RATE * 10, RATE * 10 + Math.round(0.08 * RATE));
    expect(findChunkCut(pcm, RATE)).toBe(RATE * 17);
  });

  it('keeps the earliest frame on ties', () => {
    expect(findChunkCut(loud(RATE * CHUNK_SECONDS), RATE)).toBe(RATE * 17);
  });
});

describe('PcmChunker', () => {
  it('emits nothing until 20 s, then the cut head, and the tail on flush', () => {
    const chunker = new PcmChunker(RATE);
    const gapStart = RATE * 19;
    // Feed in small worklet-sized pieces.
    const pcm = loud(RATE * 25);
    pcm.fill(0, gapStart, gapStart + Math.round(0.08 * RATE));
    const step = 2400;
    const emitted: Int16Array[] = [];
    for (let i = 0; i < pcm.length; i += step) {
      emitted.push(...chunker.push(pcm.subarray(i, Math.min(i + step, pcm.length))));
    }
    expect(emitted).toHaveLength(1);
    expect(emitted[0].length).toBe(gapStart);
    const tail = chunker.flush();
    expect(tail?.length).toBe(pcm.length - gapStart);
    expect(chunker.flush()).toBeNull();
  });
});

describe('joinChunkLines', () => {
  it('joins chunk lines in chunk order and renumbers from 1', async () => {
    // Chunks finish out of order (chunk 2 before chunk 1); the join still
    // follows chunk order once the caller awaits them into index order.
    const finish = (text: string, ms: number) =>
      new Promise<{ text: string }[]>((resolve) => setTimeout(() => resolve([{ text }]), ms));
    const [second, first] = await Promise.all([finish('second', 5), finish('first', 20)]);
    const lines = joinChunkLines([[first[0]], [second[0]]]);
    expect(lines.map((l) => [l.n, l.text, l.source])).toEqual([
      [1, 'first', 'voice'],
      [2, 'second', 'voice'],
    ]);
  });

  it('keeps chunk-relative timings and skips nothing', () => {
    const lines = joinChunkLines([
      [{ text: 'a', startMs: 0, endMs: 100 }],
      [],
      [{ text: 'b', startMs: 0, endMs: 50 }],
    ]);
    expect(lines).toMatchObject([
      { n: 1, text: 'a', startMs: 0, endMs: 100 },
      { n: 2, text: 'b', startMs: 0, endMs: 50 },
    ]);
  });
});
