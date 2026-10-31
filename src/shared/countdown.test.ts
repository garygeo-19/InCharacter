import { describe, expect, test } from 'vitest';
import {
  COUNTDOWN_START,
  countdownBudgetMs,
  countdownTickMs,
  startCountdown,
  tickCountdown,
} from './countdown';

// The reviewer bug (31 Oct 2026): the pre-class countdown froze on "1" in
// WebKit and the class never started. The countdown must always reach the
// class, exactly once, no matter how ticks arrive.

describe('countdown', () => {
  test('starts at 3, class not started', () => {
    expect(startCountdown()).toEqual({ count: 3, done: false });
    expect(COUNTDOWN_START).toBe(3);
  });

  test('three ticks reach the class', () => {
    let state = startCountdown();
    state = tickCountdown(state);
    expect(state).toEqual({ count: 2, done: false });
    state = tickCountdown(state);
    expect(state).toEqual({ count: 1, done: false });
    state = tickCountdown(state);
    expect(state).toEqual({ count: 0, done: true });
  });

  test('the start fires exactly once: further ticks change nothing', () => {
    let state = tickCountdown(tickCountdown(tickCountdown(startCountdown())));
    expect(state.done).toBe(true);
    const finished = state;
    // A re-fired timer or a double effect meets the same state object.
    state = tickCountdown(state);
    expect(state).toBe(finished);
    state = tickCountdown(tickCountdown(state));
    expect(state).toBe(finished);
    expect(state.count).toBe(0);
  });

  test('the count never goes negative', () => {
    let state = startCountdown();
    for (let i = 0; i < 10; i++) state = tickCountdown(state);
    expect(state).toEqual({ count: 0, done: true });
  });

  test('tick lengths match the fast and real timers', () => {
    expect(countdownTickMs(true)).toBe(300);
    expect(countdownTickMs(false)).toBe(1000);
  });

  test('the watchdog budget covers every tick plus slack', () => {
    // The backstop must land strictly after the last tick on a healthy run.
    expect(countdownBudgetMs(true)).toBeGreaterThan(COUNTDOWN_START * countdownTickMs(true));
    expect(countdownBudgetMs(false)).toBeGreaterThan(COUNTDOWN_START * countdownTickMs(false));
  });
});
