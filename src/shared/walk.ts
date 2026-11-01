// The walking map (§16.6): a pure walk model drawn from what the traveler
// SAID they would do. Each route carries the moves the game master chose;
// the client applies them in order. Start at (0,0) heading north (up) at the
// start label's pin; each step turns (relative to the current heading) then
// advances `blocks` grid units. A pin is recorded where each new node's
// speaker is met — the position after the moves that led to that node.

export type WalkTurn = 'left' | 'right' | 'none';

export type WalkMove = {
  turn: WalkTurn;
  blocks: number;
};

export type WalkPos = { x: number; y: number };

/** Heading: 0 north, 1 east, 2 south, 3 west. */
export type WalkHeading = 0 | 1 | 2 | 3;

export const START_POS: WalkPos = { x: 0, y: 0 };
export const START_HEADING: WalkHeading = 0;

const DX = [0, 1, 0, -1];
const DY = [1, 0, -1, 0];

function applyTurn(heading: WalkHeading, turn: WalkTurn): WalkHeading {
  if (turn === 'left') return ((heading + 3) % 4) as WalkHeading;
  if (turn === 'right') return ((heading + 1) % 4) as WalkHeading;
  return heading;
}

/** Apply one step: turn, then advance `blocks` grid units. */
export function applyStep(
  pos: WalkPos,
  heading: WalkHeading,
  move: WalkMove,
): { pos: WalkPos; heading: WalkHeading } {
  const next = applyTurn(heading, move.turn);
  return {
    pos: { x: pos.x + DX[next] * move.blocks, y: pos.y + DY[next] * move.blocks },
    heading: next,
  };
}

export type WalkSegment = { from: WalkPos; to: WalkPos };

/** Apply a leg (one route's moves): turn/advance per step, collecting segments. */
export function applyLeg(
  pos: WalkPos,
  heading: WalkHeading,
  moves: WalkMove[],
): { pos: WalkPos; heading: WalkHeading; segments: WalkSegment[] } {
  const segments: WalkSegment[] = [];
  let cur = pos;
  let hdg = heading;
  for (const m of moves ?? []) {
    const step = applyStep(cur, hdg, m);
    // Record every step, even a 0-block turn, so the trail stays continuous.
    segments.push({ from: cur, to: step.pos });
    cur = step.pos;
    hdg = step.heading;
  }
  return { pos: cur, heading: hdg, segments };
}

export type WalkTrail = {
  /** Every vertex from the start pin to the current position. */
  points: WalkPos[];
  /** Straight segments between consecutive vertices. */
  segments: WalkSegment[];
  /** Where each leg ended (the pin position after that leg's moves). */
  legEnds: WalkPos[];
  end: WalkPos;
  heading: WalkHeading;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
};

/** Build the trail for a sequence of legs (one moves array per transition). */
export function buildTrail(legs: WalkMove[][]): WalkTrail {
  const points: WalkPos[] = [{ ...START_POS }];
  const segments: WalkSegment[] = [];
  const legEnds: WalkPos[] = [];
  let pos: WalkPos = { ...START_POS };
  let heading: WalkHeading = START_HEADING;
  for (const moves of legs) {
    const leg = applyLeg(pos, heading, moves ?? []);
    pos = leg.pos;
    heading = leg.heading;
    for (const s of leg.segments) {
      segments.push(s);
      points.push({ ...s.to });
    }
    legEnds.push({ ...pos });
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    points,
    segments,
    legEnds,
    end: { ...pos },
    heading,
    bounds: {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    },
  };
}

/** Resolve the moves for the transition the game master chose (§16.6): the
 *  route with the returned id; when the route is the default fallback, the
 *  route (if any) that leads to the same next node — otherwise stay put,
 *  which is what the "¿Perdón?" repeats do. Missing moves also stay put. */
export function resolveLegMoves(
  routes: { id: string; moves?: WalkMove[] | null; next?: string }[],
  routeId: string,
  next: string,
): WalkMove[] {
  const direct = routes.find((r) => r.id === routeId);
  if (direct) return [...(direct.moves ?? [])];
  if (routeId === 'default') {
    const sameTarget = routes.find((r) => r.next === next);
    if (sameTarget) return [...(sameTarget.moves ?? [])];
  }
  return [];
}

function stepWord(m: WalkMove): string {
  return m.turn === 'none' ? 'straight' : m.turn;
}

/** "right 3 blocks" (first phrase carries the unit) or "right 3" after it. */
function stepPhrase(m: WalkMove, withUnit: boolean): string | null {
  if (m.blocks <= 0) return null;
  const unit = withUnit ? (m.blocks === 1 ? ' block' : ' blocks') : '';
  return `${stepWord(m)} ${m.blocks}${unit}`;
}

/** Plain-language summary of the whole walk for the map's aria label (§16.6). */
export function describeWalk(
  legs: WalkMove[][],
  opts: { arrived: boolean; goal?: string | null },
): string {
  // First moving step carries the unit ("right 3 blocks"), the rest are bare
  // ("straight 2 and left 1"); steps join with " and " in a leg, legs with
  // ", then ". Zero-block steps say nothing about distance.
  let first = true;
  const legTexts: string[] = [];
  for (const moves of legs) {
    const phrases: string[] = [];
    for (const m of moves ?? []) {
      const phrase = stepPhrase(m, first);
      if (phrase) {
        phrases.push(phrase);
        first = false;
      }
    }
    if (phrases.length > 0) legTexts.push(phrases.join(' and '));
  }
  const walked =
    legTexts.length === 0
      ? 'You stayed where you started'
      : `You walked ${legTexts.join(', then ')}`;
  const goal = opts.goal ?? 'the station';
  return opts.arrived ? `${walked}, and reached ${goal}.` : `${walked}, and are on your way to ${goal}.`;
}
