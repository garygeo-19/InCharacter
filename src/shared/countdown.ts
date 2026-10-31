// Pre-class countdown state logic (REQUIREMENTS.md §4.5): 3-2-1, then the
// class begins.
//
// The visible count ticks down once per step; the class starts exactly once
// when the count reaches zero. The transition must never strand the learner:
// the component pairs these ticks with an absolute watchdog (see
// countdownBudgetMs), so even a dropped or long-delayed tick still lands the
// class. A reviewer saw the old chained-timeout countdown freeze on "1" in
// WebKit (voice.spec.ts:178, timers.spec.ts:201, 31 Oct 2026): one lost final
// tick meant the class never started.

/** First number shown. */
export const COUNTDOWN_START = 3;

/** Visible tick length. `?fast=1` shortens timers for tests and demos. */
export function countdownTickMs(fast: boolean): number {
  return fast ? 300 : 1000;
}

/**
 * Absolute budget for the whole countdown, from mount to class start.
 * Covers every tick plus slack for a loaded device, so a watchdog set to
 * this always fires after the last tick — it only ever matters when a tick
 * is lost or delayed.
 */
export function countdownBudgetMs(fast: boolean): number {
  return COUNTDOWN_START * countdownTickMs(fast) + 2000;
}

export type CountdownState = { count: number; done: boolean };

/** Fresh countdown showing COUNTDOWN_START, class not started. */
export function startCountdown(): CountdownState {
  return { count: COUNTDOWN_START, done: false };
}

/**
 * Advance one tick. Reaching zero starts the class (`done: true`); further
 * ticks return the same state, so the start fires exactly once no matter
 * how many times timers or effects re-fire.
 */
export function tickCountdown(state: CountdownState): CountdownState {
  if (state.done) return state;
  const count = state.count - 1;
  return count <= 0 ? { count: 0, done: true } : { count, done: false };
}
