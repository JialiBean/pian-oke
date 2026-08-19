import type { ChordEvidence } from "./chordVerify";
import { CaptureRing, MODEL_SAMPLE_RATE, attachCapture } from "./capture";

/**
 * ML polyphonic ear: Spotify's Basic Pitch (Apache-2.0) running locally via
 * TensorFlow.js. The model listens to ~2 s of recent audio and emits per-
 * frame note posteriors for the 88 piano keys (~86 fps); we reduce those to
 * ChordEvidence for the expected tones, so it plugs into the follower
 * exactly like the spectral comb — but it can genuinely separate octaves,
 * so nothing is flagged degenerate.
 *
 * Everything is local: the model files are vendored under
 * /models/basic-pitch (see the LICENSE file there); tfjs + basic-pitch load
 * through a dynamic import so violin mode never pays for them.
 */

/** Basic Pitch constants (mirrors the library's inference.ts). */
const FFT_HOP = 256;
const WINDOW_SAMPLES = MODEL_SAMPLE_RATE * 2 - FFT_HOP; // 43844
const LOWEST_MIDI = 21; // posterior index 0 = A0

const MODEL_URL = "/models/basic-pitch/model.json";
/** Re-run inference on the freshest window this often. */
const RUN_INTERVAL_MS = 450;
/** Results older than this are stale — callers fall back to spectral. */
const STALE_MS = 1600;

export type MlEarState = "idle" | "loading" | "ready" | "error";

interface InferenceResult {
  /** Concatenated note posteriors, frames[t][0..87]. */
  frames: number[][];
  wallTime: number;
}

type BasicPitchModel = {
  model: Promise<unknown>;
  evaluateModel(
    audio: Float32Array,
    onComplete: (f: number[][], o: number[][], c: number[][]) => void,
    onProgress: (p: number) => void,
  ): Promise<void>;
};

export class MlEar {
  state: MlEarState = "idle";
  detail = "";
  onState?: (state: MlEarState, detail: string) => void;

  private bp: BasicPitchModel | null = null;
  private tf: typeof import("@tensorflow/tfjs") | null = null;
  private ring: CaptureRing | null = null;
  private capture: { dispose: () => void } | null = null;
  private timer = 0;
  private busy = false;
  private latest: InferenceResult | null = null;
  private loadPromise: Promise<void> | null = null;

  private setState(state: MlEarState, detail = "") {
    this.state = state;
    this.detail = detail;
    this.onState?.(state, detail);
  }

  /** Load tfjs + the model and warm the backend up. Safe to call twice. */
  load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.doLoad().catch((e) => {
        this.setState("error", e instanceof Error ? e.message : String(e));
      });
    }
    return this.loadPromise;
  }

  private async doLoad() {
    this.setState("loading");
    const [{ BasicPitch }, tf] = await Promise.all([
      import("@spotify/basic-pitch"),
      import("@tensorflow/tfjs"),
    ]);
    this.tf = tf;
    this.bp = new BasicPitch(MODEL_URL) as unknown as BasicPitchModel;
    // The graph's weight tensors must exist BEFORE any scoped inference —
    // a scope started around the first run would otherwise adopt and then
    // dispose them, and every later run would execute on dead tensors.
    await this.bp.model;
    // Warm-up compiles the WebGL shaders so the first real run is not slow.
    await this.infer(new Float32Array(MODEL_SAMPLE_RATE));
    this.latest = null; // warm-up posteriors are not evidence
    this.setState("ready", tf.getBackend());
  }

  /** Tap a running audio graph; starts the periodic inference loop. */
  async attach(ctx: AudioContext, source: AudioNode) {
    this.detach();
    const { ring, dispose } = await attachCapture(ctx, source);
    this.ring = ring;
    this.capture = { dispose };
    this.timer = window.setInterval(() => void this.runOnRing(), RUN_INTERVAL_MS);
  }

  detach() {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.capture?.dispose();
    this.capture = null;
    this.ring = null;
    this.latest = null;
  }

  private async runOnRing() {
    const ring = this.ring;
    if (!ring || this.state !== "ready" || this.busy) return;
    // Wait for at least a second of real audio before trusting the window.
    if (ring.total < MODEL_SAMPLE_RATE) return;
    const slice = new Float32Array(WINDOW_SAMPLES);
    ring.readLatest(slice);
    await this.infer(slice);
  }

  /**
   * Run the model over one audio slice (22050 Hz mono) and keep the note
   * posteriors as the current result. Also used directly by the dev hook,
   * which has no microphone.
   */
  async infer(slice: Float32Array): Promise<number[][] | null> {
    const bp = this.bp;
    const tf = this.tf;
    if (!bp || !tf) return null;
    if (this.busy) return null;
    this.busy = true;
    const collected: number[][] = [];
    try {
      // The library leaves intermediate tensors alive; scope them so the
      // periodic runs do not leak GPU memory.
      tf.engine().startScope();
      await bp.evaluateModel(
        slice,
        (frames) => {
          collected.push(...frames);
        },
        () => undefined,
      );
    } finally {
      tf.engine().endScope();
      this.busy = false;
    }
    this.latest = { frames: collected, wallTime: performance.now() };
    return collected;
  }

  /**
   * Reduce the newest posteriors to evidence for the expected tones.
   * Returns null when no fresh result exists (caller falls back to the
   * spectral comb).
   */
  evidenceFor(midis: number[], windowMs = 500): ChordEvidence[] | null {
    const res = this.latest;
    if (!res || res.frames.length === 0) return null;
    if (performance.now() - res.wallTime > STALE_MS) return null;
    return posteriorsToEvidence(res.frames, midis, windowMs);
  }
}

/**
 * Max note posterior per expected pitch over the trailing window of frames.
 * Posterior index 0 is A0 (MIDI 21); pitches outside the 88 keys score 0.
 * ML evidence is never degenerate — the model separates octaves by timbre.
 */
export function posteriorsToEvidence(
  frames: number[][],
  midis: number[],
  windowMs: number,
): ChordEvidence[] {
  const framesWanted = Math.ceil((windowMs / 1000) * (MODEL_SAMPLE_RATE / FFT_HOP));
  const from = Math.max(0, frames.length - framesWanted);
  return midis.map((midi) => {
    const idx = midi - LOWEST_MIDI;
    let best = 0;
    if (idx >= 0 && idx < 88) {
      for (let t = from; t < frames.length; t++) {
        const v = frames[t][idx];
        if (v > best) best = v;
      }
    }
    return { midi, evidence: best, degenerate: false };
  });
}
