import { describe, expect, it } from 'vitest';
import {
  buildNotes,
  CATALOG_DEFAULT,
  fetchPack,
  liveEntries,
  stripPrefix,
  type Pack,
} from './notes';
import { expectDemoNotes, loadDemoPack } from './demo-fixture';

// REQUIREMENTS.md §6.5: the demo class table and anchors, reproduced exactly.
// The part payload is a verbatim extract of the live pack (the one fixture
// exception to "no copies", §6.1/§15); the live test below re-checks it
// against the catalog at run time.

describe('§6.5 demo class (pack extract)', () => {
  it('reproduces the notes table and anchors exactly', () => {
    expectDemoNotes(buildNotes(loadDemoPack(), 'p10-at-the-restaurant'));
  });

  it('strips Part/Lesson prefixes for display', () => {
    expect(stripPrefix('Part 1: At the Restaurant')).toBe('At the Restaurant');
    expect(stripPrefix('Lesson 1: Food & Eating Out')).toBe('Food & Eating Out');
    expect(stripPrefix('At the Restaurant')).toBe('At the Restaurant');
  });

  it('rejects an unknown part', () => {
    expect(() => buildNotes(loadDemoPack(), 'nope')).toThrow('Unknown part');
  });
});

describe('§6.5 demo class (live pack)', () => {
  it('matches the live catalog pack', async (ctx) => {
    let pack: Pack;
    try {
      const res = await fetch(`${CATALOG_DEFAULT}/packs/catalog.json`);
      if (!res.ok) throw new Error(`catalog: ${res.status}`);
      const { packs } = (await res.json()) as { packs: Parameters<typeof liveEntries>[0] };
      const entry = liveEntries(packs).find((p) => p.id === 'spanish-food-shopping');
      if (!entry) throw new Error('demo pack missing from catalog');
      pack = await fetchPack(CATALOG_DEFAULT, entry);
    } catch {
      ctx.skip();
      return;
    }
    expect(pack.packVersion).toBe('1.0.9');
    expectDemoNotes(buildNotes(pack, 'p10-at-the-restaurant'));
  }, 60000);
});
