// Voice capture and transcription helpers (REQUIREMENTS.md §9.6).
// Shared by the client (WAV wrapping) and the server (bias settings,
// turn-to-line mapping), so both sides agree on the wire format.

import type { Line } from './types';

/** Capture format everywhere: mono 16-bit PCM at 24 kHz (§9.6). */
export const VOICE_SAMPLE_RATE = 24000;

/** The API takes at most 50 keyword hints per request (§9.6). */
export const VOICE_MAX_KEYWORDS = 50;

/** Model id for transcription (§9.1). */
export const VOICE_MODEL = 'muse-voice-transcribe-1.0';

/**
 * Mic start budget: when capture neither opens nor fails within this long
 * (a hanging permission prompt or worklet load), the turn falls back to
 * typing instead of waiting on silence (§4.4: switch to Type and say so).
 */
export const VOICE_START_TIMEOUT_MS = 8000;

/** Cap on the audio the server accepts per request (§10.2). */
export const TRANSCRIBE_MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** Pack language code → Voice API language name (§9.6 languageBias).
 *  The live catalog only serves en, en-US and es (checked 30 Oct 2026);
 *  anything else falls back to English-only bias. */
const VOICE_LANGUAGE_NAMES: Record<string, string> = {
  es: 'Spanish',
  'es-419': 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
};

export function languageBiasFor(packLanguage: string): string[] {
  if (packLanguage === 'en' || packLanguage === 'en-US') return ['English'];
  const name = VOICE_LANGUAGE_NAMES[packLanguage];
  return name ? ['English', name] : ['English'];
}

/** The API rejects the whole request if any keyword is longer than this (400, seen 30 Oct 2026). */
export const VOICE_MAX_KEYWORD_LENGTH = 30;

/**
 * Part anchors (§6.3) become the transcription keywords: trimmed, de-duplicated, at most 30 characters each
 * (longer anchors are dropped, since a cut-off phrase would bias recognition toward words nobody says), at most 50.
 */
export function keywordsFor(anchors: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of anchors) {
    const k = raw.trim();
    if (!k || k.length > VOICE_MAX_KEYWORD_LENGTH || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
    if (out.length === VOICE_MAX_KEYWORDS) break;
  }
  return out;
}

/** The `request` part of POST /v1/asr/transcribe in file mode (§9.6). */
export function transcribeRequestBody(opts: { packLanguage: string; anchors: string[] }): {
  model: string;
  mode: 'ENDPOINTING';
  audioEncoding: 'WAV';
  languageBias: string[];
  keywords: string[];
} {
  return {
    model: VOICE_MODEL,
    mode: 'ENDPOINTING',
    audioEncoding: 'WAV',
    languageBias: languageBiasFor(opts.packLanguage),
    keywords: keywordsFor(opts.anchors),
  };
}

/** Wrap mono 16-bit PCM samples in a 44-byte RIFF/WAVE header. */
export function encodeWav(pcm: Int16Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes), 44);
  return out;
}

/** Minimal WAV check: RIFF/WAVE, mono 16-bit PCM. Returns an error string or null. */
export function wavProblem(bytes: Uint8Array): string | null {
  if (bytes.length < 44) return 'Audio is too short to be a WAV file.';
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return 'Audio is not a WAV file.';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint16(34, true) !== 16) {
    return 'Audio must be mono 16-bit PCM WAV at 16 kHz or 24 kHz.';
  }
  return null;
}

export type VoiceTurn = {
  turnId: number;
  startMs?: number;
  endMs?: number;
  transcript: string;
  speaker?: string;
};

/** Each returned turn becomes one transcript line (§9.6, §10.1). */
export function turnsToLines(turns: VoiceTurn[], source: Line['source'] = 'voice'): Line[] {
  const lines: Line[] = [];
  for (const turn of turns) {
    const text = turn.transcript.trim();
    if (!text) continue;
    lines.push({
      n: lines.length + 1,
      text,
      source,
      ...(turn.startMs !== undefined ? { startMs: turn.startMs } : {}),
      ...(turn.endMs !== undefined ? { endMs: turn.endMs } : {}),
    });
  }
  return lines;
}
