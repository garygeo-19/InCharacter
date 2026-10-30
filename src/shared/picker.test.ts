import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUsableStatuses, staleUsableIds, usableQuestions, type Bank } from './bank';
import { buildNotes } from './notes';
import { loadDemoPack } from './demo-fixture';
import { fallbackPick, validatePicks, type UsableQuestion } from './picker';

function seedUsable(): UsableQuestion[] {
  const bank = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../content/banks/spanish-food-shopping/p10-at-the-restaurant.json'),
      'utf8',
    ),
  ) as Bank;
  const notes = buildNotes(loadDemoPack(), 'p10-at-the-restaurant');
  const words = new Map(notes.map((n) => [n.id, n.evidenceWords]));
  const fresh = staleUsableIds(bank, notes);
  return usableQuestions(bank, parseUsableStatuses('approved,checked'))
    .filter((q) => fresh.has(q.id))
    .map((q, i) => ({
      id: q.id,
      difficulty: q.difficulty,
      noteIds: q.noteIds,
      evidenceWords: [...new Set(q.noteIds.flatMap((id) => words.get(id) ?? []))],
      bankIndex: i,
    }));
}

describe('picker (§9.2)', () => {
  const usable = seedUsable();

  it('accepts a valid model choice', () => {
    const picks = [
      { questionId: 'q-buen-provecho-meaning' },
      { questionId: 'q-menu-in-madrid' },
      { questionId: 'q-paella-seafood' },
    ];
    expect(validatePicks(picks, usable, [])).toEqual([]);
  });

  it('rejects wrong order, shared notes, repeats and unknown ids', () => {
    // shared note: both on fact-buen-provecho
    expect(
      validatePicks(
        [
          { questionId: 'q-buen-provecho-meaning' },
          { questionId: 'q-walking-past-diners' },
          { questionId: 'q-paella-seafood' },
        ],
        usable,
        [],
      ),
    ).not.toEqual([]);
    // wrong difficulty order
    expect(
      validatePicks(
        [
          { questionId: 'q-menu-in-madrid' },
          { questionId: 'q-buen-provecho-meaning' },
          { questionId: 'q-paella-seafood' },
        ],
        usable,
        [],
      ),
    ).not.toEqual([]);
    // excluded, duplicate, unknown
    expect(
      validatePicks(
        [
          { questionId: 'q-buen-provecho-meaning' },
          { questionId: 'q-menu-in-madrid' },
          { questionId: 'q-menu-in-madrid' },
        ],
        usable,
        ['q-buen-provecho-meaning'],
      ),
    ).not.toEqual([]);
    expect(
      validatePicks(
        [
          { questionId: 'q-buen-provecho-meaning' },
          { questionId: 'q-menu-in-madrid' },
          { questionId: 'q-nope' },
        ],
        usable,
        [],
      ),
    ).not.toEqual([]);
  });

  it('falls back to probing what the teacher skipped', () => {
    // Transcript covers buen provecho heavily: the d1 fallback should avoid
    // q-buen-provecho-meaning and pick a less-mentioned note instead.
    const transcript = [
      'Welcome! Today say buen provecho, enjoy your meal, even walking past strangers eating.',
      'Buen provecho means enjoy your meal, a communal courtesy.',
    ].join('\n');
    const picks = fallbackPick(usable, [], transcript);
    expect(validatePicks(picks, usable, [])).toEqual([]);
    expect(picks[0].questionId).not.toBe('q-buen-provecho-meaning');
    expect(picks).toEqual([
      { questionId: 'q-propina-meaning' },
      { questionId: 'q-getting-the-check' },
      { questionId: 'q-paella-seafood' },
    ]);
  });

  it('ignores excludeIds when nothing else is left, then the shared-note rule', () => {
    const d1 = usable.filter((q) => q.difficulty === 1).map((q) => q.id);
    const picks = fallbackPick(usable, d1, 'unrelated words here');
    expect(picks).toHaveLength(3);
    expect(validatePicks(picks, usable, [])).toEqual([]);
    // Only one d2 question avoids the d1 notes after exclusions; the d3 pick
    // may share a note rather than fail.
    const tiny: UsableQuestion[] = [
      { id: 'a', difficulty: 1, noteIds: ['n1'], evidenceWords: [], bankIndex: 0 },
      { id: 'b', difficulty: 2, noteIds: ['n1'], evidenceWords: [], bankIndex: 1 },
      { id: 'c', difficulty: 3, noteIds: ['n1'], evidenceWords: [], bankIndex: 2 },
    ];
    expect(fallbackPick(tiny, [], '')).toEqual([{ questionId: 'a' }, { questionId: 'b' }, { questionId: 'c' }]);
  });

  it('breaks evidence ties by bank order', () => {
    const picks = fallbackPick(usable, [], '');
    expect(picks[0].questionId).toBe('q-propina-meaning');
  });
});
