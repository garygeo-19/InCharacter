// A timed turn (one class, or one answer) finishes by Done/End or by
// timeout — whichever comes first. The timer stops at once, and the lines
// are delivered exactly once, even when a timeout fires while a
// transcription is already in flight (§4.5, §4.6).
//
// Voice turns split finishing into two steps: finish() stops the timer and
// the recording, then deliver() hands the transcribed lines over once.
// Typed turns do both together. A voice turn that falls back to typing
// after a transcription error delivers via deliver() directly: the timer
// is already stopped, so there is nothing left to finish.

export type TurnFinishReason = 'done' | 'timeout';

export class TimedTurn {
  private stopped = false;
  private delivered = false;

  /** The timer ticks only while the turn is still open. */
  get timerRunning(): boolean {
    return !this.stopped;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get isDelivered(): boolean {
    return this.delivered;
  }

  /**
   * Stop the timer and the recording. Returns true for the first caller
   * only — a Done tap and a timeout racing each other submit once, and a
   * timeout firing during transcription does nothing.
   */
  finish(_reason: TurnFinishReason): boolean {
    if (this.stopped) return false;
    this.stopped = true;
    return true;
  }

  /**
   * Deliver the turn's lines. Returns true for the first caller only, so
   * one answer or class is submitted exactly once.
   */
  deliver(): boolean {
    if (this.delivered) return false;
    this.delivered = true;
    return true;
  }
}
