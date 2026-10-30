import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// M0 placeholder: proves the stack serves on laptop + phone.
// The M1 flow (catalog → briefing → class → questions → debrief) replaces this.
function App() {
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad status'))))
      .then((d: { ok?: boolean }) => setHealth(d.ok ? 'ok' : 'down'))
      .catch(() => setHealth('down'));
  }, []);

  return (
    <main className="page">
      <header className="masthead">
        <p className="brand">In Character</p>
        <h1>Teach it to learn it.</h1>
        <p className="lede">
          Study a lesson&apos;s notes, teach a 3-minute class to four students,
          answer their questions, and get a score backed by your own words.
        </p>
      </header>

      <section className="panel" aria-live="polite">
        <h2>Setup check</h2>
        <p>
          API: {health === 'checking' ? 'checking…' : health === 'ok' ? 'reachable' : 'not reachable'}
        </p>
        <p className="fine">What you say is sent to Meta&apos;s API to be transcribed and graded. In Character doesn&apos;t keep it. Your scores stay on this device.</p>
      </section>

      <footer className="footer">
        <p>Lessons from FlashFeed · Student voices are AI-generated.</p>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
