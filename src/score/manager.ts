import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { midiToName } from "../audio/noteUtils";
import type { NoteEvent } from "./types";

const DEFAULT_COLOR = "#000000";

/**
 * Wraps OpenSheetMusicDisplay: loads MusicXML, extracts the playable note
 * sequence, moves the cursor, and colors noteheads. OSMD internals are
 * accessed defensively (any-typed) because they are not fully typed as a
 * public API.
 */
export class ScoreManager {
  osmd: OpenSheetMusicDisplay | null = null;
  events: NoteEvent[] = [];
  title = "";
  tempoBpm = 100;

  private container: HTMLElement | null = null;
  private currentStep = 0;
  private currentEventIndex = 0;
  private colors: Array<string | null> = [];
  private gmap: Map<unknown, any> | null = null;
  private resizeTimer = 0;

  attach(container: HTMLElement) {
    container.replaceChildren(); // drop any stale render from a prior mount
    this.container = container;
    window.addEventListener("resize", this.onResize);
  }

  dispose() {
    window.removeEventListener("resize", this.onResize);
  }

  private onResize = () => {
    if (!this.osmd || this.events.length === 0) return;
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.rerender(), 250);
  };

  async load(content: string | Document): Promise<void> {
    if (!this.container) throw new Error("Score container is not attached");
    if (!this.osmd) {
      this.osmd = new OpenSheetMusicDisplay(this.container, {
        autoResize: false,
        backend: "svg",
        drawTitle: true,
        followCursor: false,
      });
    }
    await this.osmd.load(content as any);
    this.osmd.render();
    this.gmap = null;
    this.title = this.readTitle();
    try {
      const bpm = Number((this.osmd as any)?.Sheet?.DefaultStartTempoInBpm);
      this.tempoBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 100;
    } catch {
      this.tempoBpm = 100;
    }
    this.extract();
    this.colors = this.events.map(() => null);
    this.currentEventIndex = 0;
    const cursor: any = this.osmd.cursor;
    cursor.reset();
    this.currentStep = 0;
    this.moveCursorToEvent(0);
  }

  private readTitle(): string {
    try {
      return String((this.osmd as any)?.Sheet?.TitleString ?? "").trim();
    } catch {
      return "";
    }
  }

  private iter(): any {
    const cursor: any = this.osmd!.cursor;
    return cursor.Iterator ?? cursor.iterator;
  }

  private extract() {
    const cursor: any = this.osmd!.cursor;
    cursor.hide();
    cursor.reset();
    const events: NoteEvent[] = [];
    let step = 0;
    let guard = 0;
    while (!this.iter().EndReached && guard++ < 20000) {
      const it = this.iter();
      const entries: any[] = it.CurrentVoiceEntries ?? [];
      const midis: number[] = [];
      const sourceNotes: unknown[] = [];
      let noteLength = 0;
      for (const ve of entries) {
        const graceEntry = !!ve?.IsGrace;
        for (const note of ve?.Notes ?? []) {
          if (!note?.Pitch) continue; // unpitched
          // Rests with display-step/octave hints get a phantom Pitch in OSMD —
          // ask the note itself before trusting Pitch.
          if (typeof note.isRest === "function" && note.isRest()) continue;
          if (graceEntry || note.IsGraceNote) continue;
          const tie = note.NoteTie;
          if (tie && tie.StartNote !== note) continue; // tie continuation
          const midi = this.noteMidi(note);
          if (midi === null) continue;
          sourceNotes.push(note);
          if (!midis.includes(midi)) midis.push(midi);
          const len = Number(note.Length?.RealValue);
          if (Number.isFinite(len) && len > noteLength) noteLength = len;
        }
      }
      if (midis.length > 0) {
        midis.sort((x, y) => x - y);
        let timestamp = Number(
          it.CurrentSourceTimestamp?.RealValue ?? it.currentTimeStamp?.RealValue,
        );
        if (!Number.isFinite(timestamp)) timestamp = step * 0.25;
        events.push({
          index: events.length,
          stepIndex: step,
          midis,
          names: midis.map(midiToName),
          measure: Number(it.CurrentMeasureIndex ?? 0) + 1,
          timestamp,
          duration: noteLength > 0 ? noteLength : 0.25,
          sourceNotes,
        });
      }
      cursor.next();
      step++;
    }
    // Clamp each duration to the gap to the next event so rests stay silent
    // and overlapping reads can't smear together.
    for (let i = 0; i < events.length - 1; i++) {
      const gap = events[i + 1].timestamp - events[i].timestamp;
      if (gap > 0) events[i].duration = Math.min(events[i].duration, gap);
    }
    this.events = events;
  }

  private noteMidi(note: any): number | null {
    try {
      const p = note.Pitch;
      const f = p?.Frequency;
      if (typeof f === "number" && f > 0) {
        return Math.round(69 + 12 * Math.log2(f / 440));
      }
      if (typeof p?.getHalfTone === "function") return p.getHalfTone() + 12;
      if (typeof note.halfTone === "number") return note.halfTone + 12;
    } catch {
      // fall through
    }
    return null;
  }

  moveCursorToEvent(i: number) {
    const osmd = this.osmd;
    if (!osmd || this.events.length === 0) return;
    const cursor: any = osmd.cursor;
    this.currentEventIndex = i;
    if (i >= this.events.length) {
      cursor.hide();
      return;
    }
    const target = this.events[i].stepIndex;
    cursor.hide();
    if (target < this.currentStep) {
      cursor.reset();
      this.currentStep = 0;
    }
    while (this.currentStep < target) {
      cursor.next();
      this.currentStep++;
    }
    cursor.show();
    this.scrollToCursor();
  }

  private scrollToCursor() {
    try {
      const el: HTMLElement | undefined = (this.osmd as any)?.cursor
        ?.cursorElement;
      el?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    } catch {
      // scrolling is best-effort
    }
  }

  /** Persistently color an event's noteheads (null restores default black). */
  colorEvent(i: number, color: string | null) {
    const event = this.events[i];
    if (!event) return;
    this.colors[i] = color;
    this.applyColor(event, color ?? DEFAULT_COLOR);
  }

  /** Temporarily color an event without recording it (e.g. red flash). */
  flashEvent(i: number, color: string) {
    const event = this.events[i];
    if (!event) return;
    this.applyColor(event, color);
  }

  /** Restore an event to its recorded persistent color. */
  restoreEvent(i: number) {
    const event = this.events[i];
    if (!event) return;
    this.applyColor(event, this.colors[i] ?? DEFAULT_COLOR);
  }

  private applyColor(event: NoteEvent, color: string) {
    for (const sn of event.sourceNotes) {
      const gn = this.graphicalNote(sn);
      const el: SVGGElement | undefined = gn?.getSVGGElement?.();
      if (!el) continue;
      el.querySelectorAll("path").forEach((p) => {
        p.setAttribute("fill", color);
        p.setAttribute("stroke", color);
      });
    }
  }

  private graphicalNote(sourceNote: unknown): any {
    if (!this.gmap) this.buildGmap();
    return this.gmap!.get(sourceNote);
  }

  private buildGmap() {
    this.gmap = new Map();
    try {
      const sheet: any = (this.osmd as any)?.GraphicSheet;
      const measureList: any[][] = sheet?.MeasureList ?? [];
      for (const row of measureList) {
        for (const gm of row ?? []) {
          for (const se of gm?.staffEntries ?? []) {
            for (const gve of se?.graphicalVoiceEntries ?? []) {
              for (const gn of gve?.notes ?? []) {
                const sn = gn?.sourceNote;
                if (sn) this.gmap.set(sn, gn);
              }
            }
          }
        }
      }
    } catch {
      // leave whatever was collected
    }
  }

  /** Re-render (after zoom/resize) and restore colors + cursor position. */
  rerender() {
    const osmd = this.osmd;
    if (!osmd) return;
    osmd.render();
    this.gmap = null;
    this.events.forEach((event, i) => {
      const c = this.colors[i];
      if (c) this.applyColor(event, c);
    });
    const cursor: any = osmd.cursor;
    cursor.hide();
    cursor.reset();
    this.currentStep = 0;
    if (this.currentEventIndex < this.events.length) {
      const target = this.events[this.currentEventIndex].stepIndex;
      while (this.currentStep < target) {
        cursor.next();
        this.currentStep++;
      }
      cursor.show();
    }
  }

  setZoom(delta: number) {
    const osmd: any = this.osmd;
    if (!osmd) return;
    const z = Math.min(2, Math.max(0.5, (osmd.Zoom ?? 1) + delta));
    osmd.Zoom = z;
    this.rerender();
  }

  /** Clear all coloring and put the cursor back at the first note. */
  resetProgress() {
    this.colors = this.events.map(() => null);
    this.currentEventIndex = 0;
    this.rerender();
    this.scrollToCursor();
  }
}
