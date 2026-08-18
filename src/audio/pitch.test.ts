import { describe, expect, it } from "vitest";
import { PitchDetector } from "./pitch";

const SR = 48000;
const N = 2048;
const N_BIG = 4096; // engine's window since the low-range extension

function toneN(
  n: number,
  freq: number,
  harmonics: number[] = [1, 0.4, 0.25, 0.15],
): Float32Array {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    harmonics.forEach((amp, k) => {
      v += amp * Math.sin(2 * Math.PI * freq * (k + 1) * t + 0.3 * k);
    });
    buf[i] = v * 0.2;
  }
  return buf;
}

function tone(freq: number, harmonics?: number[]): Float32Array {
  return toneN(N, freq, harmonics);
}

function centsOff(detected: number, expected: number): number {
  return Math.abs(1200 * Math.log2(detected / expected));
}

describe("PitchDetector (McLeod)", () => {
  it("detects violin-range fundamentals within 10 cents", () => {
    const det = new PitchDetector(SR, 150, 3200);
    // G3, A3, D4, A4, E5, A5, A6 — the working range of beginner violin.
    for (const f of [196, 220, 293.66, 440, 659.25, 880, 1760]) {
      const r = det.detect(tone(f));
      expect(r, `no detection at ${f} Hz`).not.toBeNull();
      expect(r!.clarity).toBeGreaterThan(0.85);
      expect(centsOff(r!.freq, f), `detune at ${f} Hz`).toBeLessThan(10);
    }
  });

  it("detects the violin's top E (E7) within 25 cents", () => {
    const det = new PitchDetector(SR, 150, 3200);
    const f = 2637.02;
    const r = det.detect(tone(f, [1, 0.3]));
    expect(r).not.toBeNull();
    expect(centsOff(r!.freq, f)).toBeLessThan(25);
  });

  it("resists octave errors on piano-like spectra (2nd harmonic dominant)", () => {
    const det = new PitchDetector(SR, 70, 3200);
    // Struck strings often have the 2nd harmonic louder than the fundamental.
    const pianoish = [0.5, 1.0, 0.6, 0.3, 0.2];
    for (const f of [130.81, 220, 261.63, 440]) {
      const r = det.detect(toneN(N_BIG, f, pianoish));
      expect(r, `no detection at ${f} Hz`).not.toBeNull();
      expect(centsOff(r!.freq, f), `octave/detune error at ${f} Hz`).toBeLessThan(15);
    }
  });

  it("reads the extended low range (piano mid-low, cello C2)", () => {
    const det = new PitchDetector(SR, 70, 3200);
    for (const f of [73.42, 98, 130.81]) {
      const r = det.detect(toneN(N_BIG, f));
      expect(r, `no detection at ${f} Hz`).not.toBeNull();
      expect(centsOff(r!.freq, f)).toBeLessThan(12);
    }
  });

  it("returns null for silence", () => {
    const det = new PitchDetector(SR, 150, 3200);
    expect(det.detect(new Float32Array(N))).toBeNull();
  });

  it("does not report high clarity for noise", () => {
    const det = new PitchDetector(SR, 150, 3200);
    let seed = 123456789;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    const noise = new Float32Array(N);
    for (let i = 0; i < N; i++) noise[i] = rand() * 0.4;
    const r = det.detect(noise);
    expect(!r || r.clarity < 0.8).toBe(true);
  });
});
