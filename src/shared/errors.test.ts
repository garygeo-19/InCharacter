// friendlyErrorMessage: technical failures become plain words with an
// action; server messages that are already plain pass through untouched.
import { describe, expect, it } from 'vitest';
import { friendlyErrorMessage } from './errors';

describe('friendlyErrorMessage', () => {
  it('replaces a bare failure status with plain words', () => {
    const out = friendlyErrorMessage(new Error('Request failed: 502'));
    expect(out).not.toMatch(/502/);
    expect(out).not.toMatch(/request failed/i);
    expect(out).toMatch(/try again/i);
  });

  it('replaces forwarded transcription detail with plain words', () => {
    const out = friendlyErrorMessage(
      'Transcription failed with status 500: {"error":{"message":"model overloaded"}}',
    );
    expect(out).not.toMatch(/status/i);
    expect(out).toMatch(/try again/i);
  });

  it('names rate limits and the full-day cap', () => {
    expect(friendlyErrorMessage('Request failed: 429')).toMatch(/wait/i);
    expect(friendlyErrorMessage('Request failed: 503')).toMatch(/tomorrow/i);
  });

  it('names connection problems and timeouts', () => {
    expect(friendlyErrorMessage(new TypeError('Failed to fetch'))).toMatch(/connection/i);
    expect(friendlyErrorMessage('grade/class timed out after 45000 ms')).toMatch(/too long/i);
  });

  it('passes plain server messages through', () => {
    expect(friendlyErrorMessage('Too many classes this hour.')).toBe('Too many classes this hour.');
    expect(friendlyErrorMessage('Audio is too large (at most 10 MB).')).toBe(
      'Audio is too large (at most 10 MB).',
    );
  });

  it('never returns an empty string', () => {
    expect(friendlyErrorMessage('')).toMatch(/wrong/i);
    expect(friendlyErrorMessage(null)).toMatch(/wrong/i);
  });
});
