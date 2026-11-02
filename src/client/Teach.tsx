import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  countdownBudgetMs,
  countdownTickMs,
  startCountdown,
  tickCountdown,
  type CountdownState,
} from '../shared/countdown';
import { friendlyErrorMessage } from '../shared/errors';
import { joinChunkLines, visibleChunkPrefix } from '../shared/chunks';
import { splitTextToLines } from '../shared/lines';
import {
  QUESTION_CAPTION_FALLBACK_MS,
  questionAudioAfter,
  questionAudioMode,
} from '../shared/question-audio';
import { TimedTurn } from '../shared/timed-turn';
import { VOICE_START_TIMEOUT_MS } from '../shared/voice';
import { buildNotes, buildOutline, PackSchema, stripPrefix, type Note } from '../shared/notes';
import { SCORING_CONFIG } from '../shared/scoring-config';
import { formatPoints, headlineFor, scoreSession } from '../shared/scoring';
import type { Line, Peek } from '../shared/types';
import { api, type BankDisplay, type LineIn, type TranscribedLine } from './api';
import { Segments, VerdictChip, mmss } from './format';
import { LevelBar, useReducedMotion } from './levelbar';
import {
  captureToWav,
  playSharedQuestion,
  replaySharedQuestion,
  sharedQuestionAudio,
  startChunkedCapture,
} from './voice';
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
  const [loadSeq, setLoadSeq] = useState(0);
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
  }, [props.packId, props.partId, loadSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  const outline = useMemo(() => (notes ? buildOutline(notes) : null), [notes]);
  const notesById = useMemo(() => new Map((notes ?? []).map((n) => [n.id, n])), [notes]);
  const bankById = useMemo(() => new Map((bank ?? []).map((q) => [q.id, q])), [bank]);

  const recordPeek = (peek: Peek) => setPeeks((p) => [...p, peek]);

  if (error) {
    return (
      <>
        <p className="error">{friendlyErrorMessage(error)}</p>
        <div className="sticky-action">
          <button
            type="button" className="primary"
            onClick={() => {
              setError(null);
              setLoadSeq((s) => s + 1);
            }}
          >
            Try again
          </button>
          <button type="button" className="secondary" onClick={props.onExit}>Home</button>
        </div>
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
          peekStyle={props.settings.peekStyle} liveCaptions={props.settings.liveCaptions} onPeek={recordPeek}
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
          mode={props.settings.mode} soundOn={props.settings.sound}
          packId={props.packId} partId={props.partId}
          totalSecs={answerSecs}
          outline={outline} noteText={(id) => notesById.get(id)?.text ?? ''}
          peekStyle={props.settings.peekStyle} liveCaptions={props.settings.liveCaptions} onPeek={recordPeek}
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
          <p className="lede">{friendlyErrorMessage(phase.error)}</p>
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
              <button type="button" className="primary" onClick={() => setPhase({ name: 'choosing' })}>
                Try again
              </button>
              <button type="button" className="secondary" onClick={props.onNextClass}>Back to classes</button>
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
export function useTimerAnnouncement(left: number): string {
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (left === 30) setMsg('30 seconds left.');
    else if (left === 10) setMsg('10 seconds left.');
  }, [left]);
  return msg;
}

export function Countdown({ fast, onDone }: { fast: boolean; onDone: () => void }) {
  const [state, setState] = useState<CountdownState>(() => startCountdown());
  // The class starts exactly once: the last tick and the watchdog below
  // race, and StrictMode's dev double-effect re-fires, so a ref guards it.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const doneRef = useRef(false);
  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDoneRef.current();
  }, []);

  const step = countdownTickMs(fast);
  useEffect(() => {
    if (state.done) {
      finish();
      return;
    }
    const t = setTimeout(() => setState((s) => tickCountdown(s)), step);
    return () => clearTimeout(t);
  }, [state, step, finish]);

  // Absolute backstop: even a dropped or long-delayed tick still starts the
  // class. Budgeted past the last tick, so this never fires on a healthy run.
  useEffect(() => {
    const w = setTimeout(finish, countdownBudgetMs(fast));
    return () => clearTimeout(w);
  }, [fast, finish]);

  return <h1 className="countdown" aria-live="assertive">{state.count > 0 ? state.count : 'Teach!'}</h1>;
}

// One multi-line box for teaching and answers. The learner writes freely
// (phone dictation lands here as one block); the sticky action submits, and
// code splits the text into numbered lines for the evidence rules. The split
// is never shown.
export function LongBox(props: {
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

// The learner's own words, kept on screen after Done: a "You" bubble under
// the character's line. While voice is still transcribing it shows
// "Transcribing…" instead of the text (owner fix, Nov 2026).
export function YouBubble({ lines, transcribing }: { lines: Line[] | null; transcribing?: boolean }) {
  const text = (lines ?? []).map((l) => l.text).join(' ').trim();
  return (
    <div className="answer">
      <div className="bubble you">
        <p className="asker">You</p>
        {transcribing || text === '' ? (
          transcribing ? (
            <p role="status">Transcribing…</p>
          ) : (
            <p className="fine">(no reply)</p>
          )
        ) : (
          <p>{text}</p>
        )}
      </div>
    </div>
  );
}

// Motion feedback for model waits: three bouncing dots plus an accessible
// status message. Under prefers-reduced-motion the dots sit still.
export function WaitingDots({ status }: { status: string }) {
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

// Voice turn: records from mount, transcribes once `active` flips false.
// While the learner talks, every ~20 s of PCM is cut (at the quietest
// 80 ms frame) into a chunk and POSTed to /api/transcribe in the
// background; when the turn ends the remainder is sent, and the chunk
// lines are joined in chunk order (owner fix 31 Oct 2026 — a 117 s
// recording transcribes in ~8 s instead of ~50 s). Chunk WAVs are kept
// until every chunk succeeds, a failed chunk is retried once, and "Try
// again" re-sends only the failed chunks without re-recording; "Type it
// instead" hands back to the typed box (§10.1, §11.7). A mic start that
// fails or hangs falls back to the typed box on its own
// (onMicUnavailable), so a bad mic never holds the turn on silence.
type ChunkEntry = {
  wav: Uint8Array;
  lines: TranscribedLine[] | null;
  promise: Promise<void> | null;
};

export function VoiceLineTaker(props: {
  packId: string;
  partId: string;
  active: boolean;
  cue: string;
  liveCaptions: boolean;
  onDone: (lines: Line[]) => void;
  onTypeInstead: () => void;
  onMicUnavailable: () => void;
  /** The caller shows its own "Transcribing…" bubble: keep the status
   *  for screen readers without a second visible line. */
  quietTranscribing?: boolean;
}) {
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState<'recording' | 'transcribing' | 'error'>('recording');
  const [error, setError] = useState('');
  // Live captions: the joined lines of the in-order revealed prefix, from
  // chunk results already fetched for the final transcript (no new calls).
  const [captionLines, setCaptionLines] = useState<Line[]>([]);
  const captureRef = useRef<{ stop: () => Int16Array | null } | null>(null);
  const entriesRef = useRef<ChunkEntry[]>([]);
  const doneRef = useRef(false);
  const unavailableRef = useRef(props.onMicUnavailable);
  unavailableRef.current = props.onMicUnavailable;
  const meta = useMemo(
    () => ({ packId: props.packId, partId: props.partId }),
    [props.packId, props.partId],
  );

  // One POST with a single retry; success stores the chunk's lines and
  // reveals the newly visible in-order prefix as live captions.
  const postEntry = (entry: ChunkEntry): Promise<void> => {
    const attempt = () =>
      api.transcribe(entry.wav, meta).then((d) => {
        entry.lines = d.lines;
        setCaptionLines(
          joinChunkLines(visibleChunkPrefix(entriesRef.current.map((e) => e.lines))),
        );
      });
    const promise = attempt().catch(() => attempt());
    entry.promise = promise.catch(() => {
      // Failure surfaces as lines === null at join time; the chunk WAV is
      // kept so "Try again" can re-send it.
    });
    return entry.promise;
  };

  // Join finished chunks in order; failures (null lines) become the
  // current error handling (§11.7).
  const finishChunks = (): Promise<void> => {
    const entries = entriesRef.current;
    return Promise.all(entries.map((e) => e.promise ?? Promise.resolve()))
      .then(() => {
        if (doneRef.current) return;
        const failed = entries.some((e) => e.lines === null);
        if (failed) {
          throw new Error('Transcription failed.');
        }
        doneRef.current = true;
        props.onDone(joinChunkLines(entries.map((e) => e.lines ?? [])));
      })
      .catch((e: Error) => {
        if (doneRef.current) return;
        setError(e.message);
        setStatus('error');
      });
  };

  const stopAndSend = () => {
    const capture = captureRef.current;
    captureRef.current = null;
    const tail = capture ? capture.stop() : new Int16Array(0);
    if (tail && tail.length > 0) {
      const entry: ChunkEntry = { wav: captureToWav(tail), lines: null, promise: null };
      entriesRef.current.push(entry);
      postEntry(entry);
    } else if (entriesRef.current.length === 0) {
      // Nothing captured at all: send the empty WAV so the turn resolves
      // to no lines (the "We didn't catch anything" path), as before.
      const entry: ChunkEntry = { wav: captureToWav(new Int16Array(0)), lines: null, promise: null };
      entriesRef.current.push(entry);
      postEntry(entry);
    }
    setStatus('transcribing');
    void finishChunks();
  };

  useEffect(() => {
    let live = true;
    let settled = false;
    // A failed or hanging mic start falls back to Type at once (§4.4:
    // switch to Type and say so) instead of holding voice on silence.
    const failMic = () => {
      if (!live || settled) return;
      settled = true;
      unavailableRef.current();
    };
    const slow = setTimeout(failMic, VOICE_START_TIMEOUT_MS);
    startChunkedCapture(
      (peak) => {
        if (live) setLevel(peak);
      },
      (pcm) => {
        if (!live) return;
        const entry: ChunkEntry = { wav: captureToWav(pcm), lines: null, promise: null };
        entriesRef.current.push(entry);
        postEntry(entry);
      },
    )
      .then((capture) => {
        // A capture that opens after the fallback is stopped at once so the
        // mic is released.
        if (!live || settled) {
          capture.stop();
          return;
        }
        settled = true;
        clearTimeout(slow);
        captureRef.current = capture;
      })
      .catch(() => {
        if (!live || settled) return;
        clearTimeout(slow);
        failMic();
      });
    return () => {
      live = false;
      clearTimeout(slow);
      captureRef.current?.stop();
      captureRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const retryFailed = () => {
    setStatus('transcribing');
    for (const entry of entriesRef.current) {
      if (entry.lines === null) postEntry(entry);
    }
    void finishChunks();
  };

  useEffect(() => {
    if (!props.active && status === 'recording' && !doneRef.current) {
      stopAndSend();
    }
  }, [props.active, status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'transcribing') {
    return props.quietTranscribing
      ? <p role="status" className="sr-only">Transcribing…</p>
      : <p role="status">Transcribing…</p>;
  }
  if (status === 'error') {
    return (
      <>
        <p className="error">{friendlyErrorMessage(error)}</p>
        <div className="row">
          <button
            type="button" className="primary"
            onClick={retryFailed}
          >
            Try again
          </button>
          <button type="button" className="secondary" onClick={props.onTypeInstead}>
            Type it instead
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <LevelBar level={level} />
      {props.liveCaptions && <LiveCaptions lines={captionLines} />}
      <p className="rec" aria-hidden="true">
        <span className="rec-dot" aria-hidden>●</span> Recording
      </p>
      <p className="lede">{props.cue}</p>
    </>
  );
}

// Live captions (§4.5, §9.6 should): each chunk's lines appear as soon as
// that chunk's transcription returns, in chunk order (a later chunk waits
// for the earlier ones). The box scrolls itself with instant jumps — never
// smooth — so the newest line is visible without moving the page, and
// reduced motion needs no special case. Hidden by the "Live captions"
// setting; transcription and grading are unchanged.
export function LiveCaptions({ lines }: { lines: Line[] }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <section aria-label="Live captions">
      <div ref={boxRef} className="captions" aria-live="polite">
        {lines.length === 0 ? (
          <p className="captions-hint">Captions appear about every 20 seconds.</p>
        ) : (
          lines.map((l) => <p key={l.n}>{l.text}</p>)
        )}
      </div>
    </section>
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
  liveCaptions: boolean;
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
  const [micNotice, setMicNotice] = useState(false);
  const [voiceActive, setVoiceActive] = useState(true);
  // One class is submitted exactly once: Done/End stops the timer at once
  // and a timeout firing mid-transcription does nothing a second time.
  const turnRef = useRef<TimedTurn | null>(null);
  if (!turnRef.current) turnRef.current = new TimedTurn();
  const [stopped, setStopped] = useState(false);
  const useVoice = voice && !typedFallback;
  const useVoiceRef = useRef(useVoice);
  useVoiceRef.current = useVoice;

  const finishClass = (reason: 'done' | 'timeout'): boolean => {
    const turn = turnRef.current!;
    if (!turn.finish(reason)) return false;
    setStopped(true);
    if (useVoiceRef.current) {
      setVoiceActive(false);
    } else if (turn.deliver()) {
      props.onEnd(splitTextToLines(draftRef.current));
    }
    return true;
  };
  const deliverClassLines = (lines: Line[]) => {
    if (turnRef.current!.deliver()) props.onEnd(lines);
  };
  // A failed or hanging mic start falls back to typing with a fresh turn,
  // keeping the remaining time; the notice says so (§4.4).
  const fallBackToTyping = (notice: boolean) => {
    turnRef.current = new TimedTurn();
    setStopped(false);
    setTypedFallback(true);
    if (notice) setMicNotice(true);
  };

  useEffect(() => {
    if (!turnRef.current!.timerRunning) return;
    if (left <= 0) {
      finishClass('timeout');
      return;
    }
    const t = setTimeout(() => setElapsed((e) => e + 1), 1000);
    return () => clearTimeout(t);
  }, [left, useVoice, stopped]); // eslint-disable-line react-hooks/exhaustive-deps

  const sending = stopped && useVoice;

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
      {micNotice && (
        <p className="error" role="status">Mic unavailable — using Type instead.</p>
      )}
      {useVoice ? (
        <>
          <VoiceLineTaker
            packId={props.packId} partId={props.partId}
            active={voiceActive} cue="Teach your class — speak now."
            liveCaptions={props.liveCaptions}
            onDone={deliverClassLines}
            onTypeInstead={() => fallBackToTyping(false)}
            onMicUnavailable={() => fallBackToTyping(true)}
          />
          {sending && (
            <>
              <p role="status">Class sent…</p>
              <WaitingDots status="Class sent. Transcribing your class." />
            </>
          )}
        </>
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
          disabled={elapsed < props.endAfterSecs || stopped}
          onClick={() => {
            if (useVoice) finishClass('done');
            else {
              // Typed fallback after a transcription error delivers even
              // though the timer already stopped for the voice turn.
              const turn = turnRef.current!;
              if (turn.isStopped) deliverClassLines(splitTextToLines(draftRef.current));
              else finishClass('done');
            }
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

// The shared question audio element, mounted in the question view so the
// mp3 URL is in the DOM (and the iOS-unlocked element of voice.ts is the
// one that plays). Unmounting pauses it.
export function QuestionAudioSlot({ src }: { src: string }) {
  const slotRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = sharedQuestionAudio();
    el.setAttribute('src', src);
    slotRef.current?.appendChild(el);
    return () => {
      el.pause();
      el.remove();
    };
  }, [src]);
  return <span ref={slotRef} className="question-audio" />;
}

function QuestionScreen(props: {
  index: number;
  asking: boolean;
  picks: { questionId: string }[];
  bankById: Map<string, BankDisplay>;
  mode: Settings['mode'];
  soundOn: boolean;
  packId: string;
  partId: string;
  totalSecs: number;
  outline: ReturnType<typeof buildOutline>;
  noteText: (id: string) => string;
  peekStyle: Settings['peekStyle'];
  liveCaptions: boolean;
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
  const [micNotice, setMicNotice] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(true);
  // Voice answers auto-record: recording (and the timer) starts when the
  // question audio ends (§4.6), which flips asking to false and mounts the
  // VoiceLineTaker below. With no audio, a failed load, or a play()
  // rejection, the caption fallback starts 2 s after it appears.
  const [audioFailed, setAudioFailed] = useState(false);
  // One answer is submitted exactly once: Done stops the timer at once and
  // a timeout firing mid-transcription does nothing a second time.
  const turnRef = useRef<TimedTurn | null>(null);
  if (!turnRef.current) turnRef.current = new TimedTurn();
  const [submitted, setSubmitted] = useState(false);
  const answeringVoice = useVoice && !typedFallback;
  const answeringVoiceRef = useRef(answeringVoice);
  answeringVoiceRef.current = answeringVoice;

  const finishAnswer = (reason: 'done' | 'timeout'): boolean => {
    const turn = turnRef.current!;
    if (!turn.finish(reason)) return false;
    setSubmitted(true);
    if (answeringVoiceRef.current) {
      setAnswerOpen(false);
    } else if (turn.deliver()) {
      props.onAnswered(splitTextToLines(draftRef.current));
    }
    return true;
  };
  const deliverAnswerLines = (lines: Line[]) => {
    if (turnRef.current!.deliver()) props.onAnswered(lines);
  };
  // A failed or hanging mic start falls back to typing with a fresh turn,
  // keeping the remaining time; the notice says so (§4.4).
  const fallBackToTyping = (notice: boolean) => {
    turnRef.current = new TimedTurn();
    setSubmitted(false);
    setTypedFallback(true);
    if (notice) setMicNotice(true);
  };

  const audioUrl = q?.audioUrl ?? null;
  const audioWanted = questionAudioMode({ audioUrl, soundOn: props.soundOn });
  const audioMode = questionAudioAfter({
    mode: audioWanted,
    event: audioFailed ? 'error' : 'replayed',
  });

  useEffect(() => {
    setElapsed(0);
    setDraft('');
    setTypedFallback(false);
    setMicNotice(false);
    setAnswerOpen(true);
    setAudioFailed(false);
    turnRef.current = new TimedTurn();
    setSubmitted(false);
  }, [props.index]);

  // The answer timer runs once the answer has started (asking flipped):
  // voice recording starts then too, so the timer and the mic agree.
  useEffect(() => {
    if (props.asking) return undefined;
    if (!turnRef.current!.timerRunning) return undefined;
    if (left <= 0) {
      finishAnswer('timeout');
      return undefined;
    }
    const t = setTimeout(() => setElapsed((e) => e + 1), 1000);
    return () => clearTimeout(t);
  }, [left, props.asking, submitted]); // eslint-disable-line react-hooks/exhaustive-deps

  // Asking (§4.6): the question plays its audio with the caption shown.
  // Voice answers start when the audio ends, with a "Your turn" cue. With
  // no audio, a failed load, or a play() rejection, the caption fallback
  // starts 2 s after it appears. Type mode plays the audio too (see the
  // effect below), and the answer box is usable at once.
  useEffect(() => {
    if (!props.asking || !q) return undefined;
    if (!useVoice) {
      props.onAsked();
      return undefined;
    }
    if (audioMode === 'audio' && audioUrl) {
      return playSharedQuestion(audioUrl, {
        onEnded: () => props.onAsked(),
        onError: () => setAudioFailed(true),
      });
    }
    const t = setTimeout(props.onAsked, QUESTION_CAPTION_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [props.asking, props.index, useVoice, audioMode, audioUrl, q]); // eslint-disable-line react-hooks/exhaustive-deps

  // Type mode: the question audio plays alongside the already-usable
  // answer box. Replay restarts it; the answer timer is untouched.
  useEffect(() => {
    if (useVoice || audioMode !== 'audio' || !audioUrl) return undefined;
    return playSharedQuestion(audioUrl, {
      onEnded: () => {},
      onError: () => setAudioFailed(true),
    });
  }, [props.index, useVoice, audioMode, audioUrl]); // eslint-disable-line react-hooks/exhaustive-deps

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
          {audioWanted === 'audio' && audioUrl && (
            <>
              <QuestionAudioSlot src={audioUrl} />
              <button
                type="button" className="secondary"
                aria-label={`Replay ${student}'s question`}
                onClick={() => replaySharedQuestion(() => setAudioFailed(true))}
              >
                Replay
              </button>
            </>
          )}
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
              {micNotice && (
                <p className="error" role="status">Mic unavailable — using Type instead.</p>
              )}
              <VoiceLineTaker
                packId={props.packId} partId={props.partId}
                active={answerOpen} cue="Answer the question — speak now."
                liveCaptions={props.liveCaptions}
                onDone={deliverAnswerLines}
                onTypeInstead={() => fallBackToTyping(false)}
                onMicUnavailable={() => fallBackToTyping(true)}
                quietTranscribing
              />
              {submitted && <YouBubble lines={null} transcribing />}
              <div className="sticky-action">
                <button type="button" className="primary" disabled={!answerOpen || submitted} onClick={() => finishAnswer('done')}>
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
              {submitted && <YouBubble lines={splitTextToLines(draftRef.current)} />}
              <div className="sticky-action">
                <button
                  type="button" className="primary" disabled={submitted}
                  onClick={() => {
                    // Typed fallback after a transcription error delivers
                    // even though the timer already stopped for the voice turn.
                    const turn = turnRef.current!;
                    if (turn.isStopped) deliverAnswerLines(splitTextToLines(draftRef.current));
                    else finishAnswer('done');
                  }}
                >
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

// The celebration at the top of the debrief: the headline, the score
// counting up with the stars appearing, and a short sparkle burst for 2–3
// stars. Under prefers-reduced-motion the final state shows at once; a tap
// skips the animation. No sound. The visible score stays silent for screen
// readers while counting; one live region announces the final headline and
// score once.
export function Celebration({ headline, total, stars }: { headline: string; total: number; stars: number }) {
  const reduceMotion = useReducedMotion();
  const [shown, setShown] = useState(reduceMotion ? total : 0);
  const done = shown >= total;

  useEffect(() => {
    if (reduceMotion) {
      setShown(total);
      return;
    }
    setShown(0);
    let raf = 0;
    const start = performance.now();
    const DURATION_MS = 1400;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / DURATION_MS);
      setShown(Math.round((1 - Math.pow(1 - p, 3)) * total));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total, reduceMotion]);

  // Stars appear one by one as the count climbs.
  const revealed = done || total <= 0 ? stars : Math.min(stars, Math.floor((shown / total) * (stars + 1)));

  const pieces = useMemo(
    () =>
      Array.from({ length: 26 }, (_, i) => ({
        left: (i * 37.7) % 100,
        delay: ((i * 53) % 300) / 1000,
        size: 6 + ((i * 29) % 8),
        color: ['#9a3412', '#e0b84f', '#1b5e20', '#d98a85'][i % 4],
        drift: ((i * 41) % 120) - 60,
        spin: ((i * 67) % 360) - 180,
      })),
    [],
  );

  return (
    <>
      <section
        className="celebration"
        aria-label="Your score"
        onClick={() => setShown(total)}
      >
        {stars >= 2 && !reduceMotion && (
          <div className="burst" aria-hidden="true">
            {pieces.map((p, i) => (
              <span
                key={i}
                className="spark"
                style={
                  {
                    left: `${p.left}%`,
                    width: p.size,
                    height: p.size,
                    background: p.color,
                    animationDelay: `${p.delay}s`,
                    '--drift': `${p.drift}px`,
                    '--spin': `${p.spin}deg`,
                  } as CSSProperties
                }
              />
            ))}
          </div>
        )}
        <h1>{headline}</h1>
        <div className="score-number" aria-hidden="true">
          {shown} / 100
        </div>
        {stars <= 0 ? (
          <span className="stars">Keep practicing</span>
        ) : (
          <span className="stars" aria-hidden="true">
            {Array.from({ length: 3 }, (_, i) => (
              <span key={`${i}-${i < revealed ? 'on' : 'off'}`} className={i < revealed ? 'star-pop' : 'star-dim'}>
                {i < revealed ? '★' : '☆'}
              </span>
            ))}
          </span>
        )}
        {!done && <p className="fine">Tap to skip.</p>}
      </section>
      {done && (
        <p className="sr-only" role="status">
          {headline} Your score is {total} out of 100.
        </p>
      )}
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

  // The breakdown below reads every number from this score object, so it
  // always matches the total. Nothing here recomputes scoring math.
  const score = useMemo(() => {
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

  const b = score.breakdown;
  const headline = headlineFor(score.stars);

  return (
    <>
      <Celebration headline={headline} total={score.total} stars={score.stars} />
      <section aria-label="How your score was calculated">
        <h2>How your score was calculated</h2>
        <ul className="breakdown">
          <li>
            Notes: {b.covered} covered, {b.partial} partly, {b.missed} missed,{' '}
            {b.wrong} not quite right ({formatPoints(b.earnedWeight)} of {formatPoints(b.totalWeight)} weight →{' '}
            {formatPoints(b.coverage)} of 40)
          </li>
          <li>
            Teaching moves: {b.moves.length > 0 ? b.moves.join(', ') : 'none'} →{' '}
            {formatPoints(b.movesPoints)} of 10
          </li>
          {b.accuracyPenalty > 0 && (
            <li>Not quite right: −{formatPoints(b.accuracyPenalty)} (2 points per note)</li>
          )}
          <li>Lesson: {formatPoints(b.lesson)} of 50</li>
          {b.perQuestion.map((q, i) => (
            <li key={i}>
              Question {i + 1}: {formatPoints(q.score)} of {q.max}
            </li>
          ))}
          <li>Questions: {formatPoints(b.questions)} of 50</li>
          <li>
            Peeks: {b.peekCount} peek{b.peekCount === 1 ? '' : 's'}, {b.peekSeconds.toFixed(1)}s →{' '}
            {b.peekPenalty > 0 ? `−${formatPoints(b.peekPenalty)}` : 'no penalty'}
          </li>
          <li>
            <strong>
              Total: {formatPoints(b.lesson)} + {formatPoints(b.questions)} − {formatPoints(b.peekPenalty)} ={' '}
              {b.total}
            </strong>
          </li>
        </ul>
      </section>
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
          {b.peekCount} peek{b.peekCount === 1 ? '' : 's'}, {b.peekSeconds.toFixed(1)}s
          {props.peeks.length > 0 && (
            <> on {[...new Set(props.peeks.map((p) => notesById.get(p.noteId)?.label ?? p.noteId))].join(', ')}</>
          )}
          . {b.peekPenalty > 0 ? `−${formatPoints(b.peekPenalty)} points` : 'no penalty'}.
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
