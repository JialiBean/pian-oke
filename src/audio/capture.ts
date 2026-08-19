/**
 * Gapless mono capture for the ML ear. The AnalyserNode used by the tuner
 * polls overlapping snapshots on animation frames — fine for per-frame
 * analysis, useless as a continuous stream. This taps the mic through an
 * AudioWorklet (128-sample blocks, no gaps), resamples to the model's
 * 22050 Hz with a phase-continuous linear interpolator, and keeps the
 * last few seconds in a ring buffer.
 */

/** Basic Pitch's expected input rate. */
export const MODEL_SAMPLE_RATE = 22050;

/**
 * Streaming linear resampler + ring buffer. Push blocks at the input rate,
 * read the freshest N output samples whenever needed. `total` counts output
 * samples ever produced, so callers can timestamp reads.
 */
export class CaptureRing {
  readonly outRate: number;
  /** Output samples produced since construction. */
  total = 0;

  private readonly ring: Float32Array;
  private readonly step: number;
  /** Input samples consumed by prior push() calls. */
  private inConsumed = 0;
  /** Last sample of the previous block, for positions straddling the edge. */
  private prev = 0;
  private write = 0;
  private filled = 0;

  constructor(inRate: number, outRate = MODEL_SAMPLE_RATE, seconds = 5) {
    this.outRate = outRate;
    this.step = inRate / outRate;
    this.ring = new Float32Array(Math.ceil(outRate * seconds));
  }

  push(block: Float32Array) {
    const n = block.length;
    if (n === 0) return;
    // Output position p is recomputed from the output counter each time —
    // no accumulated phase, so the result is exact and independent of how
    // the input happens to be chunked. Interpolation needs one sample of
    // lookahead, so positions past the block's second-to-last sample wait
    // for the next push.
    const limit = this.inConsumed + n - 1;
    let p = this.total * this.step;
    while (p < limit) {
      const idx = Math.floor(p);
      const frac = p - idx;
      const local = idx - this.inConsumed;
      const a = local < 0 ? this.prev : block[local];
      const b = block[local + 1];
      this.ring[this.write] = a + (b - a) * frac;
      this.write = (this.write + 1) % this.ring.length;
      if (this.filled < this.ring.length) this.filled++;
      this.total++;
      p = this.total * this.step;
    }
    this.inConsumed += n;
    this.prev = block[n - 1];
  }

  /** Copy the freshest `out.length` samples (zero-padded on the left when
   * the ring holds less). Returns how many were real. */
  readLatest(out: Float32Array): number {
    const want = out.length;
    const have = Math.min(want, this.filled);
    out.fill(0, 0, want - have);
    let src = (this.write - have + this.ring.length) % this.ring.length;
    for (let i = want - have; i < want; i++) {
      out[i] = this.ring[src];
      src = (src + 1) % this.ring.length;
    }
    return have;
  }
}

/** Worklet source, inlined so dev and build serve it identically. */
const WORKLET_SOURCE = `
class JvCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("jv-capture", JvCaptureProcessor);
`;

/**
 * Attach a capture tap to a Web Audio source. Returns a handle exposing the
 * ring and a dispose(). The worklet module loads once per context.
 */
export async function attachCapture(
  ctx: AudioContext,
  source: AudioNode,
  seconds = 5,
): Promise<{ ring: CaptureRing; dispose: () => void }> {
  const anyCtx = ctx as AudioContext & { __jvCaptureModule?: Promise<void> };
  if (!anyCtx.__jvCaptureModule) {
    const url = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
    anyCtx.__jvCaptureModule = ctx.audioWorklet.addModule(url).finally(() => {
      URL.revokeObjectURL(url);
    });
  }
  await anyCtx.__jvCaptureModule;

  const ring = new CaptureRing(ctx.sampleRate, MODEL_SAMPLE_RATE, seconds);
  const node = new AudioWorkletNode(ctx, "jv-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  node.port.onmessage = (e: MessageEvent<Float32Array>) => ring.push(e.data);
  source.connect(node);
  return {
    ring,
    dispose: () => {
      node.port.onmessage = null;
      try {
        source.disconnect(node);
      } catch {
        // context may already be closed
      }
    },
  };
}
