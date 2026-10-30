import { useState } from 'react';
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

// Name tags instead of box overlays: the hand-set boxes never lined up
// with the people in the picture. The asker is a filled tag plus a
// "<Name> is asking" line, so it never depends on box positions.
export function ClassroomFigure(props: {
  small?: boolean;
  alt?: string;
  label?: string;
  /** The student currently asking: their name tag is highlighted. */
  highlightId?: string | null;
}) {
  const asker = props.highlightId ? studentById(props.highlightId) : null;
  return (
    <figure
      className={`classroom-fig${props.small ? ' small' : ''}`}
      aria-label={props.label ?? 'Your class'}
    >
      <img src={CLASSROOM_SRC} alt={props.alt ?? CLASSROOM_ALT} loading="lazy" />
      {asker && (
        <figcaption>
          <p className="asker-line">{asker.name} is asking</p>
          <ul className="name-tags" aria-label="Students">
            {castStudents().map((s) => (
              <li
                key={s.id}
                className={`name-tag${s.id === asker.id ? ' is-asking' : ''}`}
                aria-current={s.id === asker.id ? 'true' : undefined}
              >
                {s.name}
              </li>
            ))}
          </ul>
        </figcaption>
      )}
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
