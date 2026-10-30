import { describe, expect, it } from 'vitest';
import { SCORING_CONFIG } from './scoring-config';

// Harness smoke test for M0; the §8.7 worked example (total 72) is an M1 test.
describe('SCORING_CONFIG', () => {
  it('totals 100 before peek penalties', () => {
    expect(SCORING_CONFIG.lessonMax + SCORING_CONFIG.questionsMax).toBe(100);
  });

  it('question points sum to the questions max', () => {
    const sum = SCORING_CONFIG.questionPoints.reduce((a, b) => a + b, 0);
    expect(sum).toBe(SCORING_CONFIG.questionsMax);
  });

  it('gives Type mode double time (§4.5, §4.6)', () => {
    expect(SCORING_CONFIG.classSeconds.typed).toBe(2 * SCORING_CONFIG.classSeconds.voice);
    expect(SCORING_CONFIG.answerSeconds.typed).toBe(2 * SCORING_CONFIG.answerSeconds.voice);
  });
});
