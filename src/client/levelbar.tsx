// Pinned recording level bar: a thin horizontal bar fixed to the top of the
// viewport (below the safe-area inset), so it stays on screen while the
// learner scrolls the outline. The bar itself is silent for screen readers;
// one live region announces "Recording" once when it mounts, never per
// frame. Under prefers-reduced-motion the fill sits steady red with a
// numeric level snapped about twice a second instead of animating freely.
import { useEffect, useRef, useState } from 'react';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function LevelBar({ level }: { level: number }) {
  const reduceMotion = useReducedMotion();
  // Free updates normally; a ~2 Hz snapshot under reduced motion.
  const [shown, setShown] = useState(0);
  const latest = useRef(0);
  latest.current = Math.min(1, Math.max(0, level));
  useEffect(() => {
    if (!reduceMotion) {
      setShown(latest.current);
      return;
    }
    setShown(latest.current);
    const t = setInterval(() => setShown(latest.current), 500);
    return () => clearInterval(t);
  }, [reduceMotion]);
  useEffect(() => {
    if (!reduceMotion) setShown(latest.current);
  }, [level, reduceMotion]);

  const pct = Math.round(shown * 100);
  return (
    <div className="levelbar-pinned">
      <span className="sr-only" role="status">
        Recording
      </span>
      <div className="levelbar-track" aria-hidden="true">
        <div
          className={reduceMotion ? 'levelbar-fill still' : 'levelbar-fill'}
          style={{ width: `${pct}%` }}
        />
      </div>
      {reduceMotion && (
        <span className="levelbar-num" aria-hidden="true">
          Mic level {pct}%
        </span>
      )}
    </div>
  );
}
