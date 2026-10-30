import { useEffect, useMemo, useRef, useState } from 'react';
import cast from '../../content/cast.json';
import { buildNotes, buildOutline, PackSchema, stripPrefix, type Note } from '../shared/notes';
import { SCORING_CONFIG } from '../shared/scoring-config';
import { scoreSession } from '../shared/scoring';
import type { Line, Peek } from '../shared/types';
import { api, type BankDisplay, type LineIn } from './api';
import { Segments, Stars, VerdictChip, mmss } from './format';
import {
  excludeIds,
  recordAttempt,
  type AttemptRecord,
  type Settings,
} from './history';
import { OutlinePeek } from './peek';

type Phase =
  | { name: 'countdown'; count: number }
  | { name: 'class' }
  | { name: 'empty' }
  | { name: 'choosing' }
  | { name: 'questions'; index: number; asking: boolean }
  | { name: 'grading' }
  | { name: 'debrief' }
  | { name: 'failed'; error: string };

type ClassGrade = {
  notes: { noteId: string; verdict: 'covered' | 'partial' | 'missed' | 'wrong'; quote: string | null; why: string }[];
  moves: { move: string; quote: string }[];
  dropped: number;
};

type AnswersGrade = {
  answers: {
    questionId: string;
    points: { index: number; result: 'hit' | 'partial' | 'none'; quote: string | null }[];
    contradictions: { quote: string; noteId: string; why: string }[];
    empty: boolean;
  }[];
  dropped: number;
};

const studentsById = new Map(
  (cast.students as { id: string; name: string }[]).map((s) => [s.id, s.name]),
);

export function Teach(props: {
  packId: string;
  partId: string;
  catalog: { id: string; name: string; icon?: string }[] | null;
  settings: Settings;
  history: AttemptRecord[];
  setHistory: (h: AttemptRecord[]) => void;
  fast: boolean;
  onExit: () => void;
  onNextClass: () => void;
  onTeachAgain: () => void;
}) {
  const pack = (props.catalog ?? []).find((p) => p.id === props.packId) ?? null;
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [partTitle, setPartTitle] = useState(props.partId);
  const [bank, setBank] = useState<BankDisplay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'countdown', count: 3 });
  const [classLines, setClassLines] = useState<Line[]>([]);
  const [peeks, setPeeks] = useState<Peek[]>([]);
  const [picks, setPicks] = useState<{ questionId: string }[]>([]);
  const [answers, setAnswers] = useState<{ questionId: string; lines: Line[] }[]>([]);
  const [classGrade, setClassGrade] = useState<ClassGrade | null>(null);
  const [answersGrade, setAnswersGrade] = useState<AnswersGrade | null>(null);
  const [gradeAttempts, setGradeAttempts] = useState(0);

  const classSecs = props.fast ? 12 : SCORING_CONFIG.classSeconds.typed;
  const answerSecs = props.fast ? 8 : SCORING_CONFIG.answerSeconds.typed;
  const endAfterSecs = props.fast ? 2 : 30;

  useEffect(() => {
    let live = true;
    api.pack(props.packId)
      .then((raw) => {
        if (!live) return;
        const parsed = PackSchema.parse(raw);
        setNotes(buildNotes(parsed, props.partId));
      })
      .catch((e: Error) => live && setError(e.message));
    api.bank(props.packId, props.partId)
      .then((d) => live && setBank(d.questions))
      .catch((e: Error) => live && setError(e.message));
    api.parts(props.packId)
      .then((d) => {
        if (!live) return;
        const found = d.lessons.flatMap((l) => l.parts).find((p) => p.id === props.partId);
        if (found) setPartTitle(stripPrefix(found.title));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [props.packId, props.partId]);

  const outline = useMemo(() => (notes ? buildOutline(notes) : null), [notes]);
  const notesById = useMemo(() => new Map((notes ?? []).map((n) => [n.id, n])), [notes]);
  const bankById = useMemo(() => new Map((bank ?? []).map((q) => [q.id, q])), [bank]);

  const recordPeek = (peek: Peek) => setPeeks((p) => [...p, peek]);

  if (error) {
    return (
      <>
        <p className="error">{error}</p>
        <button type="button" className="primary" onClick={props.onExit}>Home</button>
      </>
    );
  }
  if (!notes || !outline || !bank) return <p>Preparing your class…</p>;

  return (
    <>
      {phase.name === 'countdown' && (
        <Countdown
          fast={props.fast}
          onDone={() => setPhase({ name: 'class' })}
        />
      )}
      {phase.name === 'class' && (
        <ClassScreen
          totalSecs={classSecs} endAfterSecs={endAfterSecs}
          outline={outline} noteText={(id) => notesById.get(id)?.text ?? ''}
          peekStyle={props.settings.peekStyle} onPeek={recordPeek}
          lines={classLines} setLines={setClassLines}
          onEnd={(lines) => {
            if (lines.length === 0) setPhase({ name: 'empty' });
            else {
              setClassLines(lines);
              setPhase({ name: 'choosing' });
            }
          }}
        />
      )}
      {phase.name === 'empty' && (
        <>
          <h1>We didn&apos;t catch anything</h1>
          <p className="lede">Your class had no lines. Try again, or head home.</p>
          <div className="sticky-action">
            <button type="button" className="primary" onClick={() => {
              setClassLines([]);
              setPhase({ name: 'countdown', count: 3 });
            }}>
              Try again
            </button>
            <button type="button" className="secondary" onClick={props.onExit}>Home</button>
          </div>
        </>
      )}
      {phase.name === 'choosing' && (
        <Choosing
          packId={props.packId} partId={props.partId}
          classLines={classLines} history={props.history}
          onDone={(picked, grade) => {
            setPicks(picked);
            setClassGrade(grade);
            setAnswers(picked.map((p) => ({ questionId: p.questionId, lines: [] })));
            setPhase({ name: 'questions', index: 0, asking: true });
          }}
          onError={(message) => setPhase({ name: 'failed', error: message })}
        />
      )}
      {phase.name === 'questions' && (
        <QuestionScreen
          index={phase.index} asking={phase.asking}
          picks={picks} bankById={bankById}
          totalSecs={answerSecs}
          outline={outline} noteText={(id) => notesById.get(id)?.text ?? ''}
          peekStyle={props.settings.peekStyle} onPeek={recordPeek}
          onAsked={() => setPhase({ name: 'questions', index: phase.index, asking: false })}
          onAnswered={(lines) => {
            const next = answers.map((a, i) =>
              i === phase.index ? { ...a, lines } : a,
            );
            setAnswers(next);
            if (phase.index + 1 < picks.length) {
              setPhase({ name: 'questions', index: phase.index + 1, asking: true });
            } else {
              setPhase({ name: 'grading' });
            }
          }}
        />
      )}
      {phase.name === 'grading' && (
        <Grading
          packId={props.packId} partId={props.partId} answers={answers}
          attempts={gradeAttempts}
          onDone={(grade) => {
            setAnswersGrade(grade);
            setPhase({ name: 'debrief' });
          }}
          onError={(message) => setPhase({ name: 'failed', error: message })}
        />
      )}
      {phase.name === 'failed' && (
        <>
          <h1>Grading hit a snag</h1>
          <p className="lede">{phase.error}</p>
          {classGrade ? (
            <NoScoreDebrief
              classLines={classLines} peeks={peeks}
              onRetry={() => {
                setGradeAttempts((a) => a + 1);
                setPhase({ name: 'grading' });
              }}
              onExit={props.onExit}
            />
          ) : (
            <div className="sticky-action">
              <button type="button" className="primary" onClick={props.onNextClass}>Back to classes</button>
            </div>
          )}
        </>
      )}
      {phase.name === 'debrief' && classGrade && answersGrade && (
        <Debrief
          notes={notes} bankById={bankById}
          classGrade={classGrade} answersGrade={answersGrade}
          classLines={classLines} answers={answers} peeks={peeks}
          packName={pack?.name ?? props.packId} icon={pack?.icon}
          onRecord={(total, stars) => {
            props.setHistory(recordAttempt({
              packId: props.packId, packName: pack?.name ?? props.packId,
              partId: props.partId, partTitle: partTitle || props.partId,
              icon: pack?.icon, total, stars,
              askedIds: picks.map((p) => p.questionId),
            }));
          }}
          onTeachAgain={props.onTeachAgain}
          onNextClass={props.onNextClass}
          onExit={props.onExit}
        />
      )}
    </>
  );
}

function Countdown({ fast, onDone }: { fast: boolean; onDone: () => void }) {
  const [count, setCount] = useState(3);
  useEffect(() => {
    if (count <= 0) {
      onDone();
      return;
    }
    const t = setTimeout(() => setCount((c) => c - 1), fast ? 300 : 1000);
    return () => clearTimeout(t);
  }, [count]); // eslint-disable-line react-hooks/exhaustive-deps
  return <h1 className="countdown" aria-live="assertive">{count > 0 ? count : 'Teach!'}</h1>;
}

function ChatBox(props: {
  lines: Line[];
  onSend: (text: string) => void;
  placeholder: string;
  sendLabel?: string;
}) {
  const [draft, setDraft] = useState('');
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    props.onSend(text);
    setDraft('');
  };
  return (
    <div className="chat">
      <ul className="chat-lines" aria-live="polite">
        {props.lines.map((l) => (
          <li key={l.n} className="chat-line">{l.text}</li>
        ))}
      </ul>
      <div className="chat-input">
        <input
          type="text" aria-label={props.placeholder} placeholder={props.placeholder}
          value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <button type="button" className="primary" onClick={send}>{props.sendLabel ?? 'Send'}</button>
      </div>
    </div>
  );
}

function ClassScreen(props: {
  totalSecs: number;
  endAfterSecs: number;
  outline: ReturnType<typeof buildOutline>;
  noteText: (id: string) => string;
  peekStyle: Settings['peekStyle'];
  onPeek: (peek: Peek) => void;
  lines: Line[];
  setLines: (lines: Line[]) => void;
  onEnd: (lines: Line[]) => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const linesRef = useRef(props.lines);
  linesRef.current = props.lines;
  const left = props.totalSecs - elapsed;
  const warned = left <= 30;

  useEffect(() => {
    if (left <= 0) {
      props.onEnd(linesRef.current);
      return;
    }
    const t = setTimeout(() => setElapsed((e) => e + 1), 1000);
    return () => clearTimeout(t);
  }, [left]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="timer" role="timer" aria-live={warned ? 'polite' : 'off'}>
        {mmss(left)}
      </div>
      <div className="classroom small" aria-label="Students listening">
        {(cast.students as { id: string; name: string }[]).map((s) => (
          <span className="student-dot" key={s.id}>{s.name[0]}</span>
        ))}
      </div>
      <OutlinePeek
        outline={props.outline} noteText={props.noteText} phase="class"
        peekStyle={props.peekStyle} onPeek={props.onPeek}
      />
      <ChatBox
        lines={props.lines}
        placeholder="Teach your class, one message per line"
        onSend={(text) => props.setLines([...linesRef.current, { n: linesRef.current.length + 1, text, source: 'typed' }])}
      />
      <div className="sticky-action">
        <button
          type="button" className="primary"
          disabled={elapsed < props.endAfterSecs}
          onClick={() => props.onEnd(linesRef.current)}
        >
          End class
        </button>
      </div>
    </>
  );
}

function Choosing(props: {
  packId: string;
  partId: string;
  classLines: Line[];
  history: AttemptRecord[];
  onDone: (picks: { questionId: string }[], grade: ClassGrade) => void;
  onError: (message: string) => void;
}) {
  // Fire once even under StrictMode's dev double-mount: each fire is a model call.
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    const lines: LineIn[] = props.classLines.map((l) => ({ n: l.n, text: l.text }));
    void Promise.all([
      api.pick({
        packId: props.packId, partId: props.partId, classLines: lines,
        excludeIds: excludeIds(props.history, props.packId, props.partId),
      }),
      api.gradeClass({ packId: props.packId, partId: props.partId, classLines: lines }),
    ])
      .then(([pick, grade]) => props.onDone(pick.picks, grade))
      .catch((e: Error) => props.onError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <h1>Hands are going up…</h1>
      <p className="lede">Picking three questions and grading your class.</p>
    </>
  );
}

function QuestionScreen(props: {
  index: number;
  asking: boolean;
  picks: { questionId: string }[];
  bankById: Map<string, BankDisplay>;
  totalSecs: number;
  outline: ReturnType<typeof buildOutline>;
  noteText: (id: string) => string;
  peekStyle: Settings['peekStyle'];
  onPeek: (peek: Peek) => void;
  onAsked: () => void;
  onAnswered: (lines: Line[]) => void;
}) {
  const q = props.bankById.get(props.picks[props.index].questionId);
  const [elapsed, setElapsed] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const left = props.totalSecs - elapsed;

  useEffect(() => {
    setElapsed(0);
    setLines([]);
  }, [props.index]);

  useEffect(() => {
    if (!props.asking) {
      if (left <= 0) {
        props.onAnswered(linesRef.current);
        return;
      }
      const t = setTimeout(() => setElapsed((e) => e + 1), 1000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [left, props.asking]); // eslint-disable-line react-hooks/exhaustive-deps

  // In Type mode with no recorded audio yet (M3), the caption is the question.
  useEffect(() => {
    if (props.asking) {
      const t = setTimeout(props.onAsked, 2500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [props.asking, props.index]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!q) return <p>Loading question…</p>;
  const student = studentsById.get(q.studentId) ?? q.studentId;

  return (
    <>
      <p className="fine">Question {props.index + 1} of 3.</p>
      <div className="question">
        <span className="portrait" aria-hidden>{student[0]}</span>
        <div className="bubble">
          <p className="asker">{student}</p>
          <p>{q.text}</p>
          <p className="fine">Student voices arrive in M3 — caption only for now.</p>
        </div>
      </div>
      {!props.asking && (
        <>
          <div className="timer" role="timer" aria-live={left <= 30 ? 'polite' : 'off'}>
            {mmss(left)}
          </div>
          <details className="drawer">
            <summary>Outline (peek)</summary>
            <OutlinePeek
              outline={props.outline} noteText={props.noteText} phase="questions"
              peekStyle={props.peekStyle} onPeek={props.onPeek}
            />
          </details>
          <ChatBox
            lines={lines} placeholder="Type your answer" sendLabel="Send"
            onSend={(text) => setLines((l) => [...l, { n: l.length + 1, text, source: 'typed' }])}
          />
          <div className="sticky-action">
            <button type="button" className="primary" onClick={() => props.onAnswered(linesRef.current)}>
              Done
            </button>
          </div>
        </>
      )}
    </>
  );
}

function Grading(props: {
  packId: string;
  partId: string;
  answers: { questionId: string; lines: Line[] }[];
  attempts: number;
  onDone: (grade: AnswersGrade) => void;
  onError: (message: string) => void;
}) {
  const fired = useRef(0);
  useEffect(() => {
    if (fired.current === props.attempts + 1) return;
    fired.current = props.attempts + 1;
    void api.gradeAnswers({
      packId: props.packId,
      partId: props.partId,
      answers: props.answers.map((a) => ({
        questionId: a.questionId,
        lines: a.lines.map((l) => ({ n: l.n, text: l.text })),
      })),
    })
      .then((g) => props.onDone(g))
      .catch((e: Error) => props.onError(e.message));
  }, [props.attempts]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <h1>Grading your class…</h1>
      <div className="classroom small" aria-label="Students">
        {(cast.students as { id: string; name: string }[]).map((s) => (
          <span className="student-dot" key={s.id}>{s.name[0]}</span>
        ))}
      </div>
    </>
  );
}

function NoScoreDebrief(props: {
  classLines: Line[];
  peeks: Peek[];
  onRetry: () => void;
  onExit: () => void;
}) {
  return (
    <>
      <h1>Your class</h1>
      <ul className="chat-lines">
        {props.classLines.map((l) => (
          <li key={l.n} className="chat-line">{l.text}</li>
        ))}
      </ul>
      <p className="lede">Grading didn&apos;t come back, so there&apos;s no score yet — your words and peeks are above.</p>
      <div className="sticky-action">
        <button type="button" className="primary" onClick={props.onRetry}>Grade again</button>
        <button type="button" className="secondary" onClick={props.onExit}>Home</button>
      </div>
    </>
  );
}

function Debrief(props: {
  notes: Note[];
  bankById: Map<string, BankDisplay>;
  classGrade: ClassGrade;
  answersGrade: AnswersGrade;
  classLines: Line[];
  answers: { questionId: string; lines: Line[] }[];
  peeks: Peek[];
  packName: string;
  icon?: string;
  onRecord: (total: number, stars: number) => void;
  onTeachAgain: () => void;
  onNextClass: () => void;
  onExit: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const notesById = useMemo(() => new Map(props.notes.map((n) => [n.id, n])), [props.notes]);

  const score = useMemo(() => {
    const weights = new Map(props.notes.map((n) => [n.id, n.weight]));
    return scoreSession({
      classGrades: props.classGrade.notes,
      notes: props.notes.map((n) => ({ id: n.id, weight: n.weight })),
      moves: props.classGrade.moves,
      answers: props.answersGrade.answers,
      peeks: props.peeks,
    });
  }, [props]);

  const recorded = useRef(false);
  useEffect(() => {
    if (!recorded.current) {
      recorded.current = true;
      props.onRecord(score.total, score.stars);
    }
  }, [score]); // eslint-disable-line react-hooks/exhaustive-deps

  const peekSecs = props.peeks.reduce((s, p) => s + p.ms, 0) / 1000;

  return (
    <>
      <h1>{score.total} / 100</h1>
      <Stars n={score.stars} />
      <section aria-label="Your class">
        <h2>Your class</h2>
        {props.classGrade.notes.map((g) => {
          const note = notesById.get(g.noteId);
          return (
            <div className="grade-row" key={g.noteId}>
              <p>
                <VerdictChip verdict={g.verdict} /> <strong>{note?.label}</strong>
              </p>
              {g.quote && <blockquote>“{g.quote}”</blockquote>}
              {note && (
                <button
                  type="button" className="secondary"
                  aria-expanded={expanded === g.noteId}
                  onClick={() => setExpanded(expanded === g.noteId ? null : g.noteId)}
                >
                  See note
                </button>
              )}
              {note && expanded === g.noteId && (
                <p className="fine"><Segments text={note.text} /></p>
              )}
            </div>
          );
        })}
        {props.classGrade.moves.length > 0 && (
          <>
            <h3>Teaching moves</h3>
            {props.classGrade.moves.map((m) => (
              <div className="grade-row" key={m.move}>
                <p><strong>{m.move}</strong></p>
                <blockquote>“{m.quote}”</blockquote>
              </div>
            ))}
          </>
        )}
      </section>

      <section aria-label="Your answers">
        <h2>Your answers</h2>
        {props.answersGrade.answers.map((a) => {
          const q = props.bankById.get(a.questionId);
          const lines = props.answers.find((x) => x.questionId === a.questionId)?.lines ?? [];
          return (
            <div className="grade-row" key={a.questionId}>
              <p><strong>{studentsById.get(q?.studentId ?? '') ?? ''}:</strong> {q?.text}</p>
              <ul className="chat-lines">
                {lines.length === 0 && <li className="chat-line empty-answer">(no answer — scored 0)</li>}
                {lines.map((l) => (
                  <li key={l.n} className="chat-line">{l.text}</li>
                ))}
              </ul>
              {a.points.map((p) => (
                <p key={p.index}>
                  <VerdictChip verdict={p.result === 'none' ? 'missed' : p.result === 'hit' ? 'hit' : 'partial-point'} />{' '}
                  {q?.expectedPoints[p.index]?.point ?? ''}
                  {p.quote && <blockquote>“{p.quote}”</blockquote>}
                </p>
              ))}
              {q && (
                <p className="fine">
                  A full answer covers: {q.expectedPoints.map((p) => p.point).join(' ')}
                </p>
              )}
            </div>
          );
        })}
      </section>

      <section aria-label="Peeks">
        <h2>Peeks</h2>
        <p>
          {props.peeks.length} peek{props.peeks.length === 1 ? '' : 's'}, {peekSecs.toFixed(1)}s
          {props.peeks.length > 0 && (
            <> on {[...new Set(props.peeks.map((p) => notesById.get(p.noteId)?.label ?? p.noteId))].join(', ')}</>
          )}
          . −{score.peekPenalty} points.
        </p>
      </section>

      <div className="sticky-action">
        <button type="button" className="primary" onClick={props.onTeachAgain}>Teach again</button>
        <div className="row">
          <button type="button" className="secondary" onClick={props.onNextClass}>Next class</button>
          <button type="button" className="secondary" onClick={props.onExit}>Home</button>
        </div>
      </div>
    </>
  );
}
