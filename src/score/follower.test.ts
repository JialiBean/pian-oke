import { beforeEach, describe, expect, it } from "vitest";
import { Follower } from "./follower";
import type { NoteEvent } from "./types";
import type { AudioFrame } from "../audio/engine";
import { midiToFreq, midiToName, toReading } from "../audio/noteUtils";

function makeEvents(midis: number[]): NoteEvent[] {
  return midis.map((m, i) => ({
    index: i,
    stepIndex: i,
    midis: [m],
    names: [midiToName(m)],
    measure: 1,
    timestamp: i * 0.25,
    duration: 0.25,
    sourceNotes: [],
  }));
}

function loud(t: number, midi: number, rms = 0.05): AudioFrame {
  return { time: t, rms, reading: toReading(midiToFreq(midi), 0.97, rms) };
}

function silent(t: number): AudioFrame {
  return { time: t, rms: 0.0001, reading: null };
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
});
