import { useEffect, useRef, useState } from 'react';
import type { Peek } from '../shared/types';
import type { Outline } from '../shared/notes';

// Hold-to-peek on the outline (§5). A peek starts after a 300 ms hold, ends
// on release, slide-off or cancel; the timer and recording keep running.
// Tap mode (accessibility setting) opens on tap and closes on a second tap
// or after 10 seconds. One note visible at a time.

const HOLD_MS = 300;
const TAP_CLOSE_MS = 10_000;

export function OutlinePeek(props: {
  outline: Outline;
  noteText: (id: string) => string;
  phase: 'class' | 'questions';
  peekStyle: 'hold' | 'tap';
  onPeek: (peek: Peek) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peekStart = useRef<number>(0);
  const peekingId = useRef<string | null>(null);

  const clearTimers = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (tapTimer.current) clearTimeout(tapTimer.current);
    holdTimer.current = tapTimer.current = null;
  };

  useEffect(() => clearTimers, []);

  const finishPeek = (id: string | null) => {
    if (id && peekingId.current === id) {
      const endedAt = Date.now();
      props.onPeek({
        noteId: id, phase: props.phase,
        startedAt: peekStart.current, endedAt, ms: endedAt - peekStart.current,
      });
      peekingId.current = null;
    }
    setOpenId(null);
  };

  const openPeek = (id: string) => {
    peekStart.current = Date.now();
    peekingId.current = id;
    setOpenId(id);
  };

  const startHold = (id: string) => {
    if (props.peekStyle === 'tap') return;
    clearTimers();
    holdTimer.current = setTimeout(() => openPeek(id), HOLD_MS);
  };

  const endHold = () => {
    if (props.peekStyle === 'tap') return;
    if (holdTimer.current) {
      // released before 300 ms: a tap or scroll, records nothing (§5)
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
      return;
    }
    finishPeek(openId);
  };

  const tapRow = (id: string) => {
    if (props.peekStyle !== 'tap') return;
    if (openId === id) {
      clearTimers();
      finishPeek(id);
    } else {
      clearTimers();
      openPeek(id);
      tapTimer.current = setTimeout(() => finishPeek(id), TAP_CLOSE_MS);
    }
  };

  const row = (id: string, label: string) => (
    <button
      key={id}
      type="button"
      className={`peek-row${openId === id ? ' open' : ''}`}
      aria-expanded={openId === id}
      onPointerDown={() => startHold(id)}
      onPointerUp={endHold}
      onPointerLeave={endHold}
      onPointerCancel={endHold}
      onClick={() => tapRow(id)}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          if (props.peekStyle === 'tap') tapRow(id);
          else startHold(id);
        }
      }}
      onKeyUp={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && props.peekStyle !== 'tap') {
          e.preventDefault();
          endHold();
        }
      }}
    >
      <span className="peek-label">{label}</span>
      {openId === id && <span className="peek-text">{props.noteText(id)}</span>}
    </button>
  );

  return (
    <div className="outline" aria-label="Lesson outline — press and hold a row to peek">
      {props.outline.facts.map((r) => row(r.id, r.label))}
      {props.outline.words.length > 0 && (
        <p className="outline-group">Words</p>
      )}
      {props.outline.words.map((r) => row(r.id, r.label))}
    </div>
  );
}
