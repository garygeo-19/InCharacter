import { useState } from 'react';
import { LevelBar } from './levelbar';
import { checkMic } from './voice';
import type { Settings } from './history';

// Mode choice with the §4.4 mic check: permission prompt, then a 2-second
// level meter. Denial falls back to Type and says so. Shared by the
// classroom briefing and the session briefing (§16.3).
export function ModePicker(props: {
  settings: Settings;
  updateSettings: (s: Settings) => void;
}) {
  const [mic, setMic] = useState<'idle' | 'checking' | 'denied'>('idle');
  const [level, setLevel] = useState(0);

  const chooseVoice = () => {
    setMic('checking');
    setLevel(0);
    checkMic(setLevel)
      .then(() => {
        setMic('idle');
        props.updateSettings({ ...props.settings, mode: 'voice' });
      })
      .catch(() => setMic('denied'));
  };

  return (
    <section aria-label="Mode">
      <h2>Mode</h2>
      <div className="row" role="radiogroup" aria-label="Mode">
        <button
          type="button" aria-pressed={props.settings.mode === 'typed'}
          className="secondary"
          onClick={() => props.updateSettings({ ...props.settings, mode: 'typed' })}
        >
          Type (mic off){props.settings.mode === 'typed' ? ' ✓' : ''}
        </button>
        <button
          type="button" aria-pressed={props.settings.mode === 'voice'}
          className="secondary" disabled={mic === 'checking'}
          onClick={chooseVoice}
        >
          Voice{props.settings.mode === 'voice' ? ' ✓' : ''}
        </button>
      </div>
      {mic === 'checking' && (
        <>
          <p className="fine" role="status">Listening — speak to test your mic…</p>
          <LevelBar level={level} />
        </>
      )}
      {mic === 'denied' && (
        <p className="error" role="status">Mic unavailable — using Type instead.</p>
      )}
    </section>
  );
}
