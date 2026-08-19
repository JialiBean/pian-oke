import { beforeEach, describe, expect, it } from "vitest";
import { Follower } from "./follower";
import type { NoteEvent } from "./types";
import type { AudioFrame } from "../audio/engine";
import { midiToFreq, midiToName, toReading } from "../audio/noteUtils";

function makeChordEvents(chords: number[][]): NoteEvent[] {
  return chords.map((midis, i) => ({
    index: i,
    stepIndex: i,
    midis,
    names: midis.map(midiToName),
    measure: 1,
    timestamp: i * 0.25,
    duration: 0.25,
    sourceNotes: [],
  }));
}

function makeEvents(midis: number[]): NoteEvent[] {
  return makeChordEvents(midis.map((m) => [m]));
}

function loud(t: number, midi: number, rms = 0.05): AudioFrame {
  return { time: t, rms, reading: toReading(midiToFreq(midi), 0.97, rms) };
}

function silent(t: number): AudioFrame {
  return { time: t, rms: 0.0001, reading: null };
}

/**
 * A polyphonic frame: evidence per MIDI as [midi, evidence] pairs (or just a
 * midi for full evidence), an optional monophonic reading, degenerate flags.
 */
function chordFrame(
  t: number,
  evidence: Array<[number, number] | number>,
  opts: { read?: number | null; rms?: number; degenerate?: number[] } = {},
): AudioFrame {
  const rms = opts.rms ?? 0.05;
  const read = opts.read;
  return {
    time: t,
    rms,
    reading: read == null ? null : toReading(midiToFreq(read), 0.97, rms),
    chord: evidence.map((e) => {
      const [midi, ev] = Array.isArray(e) ? e : [e, 0.9];
      return { midi, evidence: ev, degenerate: opts.degenerate?.includes(midi) ?? false };
    }),
  };
}

describe("Follower (wait-mode karaoke)", () => {
  let matched: Array<{ i: number; firstTry: boolean }>;
  let wrong: Array<{ i: number; midi: number }>;
  let skipped: number[];
  let finishedCount: number;
  let follower: Follower;

  beforeEach(() => {
    matched = [];
    wrong = [];
    skipped = [];
    finishedCount = 0;
    follower = new Follower({
      onMatched: (i, firstTry) => matched.push({ i, firstTry }),
      onWrong: (i, midi) => wrong.push({ i, midi }),
      onSkipped: (i) => skipped.push(i),
      onFinished: () => finishedCount++,
    });
  });

  it("advances after the correct pitch is held, then finishes", () => {
    follower.start(makeEvents([69, 71]));
    follower.feed(loud(0, 69));
    follower.feed(loud(30, 69));
    expect(matched).toHaveLength(0); // 30ms < holdMs
    follower.feed(loud(80, 69));
    expect(matched).toEqual([{ i: 0, firstTry: true }]);
    follower.feed(loud(100, 71));
    follower.feed(loud(130, 71));
    follower.feed(loud(180, 71));
    expect(matched).toHaveLength(2);
    expect(finishedCount).toBe(1);
    expect(follower.active).toBe(false);
  });

  it("does not let one sustained note match a repeated note", () => {
    follower.start(makeEvents([69, 69]));
    follower.feed(loud(0, 69));
    follower.feed(loud(80, 69));
    expect(matched).toHaveLength(1);
    // Keep sustaining the same bow: must NOT advance.
    for (let t = 100; t <= 400; t += 30) follower.feed(loud(t, 69));
    expect(matched).toHaveLength(1);
    // A short gap re-arms, then the re-played note counts.
    follower.feed(silent(420));
    follower.feed(silent(480));
    follower.feed(loud(500, 69));
    follower.feed(loud(580, 69));
    expect(matched).toHaveLength(2);
    expect(finishedCount).toBe(1);
  });

  it("re-arms a repeated note on a fresh bow attack without a gap", () => {
    follower.start(makeEvents([69, 69]));
    follower.feed(loud(0, 69));
    follower.feed(loud(80, 69));
    expect(matched).toHaveLength(1);
    for (let t = 100; t <= 340; t += 30) follower.feed(loud(t, 69, 0.05));
    expect(matched).toHaveLength(1);
    // Sudden level jump = new articulation.
    follower.feed(loud(360, 69, 0.2));
    follower.feed(loud(440, 69, 0.18));
    expect(matched).toHaveLength(2);
  });

  it("moves straight into a different next pitch without needing a gap", () => {
    follower.start(makeEvents([69, 74]));
    follower.feed(loud(0, 69));
    follower.feed(loud(80, 69));
    expect(matched).toHaveLength(1);
    // Legato change to the next (different) note: no silence in between.
    follower.feed(loud(100, 74));
    follower.feed(loud(180, 74));
    expect(matched).toHaveLength(2);
  });

  it("reports a stable wrong note once and marks the fix as corrected", () => {
    follower.start(makeEvents([69]));
    follower.feed(loud(0, 71));
    follower.feed(loud(100, 71));
    expect(wrong).toHaveLength(0); // not stable long enough yet
    follower.feed(loud(200, 71));
    expect(wrong).toEqual([{ i: 0, midi: 71 }]);
    follower.feed(loud(230, 71));
    follower.feed(loud(260, 71));
    expect(wrong).toHaveLength(1); // no re-fire while it keeps sounding
    follower.feed(loud(300, 69));
    follower.feed(loud(380, 69));
    expect(matched).toEqual([{ i: 0, firstTry: false }]);
  });

  it("ignores out-of-tune notes beyond the tolerance", () => {
    follower.cfg.centsTol = 50;
    follower.start(makeEvents([69]));
    const sharpByALot = 440 * Math.pow(2, 0.7 / 12); // ~70 cents sharp
    const frame = (t: number): AudioFrame => ({
      time: t,
      rms: 0.05,
      reading: toReading(sharpByALot, 0.97, 0.05),
    });
    follower.feed(frame(0));
    follower.feed(frame(80));
    follower.feed(frame(160));
    expect(matched).toHaveLength(0);
  });

  it("accepts any tone of a double stop", () => {
    follower.start([
      {
        index: 0,
        stepIndex: 0,
        midis: [62, 69],
        names: ["D4", "A4"],
        measure: 1,
        timestamp: 0,
        duration: 0.25,
        sourceNotes: [],
      },
    ]);
    follower.feed(loud(0, 69));
    follower.feed(loud(80, 69));
    expect(matched).toHaveLength(1);
  });

  it("supports skip and back", () => {
    follower.start(makeEvents([69, 71, 72]));
    follower.skip();
    expect(skipped).toEqual([0]);
    expect(follower.index).toBe(1);
    expect(follower.back()).toBe(0);
    expect(follower.index).toBe(0);
    expect(follower.back()).toBeNull();
  });

  describe("requireAllTones (piano full-chord mode)", () => {
    const CEG = [60, 64, 67];

    beforeEach(() => {
      follower.cfg.requireAllTones = true;
    });

    it("stays on any-tone matching while the flag is off", () => {
      follower.cfg.requireAllTones = false;
      follower.start(makeChordEvents([CEG]));
      // Even with evidence for just one tone, the monophonic reading rules.
      follower.feed(chordFrame(0, [60], { read: 60 }));
      follower.feed(chordFrame(80, [60], { read: 60 }));
      expect(matched).toHaveLength(1);
    });

    it("advances only after every chord tone shows evidence", () => {
      follower.start(makeChordEvents([CEG]));
      for (let t = 0; t <= 300; t += 30) {
        follower.feed(chordFrame(t, [60, 64, [67, 0.2]], { read: 60 }));
      }
      expect(matched).toHaveLength(0); // G missing: no advance...
      expect(wrong).toHaveLength(0); // ...and C4 in hand is not "wrong"
      follower.feed(chordFrame(330, CEG, { read: 60 }));
      follower.feed(chordFrame(400, CEG, { read: 60 }));
      expect(matched).toEqual([{ i: 0, firstTry: true }]);
    });

    it("collects tones arriving in different frames (rolled chord)", () => {
      follower.start(makeChordEvents([CEG]));
      follower.feed(chordFrame(0, [60], { read: 60 }));
      follower.feed(chordFrame(100, [64], { read: 64 }));
      follower.feed(chordFrame(200, [67], { read: 67 }));
      expect(matched).toHaveLength(0); // window satisfied, hold not yet
      follower.feed(chordFrame(230, [67], { read: 67 }));
      follower.feed(chordFrame(270, [67], { read: 67 }));
      expect(matched).toHaveLength(1);
    });

    it("expires evidence older than the rolling window", () => {
      follower.start(makeChordEvents([CEG]));
      follower.feed(chordFrame(0, [60], { read: 60 }));
      for (let t = 450; t <= 900; t += 50) {
        follower.feed(chordFrame(t, [64, 67], { read: 64 }));
      }
      expect(matched).toHaveLength(0); // C evidence expired before E+G came
      follower.feed(chordFrame(920, CEG, { read: 60 }));
      follower.feed(chordFrame(990, CEG, { read: 60 }));
      expect(matched).toHaveLength(1);
    });

    it("works without a usable monophonic reading (polyphonic mush)", () => {
      follower.start(makeChordEvents([CEG]));
      follower.feed(chordFrame(0, CEG, { read: null }));
      follower.feed(chordFrame(80, CEG, { read: null }));
      expect(matched).toHaveLength(1);
    });

    it("reports a wrong note from the monophonic reading only", () => {
      follower.start(makeChordEvents([CEG]));
      // Player holds D4 instead: no advance, and the wrong note is reported.
      for (let t = 0; t <= 200; t += 30) {
        follower.feed(chordFrame(t, [[60, 0.1], [64, 0.1], [67, 0.1]], { read: 62 }));
      }
      expect(matched).toHaveLength(0);
      expect(wrong).toEqual([{ i: 0, midi: 62 }]);
    });

    it("requires a fresh attack before crediting a degenerate (octave) tone", () => {
      // C3+C4: C4 is spectrally inseparable from C3's even partials.
      follower.start(makeChordEvents([[48, 60]]));
      for (let t = 0; t <= 300; t += 30) {
        follower.feed(chordFrame(t, [48, 60], { read: 48, degenerate: [60] }));
      }
      expect(matched).toHaveLength(0); // ringing spectrum alone: no credit
      // A fresh attack (RMS jump) supplies the missing articulation.
      follower.feed(chordFrame(330, [48, 60], { read: 48, rms: 0.3, degenerate: [60] }));
      follower.feed(chordFrame(400, [48, 60], { read: 48, rms: 0.25, degenerate: [60] }));
      expect(matched).toHaveLength(1);
    });

    it("needs a re-articulation for a repeated chord", () => {
      follower.start(makeChordEvents([CEG, CEG]));
      follower.feed(chordFrame(0, CEG, { read: 60 }));
      follower.feed(chordFrame(80, CEG, { read: 60 }));
      expect(matched).toHaveLength(1);
      // The same chord keeps ringing: must not advance again.
      for (let t = 110; t <= 400; t += 30) {
        follower.feed(chordFrame(t, CEG, { read: 60 }));
      }
      expect(matched).toHaveLength(1);
      // Restrike (fresh attack) re-arms and completes the repeat.
      follower.feed(chordFrame(430, CEG, { read: 60, rms: 0.3 }));
      follower.feed(chordFrame(500, CEG, { read: 60, rms: 0.25 }));
      expect(matched).toHaveLength(2);
      expect(finishedCount).toBe(1);
    });

    it("falls back to any-tone matching when frames carry no evidence", () => {
      follower.start(makeChordEvents([CEG]));
      follower.feed(loud(0, 60));
      follower.feed(loud(80, 60));
      expect(matched).toHaveLength(1);
    });

    it("leaves single-note events on the monophonic path", () => {
      follower.start(makeEvents([69]));
      follower.feed(chordFrame(0, [[69, 0.05]], { read: 69 }));
      follower.feed(chordFrame(80, [[69, 0.05]], { read: 69 }));
      expect(matched).toHaveLength(1); // evidence ignored: 1 midi = mono rules
    });
  });
});
