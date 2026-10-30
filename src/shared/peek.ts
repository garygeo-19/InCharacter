// Hold-to-peek phase machine (REQUIREMENTS.md §5).
//
// A peek starts only after a 300 ms hold, so taps and scrolls don't count.
// Releasing before the timer fires records nothing; releasing after closes
// the peek. Pointer and keyboard input share these transitions, so the
// 300 ms rule is identical for both.
//
// Pure transitions (no timers) so the rule is unit-testable; the component
// in src/client/peek.tsx owns one phase value and the setTimeout.

export const PEEK_HOLD_MS = 300;

export type PeekHoldPhase = 'idle' | 'holding' | 'open';

export function beginHold(): PeekHoldPhase {
  return 'holding';
}

// Run when the 300 ms timer fires. Clearing 'holding' here is what lets a
// later release close the peek instead of being mistaken for an early tap.
export function holdTimerFired(phase: PeekHoldPhase): PeekHoldPhase {
  return phase === 'holding' ? 'open' : phase;
}

export type PeekRelease = {
  phase: PeekHoldPhase;
  action: 'discard' | 'close' | 'none';
};

export function releaseHold(phase: PeekHoldPhase): PeekRelease {
  if (phase === 'holding') return { phase: 'idle', action: 'discard' };
  if (phase === 'open') return { phase: 'idle', action: 'close' };
  return { phase: 'idle', action: 'none' };
}
