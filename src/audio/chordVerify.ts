import { midiToFreq } from "./noteUtils";

/**
 * Score-guided polyphonic verification: given a frequency spectrum (dB values
 * from AnalyserNode.getFloatFrequencyData) and the set of pitches the score
 * says should be sounding, report how much spectral evidence each pitch has.
 *
 * This is NOT transcription — it never asks "what is being played", only
 * "is there energy where THIS pitch's harmonics belong, above the local
 * background". That narrower question is answerable with a plain FFT.
 *
 * Each pitch is scored with a harmonic comb (k·f0, k = 1..6): the peak level
 * inside a small search window around each harmonic is compared to the median
 * level of the neighbouring bins, and the resulting SNRs are combined with
 * 1/k weights. Two guards keep the comb honest:
 *
 * - A harmonic whose frequency collides with a partial of ANOTHER expected
 *   pitch (within window width) proves nothing and is excluded. When every
 *   harmonic of a pitch is masked this way — octaves, twelfths, and
 *   generally any pitch sitting on a lower chord tone's partial series —
 *   the pitch is flagged `degenerate` and scored optimistically on the
 *   shared comb; the follower then demands a fresh attack instead of
 *   spectral proof, because no FFT of the mixture can separate the two.
 * - A "peak" that keeps rising past the search-window edge is the shoulder
 *   of a neighbouring peak, not a peak at the expected spot, and scores 0.
 */

export interface ChordEvidence {
  midi: number;
  /** 0..1 confidence that this pitch is currently sounding. */
  evidence: number;
  /**
   * True when every comb harmonic is shared with other expected pitches
   * (octave doubling and friends): evidence is then optimistic — it proves
   * the compound spectrum, not this tone specifically.
   */
  degenerate: boolean;
}

export interface ChordVerifyConfig {
  sampleRate: number;
  /** The analyser's fftSize; the spectrum has fftSize/2 bins. */
  fftSize: number;
  a4?: number;
}

export interface HarmonicPlan {
  midi: number;
  f0: number;
  degenerate: boolean;
  harmonics: Array<{ k: number; freq: number; shared: boolean }>;
}

/** Comb depth scored per expected pitch. */
const MAX_HARMONICS = 6;
/** Partials of other chord tones considered strong enough to mask ours. */
const MASKER_HARMONICS = 12;
/** Search half-width around a harmonic: ±2.5% (~±43 cents) for tuning drift
 * and piano inharmonicity stretch, never below the Blackman smear. */
const SEARCH_REL = 0.025;
const SEARCH_MIN_BINS = 2;
/** Blackman main lobe reaches ±3 bins; background sampling stays outside. */
const LOBE_BINS = 3;
const BG_WIDTH = 4;
/** SNR (dB over local background) mapping to a 0..1 harmonic score. */
const SNR_FLOOR_DB = 5;
const SNR_FULL_DB = 15;
const DB_FLOOR = -140;

function clampDb(v: number): number {
  return Number.isFinite(v) ? Math.max(v, DB_FLOOR) : DB_FLOOR;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Decide which harmonics of each expected pitch are usable as evidence.
 * A harmonic is `shared` when a partial (up to MASKER_HARMONICS) of another
 * expected pitch lands within collision distance: the energy there cannot be
 * attributed to one pitch or the other. Distinguishability is resolution-
 * dependent, so the collision distance combines FFT smear with the relative
 * search window.
 */
export function planCombs(expectedMidis: number[], cfg: ChordVerifyConfig): HarmonicPlan[] {
  const a4 = cfg.a4 ?? 440;
  const binWidth = cfg.sampleRate / cfg.fftSize;
  const maxFreq = 0.45 * cfg.sampleRate;
  const midis = [...new Set(expectedMidis)];
  const f0s = midis.map((m) => midiToFreq(m, a4));

  return midis.map((midi, i) => {
    const f0 = f0s[i];
    const harmonics: HarmonicPlan["harmonics"] = [];
    for (let k = 1; k <= MAX_HARMONICS; k++) {
      const freq = k * f0;
      if (freq >= maxFreq) break;
      const tol = LOBE_BINS * binWidth + SEARCH_REL * freq;
      let shared = false;
      for (let j = 0; j < f0s.length && !shared; j++) {
        if (j === i) continue;
        const m = Math.round(freq / f0s[j]);
        if (m >= 1 && m <= MASKER_HARMONICS && Math.abs(freq - m * f0s[j]) < tol) {
          shared = true;
        }
      }
      harmonics.push({ k, freq, shared });
    }
    // Degenerate when the unshared harmonics carry too little comb weight to
    // stand on their own — catches exact octaves (zero unshared) and near-
    // degenerate relations like the twelfth, where only faint high partials
    // remain distinguishable.
    let wAll = 0;
    let wUsable = 0;
    for (const h of harmonics) {
      wAll += 1 / h.k;
      if (!h.shared) wUsable += 1 / h.k;
    }
    const degenerate = harmonics.length > 0 && wUsable / wAll < 0.25;
    return { midi, f0, degenerate, harmonics };
  });
}

/**
 * Score one harmonic: interpolated peak inside the search window vs the
 * median of the flanking background rings. Returns 0..1.
 */
function harmonicScore(spec: Float32Array, pos: number, radius: number): number {
  const last = spec.length - 2;
  const lo = Math.max(1, Math.floor(pos - radius));
  const hi = Math.min(last, Math.ceil(pos + radius));
  if (hi < lo) return 0;

  let best = DB_FLOOR;
  let bi = lo;
  for (let i = lo; i <= hi; i++) {
    const v = clampDb(spec[i]);
    if (v > best) {
      best = v;
      bi = i;
    }
  }
  // Shoulder rejection: if the maximum sits on the window edge and the level
  // keeps rising just outside, we are on the slope of a different peak.
  if (bi === lo && clampDb(spec[lo - 1]) > best) return 0;
  if (bi === hi && clampDb(spec[hi + 1]) > best) return 0;

  // Parabolic refinement recovers the ~1 dB scalloping loss between bins.
  const a = clampDb(spec[bi - 1]);
  const c = clampDb(spec[bi + 1]);
  const denom = a + c - 2 * best;
  let peak = best;
  if (denom < -1e-9) {
    peak = Math.min(best + 3, best - ((a - c) * (a - c)) / (8 * denom));
  }

  // Background: median of each flanking ring, taken past the main lobe; the
  // worse (higher) side wins so a broad neighbouring peak cannot lift SNR.
  const gap = Math.ceil(radius) + LOBE_BINS;
  const sides: number[] = [];
  for (const dir of [-1, 1]) {
    const vals: number[] = [];
    for (let j = 0; j < BG_WIDTH; j++) {
      const idx = Math.round(pos + dir * (gap + 1 + j));
      if (idx >= 1 && idx <= last) vals.push(clampDb(spec[idx]));
    }
    if (vals.length >= 2) sides.push(median(vals));
  }
  if (sides.length === 0) return 0;
  const bg = Math.max(...sides);

  const snr = peak - bg;
  return Math.max(0, Math.min(1, (snr - SNR_FLOOR_DB) / (SNR_FULL_DB - SNR_FLOOR_DB)));
}

/**
 * Per-pitch spectral evidence for an expected chord. `spectrumDb` is the raw
 * output of getFloatFrequencyData (dB, fftSize/2 bins). Pure and stateless —
 * call once per analysis frame.
 */
export function verifyChord(
  spectrumDb: Float32Array,
  expectedMidis: number[],
  cfg: ChordVerifyConfig,
): ChordEvidence[] {
  const binWidth = cfg.sampleRate / cfg.fftSize;
  return planCombs(expectedMidis, cfg).map((plan) => {
    const usable = plan.degenerate
      ? plan.harmonics
      : plan.harmonics.filter((h) => !h.shared);
    let wSum = 0;
    let sSum = 0;
    for (const h of usable) {
      const pos = h.freq / binWidth;
      const radius = Math.max(SEARCH_MIN_BINS, SEARCH_REL * pos);
      const w = 1 / h.k;
      wSum += w;
      sSum += w * harmonicScore(spectrumDb, pos, radius);
    }
    return {
      midi: plan.midi,
      evidence: wSum > 0 ? sSum / wSum : 0,
      degenerate: plan.degenerate,
    };
  });
}
