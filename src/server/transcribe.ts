// Voice Transcribe in file mode (REQUIREMENTS.md §9.6).
// The Meta API key never leaves the server: the browser posts its WAV to
// /api/transcribe, and this module forwards it to the Voice API as
// multipart form data (a `request` JSON part plus the `audio` WAV part).
// See https://dev.meta.ai/docs/speech-to-text ("Transcribe a file").

import { transcribeRequestBody, type VoiceTurn } from '../shared/voice';
import { buildTranscribeBody } from './transcribe-stream';

const TRANSCRIBE_URL = 'https://api.meta.ai/v1/asr/transcribe';

export type TranscribeResult = {
  transcript: string;
  audioDurationMs: number;
  turns: VoiceTurn[];
};

async function readTranscribeResult(res: Response): Promise<TranscribeResult> {
  if (!res.ok) {
    // Meta's error body explains a rejected request; it holds no key or transcript.
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err = new Error(`Transcription failed with status ${res.status}${detail ? `: ${detail}` : ''}`) as Error & {
      status?: number;
    };
    err.status = res.status === 429 ? 429 : 502;
    throw err;
  }
  const body = (await res.json()) as {
    transcript?: unknown;
    audioDurationMs?: unknown;
    turns?: unknown;
  };
  if (!Array.isArray(body.turns)) throw new Error('Transcription returned no turns.');
  const turns: VoiceTurn[] = body.turns.map((t, i) => {
    const turn = t as Record<string, unknown>;
    if (typeof turn.transcript !== 'string') {
      throw new Error('Transcription returned a turn without text.');
    }
    return {
      turnId: typeof turn.turnId === 'number' ? turn.turnId : i + 1,
      ...(typeof turn.startMs === 'number' ? { startMs: turn.startMs } : {}),
      ...(typeof turn.endMs === 'number' ? { endMs: turn.endMs } : {}),
      transcript: turn.transcript,
      ...(typeof turn.speaker === 'string' ? { speaker: turn.speaker } : {}),
    };
  });
  return {
    transcript: typeof body.transcript === 'string' ? body.transcript : '',
    audioDurationMs: typeof body.audioDurationMs === 'number' ? body.audioDurationMs : 0,
    turns,
  };
}

export async function transcribeWav(opts: {
  apiKey: string;
  wav: Uint8Array;
  packLanguage: string;
  anchors: string[];
  fetchFn?: typeof fetch;
}): Promise<TranscribeResult> {
  const request = transcribeRequestBody({ packLanguage: opts.packLanguage, anchors: opts.anchors });
  const form = new FormData();
  form.append(
    'request',
    new Blob([JSON.stringify(request)], { type: 'application/json' }),
  );
  form.append(
    'audio',
    new Blob([opts.wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }),
    'audio.wav',
  );
  const run = opts.fetchFn ?? fetch;
  // Never log the key, the audio, or the transcript (§11.4).
  const res = await run(TRANSCRIBE_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.apiKey}` },
    body: form,
  });
  return readTranscribeResult(res);
}

/**
 * Streaming variant: sends audio chunk views gathered by
 * parseTranscribeUpload without copying or re-encoding them, as a streamed
 * multipart body with an exact Content-Length. This is the path the
 * /api/transcribe route uses on Node and on Workers.
 */
export async function transcribeStream(opts: {
  apiKey: string;
  audio: Uint8Array[];
  audioBytes: number;
  packLanguage: string;
  anchors: string[];
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<TranscribeResult> {
  const request = transcribeRequestBody({ packLanguage: opts.packLanguage, anchors: opts.anchors });
  const upload = buildTranscribeBody(JSON.stringify(request), opts.audio, opts.audioBytes);
  const run = opts.fetchFn ?? fetch;
  // Never log the key, the audio, or the transcript (§11.4).
  const res = await run(TRANSCRIBE_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      'content-type': upload.contentType,
      'content-length': String(upload.contentLength),
    },
    body: upload.body,
    // Required by Node's fetch for stream bodies; ignored elsewhere.
    duplex: 'half',
    ...(opts.signal ? { signal: opts.signal } : {}),
  } as RequestInit);
  return readTranscribeResult(res);
}
