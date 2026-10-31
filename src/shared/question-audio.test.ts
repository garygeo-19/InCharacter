// Question-audio fallback state logic (owner fix 31 Oct 2026): which
// questions play audio, and when a failed playback drops to the caption.
import { describe, expect, it } from 'vitest';
import {
  QUESTION_CAPTION_FALLBACK_MS,
  questionAudioAfter,
  questionAudioMode,
  questionAudioUrl,
} from './question-audio';

const AUDIO = {
  file: 'public/audio/spanish-food-shopping/p10-at-the-restaurant/q-propina-meaning.mp3',
  textHash: '3fa76fa127588d6e0b1f36ae395c2afe904ad690473a4eec3c3034c307c05c83',
  voiceId: 'voice-id-never-sent-to-client',
  model: 'eleven_v4',
};

describe('questionAudioUrl', () => {
  it('maps the listed bank mp3 to its /audio URL', () => {
    expect(
      questionAudioUrl(
        'spanish-food-shopping',
        'p10-at-the-restaurant',
        'q-propina-meaning',
        AUDIO,
      ),
    ).toBe('/audio/spanish-food-shopping/p10-at-the-restaurant/q-propina-meaning.mp3');
  });

  it('returns null without trusting anything else', () => {
    const pack = 'spanish-food-shopping';
    const part = 'p10-at-the-restaurant';
    const id = 'q-propina-meaning';
    expect(questionAudioUrl(pack, part, id, null)).toBeNull();
    expect(questionAudioUrl(pack, part, id, { ...AUDIO, textHash: '' })).toBeNull();
    expect(questionAudioUrl(pack, part, id, { ...AUDIO, file: 'public/audio/other.mp3' })).toBeNull();
    expect(questionAudioUrl(pack, part, 'q-other', AUDIO)).toBeNull();
  });
});

describe('questionAudioMode', () => {
  it('plays only with a URL and sound on', () => {
    expect(questionAudioMode({ audioUrl: '/audio/q.mp3', soundOn: true })).toBe('audio');
    expect(questionAudioMode({ audioUrl: null, soundOn: true })).toBe('caption');
    expect(questionAudioMode({ audioUrl: '/audio/q.mp3', soundOn: false })).toBe('caption');
    expect(questionAudioMode({ audioUrl: null, soundOn: false })).toBe('caption');
  });
});

describe('questionAudioAfter', () => {
  it('drops to the caption on a failed load or a play() rejection', () => {
    expect(questionAudioAfter({ mode: 'audio', event: 'error' })).toBe('caption');
    expect(questionAudioAfter({ mode: 'audio', event: 'rejected' })).toBe('caption');
  });

  it('keeps the mode when the audio ends or replays', () => {
    expect(questionAudioAfter({ mode: 'audio', event: 'ended' })).toBe('audio');
    expect(questionAudioAfter({ mode: 'audio', event: 'replayed' })).toBe('audio');
    expect(questionAudioAfter({ mode: 'caption', event: 'ended' })).toBe('caption');
  });

  it('keeps the 2 s caption fallback both sides agree on', () => {
    expect(QUESTION_CAPTION_FALLBACK_MS).toBe(2000);
  });
});
