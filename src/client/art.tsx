import { useEffect, useState } from 'react';
import cast from '../../content/cast.json';

// Classroom art (M4, REQUIREMENTS.md §9.8). Files live in public/art/;
// cast.json points at them. Portraits keep their alt text from the cast
// descriptions so every picture names who it shows.

export type CastStudent = {
  id: string;
  name: string;
  type: string;
  description: string;
  voiceId: string;
  portrait: string;
};

export function castStudents(): CastStudent[] {
  return cast.students as CastStudent[];
}

export function studentById(id: string): CastStudent | null {
  return castStudents().find((s) => s.id === id) ?? null;
}

export const CLASSROOM_SRC = `/${cast.classroom as string}`;
export const CLASSROOM_ALT =
  'Your evening class: four adult students at their desks, facing you — ' +
  'Maya (curly dark hair, mustard sweater), Leo (gray beard, denim jacket), ' +
  'Priya (glasses, teal cardigan) and Sam (short hair, red hoodie).';

export function portraitSrc(id: string): string {
  const s = studentById(id);
  return s ? `/${s.portrait}` : '';
}

export function portraitAlt(id: string): string {
  const s = studentById(id);
  return s ? `${s.name}, ${s.description}` : id;
}

export function PortraitImg({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  const student = studentById(id);
  if (!student || failed) {
    return (
      <span className="portrait" aria-hidden>
        {(student?.name ?? id)[0]}
      </span>
    );
  }
  return (
    <img
      className="portrait-img"
      src={portraitSrc(id)}
      alt={portraitAlt(id)}
      width={56}
      height={56}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

type MaskBox = { x1: number; y1: number; x2: number; y2: number };
type MasksFile = {
  source: 'sam-3.1' | 'hand';
  segments: { studentId: string; box: MaskBox }[];
};

// Fallback if /art/classroom-masks.json can't be fetched. It mirrors the
// hand-set boxes (scripts/art-build.ts --hand); the fetched file wins when
// present. Fractions of the picture, left to right: maya, leo, priya, sam.
const FALLBACK_SEGMENTS: MasksFile['segments'] = [
  { studentId: 'maya', box: { x1: 0.1, y1: 0.375, x2: 0.335, y2: 0.84 } },
  { studentId: 'leo', box: { x1: 0.36, y1: 0.36, x2: 0.6, y2: 0.85 } },
  { studentId: 'priya', box: { x1: 0.6, y1: 0.355, x2: 0.83, y2: 0.85 } },
  { studentId: 'sam', box: { x1: 0.825, y1: 0.32, x2: 0.998, y2: 0.86 } },
];

function validBox(box: MaskBox): boolean {
  return (
    [box.x1, box.y1, box.x2, box.y2].every((v) => typeof v === 'number' && v >= 0 && v <= 1) &&
    box.x1 < box.x2 &&
    box.y1 < box.y2
  );
}

export function ClassroomFigure(props: {
  small?: boolean;
  alt?: string;
  label?: string;
  /** Show the per-student boxes; the highlighted one is outlined, the rest dimmed. */
  highlightId?: string | null;
}) {
  const [segments, setSegments] = useState<MasksFile['segments']>(FALLBACK_SEGMENTS);
  useEffect(() => {
    let live = true;
    fetch(`/${cast.masks as string}`)
      .then((r) => {
        if (!r.ok) throw new Error('no masks');
        return r.json();
      })
      .then((json: MasksFile) => {
        if (!live || !Array.isArray(json.segments)) return;
        const good = json.segments.filter(
          (s) => studentById(s.studentId) && s.box && validBox(s.box),
        );
        if (good.length === 4) setSegments(good);
      })
      .catch(() => {
        // Keep the fallback boxes.
      });
    return () => {
      live = false;
    };
  }, []);

  const asking = props.highlightId ?? null;
  return (
    <figure
      className={`classroom-fig${props.small ? ' small' : ''}${asking ? ' has-asker' : ''}`}
      aria-label={props.label ?? 'Your class'}
    >
      <img src={CLASSROOM_SRC} alt={props.alt ?? CLASSROOM_ALT} loading="lazy" />
      {asking &&
        segments.map((s) => (
          <div
            key={s.studentId}
            aria-hidden
            className={`mask-box${s.studentId === asking ? ' is-asker' : ' is-dim'}`}
            style={{
              left: `${s.box.x1 * 100}%`,
              top: `${s.box.y1 * 100}%`,
              width: `${(s.box.x2 - s.box.x1) * 100}%`,
              height: `${(s.box.y2 - s.box.y1) * 100}%`,
            }}
          >
            {s.studentId === asking && (
              <span className="mask-tag">{studentById(s.studentId)?.name}</span>
            )}
          </div>
        ))}
    </figure>
  );
}

export function CastRow() {
  return (
    <div className="portrait-row" aria-label="Your students">
      {castStudents().map((s) => (
        <div className="portrait-cell" key={s.id}>
          <PortraitImg id={s.id} />
          <span>{s.name}</span>
        </div>
      ))}
    </div>
  );
}
