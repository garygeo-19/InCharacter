// All scoring weights in one place (REQUIREMENTS.md §8) so they can be tuned.
// The scoring math itself lands in M1; M0 only pins the config shape.
export const SCORING_CONFIG = {
  lessonMax: 50,
  questionsMax: 50,
  coverageMax: 40,
  movesMax: 10,
  pointsPerMove: 2,
  wrongNotePenalty: 2,
  questionPoints: [15, 15, 20] as const,
  contradictionFactor: 0.75,
  peekMaxPenalty: 20,
  peekPerCount: 2,
  peekSecondsPerPoint: 3,
  classSeconds: { voice: 180, typed: 360 },
  answerSeconds: { voice: 60, typed: 120 },
} as const;

export type ScoringConfig = typeof SCORING_CONFIG;
