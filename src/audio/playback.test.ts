import { describe, expect, it } from "vitest";
import { buildSchedule } from "./playback";
import type { NoteEvent } from "../score/types";

function event(timestamp: number, duration: number, midis: number[]): NoteEvent {
  return {
    index: 0,
    stepIndex: 0,
    midis,
    names: [],
    measure: 1,
    timestamp,
    duration,
    sourceNotes: [],
  };
}

describe("buildSchedule", () => {
  it("converts whole-note positions to seconds at the given tempo", () => {
    // 120 bpm → a quarter lasts 0.5 s, a whole note 2 s.
    const schedule = buildSchedule(
      [event(0, 0.25, [69]), event(0.25, 0.25, [76]), event(0.75, 0.5, [69])],
      120,
      1,
    );
    expect(schedule[0].time).toBeCloseTo(0, 5);
    expect(schedule[1].time).toBeCloseTo(0.5, 5);
    expect(schedule[2].time).toBeCloseTo(1.5, 5);
    expect(schedule[0].dur).toBeCloseTo(0.25 * 2 * 0.92, 5);
    expect(schedule[0].freqs[0]).toBeCloseTo(440, 3);
  });

  it("halving the tempo factor doubles every time", () => {
    const fast = buildSchedule([event(0, 0.25, [69]), event(0.5, 0.25, [69])], 100, 1);
    const slow = buildSchedule([event(0, 0.25, [69]), event(0.5, 0.25, [69])], 100, 0.5);
    expect(slow[1].time).toBeCloseTo(fast[1].time * 2, 5);
    expect(slow[0].dur).toBeCloseTo(fast[0].dur * 2, 5);
  });

  it("offsets so the first event starts at zero even mid-score", () => {
    const schedule = buildSchedule([event(3, 0.25, [69]), event(3.25, 0.25, [71])], 120, 1);
    expect(schedule[0].time).toBeCloseTo(0, 5);
    expect(schedule[1].time).toBeGreaterThan(0);
  });

  it("enforces a minimum audible duration", () => {
    const schedule = buildSchedule([event(0, 0.001, [69])], 200, 1);
    expect(schedule[0].dur).toBeGreaterThanOrEqual(0.08);
  });

  it("respects the A4 tuning reference", () => {
    const schedule = buildSchedule([event(0, 0.25, [69])], 100, 1, 442);
    expect(schedule[0].freqs[0]).toBeCloseTo(442, 3);
  });
});
