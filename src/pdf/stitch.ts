/**
 * Utilities for cleaning, validating, and combining per-page MusicXML
 * documents produced by the transcription model.
 */

export function extractXml(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:xml)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const declStart = s.indexOf("<?xml");
  const rootStart = s.indexOf("<score-partwise");
  const start = declStart >= 0 && declStart < rootStart ? declStart : rootStart;
  const endTag = "</score-partwise>";
  const end = s.lastIndexOf(endTag);
  if (rootStart < 0 || end < 0) {
    throw new Error("No <score-partwise> MusicXML document found in the response");
  }
  return s.slice(start, end + endTag.length);
}

export interface ParsedPage {
  doc: Document;
  measures: Element[];
  noteCount: number;
}

export function parsePage(xml: string): ParsedPage {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const parseError = doc.getElementsByTagName("parsererror")[0];
  if (parseError) {
    throw new Error(`XML parse error: ${(parseError.textContent ?? "unknown").slice(0, 300)}`);
  }
  const root = doc.documentElement;
  if (root.tagName !== "score-partwise") {
    throw new Error(`Root element is <${root.tagName}>, expected <score-partwise>`);
  }
  const part = root.getElementsByTagName("part")[0];
  if (!part) throw new Error("No <part> element found");
  const measures = Array.from(part.children).filter((c) => c.tagName === "measure");
  if (measures.length === 0) throw new Error("No measures found in the part");
  const noteCount = part.getElementsByTagName("pitch").length;
  if (noteCount === 0) throw new Error("No pitched notes found");
  return { doc, measures, noteCount };
}

/**
 * Make sure a MusicXML document carries a real title (renderers show
 * "Untitled Score" otherwise — OMR exports usually have none). Inserts or
 * replaces the title only when it's missing or a placeholder.
 */
export function ensureTitle(xml: string, title: string): string {
  if (!title.trim()) return xml;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror")[0]) return xml;
  const root = doc.documentElement;
  if (root.tagName !== "score-partwise") return xml;
  const movement = root.getElementsByTagName("movement-title")[0];
  const workTitle = root.getElementsByTagName("work-title")[0];
  const existing = (workTitle?.textContent ?? movement?.textContent ?? "").trim();
  if (existing && !/untitled/i.test(existing)) return xml;
  if (workTitle) {
    workTitle.textContent = title;
  } else if (movement) {
    movement.textContent = title;
  } else {
    const work = doc.createElement("work");
    const wt = doc.createElement("work-title");
    wt.textContent = title;
    work.appendChild(wt);
    root.insertBefore(work, root.firstChild);
  }
  return new XMLSerializer().serializeToString(doc);
}

/** Canonical musical direction terms used to repair OCR'd text. */
const DIRECTION_PHRASES = [
  "cresc. poco a poco",
  "poco a poco cresc.",
  "cresc.",
  "crescendo",
  "decresc.",
  "decrescendo",
  "dim.",
  "diminuendo",
  "sostenuto",
  "dolce",
  "espressivo",
  "legato",
  "marcato",
  "cantabile",
  "tranquillo",
  "rit.",
  "ritard.",
  "ritenuto",
  "rall.",
  "rallentando",
  "accel.",
  "accelerando",
  "a tempo",
  "molto",
  "poco",
  "pizz.",
  "arco",
  "con sordino",
  "senza sordino",
  "sul ponticello",
  "sul tasto",
  "andante",
  "adagio",
  "allegro",
  "allegretto",
  "moderato",
  "vivace",
  "largo",
  "lento",
  "presto",
];

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Uint16Array(b.length + 1);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

/**
 * Snap OCR'd direction text to the closest known musical term, or return
 * null when nothing is close enough (drop garbage rather than render it).
 */
export function correctDirectionText(text: string): string | null {
  const norm = text
    .toLowerCase()
    .replace(/[^a-z. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return null;
  let best: string | null = null;
  let bestSim = 0;
  for (const phrase of DIRECTION_PHRASES) {
    const sim = 1 - levenshtein(norm, phrase) / Math.max(norm.length, phrase.length);
    if (sim > bestSim) {
      bestSim = sim;
      best = phrase;
    }
  }
  return bestSim >= 0.55 ? best : null;
}

/**
 * Repair known defects in OMR (Audiveris) MusicXML output that break score
 * renderers. Currently: `<divisions>0</divisions>` (seen on barely-detected
 * mini-systems), which causes a division by zero downstream — removing the
 * element makes the measure inherit the previous valid divisions.
 */
export function sanitizeOmrXml(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror")[0]) return xml;
  let changed = false;
  for (const div of Array.from(doc.getElementsByTagName("divisions"))) {
    if (!(Number(div.textContent) > 0)) {
      div.remove();
      changed = true;
    }
  }
  // OMR titles and credit blocks are OCR'd page text ("DO NOT COPY…",
  // purchase links) far more often than real titles — drop them all and let
  // the importer set a trustworthy title (the file name) instead.
  for (const tag of ["credit", "movement-title", "work"]) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      el.remove();
      changed = true;
    }
  }

  // Rests sometimes carry display-step/display-octave placement hints, which
  // some renderers mis-parse into phantom pitched notes. The hints are purely
  // cosmetic — drop them.
  for (const rest of Array.from(doc.getElementsByTagName("rest"))) {
    for (const tag of ["display-step", "display-octave"]) {
      for (const el of Array.from(rest.getElementsByTagName(tag))) {
        el.remove();
        changed = true;
      }
    }
  }

  // OCR text is unreliable on engraving fonts: snap each <words> direction to
  // the closest known musical term, and drop anything that matches nothing
  // (accent rows read as "AAAA", stray glyph garbage) — never render fake words.
  for (const words of Array.from(doc.getElementsByTagName("words"))) {
    const text = (words.textContent ?? "").trim();
    const corrected = correctDirectionText(text);
    if (corrected === null) {
      let direction: Element | null = words;
      while (direction && direction.tagName !== "direction") {
        direction = direction.parentElement;
      }
      (direction ?? words).remove();
      changed = true;
    } else if (corrected !== text) {
      words.textContent = corrected;
      changed = true;
    }
  }

  // OMR stamps directions with absolute pixel offsets from its own analysis;
  // renderers half-honor them, which is what makes dynamics float in odd
  // places. Strip the offsets and anchor dynamics below the staff so the
  // renderer lays them out cleanly at their musical positions.
  const OFFSET_ATTRS = ["default-x", "default-y", "relative-x", "relative-y"];
  const stripOffsets = (el: Element) => {
    for (const attr of OFFSET_ATTRS) {
      if (el.hasAttribute(attr)) {
        el.removeAttribute(attr);
        changed = true;
      }
    }
    for (const child of Array.from(el.children)) stripOffsets(child);
  };
  for (const direction of Array.from(doc.getElementsByTagName("direction"))) {
    stripOffsets(direction);
    if (direction.getAttribute("placement") !== "below") {
      direction.setAttribute("placement", "below");
      changed = true;
    }
  }

  // Repair hairpin (wedge) pairing: an orphaned start smears an endless
  // crescendo arrow across systems; an orphaned stop is garbage. Cap spans at
  // two measures (printed hairpins in this repertoire are short; long swells
  // are the "cresc. poco a poco" text, not a wedge).
  for (const part of Array.from(doc.getElementsByTagName("part"))) {
    const measures = Array.from(part.children).filter((c) => c.tagName === "measure");
    let openSince = -1;
    const mkStop = () => {
      const direction = doc.createElement("direction");
      direction.setAttribute("placement", "below");
      const dtype = doc.createElement("direction-type");
      const wedge = doc.createElement("wedge");
      wedge.setAttribute("type", "stop");
      dtype.appendChild(wedge);
      direction.appendChild(dtype);
      return direction;
    };
    measures.forEach((measure, mi) => {
      // Snapshot before any insertion so repair stops aren't re-scanned.
      const wedges = Array.from(measure.getElementsByTagName("wedge"));
      if (openSince >= 0 && mi - openSince >= 2) {
        measure.insertBefore(mkStop(), measure.firstChild);
        openSince = -1;
        changed = true;
      }
      for (const wedge of wedges) {
        const type = wedge.getAttribute("type");
        if (type === "crescendo" || type === "diminuendo") {
          if (openSince >= 0) {
            const direction = wedge.closest("direction");
            measure.insertBefore(mkStop(), direction ?? wedge);
            changed = true;
          }
          openSince = mi;
        } else if (type === "stop") {
          if (openSince < 0) {
            const direction = wedge.closest("direction");
            (direction ?? wedge).remove();
            changed = true;
          } else {
            openSince = -1;
          }
        }
      }
    });
    if (openSince >= 0 && measures.length > 0) {
      measures[measures.length - 1].appendChild(mkStop());
      changed = true;
    }
  }

  return changed ? new XMLSerializer().serializeToString(doc) : xml;
}

/**
 * Merge page documents into one score: page 1 is the base, later pages'
 * measures are appended to its first part, then all measures are renumbered
 * sequentially. Each page restates <attributes> (incl. divisions) in its
 * first measure, so appending across pages is safe.
 */
export function stitchPages(pageXmls: string[]): string {
  if (pageXmls.length === 0) throw new Error("No pages to combine");
  const pages = pageXmls.map(parsePage);
  const base = pages[0].doc;
  const basePart = base.documentElement.getElementsByTagName("part")[0];
  for (const page of pages.slice(1)) {
    for (const measure of page.measures) {
      basePart.appendChild(base.importNode(measure, true));
    }
  }
  Array.from(basePart.children)
    .filter((c) => c.tagName === "measure")
    .forEach((m, i) => m.setAttribute("number", String(i + 1)));
  return new XMLSerializer().serializeToString(base);
}
