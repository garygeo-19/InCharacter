import { describe, expect, it } from 'vitest';
import {
  checkSessionGraph,
  isSessionUsable,
  resolveTurn,
  scoreSessionRun,
  scoreSessionTurns,
  SessionFileSchema,
  type SessionFile,
  type SessionNode,
} from './session';
import { noteHash, type Note } from './notes';

function note(id: string): Note {
  const title = `Note ${id}`;
  const text = `The text of ${id} about habits and practice.`;
  return {
    id, kind: 'fact', label: title, text, weight: 2,
    anchors: [title], evidenceWords: ['habits', 'practice', id.replace(/-/g, '')],
    hash: noteHash('fact', title, text),
  };
}

const NOTES = [note('ah-p8-f1'), note('ah-p8-f2')];

function node(over: Partial<SessionNode> & { id: string }): SessionNode {
  return {
    speaker: 'alex',
    text: 'Alex speaks.',
    gloss: null,
    scene: null,
    ttsText: null,
    audio: null,
    reply: true,
    noteIds: ['ah-p8-f1'],
    expectedPoints: [{ text: 'Shrink the habit', noteIds: ['ah-p8-f1'] }],
    routes: [],
    default: null,
    end: false,
    status: 'approved',
    check: null,
    review: null,
    ...over,
  };
}

function session(nodes: SessionNode[], start = 'open'): SessionFile {
  return {
    schemaVersion: 1,
    role: 'coach',
    packId: 'atomic-habits',
    packVersion: '1.0.0',
    lessonId: 'l8',
    partId: 'part-8',
    builtAt: '2026-11-01',
    notes: NOTES.map((n) => ({ id: n.id, hash: n.hash })),
    brief: 'Alex wants a habit to stick.',
    cast: [{ id: 'alex', name: 'Alex', description: 'a friendly client', voiceId: 'v1', portrait: 'art/coach/alex.webp' }],
    scene: 'art/coach/office.webp',
    start,
    nodes,
  };
}

const reply = (id: string, next: string, def: string): SessionNode =>
  node({
    id,
    routes: [
      { id: 'applied', when: 'The coach shrinks the habit', next },
      { id: 'missed', when: 'Anything else', next: 'push' },
    ],
    default: def,
  });

const end = (id: string): SessionNode =>
  node({ id, reply: false, routes: [], default: null, end: true });

describe('checkSessionGraph (§16.2)', () => {
  it('accepts a small valid graph', () => {
    const s = session([
      reply('open', 'stage2', 'push'),
      node({ id: 'push', routes: [{ id: 'on', when: 'Any reply', next: 'stage2' }], default: 'stage2' }),
      reply('stage2', 'close-good', 'close-unsure'),
      end('close-good'),
      end('close-unsure'),
    ]);
    expect(checkSessionGraph(s, NOTES)).toEqual([]);
  });

  it('flags an unreachable node', () => {
    const s = session([reply('open', 'close-good', 'close-good'), end('close-good'), end('lost')]);
    expect(checkSessionGraph(s, NOTES).join('\n')).toMatch(/lost.*unreachable/);
  });

  it('flags a route next that names no node', () => {
    const s = session([
      node({ id: 'open', routes: [{ id: 'applied', when: 'x', next: 'ghost' }], default: 'close-good' }),
      end('close-good'),
    ]);
    expect(checkSessionGraph(s, NOTES).join('\n')).toMatch(/missing node ghost/);
  });

  it('flags a missing default on a reply node', () => {
    const s = session([
      node({ id: 'open', routes: [{ id: 'applied', when: 'x', next: 'close-good' }], default: null }),
      end('close-good'),
    ]);
    expect(checkSessionGraph(s, NOTES).join('\n')).toMatch(/needs a default/);
  });

  it('flags an end node with routes or reply true', () => {
    const s = session([
      node({ id: 'open', routes: [{ id: 'applied', when: 'x', next: 'fin' }], default: 'fin' }),
      node({ id: 'fin', reply: true, routes: [{ id: 'a', when: 'x', next: 'fin' }], default: 'fin', end: true }),
    ]);
    const errs = checkSessionGraph(s, NOTES).join('\n');
    expect(errs).toMatch(/end node must have no routes/);
    expect(errs).toMatch(/end node must have reply false/);
  });

  it('passes a pushback loop: the revisit follows default (no loops)', () => {
    const s = session([
      reply('open', 'stage2', 'push'),
      node({ id: 'push', routes: [{ id: 'on', when: 'Any reply', next: 'open' }], default: 'stage2' }),
      reply('stage2', 'close-good', 'close-unsure'),
      end('close-good'),
      end('close-unsure'),
    ]);
    // push → open is a back edge, but open is already visited on that path,
    // so run-time routing follows open's default instead of looping.
    expect(checkSessionGraph(s, NOTES)).toEqual([]);
  });

  it('flags a path longer than 8 replies without an end', () => {
    const nodes: SessionNode[] = [];
    for (let i = 0; i < 10; i++) {
      nodes.push(
        node({
          id: `n${i}`,
          routes: [{ id: 'on', when: 'Any reply', next: i === 9 ? 'fin' : `n${i + 1}` }],
          default: i === 9 ? 'fin' : `n${i + 1}`,
        }),
      );
    }
    nodes.push(end('fin'));
    const s = session(nodes, 'n0');
    expect(checkSessionGraph(s, NOTES).join('\n')).toMatch(/exceeds 8 replies/);
  });

  it('flags an unknown note id', () => {
    const s = session([
      node({
        id: 'open', noteIds: ['nope'],
        routes: [{ id: 'applied', when: 'x', next: 'close-good' }], default: 'close-good',
      }),
      end('close-good'),
    ]);
    expect(checkSessionGraph(s, NOTES).join('\n')).toMatch(/unknown note nope/);
  });
});

describe('resolveTurn (§16.3)', () => {
  const n = reply('open', 'stage2', 'push');
  it('follows a valid model route', () => {
    expect(resolveTurn(n, 'applied', [])).toEqual({ next: 'stage2', route: 'applied', source: 'model' });
  });
  it.each([['unclear'], [null], ['ghost']])('maps %s to default', (route) => {
    expect(resolveTurn(n, route, [])).toEqual({ next: 'push', route: 'default', source: 'fallback' });
  });
  it('a visited node follows default (no loops)', () => {
    expect(resolveTurn(n, 'applied', ['open'])).toEqual({ next: 'push', route: 'default', source: 'fallback' });
  });
  it('a narration node auto-advances', () => {
    const m = node({ id: 'n', reply: false, routes: [{ id: 'on', when: 'Always', next: 'stage2' }], default: null });
    expect(resolveTurn(m, null, ['n'])).toEqual({ next: 'stage2', route: 'on', source: 'fallback' });
  });
});

describe('session scoring (§16.3)', () => {
  it('scales the §8.2 math to 100 across the visited nodes', () => {
    // Two nodes: all hits (100/2) and hit+partial (0.75 × 50).
    const { turns, perNode } = scoreSessionTurns([
      { points: [{ result: 'hit' }, { result: 'hit' }], contradiction: false, empty: false },
      { points: [{ result: 'hit' }, { result: 'partial' }], contradiction: false, empty: false },
    ]);
    expect(perNode).toEqual([50, 37.5]);
    expect(turns).toBe(87.5);
  });
  it('an empty reply scores 0 and a contradiction multiplies by 0.75', () => {
    const { turns } = scoreSessionTurns([
      { points: [{ result: 'hit' }], contradiction: false, empty: true },
      { points: [{ result: 'hit' }], contradiction: true, empty: false },
    ]);
    expect(turns).toBe(37.5);
  });
  it('peeks subtract and stars follow §8.6', () => {
    const run = scoreSessionRun({
      answers: [
        { points: [{ index: 0, result: 'hit', quote: 'x' }], contradictions: [], empty: false },
      ],
      peeks: [{ ms: 4000 }],
    });
    // 100 − (2 for the peek + 1 for the full 3 s) = 97, ★★★.
    expect(run.total).toBe(97);
    expect(run.stars).toBe(3);
  });
});

describe('session usability (shared with banks)', () => {
  it('needs every node approved and fresh', () => {
    const s = session([reply('open', 'close-good', 'close-good'), end('close-good')]);
    expect(isSessionUsable(s, ['approved'], NOTES)).toBe(true);
    expect(isSessionUsable(s, ['approved', 'checked'], NOTES)).toBe(true);
    const draft = session([
      { ...reply('open', 'close-good', 'close-good'), status: 'draft' },
      end('close-good'),
    ]);
    expect(isSessionUsable(draft, ['approved'], NOTES)).toBe(false);
    expect(isSessionUsable(draft, ['approved', 'checked'], NOTES)).toBe(false);
  });
  it('goes stale when a note hash changes', () => {
    const s = session([reply('open', 'close-good', 'close-good'), end('close-good')]);
    const changed = [{ ...NOTES[0], hash: 'deadbeef' }, NOTES[1]];
    expect(isSessionUsable(s, ['approved'], changed)).toBe(false);
  });
  it('an end node with no noteIds stays usable (travel arrivals)', () => {
    const arrival = node({
      id: 'arrive', speaker: 'alex', reply: false, routes: [], default: null,
      end: true, noteIds: [], expectedPoints: [],
    });
    const s = session([
      node({
        id: 'open', noteIds: ['ah-p8-f1'],
        routes: [{ id: 'on', when: 'Any reply', next: 'arrive' }], default: 'arrive',
      }),
      arrival,
    ]);
    expect(isSessionUsable(s, ['approved'], NOTES)).toBe(true);
  });
  it('the fixture parses against the schema', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const raw = JSON.parse(
      fs.readFileSync(path.resolve('tests/fixtures/sessions/atomic-habits/part-8.json'), 'utf8'),
    );
    expect(() => SessionFileSchema.parse(raw)).not.toThrow();
    const parsed = SessionFileSchema.parse(raw);
    expect(parsed.role).toBe('coach');
  });
});
