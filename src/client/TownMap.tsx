import { useEffect, useMemo, useRef, useState } from 'react';
import { buildTrail, type WalkMove, type WalkPos } from '../shared/walk';

// The walking map (§16.6): an SVG that draws only where the traveler has
// been, from the moves of the routes the game master chose. No full town
// map — the grid is blank streets, and the trail is the learner's own words
// made visible. Compact (~150 px tall) above the line bubble on the travel
// turn screen; the debrief shows the full map with the whole trail.

export type TownMapSpeaker = {
  nodeId: string;
  speakerId: string;
  name: string;
  portrait: string;
  end: boolean;
};

function toSvg(p: WalkPos): WalkPos {
  // Model y points north (up); SVG y points down.
  return { x: p.x, y: -p.y };
}

function dist(a: WalkPos, b: WalkPos): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function TownMap(props: {
  legs: WalkMove[][];
  /** One entry per leg, in order: who was met after that leg's moves. */
  speakers: TownMapSpeaker[];
  startLabel: string;
  goalLabel: string;
  /** The goal (station) pin shows only on arrival. */
  showGoal: boolean;
  summary: string;
  /** Animate the dot along a new leg; false renders the final state at once. */
  animate?: boolean;
  /** Taller map for the debrief, which shows the whole trail. */
  full?: boolean;
}) {
  const animate = props.animate ?? true;
  const trail = useMemo(() => buildTrail(props.legs), [props.legs]);
  const pts = useMemo(() => trail.points.map(toSvg), [trail]);

  // Fit the trail: viewBox around the walked bounds with room for pins.
  const view = useMemo(() => {
    const pad = 1.6;
    let { minX, maxX, minY, maxY } = trail.bounds;
    // SVG y is flipped.
    let x0 = minX - pad;
    let x1 = maxX + pad;
    let y0 = -(maxY + pad);
    let y1 = -(minY - pad);
    if (x1 - x0 < 4) {
      const mid = (x0 + x1) / 2;
      x0 = mid - 2;
      x1 = mid + 2;
    }
    if (y1 - y0 < 3) {
      const mid = (y0 + y1) / 2;
      y0 = mid - 1.5;
      y1 = mid + 1.5;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }, [trail]);

  const grid = useMemo(() => {
    const lines: { x1: number; y1: number; x2: number; y2: number; key: string }[] = [];
    for (let gx = Math.floor(view.x); gx <= view.x + view.w; gx++) {
      lines.push({ x1: gx, y1: view.y, x2: gx, y2: view.y + view.h, key: `v${gx}` });
    }
    for (let gy = Math.floor(view.y); gy <= view.y + view.h; gy++) {
      lines.push({ x1: view.x, y1: gy, x2: view.x + view.w, y2: gy, key: `h${gy}` });
    }
    return lines;
  }, [view]);

  const path = useMemo(
    () => pts.map((p) => `${p.x},${p.y}`).join(' '),
    [pts],
  );
  const fs = view.w / 24;

  // One portrait pin per local met (first meeting wins on repeats); the end
  // node's pin is the goal, shown only on arrival.
  const pins = useMemo(() => {
    const seen = new Set<string>();
    const out: { speaker: TownMapSpeaker; pos: WalkPos }[] = [];
    props.speakers.forEach((speaker, i) => {
      if (speaker.end) return;
      if (seen.has(speaker.speakerId)) return;
      seen.add(speaker.speakerId);
      out.push({ speaker, pos: toSvg(trail.legEnds[i] ?? trail.end) });
    });
    return out;
  }, [props.speakers, trail]);

  const goalPos = useMemo(() => toSvg(trail.end), [trail]);
  const startPos = useMemo(() => (pts.length > 0 ? pts[0] : { x: 0, y: 0 }), [pts]);

  // The "you are here" dot. When a move happens it walks along the new
  // vertices over ~600 ms; with prefers-reduced-motion (or animate=false)
  // the final state shows at once.
  const [dot, setDot] = useState<WalkPos>(startPos);
  const prevPts = useRef<WalkPos[]>(pts);
  useEffect(() => {
    const target = pts.length > 0 ? pts[pts.length - 1] : startPos;
    // The new vertices are what the previous trail didn't have.
    const before = prevPts.current;
    prevPts.current = pts;
    let shared = 0;
    while (
      shared < before.length &&
      shared < pts.length &&
      before[shared].x === pts[shared].x &&
      before[shared].y === pts[shared].y
    ) {
      shared++;
    }
    const added = pts.slice(Math.max(0, shared - 1));
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduced || added.length < 2) {
      setDot(target);
      return;
    }
    const lengths: number[] = [];
    let total = 0;
    for (let i = 1; i < added.length; i++) {
      total += dist(added[i - 1], added[i]);
      lengths.push(total);
    }
    if (total === 0) {
      setDot(target);
      return;
    }
    let raf = 0;
    const t0 =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    const tick = (now: number) => {
      const covered = Math.min(total, ((now - t0) / 600) * total);
      let i = 1;
      while (i < lengths.length && lengths[i - 1] < covered) i++;
      const prev = i === 1 ? 0 : lengths[i - 2];
      const span = lengths[i - 1] - prev || 1;
      const f = (covered - prev) / span;
      const a = added[i - 1];
      const b = added[i];
      setDot({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      if (covered < total) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <svg
      className={props.full ? 'town-map town-map-full' : 'town-map'}
      data-testid="town-map"
      role="img"
      aria-label={props.summary}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <title>{props.summary}</title>
      {grid.map((l) => (
        <line key={l.key} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className="town-grid" />
      ))}
      {pts.length > 1 && (
        <polyline points={path} className="town-trail" fill="none" />
      )}
      <g data-testid="map-start">
        <circle cx={startPos.x} cy={startPos.y} r={0.18} className="town-start-ring" />
        <text x={startPos.x} y={startPos.y + 0.95} textAnchor="middle" fontSize={fs} className="town-label">
          {props.startLabel}
        </text>
      </g>
      {pins.map(({ speaker, pos }) => (
        <g key={speaker.nodeId} data-testid={`map-pin-${speaker.speakerId}`}>
          <title>{speaker.name}</title>
          <defs>
            <clipPath id={`town-pin-clip-${speaker.nodeId}`}>
              <circle cx={pos.x} cy={pos.y} r={0.45} />
            </clipPath>
          </defs>
          <circle cx={pos.x} cy={pos.y} r={0.52} className="town-pin-bg" />
          <text x={pos.x} y={pos.y + fs * 0.36} textAnchor="middle" fontSize={fs} className="town-pin-initial">
            {speaker.name.charAt(0)}
          </text>
          {speaker.portrait && (
            <image
              href={`/${speaker.portrait}`}
              x={pos.x - 0.45}
              y={pos.y - 0.45}
              width={0.9}
              height={0.9}
              clipPath={`url(#town-pin-clip-${speaker.nodeId})`}
              preserveAspectRatio="xMidYMid slice"
            >
              <title>{speaker.name}</title>
            </image>
          )}
          <circle cx={pos.x} cy={pos.y} r={0.45} className="town-pin-ring" />
        </g>
      ))}
      {props.showGoal && (
        <g data-testid="map-goal">
          <title>{props.goalLabel}</title>
          <circle cx={goalPos.x} cy={goalPos.y} r={0.55} className="town-goal-bg" />
          <path
            d={`M ${goalPos.x - 0.26} ${goalPos.y + 0.18} L ${goalPos.x - 0.26} ${goalPos.y - 0.02} L ${goalPos.x} ${goalPos.y - 0.26} L ${goalPos.x + 0.26} ${goalPos.y - 0.02} L ${goalPos.x + 0.26} ${goalPos.y + 0.18} Z M ${goalPos.x - 0.07} ${goalPos.y + 0.18} L ${goalPos.x - 0.07} ${goalPos.y + 0.04} L ${goalPos.x + 0.07} ${goalPos.y + 0.04} L ${goalPos.x + 0.07} ${goalPos.y + 0.18} Z`}
            className="town-goal-glyph"
          />
          <text x={goalPos.x} y={goalPos.y + 1.05} textAnchor="middle" fontSize={fs} className="town-label">
            {props.goalLabel}
          </text>
        </g>
      )}
      <g data-testid="map-you">
        <circle cx={dot.x} cy={dot.y} r={0.3} className="town-you-halo" />
        <circle cx={dot.x} cy={dot.y} r={0.17} className="town-you" />
      </g>
    </svg>
  );
}
