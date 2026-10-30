import { useEffect, useMemo, useRef, useState } from 'react';
import { splitTextToLines } from '../shared/lines';
import { buildNotes, buildOutline, PackSchema, stripPrefix, type Note } from '../shared/notes';
import { SCORING_CONFIG } from '../shared/scoring-config';
import { scoreSession } from '../shared/scoring';
import type { Line, Peek } from '../shared/types';
import { api, type BankDisplay, type LineIn } from './api';
import { Segments, Stars, VerdictChip, mmss } from './format';
import { captureToWav, startCapture, type VoiceCapture } from './voice';
import {
  excludeIds,
  recordAttempt,
  type AttemptRecord,
  type Settings,
} from './history';
import { OutlinePeek } from './peek';
import { CastRow, ClassroomFigure, PortraitImg, studentById } from './art';

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

function studentName(id: string): string {
  return studentById(id)?.name ?? id;
}

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

  const classSecs = props.fast ? 12 : SCORING_CONFIG.classSeconds[props.settings.mode];
  const answerSecs = props.fast ? 8 : SCORING_CONFIG.answerSeconds[props.settings.mode];
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
  if (!notes || !outline || !bank) {
    return (
      <>
        <p>Preparing your class…</p>
        <WaitingDots status="Preparing your class. Loading the notes and questions." />
      </>
    );
  }

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
          mode={props.settings.mode} packId={props.packId} partId={props.partId}
          outline={outline} noteText={(id) => notesById.get(id)?.text ?? ''}
          peekStyle={props.settings.peekStyle} onPeek={recordPeek}
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
          mode={props.settings.mode} packId={props.packId} partId={props.partId}
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

// Timers are announced at 30 s and 10 s (§11.3): the visual timer stays
// quiet for screen readers, and this live region speaks only at crossings.
function useTimerAnnouncement(left: number): string {
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (left === 30) setMsg('30 seconds left.');
    else if (left === 10) setMsg('10 seconds left.');
  }, [left]);
  return msg;
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

// One multi-line box for teaching and answers. The learner writes freely
// (phone dictation lands here as one block); the sticky action submits, and
// code splits the text into numbered lines for the evidence rules. The split
// is never shown.
function LongBox(props: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <textarea
      className="teach-box"
      aria-label={props.label}
      placeholder={props.placeholder}
      rows={6}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

// Motion feedback for model waits: three bouncing dots plus an accessible
// status message. Under prefers-reduced-motion the dots sit still.
function WaitingDots({ status }: { status: string }) {
  return (
    <p className="waiting" role="status">
      <span className="sr-only">{status}</span>
      <span className="dots" aria-hidden="true">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </span>
    </p>
  );
}

// Voice turn: records while `active`, transcribes once it flips false.
// Each returned turn becomes a transcript line (§9.6). The WAV is kept
// until the POST succeeds, so "Try again" re-sends the same audio; "Type
// instead" hands back to the typed box (§10.1, §11.7).
function VoiceLineTaker(props: {
  packId: string;
  partId: string;
  active: boolean;
  cue: string;
  onDone: (lines: Line[]) => void;
  onTypeInstead: () => void;
}) {
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState<'recording' | 'transcribing' | 'error'>('recording');
  const [error, setError] = useState('');
  const captureRef = useRef<VoiceCapture | null>(null);
  const wavRef = useRef<Uint8Array | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let live = true;
    startCapture((peak) => {
      if (live) setLevel(peak);
    })
      .then((capture) => {
        if (live) captureRef.current = capture;
        else capture.stop();
      })
      .catch(() => {
        if (!live) return;
        setError('The mic is unavailable.');
        setStatus('error');
      });
    return () => {
      live = false;
      captureRef.current?.stop();
      captureRef.current = null;
    };
  }, []);

  const post = (wav: Uint8Array) => {
    setStatus('transcribing');
    api.transcribe(wav, { packId: props.packId, partId: props.partId })
      .then((d) => {
        if (doneRef.current) return;
        doneRef.current = true;
        props.onDone(d.lines);
      })
      .catch((e: Error) => {
        setError(e.message);
        setStatus('error');
      });
  };

  useEffect(() => {
    if (!props.active && status === 'recording' && !doneRef.current) {
      const capture = captureRef.current;
      captureRef.current = null;
      const wav = captureToWav(capture ? capture.stop() : new Int16Array(0));
      wavRef.current = wav;
      post(wav);
    }
  }, [props.active, status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'transcribing') return <p role="status">Transcribing…</p>;
  if (status === 'error') {
    return (
      <>
        <p className="error">{error}</p>
        <div className="row">
          <button
            type="button" className="primary"
            disabled={!wavRef.current}
            onClick={() => wavRef.current && post(wavRef.current)}
          >
            Try again
          </button>
          <button type="button" className="secondary" onClick={props.onTypeInstead}>
            Type instead
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <p className="rec" role="status">
        <span className="rec-dot" aria-hidden>●</span> Recording
      </p>
      <div className="meter" aria-hidden>
        <div className="meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
      </div>
      <p className="lede">{props.cue}</p>
    </>
  );
}

function ClassScreen(props: {
  totalSecs: number;
  endAfterSecs: number;
  mode: Settings['mode'];
  packId: string;
  partId: string;
  outline: ReturnType<typeof buildOutline>;
  noteText: (id: string) => string;
  peekStyle: Settings['peekStyle'];
  onPeek: (peek: Peek) => void;
  onEnd: (lines: Line[]) => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const left = props.totalSecs - elapsed;
  const announcement = useTimerAnnouncement(left);
  const voice = props.mode === 'voice';
  const [typedFallback, setTypedFallback] = useState(false);
  const [voiceActive, setVoiceActive] = useState(true);
  const endedRef = useRef(false);
  const endVoice = () => {
    if (endedRef.current) return;
    endedRef.current = true;
    setVoiceActive(false);
  };
  const useVoice = voice && !typedFallback;

  useEffect(() => {
    if (left <= 0) {
      if (useVoice) endVoice();
      else props.onEnd(splitTextToLines(draftRef.current));
      return;
    }
    const t = setTimeout(() => setElapsed((e) => e + 1), 1000);
    return () => clearTimeout(t);
  }, [left, useVoice]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="timer" role="timer" aria-live="off">
        {mmss(left)}
      </div>
      <span className="sr-only" aria-live="polite">{announcement}</span>
      <ClassroomFigure small alt="Your class listening" label="Students listening" />
      <OutlinePeek
        outline={props.outline} noteText={props.noteText} phase="class"
        peekStyle={props.peekStyle} onPeek={props.onPeek}
      />
      {useVoice ? (
        <VoiceLineTaker
          packId={props.packId} partId={props.partId}
          active={voiceActive} cue="Teach your class — speak now."
          onDone={(lines) => props.onEnd(lines)}
          onTypeInstead={() => setTypedFallback(true)}
        />
      ) : (
        <LongBox
          label="Teach your class"
          placeholder="Teach your class — write as much as you like"
          value={draft} onChange={setDraft}
        />
      )}
      <div className="sticky-action">
        <button
          type="button" className="primary"
          disabled={elapsed < props.endAfterSecs || (useVoice && !voiceActive)}
          onClick={() => {
            if (useVoice) endVoice();
            else props.onEnd(splitTextToLines(draftRef.current));
          }}
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
      <WaitingDots status="Choosing questions and grading your class. This can take a few seconds." />
    </>
  );
}

function QuestionScreen(props: {
  index: number;
  asking: boolean;
  picks: { questionId: string }[];
  bankById: Map<string, BankDisplay>;
  mode: Settings['mode'];
  packId: string;
  partId: string;
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
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const left = props.totalSecs - elapsed;
  const announcement = useTimerAnnouncement(left);
  const useVoice = props.mode === 'voice';
  const [typedFallback, setTypedFallback] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(true);
  const answeredRef = useRef(false);
  const closeVoice = () => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    setAnswerOpen(false);
  };
  const answeringVoice = useVoice && !typedFallback;

  useEffect(() => {
    setElapsed(0);
    setDraft('');
    setTypedFallback(false);
    setAnswerOpen(true);
    answeredRef.current = false;
  }, [props.index]);

  useEffect(() => {
    if (!props.asking) {
      if (left <= 0) {
        if (answeringVoice) closeVoice();
        else props.onAnswered(splitTextToLines(draftRef.current));
        return;
      }
      const t = setTimeout(() => setElapsed((e) => e + 1), 1000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [left, props.asking, answeringVoice]); // eslint-disable-line react-hooks/exhaustive-deps

  // No recorded student audio yet (M3 cut line): the caption is the
  // question in both modes, and voice recording starts 2 s after it
  // appears, with a "Your turn" cue (§4.6).
  useEffect(() => {
    if (props.asking) {
      const t = setTimeout(props.onAsked, 2500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [props.asking, props.index]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!q) return <p>Loading question…</p>;
  const student = studentName(q.studentId);

  return (
    <>
      <h2 className="q-count">Question {props.index + 1} of 3.</h2>
      <ClassroomFigure
        small
        highlightId={q.studentId}
        label={`${student} is asking`}
        alt={`${student} is asking a question. The class listens.`}
      />
      <div className="question">
        <PortraitImg id={q.studentId} />
        <div className="bubble">
          <p className="asker">{student}</p>
          <p>{q.text}</p>
          <p className="fine">Student voices are being recorded — caption for now.</p>
        </div>
      </div>
      {!props.asking && (
        <>
          <div className="timer" role="timer" aria-live="off">
            {mmss(left)}
          </div>
          <span className="sr-only" aria-live="polite">{announcement}</span>
          <details className="drawer">
            <summary>Outline (peek)</summary>
            <OutlinePeek
              outline={props.outline} noteText={props.noteText} phase="questions"
              peekStyle={props.peekStyle} onPeek={props.onPeek}
            />
          </details>
          {answeringVoice ? (
            <>
              <p className="lede">Your turn — speak now.</p>
              <VoiceLineTaker
                packId={props.packId} partId={props.partId}
                active={answerOpen} cue="Answer the question — speak now."
                onDone={(voiceLines) => props.onAnswered(voiceLines)}
                onTypeInstead={() => setTypedFallback(true)}
              />
              <div className="sticky-action">
                <button type="button" className="primary" disabled={!answerOpen} onClick={closeVoice}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <LongBox
                label="Type your answer"
                placeholder="Type your answer — write as much as you like"
                value={draft} onChange={setDraft}
              />
              <div className="sticky-action">
                <button type="button" className="primary" onClick={() => props.onAnswered(splitTextToLines(draftRef.current))}>
                  Done
                </button>
              </div>
            </>
          )}
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
      <p className="lede">Checking every quote against your own words.</p>
      <WaitingDots status="Grading your class. This can take a few seconds." />
      <CastRow />
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
      <p className="chat-line">{props.classLines.map((l) => l.text).join(' ')}</p>
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
              <p><strong>{studentName(q?.studentId ?? '')}:</strong> {q?.text}</p>
              {lines.length === 0 ? (
                <p className="chat-line empty-answer">(no answer — scored 0)</p>
              ) : (
                <p className="chat-line">{lines.map((l) => l.text).join(' ')}</p>
              )}
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
