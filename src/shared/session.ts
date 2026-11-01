import { z } from 'zod';
import { notesFresh } from './bank';
import { peekPenalty, starsFor, type Score } from './scoring';
import type { CheckedAnswerGrade } from './evidence';
import type { Note } from './notes';
import type { Peek } from './types';

// REQUIREMENTS.md §16.2: the session file (Coach and Traveler share one
// engine). Zod validation plus the graph rules as pure, unit-tested code.

export const SESSION_ROLES = ['coach', 'travel'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export type SessionNodeStatus = 'draft' | 'checked' | 'approved' | 'rejected';

const AudioSchema = z.object({
  file: z.string(),
  textHash: z.string(),
  voiceId: z.string(),
  model: z.string(),
});

// One walking-map step (§16.6): turn relative to the current heading, then
// walk that many blocks. Missing or empty moves stay put (the "¿Perdón?"
// repeats). Validated here so old sessions without moves still load.
export const MoveSchema = z.object({
  turn: z.enum(['left', 'right', 'none']),
  blocks: z.number().int().min(0).max(5),
});
export type SessionMove = z.infer<typeof MoveSchema>;

const RouteSchema = z.object({
  id: z.string(),
  when: z.string(),
  next: z.string(),
  moves: z.array(MoveSchema).optional(),
});

const ExpectedPointSchema = z.object({
  text: z.string(),
  noteIds: z.array(z.string()),
});

export const SessionNodeSchema = z.object({
  id: z.string(),
  speaker: z.string(),
  text: z.string(),
  gloss: z.string().nullable(),
  // Travel nodes may set their own scene picture (§16.2, §16.5); otherwise
  // the session-level scene shows. Coach nodes leave this null.
  scene: z.string().nullable(),
  ttsText: z.string().nullable(),
  audio: AudioSchema.nullable(),
  reply: z.boolean(),
  noteIds: z.array(z.string()),
  expectedPoints: z.array(ExpectedPointSchema),
  routes: z.array(RouteSchema),
  default: z.string().nullable(),
  end: z.boolean(),
  status: z.enum(['draft', 'checked', 'approved', 'rejected']),
  check: z.unknown(),
  review: z.unknown(),
});
export type SessionNode = z.infer<typeof SessionNodeSchema>;

export const SessionFileSchema = z.object({
  schemaVersion: z.literal(1),
  role: z.enum(['coach', 'travel']),
  packId: z.string(),
  packVersion: z.string(),
  lessonId: z.string(),
  partId: z.string(),
  builtAt: z.string(),
  notes: z.array(z.object({ id: z.string(), hash: z.string() })),
  brief: z.string(),
  cast: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      voiceId: z.string(),
      portrait: z.string(),
    }),
  ),
  scene: z.string(),
  start: z.string(),
  nodes: z.array(SessionNodeSchema),
  // The walking map (§16.6, travel only): when present the session shows the
  // map. Old sessions without it — and the coach session — still load.
  map: z.object({ start: z.string(), goal: z.string() }).optional(),
});
export type SessionFile = z.infer<typeof SessionFileSchema>;

export type SessionCastMember = SessionFile['cast'][number];
export type SessionRoute = SessionFile['nodes'][number]['routes'][number];

/** A session is usable only when every node is usable (§16.2): its status
 *  is in USABLE_STATUSES and its notes are still fresh (same stale rule as
 *  banks, §7.6 — see notesFresh in bank.ts). */
export function usableSessionNodes(session: SessionFile, statuses: string[]): SessionNode[] {
  return session.nodes.filter((n) => statuses.includes(n.status));
}

export function isSessionUsable(
  session: SessionFile,
  statuses: string[],
  notes: Note[],
): boolean {
  if (session.nodes.length === 0) return false;
  return session.nodes.every(
    (n) =>
      statuses.includes(n.status) &&
      // An end node cites no notes (the arrival line needs no grounding),
      // so there is nothing that can go stale.
      (n.noteIds.length === 0 || notesFresh(session.notes, notes, n.noteIds)),
  );
}

// --- Graph rules (§16.2, code-checked) ----------------------------------------
// Every next and default names a node; start exists; every node is
// reachable; every path ends at an end node within 8 learner replies; a
// reply node has 1–3 routes and a default; an end node has no routes and
// reply: false. A narration node (reply false, not end) auto-advances along
// exactly one route.

/** At most 8 learner replies on any path from start to an end node. */
export const MAX_SESSION_REPLIES = 8;

/** Full §16.2 code checks for a session file against the part's notes. */
export function checkSessionGraph(session: SessionFile, notes: Note[]): string[] {
  const errors: string[] = [];
  const noteIds = new Set(notes.map((n) => n.id));
  const byId = new Map(session.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();

  for (const n of session.nodes) {
    if (seen.has(n.id)) errors.push(`${n.id}: duplicate node id`);
    seen.add(n.id);
    if (!byId.has(n.id)) errors.push(`${n.id}: unreachable internal error`);
    for (const id of n.noteIds) {
      if (!noteIds.has(id)) errors.push(`${n.id}: unknown note ${id}`);
    }
    for (const [i, p] of n.expectedPoints.entries()) {
      if (p.noteIds.length < 1) errors.push(`${n.id}: expected point ${i} cites no notes`);
      for (const id of p.noteIds) {
        if (!noteIds.has(id)) errors.push(`${n.id}: expected point ${i} cites unknown note ${id}`);
      }
    }
    const routeIds = new Set<string>();
    for (const r of n.routes) {
      if (routeIds.has(r.id)) errors.push(`${n.id}: duplicate route id ${r.id}`);
      routeIds.add(r.id);
      if (!byId.has(r.next)) errors.push(`${n.id}: route ${r.id} points at missing node ${r.next}`);
    }
    if (n.default !== null && !byId.has(n.default)) {
      errors.push(`${n.id}: default points at missing node ${n.default}`);
    }
    if (n.end) {
      if (n.routes.length > 0) errors.push(`${n.id}: end node must have no routes`);
      if (n.reply) errors.push(`${n.id}: end node must have reply false`);
      if (n.default !== null) errors.push(`${n.id}: end node must have no default`);
    } else if (n.reply) {
      if (n.routes.length < 1 || n.routes.length > 3) {
        errors.push(`${n.id}: reply node needs 1–3 routes, has ${n.routes.length}`);
      }
      if (n.default === null) errors.push(`${n.id}: reply node needs a default`);
    } else {
      if (n.routes.length !== 1) {
        errors.push(`${n.id}: narration node needs exactly 1 route, has ${n.routes.length}`);
      }
      if (n.default !== null) errors.push(`${n.id}: narration node must have no default`);
    }
  }

  if (!byId.has(session.start)) {
    errors.push(`start points at missing node ${session.start}`);
    return errors;
  }

  // Reachability from start (routes plus defaults).
  const reached = new Set<string>([session.start]);
  const queue = [session.start];
  while (queue.length > 0) {
    const cur = byId.get(queue.pop()!)!;
    const nexts = [...cur.routes.map((r) => r.next), ...(cur.default ? [cur.default] : [])];
    for (const nx of nexts) {
      if (byId.has(nx) && !reached.has(nx)) {
        reached.add(nx);
        queue.push(nx);
      }
    }
  }
  for (const n of session.nodes) {
    if (!reached.has(n.id)) errors.push(`${n.id}: unreachable from start`);
  }

  // Every path ends at an end node within 8 learner replies. At run time a
  // revisited reply node follows its default (no loops, §16.3), so the
  // analysis does the same; a loop through narration nodes never resolves.
  const pathErrors: string[] = [];
  const visiting: string[] = [];
  function walk(nodeId: string, replies: number, visited: Set<string>): void {
    const node = byId.get(nodeId);
    if (!node || pathErrors.length > 4) return;
    if (node.end) return;
    if (node.reply) {
      if (replies >= MAX_SESSION_REPLIES) {
        pathErrors.push(`path ${[...visiting, nodeId].join(' → ')} exceeds ${MAX_SESSION_REPLIES} replies without an end`);
        return;
      }
      if (visited.has(nodeId)) {
        // Run-time loop rule: follow default once.
        if (node.default) {
          visiting.push(`${nodeId}(default)`);
          walk(node.default, replies + 1, visited);
          visiting.pop();
        }
        return;
      }
      const next = new Set(visited);
      next.add(nodeId);
      for (const r of node.routes) {
        visiting.push(`${nodeId}:${r.id}`);
        walk(r.next, replies + 1, next);
        visiting.pop();
      }
      if (node.default) {
        visiting.push(`${nodeId}(default)`);
        walk(node.default, replies + 1, next);
        visiting.pop();
      }
    } else {
      if (visiting.includes(nodeId)) {
        pathErrors.push(`narration loop at ${nodeId}: ${[...visiting, nodeId].join(' → ')}`);
        return;
      }
      visiting.push(nodeId);
      walk(node.routes[0]?.next ?? '', replies, visited);
      visiting.pop();
    }
  }
  walk(session.start, 0, new Set());
  errors.push(...pathErrors);
  return errors;
}

// --- Writer code checks (session:build, mirroring §7.5) ------------------------
// Lengths (coach 200, travel 120 chars per line), note ids, 1–2 expected
// points per reply node, speakers from the cast, plus the graph rules.

/** Full writer code checks for a session draft against the part's notes. */
export function checkSessionFile(session: SessionFile, notes: Note[]): string[] {
  const errors: string[] = checkSessionGraph(session, notes);
  const noteIds = new Set(notes.map((n) => n.id));
  const castIds = new Set(session.cast.map((c) => c.id));
  const maxLine = session.role === 'coach' ? 200 : 120;
  if (session.cast.length < 1 || session.cast.length > 4) {
    errors.push(`cast has ${session.cast.length} members, need 1–4`);
  }
  for (const n of session.nodes) {
    if (!castIds.has(n.speaker)) errors.push(`${n.id}: unknown speaker ${n.speaker}`);
    if (n.text.length > maxLine) {
      errors.push(`${n.id}: text is ${n.text.length} chars, max ${maxLine}`);
    }
    if (n.reply) {
      if (n.expectedPoints.length < 1 || n.expectedPoints.length > 2) {
        errors.push(`${n.id}: need 1–2 expectedPoints`);
      }
    }
    for (const [i, p] of n.expectedPoints.entries()) {
      if (p.noteIds.length < 1) errors.push(`${n.id}: expected point ${i} cites no notes`);
      for (const id of p.noteIds) {
        if (!noteIds.has(id)) errors.push(`${n.id}: expected point ${i} cites unknown note ${id}`);
      }
    }
  }
  return errors;
}

export type SessionCheckerCheck = { pass: boolean; reason: string };

/** One session-check result row: four pass/fail checks plus keep/drop. */
export type SessionCheckerResult = {
  nodeId: string;
  groundedInNotes: SessionCheckerCheck;
  naturalVoice: SessionCheckerCheck;
  routeFair: SessionCheckerCheck;
  safe: SessionCheckerCheck;
  verdict: 'keep' | 'drop';
};

const SESSION_CHECK_KEYS = ['groundedInNotes', 'naturalVoice', 'routeFair', 'safe'] as const;

/** Errors from checkSessionFile that belong to one node. */
export function sessionNodeCodeErrors(nodeId: string, errors: string[]): string[] {
  return errors.filter((e) => e.startsWith(`${nodeId}:`) || e.startsWith(`${nodeId} `));
}

/** Apply the checker verdicts: any failing check, a drop verdict, or a
 *  missing verdict makes the node `rejected`, with the reason recorded. */
export function applySessionCheckerResults(
  nodes: SessionNode[],
  results: SessionCheckerResult[],
  model: string,
  at: string,
): SessionNode[] {
  const byId = new Map(results.map((r) => [r.nodeId, r]));
  return nodes.map((n) => {
    const r = byId.get(n.id);
    const checks: Record<string, SessionCheckerCheck> = {};
    for (const k of SESSION_CHECK_KEYS) {
      checks[k] = r
        ? r[k]
        : { pass: false, reason: 'No checker verdict for this node.' };
    }
    const failed = SESSION_CHECK_KEYS.some((k) => !checks[k].pass);
    const rejected = !r || r.verdict === 'drop' || failed;
    return {
      ...n,
      status: rejected ? ('rejected' as const) : n.status,
      check: { model, at, results: checks },
    };
  });
}

// --- The turn route mapping (§16.3 game master) --------------------------------

export type TurnResolution = {
  next: string;
  route: string;
  source: 'model' | 'fallback';
};

/**
 * Map the game-master outcome to the next node. "unclear", a timeout (null),
 * an invalid route id, and a revisited node all fall back to `default`;
 * narration nodes auto-advance along their single route.
 */
export function resolveTurn(
  node: SessionNode,
  modelRoute: string | null,
  visited: string[],
): TurnResolution {
  if (!node.reply) {
    const only = node.routes[0];
    return { next: only.next, route: only.id, source: 'fallback' };
  }
  const fallback: TurnResolution = { next: node.default ?? node.id, route: 'default', source: 'fallback' };
  if (visited.includes(node.id)) return fallback;
  const match = node.routes.find((r) => r.id === modelRoute);
  if (!match) return fallback;
  return { next: match.next, route: match.id, source: 'model' };
}

// --- Session scoring (§16.3) ---------------------------------------------------
// The expected-point verdicts of the visited reply nodes, scored as §8.2 but
// scaled to 100 (each visited node is worth 100/N), then peeks (§8.4).
// Stars as §8.6. Reuses the answers-evidence verdicts, so a session grade is
// a list of CheckedAnswerGrade with nodeId as the question id.

export function scoreSessionTurns(
  answers: { points: { result: 'hit' | 'partial' | 'none' }[]; contradiction: boolean; empty: boolean }[],
): { turns: number; perNode: number[] } {
  const n = answers.length;
  const perNode = answers.map((a) => {
    if (n === 0 || a.empty || a.points.length === 0) return 0;
    const mean = a.points.reduce((s, p) => s + (p.result === 'hit' ? 1 : p.result === 'partial' ? 0.5 : 0), 0) / a.points.length;
    return mean * (a.contradiction ? 0.75 : 1) * (100 / n);
  });
  return { turns: perNode.reduce((s, x) => s + x, 0), perNode };
}

export function scoreSessionRun(input: {
  answers: Pick<CheckedAnswerGrade, 'points' | 'contradictions' | 'empty'>[];
  peeks: Pick<Peek, 'ms'>[];
}): Score & { perNode: number[] } {
  const { turns, perNode } = scoreSessionTurns(
    input.answers.map((a) => ({
      points: a.points,
      contradiction: a.contradictions.length > 0,
      empty: a.empty,
    })),
  );
  const peeks = peekPenalty(input.peeks);
  const score = {
    lesson: 0,
    questions: turns,
    peekPenalty: peeks.penalty,
    total: Math.round(turns - peeks.penalty),
    stars: starsFor(Math.round(turns - peeks.penalty)),
  };
  return { ...score, perNode };
}
