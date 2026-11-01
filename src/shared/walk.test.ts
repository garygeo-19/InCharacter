import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyLeg,
  buildTrail,
  describeWalk,
  resolveLegMoves,
} from './walk';
import { SessionFileSchema } from './session';

describe('walk model (§16.6)', () => {
  it('turns right then walks blocks east from a north heading', () => {
    const leg = applyLeg({ x: 0, y: 0 }, 0, [{ turn: 'right', blocks: 3 }]);
    expect(leg.pos).toEqual({ x: 3, y: 0 });
    expect(leg.heading).toBe(1);
  });

  it('turns left then walks blocks west from a north heading', () => {
    const leg = applyLeg({ x: 0, y: 0 }, 0, [{ turn: 'left', blocks: 1 }]);
    expect(leg.pos).toEqual({ x: -1, y: 0 });
    expect(leg.heading).toBe(3);
  });

  it('walks straight with turn none, keeping the heading', () => {
    const leg = applyLeg({ x: 3, y: 0 }, 1, [{ turn: 'none', blocks: 2 }]);
    expect(leg.pos).toEqual({ x: 5, y: 0 });
    expect(leg.heading).toBe(1);
  });

  it('chains multiple steps: straight 2 then left 1', () => {
    // Pablo's directions from an east heading: straight 2, then left 1 (north).
    const leg = applyLeg({ x: 3, y: 0 }, 1, [
      { turn: 'none', blocks: 2 },
      { turn: 'left', blocks: 1 },
    ]);
    expect(leg.pos).toEqual({ x: 5, y: 1 });
    expect(leg.heading).toBe(0);
    expect(leg.segments).toHaveLength(2);
  });

  it('empty or missing moves stay put', () => {
    const leg = applyLeg({ x: 1, y: 2 }, 0, []);
    expect(leg.pos).toEqual({ x: 1, y: 2 });
    expect(leg.heading).toBe(0);
    expect(leg.segments).toHaveLength(0);
  });

  it('zero blocks stay put but keep the trail continuous', () => {
    const trail = buildTrail([[{ turn: 'right', blocks: 0 }]]);
    expect(trail.end).toEqual({ x: 0, y: 0 });
    expect(trail.legEnds).toEqual([{ x: 0, y: 0 }]);
  });

  it('records a pin position after each leg and fits the bounds', () => {
    const trail = buildTrail([
      [{ turn: 'right', blocks: 3 }],
      [
        { turn: 'none', blocks: 2 },
        { turn: 'left', blocks: 1 },
      ],
    ]);
    expect(trail.legEnds).toEqual([
      { x: 3, y: 0 },
      { x: 5, y: 1 },
    ]);
    expect(trail.end).toEqual({ x: 5, y: 1 });
    expect(trail.bounds).toEqual({ minX: 0, maxX: 5, minY: 0, maxY: 1 });
  });

  it('bounds cover a detour west of the start', () => {
    const trail = buildTrail([[{ turn: 'left', blocks: 1 }]]);
    expect(trail.bounds.minX).toBe(-1);
    expect(trail.end).toEqual({ x: -1, y: 0 });
  });

  it('resolves the moves of the route the game master chose', () => {
    const routes = [
      { id: 'lucia-right', next: 'pablo-2', moves: [{ turn: 'right' as const, blocks: 3 }] },
      { id: 'lucia-left', next: 'detour-plaza', moves: [{ turn: 'left' as const, blocks: 1 }] },
    ];
    expect(resolveLegMoves(routes, 'lucia-right', 'pablo-2')).toEqual([
      { turn: 'right', blocks: 3 },
    ]);
  });

  it('a default fallback follows the route to the same next node, else stays put', () => {
    const routes = [
      { id: 'on', next: 'marisol-3', moves: [{ turn: 'none' as const, blocks: 2 }] },
    ];
    expect(resolveLegMoves(routes, 'default', 'marisol-3')).toEqual([
      { turn: 'none', blocks: 2 },
    ]);
    // A "¿Perdón?" repeat leads somewhere no route names: stay put.
    expect(resolveLegMoves(routes, 'default', 'lucia-perdon')).toEqual([]);
    // Missing moves stay put too.
    expect(resolveLegMoves([{ id: 'on', next: 'x' }], 'on', 'x')).toEqual([]);
  });

  it('summarizes the walk for the map aria label', () => {
    expect(
      describeWalk(
        [
          [{ turn: 'right', blocks: 3 }],
          [
            { turn: 'none', blocks: 2 },
            { turn: 'left', blocks: 1 },
          ],
        ],
        { arrived: false, goal: 'Estación' },
      ),
    ).toBe(
      'You walked right 3 blocks, then straight 2 and left 1, and are on your way to Estación.',
    );
    expect(
      describeWalk(
        [[{ turn: 'right', blocks: 3 }]],
        { arrived: true, goal: 'Estación' },
      ),
    ).toBe('You walked right 3 blocks, and reached Estación.');
    expect(describeWalk([[]], { arrived: false, goal: 'Estación' })).toBe(
      'You stayed where you started, and are on your way to Estación.',
    );
  });
});

describe('session schema (§16.6 moves/map optional)', () => {
  const base = {
    schemaVersion: 1 as const,
    role: 'travel' as const,
    packId: 'spanish-travel-lodging',
    packVersion: '1.0.7',
    lessonId: 'l5-travel',
    partId: 'p14-asking-directions',
    builtAt: '2026-11-01',
    notes: [],
    brief: 'Ask the way.',
    cast: [{ id: 'lucia', name: 'Doña Lucía', description: 'd', voiceId: 'v', portrait: 'art/travel/lucia.webp' }],
    scene: 'art/travel/scene.webp',
    start: 'lucia-1',
    nodes: [],
  };

  it('accepts routes with moves and a session-level map', () => {
    const parsed = SessionFileSchema.parse({
      ...base,
      map: { start: 'Plaza', goal: 'Estación' },
      nodes: [],
    });
    expect(parsed.map).toEqual({ start: 'Plaza', goal: 'Estación' });
  });

  it('old sessions without moves or map still load (coach has neither)', () => {
    const parsed = SessionFileSchema.parse({ ...base, role: 'coach', map: undefined });
    expect(parsed.map).toBeUndefined();
  });

  it('the travel session file parses with its moves and map', () => {
    const raw = JSON.parse(
      readFileSync('content/sessions/spanish-travel-lodging/p14-asking-directions.json', 'utf8'),
    );
    const parsed = SessionFileSchema.parse(raw);
    expect(parsed.map).toEqual({ start: 'Plaza', goal: 'Estación' });
    const first = parsed.nodes.find((n) => n.id === 'lucia-1');
    expect(first?.routes.find((r) => r.id === 'lucia-right')?.moves).toEqual([
      { turn: 'right', blocks: 3 },
    ]);
  });

  it('rejects a bad turn and out-of-range blocks', () => {
    expect(
      SessionFileSchema.safeParse({
          ...base,
          nodes: [
            {
              id: 'n',
              speaker: 'lucia',
              text: 'x',
              gloss: null,
              scene: null,
              ttsText: null,
              audio: null,
              reply: true,
              noteIds: [],
              expectedPoints: [],
              routes: [{ id: 'r', when: 'x', next: 'n', moves: [{ turn: 'up', blocks: 1 }] }],
              default: null,
              end: false,
              status: 'checked',
              check: null,
              review: null,
            },
          ],
        }).success,
    ).toBe(false);
    expect(
      SessionFileSchema.safeParse({
        ...base,
        nodes: [
          {
            id: 'n',
            speaker: 'lucia',
            text: 'x',
            gloss: null,
            scene: null,
            ttsText: null,
            audio: null,
            reply: true,
            noteIds: [],
            expectedPoints: [],
            routes: [{ id: 'r', when: 'x', next: 'n', moves: [{ turn: 'right', blocks: 6 }] }],
            default: null,
            end: false,
            status: 'checked',
            check: null,
            review: null,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
