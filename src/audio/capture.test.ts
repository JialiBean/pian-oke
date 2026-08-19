import { describe, expect, it } from "vitest";
import { CaptureRing, MODEL_SAMPLE_RATE } from "./capture";

const IN_RATE = 48000;

function sine(freq: number, n: number, rate: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

describe("CaptureRing (stream resampler)", () => {
  it("converts the sample count by the rate ratio", () => {
    const ring = new CaptureRing(IN_RATE);
    ring.push(new Float32Array(48000));
    expect(ring.total).toBeGreaterThanOrEqual(22049);
    expect(ring.total).toBeLessThanOrEqual(22051);
  });

  it("preserves a sine within interpolation error", () => {
    const ring = new CaptureRing(IN_RATE);
    ring.push(sine(440, 48000, IN_RATE));
    const got = new Float32Array(22000);
    ring.readLatest(got);
    // Compare against a directly synthesized 22050 Hz sine over the same
    // stretch of signal time: the ring's newest sample corresponds to input
    // time total/outRate.
    const endTime = ring.total / MODEL_SAMPLE_RATE;
    let err = 0;
    for (let i = 0; i < got.length; i++) {
      const t = endTime - (got.length - i) / MODEL_SAMPLE_RATE;
      err += (got[i] - Math.sin(2 * Math.PI * 440 * t)) ** 2;
    }
    expect(Math.sqrt(err / got.length)).toBeLessThan(0.02);
  });

  it("is invariant to push chunk size (no seams at block edges)", () => {
    const src = sine(523.25, 12800, IN_RATE);
    const one = new CaptureRing(IN_RATE);
    one.push(src);
    const many = new CaptureRing(IN_RATE);
    for (let i = 0; i < src.length; i += 128) {
      many.push(src.subarray(i, i + 128));
    }
    expect(many.total).toBe(one.total);
    const a = new Float32Array(5000);
    const b = new Float32Array(5000);
    one.readLatest(a);
    many.readLatest(b);
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-6);
    }
  });

  it("zero-pads on the left when asked for more than captured", () => {
    const ring = new CaptureRing(IN_RATE);
    ring.push(new Float32Array(480).fill(0.5));
    const out = new Float32Array(1000);
    const real = ring.readLatest(out);
    expect(real).toBeLessThan(1000);
    expect(out[0]).toBe(0);
    expect(out[999]).toBeCloseTo(0.5, 5);
  });
});
