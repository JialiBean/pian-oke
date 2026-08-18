export interface PitchEstimate {
  freq: number;
  clarity: number;
}

/**
 * Monophonic pitch detector using the McLeod Pitch Method (NSDF +
 * key-maximum picking with parabolic interpolation). Well suited to bowed
 * strings: strong harmonics do not trip it into octave errors the way plain
 * autocorrelation does.
 */
export class PitchDetector {
  private readonly minLag: number;
  private readonly maxLag: number;
  private nsdf: Float32Array;

  constructor(
    private readonly sampleRate: number,
    minFreq = 150,
    maxFreq = 3200,
  ) {
    this.maxLag = Math.floor(sampleRate / minFreq);
    this.minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
    this.nsdf = new Float32Array(this.maxLag + 2);
  }

  detect(buf: Float32Array): PitchEstimate | null {
    const n = buf.length;
    const maxLag = Math.min(this.maxLag, n - 2);
    const nsdf = this.nsdf;

    for (let tau = 2; tau <= maxLag; tau++) {
      let acf = 0;
      let norm = 0;
      for (let i = 0, len = n - tau; i < len; i++) {
        const a = buf[i];
        const b = buf[i + tau];
        acf += a * b;
        norm += a * a + b * b;
      }
      nsdf[tau] = norm > 0 ? (2 * acf) / norm : 0;
    }

    // Key maxima between positive-going zero crossings, skipping the lobe
    // around lag zero.
    let tau = 2;
    while (tau <= maxLag && nsdf[tau] > 0) tau++;

    const peaks: Array<{ lag: number; val: number }> = [];
    let curLag = -1;
    let curVal = -1;
    for (; tau <= maxLag; tau++) {
      const v = nsdf[tau];
      if (v > 0) {
        if (v > curVal) {
          curVal = v;
          curLag = tau;
        }
      } else if (curLag >= 0) {
        peaks.push({ lag: curLag, val: curVal });
        curLag = -1;
        curVal = -1;
      }
    }
    if (curLag >= 0) peaks.push({ lag: curLag, val: curVal });

    const usable = peaks.filter((p) => p.lag >= this.minLag && p.lag < maxLag);
    if (usable.length === 0) return null;

    const highest = Math.max(...usable.map((p) => p.val));
    if (highest < 0.5) return null;
    // Pick the FIRST key maximum close to the global one (McLeod). The ratio
    // biases toward the longer period: percussive/struck tones (piano) often
    // carry a 2nd harmonic stronger than the fundamental, and a stricter
    // ratio would jump an octave up on those.
    const chosen = usable.find((p) => p.val >= 0.86 * highest)!;

    const l = chosen.lag;
    const a = nsdf[l - 1];
    const b = nsdf[l];
    const c = nsdf[l + 1];
    const denom = a + c - 2 * b;
    let delta = 0;
    let peakVal = b;
    if (Math.abs(denom) > 1e-9) {
      delta = (a - c) / (2 * denom);
      if (delta > 0.5) delta = 0.5;
      else if (delta < -0.5) delta = -0.5;
      peakVal = b - ((c - a) * (c - a)) / (8 * denom);
    }
    const lag = l + delta;
    if (lag <= 0) return null;

    return {
      freq: this.sampleRate / lag,
      clarity: Math.max(0, Math.min(1, peakVal)),
    };
  }
}
