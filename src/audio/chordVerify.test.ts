import { describe, expect, it } from "vitest";
import { planCombs, verifyChord, type ChordVerifyConfig } from "./chordVerify";
import { midiToFreq } from "./noteUtils";

const SR = 48000;
const FFT = 8192;
const CFG: ChordVerifyConfig = { sampleRate: SR, fftSize: FFT, a4: 440 };
const BIN = SR / FFT;

// ---------------------------------------------------------------------------
// Analytic spectrum synthesis. AnalyserNode applies a Blackman window before
// the FFT, so each sinusoid appears as the Blackman kernel centred on its
// frequency. We build |X| per bin directly (powers add — incoherent phases),
// over a deterministic noise floor, and convert to dB like
// getFloatFrequencyData would. Frequency-domain mirror of pitch.test.ts.
// ---------------------------------------------------------------------------

function dirichlet(x: number, n: number): number {
  const den = n * Math.sin((Math.PI * x) / n);
  if (Math.abs(den) < 1e-9) return 1;
  return Math.sin(Math.PI * x) / den;
}

/**
 * |Blackman window transform| at a fractional-bin offset, normalized to 1.
 * The shifted Dirichlet terms carry an e^{±iπ(N-1)/N} ≈ -1 phase, which
 * flips the -0.25 cosine coefficients to +0.25 in the magnitude form.
 */
function blackmanKernel(d: number, n: number): number {
  const w =
    0.42 * dirichlet(d, n) +
    0.25 * (dirichlet(d - 1, n) + dirichlet(d + 1, n)) +
    0.04 * (dirichlet(d - 2, n) + dirichlet(d + 2, n));
  return Math.abs(w) / 0.42;
}

interface Partial {
  freq: number;
  amp: number;
}

const NOISE_DB = -65;

function synthSpectrum(partials: Partial[], noiseDb = NOISE_DB): Float32Array {
  const bins = FFT / 2;
  const out = new Float32Array(bins);
  let seed = 987654321;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < bins; i++) {
    // ±4 dB ripple keeps the floor from being suspiciously flat.
    let power = Math.pow(10, (noiseDb + (rand() - 0.5) * 8) / 10);
    for (const p of partials) {
      const d = i - p.freq / BIN;
      if (Math.abs(d) <= 8) {
        const m = p.amp * blackmanKernel(d, FFT);
        power += m * m;
      }
    }
    out[i] = 10 * Math.log10(power);
  }
  return out;
}

/** Struck-string partial profile (harmonics 1..8, decaying). */
const PIANO_AMPS = [1, 0.55, 0.35, 0.22, 0.14, 0.09, 0.06, 0.04];
/** Low piano strings often bury the fundamental under partials 2-4. */
const BASS_AMPS = [0.25, 1, 0.5, 0.3, 0.18, 0.11, 0.07, 0.05];

function pianoTone(f0: number, level = 1, amps = PIANO_AMPS): Partial[] {
  return amps
    .map((a, i) => ({ freq: f0 * (i + 1), amp: a * level }))
    .filter((p) => p.freq < SR * 0.48);
}

function chordSpectrum(midis: number[], level = 1, amps = PIANO_AMPS): Float32Array {
  return synthSpectrum(midis.flatMap((m) => pianoTone(midiToFreq(m), level, amps)));
}

function evidenceMap(spec: Float32Array, expected: number[]): Map<number, number> {
  return new Map(verifyChord(spec, expected, CFG).map((c) => [c.midi, c.evidence]));
}

// C-E-G triads by root MIDI: C3=48, C4=60, C5=72.
const TRIAD = (root: number) => [root, root + 4, root + 7];

describe("verifyChord (harmonic-comb evidence)", () => {
  it("detects every tone of C-E-G triads across registers", () => {
    for (const root of [48, 60, 72]) {
      const expected = TRIAD(root);
      const ev = evidenceMap(chordSpectrum(expected), expected);
      for (const m of expected) {
        expect(ev.get(m)!, `midi ${m} in triad on ${root}`).toBeGreaterThanOrEqual(0.6);
      }
      for (const c of verifyChord(chordSpectrum(expected), expected, CFG)) {
        expect(c.degenerate, `midi ${c.midi} unexpectedly degenerate`).toBe(false);
      }
    }
  });

  it("rejects a written tone that is not sounding", () => {
    // Expected C4-E4-G4 but only C4+G4 are played: E must fail, C/G pass.
    const expected = TRIAD(60);
    const ev = evidenceMap(chordSpectrum([60, 67]), expected);
    expect(ev.get(60)!).toBeGreaterThanOrEqual(0.6);
    expect(ev.get(67)!).toBeGreaterThanOrEqual(0.6);
    expect(ev.get(64)!).toBeLessThan(0.3);
  });

  it("rejects a completely different chord", () => {
    // Expected C4-E4-G4, played D4-F4-A4 (a whole step off).
    const expected = TRIAD(60);
    const ev = evidenceMap(chordSpectrum([62, 65, 69]), expected);
    for (const m of expected) {
      expect(ev.get(m)!, `midi ${m} credited from wrong chord`).toBeLessThan(0.45);
    }
  });

  it("gives no evidence on a noise-only spectrum", () => {
    const expected = TRIAD(60);
    const ev = evidenceMap(synthSpectrum([]), expected);
    for (const m of expected) expect(ev.get(m)!).toBeLessThan(0.15);
  });

  it("still verifies chords when an extra (melody) tone also sounds", () => {
    const expected = TRIAD(60);
    const spec = synthSpectrum([
      ...[60, 64, 67].flatMap((m) => pianoTone(midiToFreq(m))),
      ...pianoTone(midiToFreq(83), 0.8), // B5 on top
    ]);
    const ev = evidenceMap(spec, expected);
    for (const m of expected) expect(ev.get(m)!).toBeGreaterThanOrEqual(0.6);
  });

  it("verifies a low tone whose fundamental is weaker than its partials", () => {
    // G2 with a buried fundamental — common on real piano bass strings.
    const expected = [43];
    const spec = synthSpectrum(pianoTone(midiToFreq(43), 1, BASS_AMPS));
    const ev = evidenceMap(spec, expected);
    expect(ev.get(43)!).toBeGreaterThanOrEqual(0.5);
  });

  it("resolves a close low-register triad (C3-E3-G3)", () => {
    const expected = TRIAD(48);
    const present = evidenceMap(chordSpectrum(expected), expected);
    for (const m of expected) expect(present.get(m)!).toBeGreaterThanOrEqual(0.55);
    // Missing middle tone is still caught down here.
    const absent = evidenceMap(chordSpectrum([48, 55]), expected);
    expect(absent.get(52)!).toBeLessThan(0.35);
  });
});

describe("verifyChord octave degeneracy", () => {
  it("flags the upper octave as degenerate (C3+C4)", () => {
    const plans = planCombs([48, 60], CFG);
    expect(plans.find((p) => p.midi === 60)!.degenerate).toBe(true);
    expect(plans.find((p) => p.midi === 48)!.degenerate).toBe(false);
  });

  it("flags a pitch riding a lower tone's partial series (perfect twelfth C4+G5)", () => {
    const plans = planCombs([60, 79], CFG);
    expect(plans.find((p) => p.midi === 79)!.degenerate).toBe(true);
  });

  it("does not flag ordinary triad intervals as degenerate", () => {
    for (const p of planCombs(TRIAD(60), CFG)) {
      expect(p.degenerate, `midi ${p.midi}`).toBe(false);
    }
  });

  it("documents octave-doubling optimism: the lower tone alone credits the octave", () => {
    // Expected C3+C4 but only C3 sounds. C4's whole comb coincides with C3's
    // even partials, so spectral evidence CANNOT separate them: the octave
    // scores high anyway (degenerate=true tells the follower to demand a
    // fresh attack instead of trusting the spectrum).
    const expected = [48, 60];
    const onlyLow = evidenceMap(chordSpectrum([48]), expected);
    expect(onlyLow.get(60)!).toBeGreaterThanOrEqual(0.5); // optimistic by design
    const both = evidenceMap(chordSpectrum(expected), expected);
    expect(both.get(60)!).toBeGreaterThanOrEqual(0.5);
    expect(both.get(48)!).toBeGreaterThanOrEqual(0.6);
  });

  it("verifies the doubled-root voicing C4-E4-G4-C5", () => {
    const expected = [60, 64, 67, 72];
    const plans = planCombs(expected, CFG);
    expect(plans.find((p) => p.midi === 72)!.degenerate).toBe(true);
    const ev = evidenceMap(chordSpectrum(expected), expected);
    for (const m of [60, 64, 67]) expect(ev.get(m)!).toBeGreaterThanOrEqual(0.55);
    // A missing NON-degenerate tone is still caught in this voicing.
    const missingThird = evidenceMap(chordSpectrum([60, 67, 72]), expected);
    expect(missingThird.get(64)!).toBeLessThan(0.3);
  });
});
