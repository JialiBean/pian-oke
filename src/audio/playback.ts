import { midiToFreq } from "./noteUtils";
import type { NoteEvent } from "../score/types";

export type InstrumentMode = "violin" | "piano";

export interface ScheduledNote {
  /** Seconds from playback start of the whole score. */
  time: number;
  /** Sounding duration in seconds. */
  dur: number;
  freqs: number[];
}

/**
 * Turn extracted note events into a wall-clock schedule.
 * `tempoFactor` scales speed (0.5 = half speed).
 */
export function buildSchedule(
  events: NoteEvent[],
  bpm: number,
  tempoFactor: number,
  a4 = 440,
): ScheduledNote[] {
  const beatsPerWhole = 4;
  const secondsPerWhole = ((60 / Math.max(20, bpm)) * beatsPerWhole) / Math.max(0.1, tempoFactor);
  const t0 = events[0]?.timestamp ?? 0;
  return events.map((event) => ({
    time: (event.timestamp - t0) * secondsPerWhole,
    dur: Math.max(0.08, event.duration * secondsPerWhole * 0.92),
    freqs: event.midis.map((m) => midiToFreq(m, a4)),
  }));
}

/**
 * Small Web Audio synth that plays a schedule with a ~1.5 s lookahead and
 * reports which event is currently sounding so the UI can move the cursor.
 * Two voices: a bowed "violin" (detuned saws, slow swell, delayed vibrato)
 * and a struck "piano" (inharmonic partials, hammer attack, natural ring).
 */
export class PlaybackEngine {
  playing = false;
  instrument: InstrumentMode = "violin";
  onTick?: (index: number) => void;
  onEnd?: () => void;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private schedule: ScheduledNote[] = [];
  private startAt = 0;
  private nextToSpawn = 0;
  private currentIndex = 0;
  private lastTicked = -1;
  private pumpTimer = 0;
  private tickTimer = 0;

  start(schedule: ScheduledNote[], fromIndex = 0) {
    this.stop();
    if (schedule.length === 0) return;
    const from = Math.min(Math.max(0, fromIndex), schedule.length - 1);
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.22;
    this.master.connect(this.ctx.destination);
    this.schedule = schedule;
    this.nextToSpawn = from;
    this.currentIndex = from;
    this.lastTicked = -1;
    this.startAt = this.ctx.currentTime + 0.15 - schedule[from].time;
    this.playing = true;

    const pump = () => {
      const ctx = this.ctx;
      if (!ctx) return;
      while (
        this.nextToSpawn < this.schedule.length &&
        this.schedule[this.nextToSpawn].time + this.startAt < ctx.currentTime + 1.5
      ) {
        this.spawn(this.schedule[this.nextToSpawn]);
        this.nextToSpawn++;
      }
    };
    pump();
    this.pumpTimer = window.setInterval(pump, 250);

    const tick = () => {
      const ctx = this.ctx;
      if (!ctx) return;
      const t = ctx.currentTime - this.startAt;
      while (
        this.currentIndex + 1 < this.schedule.length &&
        this.schedule[this.currentIndex + 1].time <= t
      ) {
        this.currentIndex++;
      }
      if (this.currentIndex !== this.lastTicked && this.schedule[this.currentIndex].time <= t) {
        this.lastTicked = this.currentIndex;
        this.onTick?.(this.currentIndex);
      }
      const last = this.schedule[this.schedule.length - 1];
      if (t > last.time + last.dur + 0.6) {
        const done = this.onEnd;
        this.stop();
        done?.();
        return;
      }
      this.tickTimer = window.setTimeout(tick, 60);
    };
    tick();
  }

  private spawn(item: ScheduledNote) {
    if (!this.ctx || !this.master) return;
    const t0 = this.startAt + item.time;
    for (const freq of item.freqs) {
      if (this.instrument === "piano") {
        this.spawnPiano(freq, t0, item.dur, item.freqs.length);
      } else {
        this.spawnViolin(freq, t0, item.dur, item.freqs.length);
      }
    }
  }

  private spawnViolin(freq: number, t0: number, dur: number, voices: number) {
    const ctx = this.ctx!;
    const t1 = t0 + dur;
    const level = 0.5 / Math.max(1, voices);

    const sawA = ctx.createOscillator();
    sawA.type = "sawtooth";
    sawA.frequency.value = freq;
    sawA.detune.value = -3;
    const sawB = ctx.createOscillator();
    sawB.type = "sawtooth";
    sawB.frequency.value = freq;
    sawB.detune.value = 3;

    // Delayed vibrato: none for the first ~quarter second, then ~5.5 Hz.
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 5.5;
    const vibrato = ctx.createGain();
    vibrato.gain.setValueAtTime(0, t0);
    vibrato.gain.setValueAtTime(0, t0 + 0.22);
    vibrato.gain.linearRampToValueAtTime(9, Math.min(t0 + 0.5, t1)); // cents
    lfo.connect(vibrato);
    vibrato.connect(sawA.detune);
    vibrato.connect(sawB.detune);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = Math.min(5000, freq * 5.5);
    filter.Q.value = 0.3;

    const gain = ctx.createGain();
    const attack = Math.min(0.09, dur * 0.35);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(level, t0 + attack);
    const releaseStart = Math.max(t0 + attack, t1 - 0.08);
    gain.gain.setValueAtTime(level, releaseStart);
    gain.gain.linearRampToValueAtTime(0.0001, t1);

    sawA.connect(filter);
    sawB.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);
    for (const node of [sawA, sawB, lfo]) {
      node.start(t0);
      node.stop(t1 + 0.05);
    }
  }

  private spawnPiano(freq: number, t0: number, dur: number, voices: number) {
    const ctx = this.ctx!;
    const level = 0.6 / Math.max(1, voices);
    // Lower notes ring longer; let them ring a little past the written value
    // like a real (lightly pedalled) piano, capped so slow tempos stay clean.
    const ring = Math.min(dur + 1.2, Math.max(0.45, 900 / freq));
    const tEnd = t0 + ring;

    // Fundamental + slightly inharmonic upper partials, hammer-fast attack.
    const partials: Array<{ mult: number; amp: number; type: OscillatorType }> = [
      { mult: 1, amp: 1, type: "triangle" },
      { mult: 2.001, amp: 0.32, type: "sine" },
      { mult: 3.004, amp: 0.14, type: "sine" },
    ];
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = Math.min(6500, freq * 9);
    filter.Q.value = 0.2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(level, t0 + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0004, tEnd);

    for (const p of partials) {
      const osc = ctx.createOscillator();
      osc.type = p.type;
      osc.frequency.value = freq * p.mult;
      const partGain = ctx.createGain();
      partGain.gain.value = p.amp;
      osc.connect(partGain);
      partGain.connect(filter);
      osc.start(t0);
      osc.stop(tEnd + 0.05);
    }
    filter.connect(gain);
    gain.connect(this.master!);
  }

  stop() {
    window.clearInterval(this.pumpTimer);
    window.clearTimeout(this.tickTimer);
    this.playing = false;
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
      this.master = null;
    }
  }
}
