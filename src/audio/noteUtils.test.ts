import { describe, expect, it } from "vitest";
import { freqToMidiFloat, midiToFreq, midiToName, toReading } from "./noteUtils";

describe("note math", () => {
  it("maps reference frequencies to MIDI", () => {
    expect(freqToMidiFloat(440)).toBeCloseTo(69, 5);
    expect(freqToMidiFloat(880)).toBeCloseTo(81, 5);
    expect(freqToMidiFloat(196, 440)).toBeCloseTo(55, 1); // violin G string
    expect(midiToFreq(69)).toBeCloseTo(440, 5);
    expect(midiToFreq(69, 442)).toBeCloseTo(442, 5);
  });

  it("names notes with octaves", () => {
    expect(midiToName(69)).toBe("A4");
    expect(midiToName(60)).toBe("C4");
    expect(midiToName(55)).toBe("G3");
    expect(midiToName(76)).toBe("E5");
    expect(midiToName(66)).toBe("F#4");
  });

  it("computes cents deviation", () => {
    const r = toReading(446, 0.95, 0.05);
    expect(r.midi).toBe(69);
    expect(r.cents).toBeCloseTo(23.4, 0);
    const flat = toReading(434, 0.95, 0.05);
    expect(flat.midi).toBe(69);
    expect(flat.cents).toBeLessThan(0);
  });

  it("respects alternate A4 tuning", () => {
    const r = toReading(442, 0.95, 0.05, 442);
    expect(r.midi).toBe(69);
    expect(Math.abs(r.cents)).toBeLessThan(0.01);
  });
});
