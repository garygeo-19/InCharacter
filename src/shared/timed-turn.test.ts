import { describe, expect, test } from 'vitest';
import { TimedTurn } from './timed-turn';

// The owner bug (31 Oct 2026): after Done the answer timer kept counting
// while the answer transcribed. Done/End must stop the timer at once, and
// a timeout racing the submit must not submit a second time.

describe('TimedTurn', () => {
  test('timer runs until the first finish', () => {
    const turn = new TimedTurn();
    expect(turn.timerRunning).toBe(true);
    expect(turn.finish('done')).toBe(true);
    expect(turn.timerRunning).toBe(false);
  });

  test('Done then timeout submits exactly once', () => {
    const turn = new TimedTurn();
    // Voice answer: Done stops the recording; the timeout fires mid-transcription.
    expect(turn.finish('done')).toBe(true);
    expect(turn.timerRunning).toBe(false);
    expect(turn.finish('timeout')).toBe(false);
    // The transcription lands once.
    expect(turn.deliver()).toBe(true);
    expect(turn.deliver()).toBe(false);
  });

  test('timeout then Done submits exactly once', () => {
    const turn = new TimedTurn();
    // Timeout fires during the recording and submits what was recorded.
    expect(turn.finish('timeout')).toBe(true);
    expect(turn.timerRunning).toBe(false);
    // The late Done tap does nothing.
    expect(turn.finish('done')).toBe(false);
    expect(turn.deliver()).toBe(true);
    expect(turn.deliver()).toBe(false);
  });

  test('timeout during transcription does nothing a second time', () => {
    const turn = new TimedTurn();
    expect(turn.finish('done')).toBe(true);
    // Still transcribing: timer stays stopped, no second submit.
    expect(turn.timerRunning).toBe(false);
    expect(turn.finish('timeout')).toBe(false);
    expect(turn.timerRunning).toBe(false);
    expect(turn.deliver()).toBe(true);
    // A further timeout after delivery still delivers nothing.
    expect(turn.finish('timeout')).toBe(false);
    expect(turn.deliver()).toBe(false);
  });

  test('typed turn finishes and delivers together, once', () => {
    const turn = new TimedTurn();
    expect(turn.finish('done')).toBe(true);
    expect(turn.deliver()).toBe(true);
    expect(turn.finish('timeout')).toBe(false);
    expect(turn.deliver()).toBe(false);
  });

  test('voice fallback to typing delivers after the timer already stopped', () => {
    const turn = new TimedTurn();
    expect(turn.finish('done')).toBe(true);
    // Transcription failed; the learner types instead. No finish left,
    // but the typed lines still go through exactly once.
    expect(turn.finish('done')).toBe(false);
    expect(turn.deliver()).toBe(true);
    expect(turn.deliver()).toBe(false);
  });
});
