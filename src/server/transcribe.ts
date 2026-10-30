// Voice Transcribe in file mode (REQUIREMENTS.md §9.6).
// The Meta API key never leaves the server: the browser posts its WAV to
// /api/transcribe, and this module forwards it to the Voice API as
// multipart form data (a `request` JSON part plus the `audio` WAV part).
// See https://dev.meta.ai/docs/speech-to-text ("Transcribe a file").

import { transcribeRequestBody, type VoiceTurn } from '../shared/voice';

const TRANSCRIBE_URL = 'https://api.meta.ai/v1/asr/transcribe';

export type TranscribeResult = {
  transcript: string;
  audioDurationMs: number;
  turns: VoiceTurn[];
};

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
  if (!res.ok) {
    const err = new Error(`Transcription failed with status ${res.status}`) as Error & {
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
