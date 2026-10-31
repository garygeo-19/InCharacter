// Streaming multipart plumbing for POST /api/transcribe.
//
// The Free plan allows 10 ms of CPU per request, so the route must not
// buffer a multi-MB upload into one byte array and re-encode it as a new
// FormData/Blob the way `c.req.parseBody()` + `audio.arrayBuffer()` does.
// Instead this module:
//
// - walks the incoming multipart body chunk by chunk, keeping only small
//   header/meta bytes plus zero-copy views of the audio chunks,
// - enforces the 10 MB cap with a byte counter (tripping stops collection;
//   later bytes are scanned past, never stored),
// - validates the WAV header from the first 44 bytes only,
// - rebuilds the outgoing Meta multipart body as a stream that re-emits the
//   same audio chunk views, with an exact Content-Length (the audio size is
//   known once the upload has been counted).
//
// Error precedence matches the old buffered route exactly: unreadable body,
// then audio/meta presence and shape, then size, then WAV header.

import { TRANSCRIBE_MAX_AUDIO_BYTES } from '../shared/voice';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** First bytes inspected for the WAV check (a RIFF header is 44 bytes). */
export const TRANSCRIBE_HEAD_BYTES = 44;

/** Meta field cap: the real value is ~60 bytes of JSON; anything larger is invalid. */
const META_MAX_BYTES = 64 * 1024;

/** Single-part header block cap; real blocks are a few hundred bytes. */
const HEADER_MAX_BYTES = 32 * 1024;

/**
 * Content-Length fast path: only when the whole body exceeds the audio cap
 * by more than this slack can the audio itself be over the cap (our form has
 * two small fields, so overhead never approaches this).
 */
export const TRANSCRIBE_UPLOAD_SLACK_BYTES = 64 * 1024;

export class UploadParseError extends Error {}

export type ParsedUpload = {
  /** The decoded `meta` field, or null when missing, a file, or invalid. */
  metaRaw: string | null;
  /** True when an `audio` file part was seen. */
  audioFound: boolean;
  /** Zero-copy views of the audio bytes (complete only when !tooLarge). */
  audioChunks: Uint8Array[];
  /** Total audio bytes counted, including bytes discarded past the cap. */
  audioBytes: number;
  /** True when audioBytes passed the cap. */
  tooLarge: boolean;
  /** The first TRANSCRIBE_HEAD_BYTES audio bytes (fewer for short audio). */
  head: Uint8Array;
};

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function startsWith(hay: Uint8Array, needle: Uint8Array): boolean {
  if (hay.length < needle.length) return false;
  for (let i = 0; i < needle.length; i++) if (hay[i] !== needle[i]) return false;
  return true;
}

/** `boundary=` from a multipart content type, or null. */
export function extractBoundary(contentType: string | null | undefined): string | null {
  const m = /multipart\/form-data;\s*boundary=([^;]+)/i.exec(contentType ?? '');
  if (!m) return null;
  let b = m[1].trim();
  if (b.length >= 2 && b.startsWith('"') && b.endsWith('"')) b = b.slice(1, -1);
  return b || null;
}

export async function parseTranscribeUpload(
  body: ReadableStream<Uint8Array> | null,
  boundary: string,
): Promise<ParsedUpload> {
  if (!body || !boundary) throw new UploadParseError('Expected multipart audio.');
  const reader = body.getReader();
  const delim = enc.encode(`\r\n--${boundary}`);
  const first = enc.encode(`--${boundary}`);
  const D = delim.length;

  let stash: Uint8Array = new Uint8Array(0);
  let eof = false;
  const fail = (): never => {
    throw new UploadParseError('Expected multipart audio.');
  };
  const pull = async (): Promise<boolean> => {
    if (eof) return false;
    const r = await reader.read();
    if (r.done) {
      eof = true;
      return false;
    }
    const chunk = r.value;
    const next = new Uint8Array(stash.length + chunk.length);
    next.set(stash, 0);
    next.set(chunk, stash.length);
    stash = next;
    return true;
  };
  const need = async (n: number): Promise<boolean> => {
    while (stash.length < n && !eof) await pull();
    return stash.length >= n;
  };

  let metaRaw: string | null = null;
  let audioFound = false;
  const audioChunks: Uint8Array[] = [];
  let audioBytes = 0;
  let tooLarge = false;
  const headAcc: Uint8Array[] = [];
  let headLen = 0;

  const pushAudio = (piece: Uint8Array): void => {
    if (piece.length === 0) return;
    audioBytes += piece.length;
    if (tooLarge) return;
    if (headLen < TRANSCRIBE_HEAD_BYTES) {
      const want = Math.min(piece.length, TRANSCRIBE_HEAD_BYTES - headLen);
      headAcc.push(piece.slice(0, want));
      headLen += want;
    }
    if (audioBytes > TRANSCRIBE_MAX_AUDIO_BYTES) {
      tooLarge = true;
      return;
    }
    audioChunks.push(piece);
  };

  // Opening `--boundary`.
  if (!(await need(first.length))) fail();
  if (!startsWith(stash, first)) fail();
  stash = stash.slice(first.length);

  // One part after another. `stash` always starts right after a consumed
  // boundary; audio bytes never accumulate here (see the audio branch).
  for (;;) {
    if (!(await need(2))) fail();
    if (stash[0] === 45 && stash[1] === 45) break; // `--`: final boundary
    if (stash[0] !== 13 || stash[1] !== 10) fail();
    stash = stash.slice(2);

    const HH = enc.encode('\r\n\r\n');
    let headerEnd = -1;
    for (;;) {
      headerEnd = indexOf(stash, HH);
      if (headerEnd >= 0) break;
      if (stash.length > HEADER_MAX_BYTES) fail();
      if (!(await pull())) fail();
    }
    const headerText = dec.decode(stash.slice(0, headerEnd));
    stash = stash.slice(headerEnd + HH.length);
    const name = /name="([^"]*)"/.exec(headerText)?.[1];
    const isFile = /(?:filename\*=[^;\r\n]+|filename="[^"]*")/.test(headerText);

    // Scan stash (pulling more as needed) for the next delimiter, calling
    // `emit` with each content slice. Keeps a D-byte tail so a delimiter
    // split across reads is still found. Returns the bytes after it.
    const scanToDelim = async (emit: (piece: Uint8Array) => void): Promise<Uint8Array> => {
      let carry = new Uint8Array(0);
      for (;;) {
        const data = carry.length === 0 ? stash : (() => {
          const joined = new Uint8Array(carry.length + stash.length);
          joined.set(carry, 0);
          joined.set(stash, carry.length);
          return joined;
        })();
        stash = new Uint8Array(0);
        const idx = indexOf(data, delim);
        if (idx >= 0) {
          emit(data.slice(0, idx));
          return data.slice(idx + D);
        }
        const keep = Math.min(data.length, D);
        emit(data.slice(0, data.length - keep));
        carry = data.slice(data.length - keep);
        if (!(await pull())) fail();
      }
    };

    if (name === 'meta' && !isFile) {
      const parts: Uint8Array[] = [];
      let len = 0;
      let over = false;
      const rest = await scanToDelim((piece) => {
        if (over) return;
        len += piece.length;
        if (len > META_MAX_BYTES) {
          over = true;
          return;
        }
        parts.push(piece);
      });
      if (!over) {
        const flat = new Uint8Array(len);
        let o = 0;
        for (const p of parts) {
          flat.set(p, o);
          o += p.length;
        }
        metaRaw = dec.decode(flat);
      }
      stash = rest;
    } else if (name === 'audio' && isFile && !audioFound) {
      audioFound = true;
      const rest = await scanToDelim(pushAudio);
      stash = rest;
    } else {
      // Unknown field or a repeated part: scan past it without storing.
      const rest = await scanToDelim(() => undefined);
      stash = rest;
    }
  }

  try {
    await reader.cancel();
  } catch {
    // The body is fully consumed or already closed; nothing to free.
  }
  const head = new Uint8Array(headLen);
  let o = 0;
  for (const p of headAcc) {
    head.set(p, o);
    o += p.length;
  }
  return { metaRaw, audioFound, audioChunks, audioBytes, tooLarge, head };
}

/** Outgoing Meta multipart body: a stream re-emitting the audio chunk views. */
export function buildTranscribeBody(
  requestJson: string,
  audio: Uint8Array[],
  audioBytes: number,
): { body: ReadableStream<Uint8Array>; contentType: string; contentLength: number } {
  const boundary = `----incharacter-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const pre = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="request"\r\n` +
      `Content-Type: application/json\r\n\r\n${requestJson}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`,
  );
  const post = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(pre);
      for (const chunk of audio) controller.enqueue(chunk);
      controller.enqueue(post);
      controller.close();
    },
  });
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: pre.length + audioBytes + post.length,
  };
}
