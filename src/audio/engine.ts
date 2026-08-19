import { PitchDetector } from "./pitch";
import { toReading, type PitchReading } from "./noteUtils";
import { verifyChord, type ChordEvidence } from "./chordVerify";
import { MlEar, type MlEarState } from "./mlEar";

export interface AudioFrame {
  time: number;
  rms: number;
  reading: PitchReading | null;
  /**
   * Per-expected-pitch spectral evidence, present only while a chord
   * verification consumer has registered targets via setChordTargets().
   */
  chord?: ChordEvidence[] | null;
}

/**
 * Owns the microphone stream and produces ~60 analysis frames per second.
 * Echo cancellation, noise suppression and auto gain are disabled — they are
 * tuned for speech and mangle bowed-string signals.
 */
export class AudioEngine {
  a4 = 440;
  running = false;
  /** Detection range, set per instrument mode before start(). */
  minFreq = 150;
  maxFreq = 3200;
  onFrame?: (frame: AudioFrame) => void;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private buf: Float32Array | null = null;
  private detector: PitchDetector | null = null;
  private raf = 0;
  // Chord verification taps a second, longer analyser (8192-sample FFT for
  // ~5.9 Hz bins at 48 kHz) so the monophonic path keeps its 4096 window.
  private freqAnalyser: AnalyserNode | null = null;
  private freqBuf: Float32Array | null = null;
  private chordTargets: number[] | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  // ML ear (Basic Pitch): created lazily, model kept loaded across restarts.
  private ml: MlEar | null = null;
  private chordEarMode: "spectral" | "ml" = "spectral";
  onMlState?: (state: MlEarState, detail: string) => void;

  /**
   * Register the chord tones (MIDI numbers) frames should carry evidence
   * for; null or empty disengages. Cheap to call every time the expected
   * event changes — the spectrum is only analysed while targets are set.
   */
  setChordTargets(midis: number[] | null) {
    this.chordTargets = midis && midis.length > 0 ? [...midis] : null;
  }

  /**
   * Choose the polyphonic evidence source. "ml" preloads Basic Pitch and
   * taps the mic stream; while the model is loading (or its result is
   * stale) frames silently carry spectral-comb evidence instead.
   */
  setChordEar(mode: "spectral" | "ml") {
    if (mode === this.chordEarMode) return;
    this.chordEarMode = mode;
    if (mode === "ml") {
      void this.ensureMl().load();
      if (this.running && this.ctx && this.source) {
        void this.ml!.attach(this.ctx, this.source);
      }
    } else {
      this.ml?.detach();
    }
  }

  /** The ML ear instance (created on demand) — also used by dev hooks. */
  ensureMl(): MlEar {
    if (!this.ml) {
      this.ml = new MlEar();
      this.ml.onState = (s, d) => this.onMlState?.(s, d);
    }
    return this.ml;
  }

  /** List available microphones (labels appear once permission is granted). */
  async listInputs(): Promise<Array<{ deviceId: string; label: string }>> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === "audioinput")
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
    } catch {
      return [];
    }
  }

  async start(deviceId?: string): Promise<void> {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.source = source;
    if (this.chordEarMode === "ml") {
      const ml = this.ensureMl();
      void ml.load();
      void ml.attach(this.ctx, source);
    }
    this.analyser = this.ctx.createAnalyser();
    // 4096 samples (~85 ms at 48 kHz) so low notes get enough periods.
    this.analyser.fftSize = 4096;
    source.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.freqAnalyser = this.ctx.createAnalyser();
    this.freqAnalyser.fftSize = 8192;
    // Faster than the 0.8 default so fresh attacks show up within a frame
    // or two; the follower's rolling window absorbs the remaining jitter.
    this.freqAnalyser.smoothingTimeConstant = 0.55;
    source.connect(this.freqAnalyser);
    this.freqBuf = new Float32Array(this.freqAnalyser.frequencyBinCount);
    this.detector = new PitchDetector(this.ctx.sampleRate, this.minFreq, this.maxFreq);
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.tick();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private tick() {
    const analyser = this.analyser;
    const buf = this.buf;
    if (!analyser || !buf) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    let reading: PitchReading | null = null;
    if (rms > 0.0012) {
      const est = this.detector!.detect(buf);
      if (est && est.clarity >= 0.6) {
        reading = toReading(est.freq, est.clarity, rms, this.a4);
      }
    }
    let chord: ChordEvidence[] | null = null;
    const targets = this.chordTargets;
    if (targets && this.freqAnalyser && this.freqBuf && this.ctx) {
      if (this.chordEarMode === "ml" && this.ml?.state === "ready") {
        chord = this.ml.evidenceFor(targets);
      }
      if (!chord) {
        // Spectral comb: primary in "spectral" mode, fallback while the
        // model loads or its latest result has gone stale.
        this.freqAnalyser.getFloatFrequencyData(this.freqBuf);
        chord = verifyChord(this.freqBuf, targets, {
          sampleRate: this.ctx.sampleRate,
          fftSize: this.freqAnalyser.fftSize,
          a4: this.a4,
        });
      }
    }
    this.onFrame?.({ time: performance.now(), rms, reading, chord });
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ml?.detach();
    this.source = null;
    this.ctx = null;
    this.analyser = null;
    this.detector = null;
    this.buf = null;
    this.freqAnalyser = null;
    this.freqBuf = null;
  }
}
