// Student question audio (REQUIREMENTS.md §4.6, §7.6, §9.7).
// bank:audio records each usable question as an mp3 and stores
// { file, textHash, voiceId, model } on the bank question, where textHash
// is sha256 of the spoken text (ttsText ?? pronunciations applied).
// The server trusts that recorded hash and only checks the file is the
// listed mp3; the client gets the URL and never sees voiceId.

/** Caption fallback delay: with no audio, a failed load, or a play()
 *  rejection, voice answers start this long after the caption appears. */
export const QUESTION_CAPTION_FALLBACK_MS = 2000;

export type BankAudioInfo = {
  file: string;
  textHash: string;
  voiceId: string;
  model: string;
};

/**
 * The playable URL for a bank question, or null. Trusts the textHash
 * recorded by bank:audio; only the file path is checked, against
 * public/audio/<packId>/<partId>/<questionId>.mp3 (served at /audio/…).
 */
export function questionAudioUrl(
  packId: string,
  partId: string,
  questionId: string,
  audio: unknown,
): string | null {
  if (!audio || typeof audio !== 'object') return null;
  const info = audio as Partial<BankAudioInfo>;
  if (typeof info.file !== 'string' || typeof info.textHash !== 'string') return null;
  if (!info.file || !info.textHash) return null;
  if (info.file !== `public/audio/${packId}/${partId}/${questionId}.mp3`) return null;
  return `/audio/${packId}/${partId}/${questionId}.mp3`;
}

export type QuestionAudioMode = 'audio' | 'caption';

/**
 * Audio plays only with a URL and sound on; everything else is the
 * caption fallback (no audio, or the learner turned sound off).
 */
export function questionAudioMode(opts: {
  audioUrl: string | null;
  soundOn: boolean;
}): QuestionAudioMode {
  return opts.audioUrl && opts.soundOn ? 'audio' : 'caption';
}

export type QuestionAudioEvent = 'ended' | 'error' | 'rejected' | 'replayed';

/**
 * Fallback transitions once playback is attempted: a failed load or a
 * play() rejection drops to the caption (which starts the answer on its
 * timer); ended and replayed keep the current mode.
 */
export function questionAudioAfter(opts: {
  mode: QuestionAudioMode;
  event: QuestionAudioEvent;
}): QuestionAudioMode {
  if (opts.event === 'error' || opts.event === 'rejected') return 'caption';
  return opts.mode;
}
