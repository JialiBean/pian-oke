export interface NoteEvent {
  /** Position in the playable-event list (0-based). */
  index: number;
  /** How many cursor.next() steps from reset reach this event. */
  stepIndex: number;
  /** MIDI numbers expected at this event (2+ entries = double stop). */
  midis: number[];
  /** Display names matching midis, e.g. ["A4", "E5"]. */
  names: string[];
  /** 1-based measure number for display. */
  measure: number;
  /** Musical position from the score start, in whole-note units. */
  timestamp: number;
  /** Sounding length for playback, in whole-note units. */
  duration: number;
  /** OSMD source Note objects, used to color noteheads. */
  sourceNotes: unknown[];
}

export type EventResult = "pending" | "correct" | "corrected" | "skipped";
