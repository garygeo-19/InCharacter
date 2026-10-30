// Voice helpers (REQUIREMENTS.md §9.6): WAV wrapping, bias settings, and
// turn-to-line mapping. The mapping test uses the recorded day-1 response
// (tests/fixtures/transcribe-day1.json): a ~42 s mixed English/Spanish WAV
// sent through file mode with languageBias ["English","Spanish"] and the
// demo part's anchors as keywords.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  encodeWav,
  keywordsFor,
  languageBiasFor,
  transcribeRequestBody,
  turnsToLines,
  VOICE_MAX_KEYWORDS,
  VOICE_SAMPLE_RATE,
  wavProblem,
} from './voice';

describe('encodeWav', () => {
  it('writes a mono 16-bit PCM WAV header that round-trips the samples', () => {
    const pcm = new Int16Array([0, 32767, -32768, 1234, -1234]);
    const wav = encodeWav(pcm);
    expect(wav.length).toBe(44 + pcm.length * 2);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...wav.subarray(offset, offset + length));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + pcm.length * 2);
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(VOICE_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(pcm.length * 2);
    expect(new Int16Array(wav.buffer, wav.byteOffset + 44, pcm.length)).toEqual(pcm);
  });

  it('accepts an empty capture without crashing', () => {
    expect(encodeWav(new Int16Array(0)).length).toBe(44);
  });
});

describe('wavProblem', () => {
  it('accepts what encodeWav writes and rejects non-WAV bytes', () => {
    expect(wavProblem(encodeWav(new Int16Array([1, 2, 3])))).toBeNull();
    expect(wavProblem(new Uint8Array([1, 2, 3]))).not.toBeNull();
    expect(wavProblem(new TextEncoder().encode('not a wav file at all, just text........'))).not.toBeNull();
  });
});

describe('bias settings (§9.6)', () => {
  it('biases English-only for English packs, plus Spanish for es', () => {
    expect(languageBiasFor('en')).toEqual(['English']);
    expect(languageBiasFor('en-US')).toEqual(['English']);
    expect(languageBiasFor('es')).toEqual(['English', 'Spanish']);
  });

  it('caps keywords at 50 anchors', () => {
    const anchors = Array.from({ length: 80 }, (_, i) => `term ${i}`);
    const keywords = keywordsFor(anchors);
    expect(keywords).toHaveLength(VOICE_MAX_KEYWORDS);
    expect(keywords[0]).toBe('term 0');
  });

  it('builds the file-mode request part', () => {
    expect(transcribeRequestBody({ packLanguage: 'es', anchors: ['la carta'] })).toEqual({
      model: 'muse-voice-transcribe-1.0',
      mode: 'ENDPOINTING',
      audioEncoding: 'WAV',
      languageBias: ['English', 'Spanish'],
      keywords: ['la carta'],
    });
  });
});

describe('turnsToLines (recorded day-1 response)', () => {
  const recorded = JSON.parse(
    readFileSync(resolve(__dirname, '../../tests/fixtures/transcribe-day1.json'), 'utf8'),
  ) as { audioDurationMs: number; turns: { turnId: number; startMs: number; endMs: number; transcript: string }[] };

  it('turns each returned turn into one voice line', () => {
    expect(recorded.audioDurationMs).toBe(41600);
    const lines = turnsToLines(recorded.turns);
    expect(lines).toHaveLength(recorded.turns.length);
    expect(lines[0]).toMatchObject({
      n: 1,
      source: 'voice',
      startMs: 0,
      endMs: 41100,
    });
    // The Spanish terms came out intact through file mode.
    for (const term of ['La carta', 'el menú', 'el menú del día', 'quisiera', 'el pollo', 'Buen provecho', 'La propina', 'Paella valenciana']) {
      expect(lines[0].text).toContain(term);
    }
  });

  it('numbers lines from 1 and skips empty turns', () => {
    const lines = turnsToLines([
      { turnId: 1, transcript: 'First.' },
      { turnId: 2, transcript: '   ' },
      { turnId: 3, startMs: 100, endMs: 200, transcript: 'Second.' },
    ]);
    expect(lines.map((l) => [l.n, l.text, l.source])).toEqual([
      [1, 'First.', 'voice'],
      [2, 'Second.', 'voice'],
    ]);
    expect(lines[1]).toMatchObject({ startMs: 100, endMs: 200 });
  });
});
