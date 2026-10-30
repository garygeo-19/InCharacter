import { describe, expect, it } from 'vitest';
import {
  beginHold,
  holdTimerFired,
  PEEK_HOLD_MS,
  releaseHold,
} from './peek';

// REQUIREMENTS.md §5: a peek starts only after a 300 ms hold and ends on
// release. Pointer and keyboard input share these transitions.
describe('hold-to-peek (§5)', () => {
  it('uses the 300 ms hold from §5', () => {
    expect(PEEK_HOLD_MS).toBe(300);
  });

  it('releasing before the timer fires records nothing', () => {
    expect(releaseHold(beginHold())).toEqual({ phase: 'idle', action: 'discard' });
  });

  it('releasing after the hold fired closes the peek', () => {
    // Regression: the fired timer must clear 'holding', otherwise release
    // looks like an early tap and the note stays open (audit.spec.ts:157 —
    // Space up left aria-expanded="true").
    expect(releaseHold(holdTimerFired(beginHold()))).toEqual({
      phase: 'idle',
      action: 'close',
    });
  });

  it('releasing while idle does nothing', () => {
    expect(releaseHold('idle')).toEqual({ phase: 'idle', action: 'none' });
  });

  it('a stray timer firing while idle opens nothing', () => {
    expect(holdTimerFired('idle')).toBe('idle');
    expect(holdTimerFired('open')).toBe('open');
  });
});
