import { describe, expect, it } from "vitest";
import { posteriorsToEvidence } from "./mlEar";

/** frames[t][88] with chosen pitches hot from a given frame onward. */
function frames(
  n: number,
  hot: Array<{ midi: number; from: number; p?: number }>,
): number[][] {
  return Array.from({ length: n }, (_, t) => {
    const row = new Array<number>(88).fill(0.02);
    for (const h of hot) {
      if (t >= h.from) row[h.midi - 21] = h.p ?? 0.85;
    }
    return row;
  });
}

describe("posteriorsToEvidence (Basic Pitch reduction)", () => {
  it("maps MIDI to the 88-key posterior index (A0 = 21)", () => {
    const f = frames(100, [{ midi: 21, from: 0 }, { midi: 108, from: 0 }]);
    const ev = posteriorsToEvidence(f, [21, 108, 60], 500);
    expect(ev.find((e) => e.midi === 21)!.evidence).toBeCloseTo(0.85);
    expect(ev.find((e) => e.midi === 108)!.evidence).toBeCloseTo(0.85);
    expect(ev.find((e) => e.midi === 60)!.evidence).toBeLessThan(0.1);
  });

  it("only looks at the trailing window", () => {
    // Pitch hot ONLY in early frames; 500 ms window (~44 frames) at the end
    // must not see it.
    const f = frames(300, []).map((row, t) => {
      if (t < 100) row[60 - 21] = 0.9;
      return row;
    });
    const ev = posteriorsToEvidence(f, [60], 500);
    expect(ev[0].evidence).toBeLessThan(0.1);
    // A wider window that reaches back does see it.
    const wide = posteriorsToEvidence(f, [60], 3500);
    expect(wide[0].evidence).toBeCloseTo(0.9);
  });

  it("scores pitches outside the 88 keys as absent", () => {
    const ev = posteriorsToEvidence(frames(50, []), [15, 120], 500);
    expect(ev[0].evidence).toBe(0);
    expect(ev[1].evidence).toBe(0);
  });

  it("never flags ML evidence as degenerate (octaves are separable)", () => {
    const f = frames(60, [{ midi: 48, from: 0 }, { midi: 60, from: 0 }]);
    for (const e of posteriorsToEvidence(f, [48, 60], 500)) {
      expect(e.degenerate).toBe(false);
      expect(e.evidence).toBeCloseTo(0.85);
    }
  });
});
