import type { NoteEvent } from "./types";
import type { AudioFrame } from "../audio/engine";

export interface FollowerConfig {
  /** Max distance from the target pitch, in cents, to count as correct. */
  centsTol: number;
  /** How long the correct pitch must be held before advancing. */
  holdMs: number;
  /** How long a stable wrong pitch must sound before it is reported. */
  wrongMs: number;
  /** Minimum detector clarity to trust a reading. */
  clarityMin: number;
  /** Minimum input level to treat the signal as playing. */
  rmsMin: number;
  /** A gap of at least this long re-arms matching for repeated notes. */
  rearmSilenceMs: number;
  /** RMS jump factor over the recent floor that counts as a new bow attack. */
  onsetRatio: number;
}

export interface FollowerCallbacks {
  onMatched(index: number, firstTry: boolean): void;
  onWrong(index: number, playedMidi: number): void;
  onSkipped(index: number): void;
  onFinished(): void;
}

/**
 * Wait-mode score follower: holds position until the expected note is played
 * in tune, then advances. Repeated notes require a re-articulation (a short
 * gap or a fresh bow attack) so a single sustained note cannot race through
 * "A A A A".
 */
export class Follower {
  cfg: FollowerConfig = {
    centsTol: 50,
    holdMs: 65,
    wrongMs: 180,
    clarityMin: 0.82,
    rmsMin: 0.0035,
    rearmSilenceMs: 45,
    onsetRatio: 2.5,
  };

  events: NoteEvent[] = [];
  index = 0;
  active = false;

  private hitStart = -1;
  private wrongStart = -1;
  private wrongMidi: number | null = null;
  private wrongReported = false;
  private hadWrong = false;
  private silenceStart = -1;
  private armed = true;
  private lastMatched: number[] = [];
  private rmsLog: Array<{ t: number; rms: number }> = [];

  constructor(private readonly cb: FollowerCallbacks) {}

  start(events: NoteEvent[], from = 0) {
    this.events = events;
    this.index = from;
    this.active = events.length > 0 && from < events.length;
    this.resetNoteState();
    this.armed = true;
    this.lastMatched = [];
    this.rmsLog = [];
  }

  private resetNoteState() {
    this.hitStart = -1;
    this.wrongStart = -1;
    this.wrongMidi = null;
    this.wrongReported = false;
    this.hadWrong = false;
    this.silenceStart = -1;
  }

  feed(frame: AudioFrame) {
    if (!this.active || this.index >= this.events.length) return;
    const cfg = this.cfg;

    this.rmsLog.push({ t: frame.time, rms: frame.rms });
    while (this.rmsLog.length > 0 && this.rmsLog[0].t < frame.time - 320) {
      this.rmsLog.shift();
    }

    const event = this.events[this.index];
    const r = frame.reading;
    const silent = !r || frame.rms < cfg.rmsMin || r.clarity < cfg.clarityMin;

    if (silent) {
      this.hitStart = -1;
      this.wrongStart = -1;
      this.wrongMidi = null;
      this.wrongReported = false;
      if (this.silenceStart < 0) this.silenceStart = frame.time;
      else if (frame.time - this.silenceStart >= cfg.rearmSilenceMs) {
        this.armed = true;
      }
      return;
    }
    this.silenceStart = -1;

    if (this.isOnset(frame)) this.armed = true;

    if (!this.armed) {
      const stillPrevious = this.lastMatched.some(
        (m) => Math.abs(r.midiFloat - m) < 0.5,
      );
      if (stillPrevious) {
        this.hitStart = -1;
        return;
      }
      this.armed = true;
    }

    const hit = event.midis.some(
      (m) => Math.abs(r.midiFloat - m) * 100 <= cfg.centsTol,
    );

    if (hit) {
      this.wrongStart = -1;
      this.wrongMidi = null;
      this.wrongReported = false;
      if (this.hitStart < 0) this.hitStart = frame.time;
      if (frame.time - this.hitStart >= cfg.holdMs) this.advance();
    } else {
      this.hitStart = -1;
      if (this.wrongMidi !== r.midi) {
        this.wrongMidi = r.midi;
        this.wrongStart = frame.time;
        this.wrongReported = false;
      } else if (
        !this.wrongReported &&
        frame.time - this.wrongStart >= cfg.wrongMs
      ) {
        this.wrongReported = true;
        this.hadWrong = true;
        this.cb.onWrong(this.index, r.midi);
      }
    }
  }

  private isOnset(frame: AudioFrame): boolean {
    const from = frame.time - 280;
    const to = frame.time - 70;
    let min = Infinity;
    for (const e of this.rmsLog) {
      if (e.t >= from && e.t <= to && e.rms < min) min = e.rms;
    }
    return (
      Number.isFinite(min) &&
      min > 0 &&
      frame.rms >= min * this.cfg.onsetRatio &&
      frame.rms > this.cfg.rmsMin * 2
    );
  }

  private advance() {
    const i = this.index;
    const event = this.events[i];
    const firstTry = !this.hadWrong;
    this.lastMatched = event.midis;
    this.resetNoteState();
    this.armed = false;
    this.index++;
    this.cb.onMatched(i, firstTry);
    if (this.index >= this.events.length) {
      this.active = false;
      this.cb.onFinished();
    }
  }

  skip() {
    if (!this.active || this.index >= this.events.length) return;
    const i = this.index;
    this.lastMatched = [];
    this.resetNoteState();
    this.armed = true;
    this.index++;
    this.cb.onSkipped(i);
    if (this.index >= this.events.length) {
      this.active = false;
      this.cb.onFinished();
    }
  }

  back(): number | null {
    if (this.index === 0) return null;
    this.index--;
    this.active = true;
    this.resetNoteState();
    this.armed = true;
    this.lastMatched = [];
    return this.index;
  }
}
