export const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

export function freqToMidiFloat(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function midiToName(midi: number): string {
  const m = Math.round(midi);
  const name = NOTE_NAMES[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${name}${octave}`;
}

export interface PitchReading {
  freq: number;
  midiFloat: number;
  midi: number;
  cents: number;
  clarity: number;
  rms: number;
}

export function toReading(
  freq: number,
  clarity: number,
  rms: number,
  a4 = 440,
): PitchReading {
  const midiFloat = freqToMidiFloat(freq, a4);
  const midi = Math.round(midiFloat);
  return { freq, midiFloat, midi, cents: (midiFloat - midi) * 100, clarity, rms };
}
