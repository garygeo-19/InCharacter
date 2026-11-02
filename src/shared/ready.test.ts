import { describe, expect, it } from 'vitest';
import { packReadySummary, packReadyTotal, type ReadyCounts } from './ready';

const COACH = { key: 'coach', title: 'Coach a client', count: 0 };
const TRAVEL = { key: 'travel', title: 'Find your way', count: 0 };

function counts(over: Partial<ReadyCounts>): ReadyCounts {
  return { classes: 0, roles: [COACH, TRAVEL], ...over };
}

describe('pack ready summary (owner fix, Nov 2026)', () => {
  it('counts classroom classes only', () => {
    expect(packReadySummary(counts({ classes: 3 }))).toBe('3 classes ready');
  });

  it('uses the singular for one class', () => {
    expect(packReadySummary(counts({ classes: 1 }))).toBe('1 class ready');
  });

  it('names a ready role session when no class is ready', () => {
    expect(
      packReadySummary(counts({ roles: [{ ...COACH, count: 1 }, TRAVEL] })),
    ).toBe('Coach a client ready');
  });

  it('joins classes and roles with one shared "ready"', () => {
    expect(
      packReadySummary(counts({ classes: 1, roles: [COACH, { ...TRAVEL, count: 2 }] })),
    ).toBe('1 class · Find your way ready');
  });

  it('says coming soon only when nothing is ready', () => {
    expect(packReadySummary(counts({}))).toBe('Classes coming soon');
  });

  it('totals everything ready for sorting', () => {
    const onlyRole = counts({ roles: [{ ...COACH, count: 1 }, TRAVEL] });
    expect(packReadyTotal(counts({}))).toBe(0);
    expect(packReadyTotal(onlyRole)).toBe(1);
    expect(packReadyTotal(counts({ classes: 2, roles: [{ ...COACH, count: 1 }, TRAVEL] }))).toBe(3);
  });
});
