// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  correctDirectionText,
  ensureTitle,
  extractXml,
  parsePage,
  sanitizeOmrXml,
  stitchPages,
} from "./stitch";

function pageXml(measures: string[], startNumber = 1): string {
  const body = measures
    .map((notes, i) => `<measure number="${startNumber + i}">${notes}</measure>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1">${body}</part>
</score-partwise>`;
}

const ATTRS =
  "<attributes><divisions>1</divisions><key><fifths>0</fifths></key>" +
  "<time><beats>4</beats><beat-type>4</beat-type></time>" +
  "<clef><sign>G</sign><line>2</line></clef></attributes>";
const NOTE =
  "<note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>";

describe("extractXml", () => {
  it("strips markdown fences and surrounding prose", () => {
    const xml = pageXml([ATTRS + NOTE]);
    const wrapped = "Here is the transcription:\n```xml\n" + xml + "\n```\nLet me know!";
    expect(extractXml(wrapped)).toContain("<score-partwise");
    expect(extractXml(wrapped)).not.toContain("```");
    expect(extractXml(wrapped).endsWith("</score-partwise>")).toBe(true);
  });

  it("passes through a clean document", () => {
    const xml = pageXml([ATTRS + NOTE]);
    expect(extractXml(xml)).toBe(xml);
  });

  it("throws when no MusicXML is present", () => {
    expect(() => extractXml("Sorry, I cannot read this page.")).toThrow(/score-partwise/);
  });
});

describe("parsePage", () => {
  it("accepts a valid page and counts measures and notes", () => {
    const page = parsePage(pageXml([ATTRS + NOTE, NOTE + NOTE]));
    expect(page.measures).toHaveLength(2);
    expect(page.noteCount).toBe(3);
  });

  it("rejects malformed XML", () => {
    expect(() => parsePage("<score-partwise><part><measure>")).toThrow();
  });

  it("rejects documents without pitched notes", () => {
    const rests = pageXml(["<note><rest/><duration>4</duration></note>"]);
    expect(() => parsePage(rests)).toThrow(/pitched/);
  });

  it("rejects the wrong root element", () => {
    expect(() => parsePage("<score-timewise><part/></score-timewise>")).toThrow(/Root element/);
  });
});

describe("sanitizeOmrXml", () => {
  it("removes zero divisions (Audiveris mini-system defect)", () => {
    const xml = pageXml([
      "<attributes><divisions>0</divisions></attributes><note><rest measure=\"yes\"/><duration>1</duration></note>",
    ]);
    const out = sanitizeOmrXml(xml);
    expect(out).not.toContain("<divisions>0</divisions>");
    expect(out).toContain("<attributes");
  });

  it("keeps valid divisions untouched", () => {
    const xml = pageXml([ATTRS + NOTE]);
    expect(sanitizeOmrXml(xml)).toBe(xml);
  });

  it("passes through unparseable input unchanged", () => {
    expect(sanitizeOmrXml("<broken")).toBe("<broken");
  });

  it("drops accent-row OCR noise but keeps real direction text", () => {
    const xml = pageXml([
      ATTRS +
        '<direction><direction-type><words>AAAA</words></direction-type></direction>' +
        '<direction><direction-type><words>sostenuto</words></direction-type></direction>' +
        NOTE,
    ]);
    const out = sanitizeOmrXml(xml);
    expect(out).not.toContain("AAAA");
    expect(out).toContain("sostenuto");
  });

  it("snaps garbled OCR direction text to real musical terms", () => {
    const xml = pageXml([
      ATTRS +
        '<direction><direction-type><words>cresc. [JOCO CZPOCO</words></direction-type></direction>' +
        '<direction><direction-type><words>cresc. pOCO (lpOCO</words></direction-type></direction>' +
        '<direction><direction-type><words>xqzt wvvv</words></direction-type></direction>' +
        NOTE,
    ]);
    const out = sanitizeOmrXml(xml);
    expect(out).not.toContain("CZPOCO");
    expect(out).not.toContain("lpOCO");
    expect(out).not.toContain("xqzt");
    expect(out.match(/cresc\. poco a poco/g)).toHaveLength(2);
  });
});

describe("sanitizeOmrXml direction layout", () => {
  it("strips absolute offsets and anchors directions below the staff", () => {
    const xml = pageXml([
      ATTRS +
        '<direction placement="above"><direction-type><dynamics default-x="312" default-y="-80"><mf/></dynamics></direction-type></direction>' +
        NOTE,
    ]);
    const out = sanitizeOmrXml(xml);
    expect(out).not.toContain("default-x");
    expect(out).not.toContain("default-y");
    expect(out).toContain('placement="below"');
    expect(out).toContain("<mf/>");
  });

  it("drops OCR'd credit blocks and titles so the file name can take over", () => {
    const xml = pageXml([ATTRS + NOTE]).replace(
      '<score-partwise version="3.1">',
      '<score-partwise version="3.1">' +
        "<movement-title>Sheet music may be purchased at example.com</movement-title>" +
        "<credit><credit-words>DO NOT COPY</credit-words></credit>",
    );
    const out = sanitizeOmrXml(xml);
    expect(out).not.toContain("movement-title");
    expect(out).not.toContain("credit");
    expect(out).toContain("<note");
  });

  it("strips display hints from rests (phantom-note trigger)", () => {
    const xml = pageXml([
      ATTRS +
        "<note><rest><display-step>B</display-step><display-octave>4</display-octave></rest><duration>4</duration><type>quarter</type></note>" +
        NOTE,
    ]);
    const out = sanitizeOmrXml(xml);
    expect(out).not.toContain("display-step");
    expect(out).not.toContain("display-octave");
    expect(out).toContain("<rest/>");
  });

  it("removes orphaned wedge stops", () => {
    const xml = pageXml([
      ATTRS +
        '<direction><direction-type><wedge type="stop"/></direction-type></direction>' +
        NOTE,
    ]);
    expect(sanitizeOmrXml(xml)).not.toContain("wedge");
  });

  it("closes an unterminated crescendo within two measures", () => {
    const xml = pageXml([
      ATTRS +
        '<direction><direction-type><wedge type="crescendo"/></direction-type></direction>' +
        NOTE,
      NOTE,
      NOTE,
      NOTE,
    ]);
    const out = sanitizeOmrXml(xml);
    const starts = (out.match(/wedge type="crescendo"/g) ?? []).length;
    const stops = (out.match(/wedge type="stop"/g) ?? []).length;
    expect(starts).toBe(1);
    expect(stops).toBe(1);
    // The stop lands at the start of the measure two after the crescendo.
    expect(out.indexOf('type="stop"')).toBeLessThan(out.length);
  });

  it("keeps well-paired wedges untouched in count", () => {
    const xml = pageXml([
      ATTRS +
        '<direction><direction-type><wedge type="crescendo"/></direction-type></direction>' +
        NOTE +
        '<direction><direction-type><wedge type="stop"/></direction-type></direction>',
    ]);
    const out = sanitizeOmrXml(xml);
    expect((out.match(/wedge type="crescendo"/g) ?? []).length).toBe(1);
    expect((out.match(/wedge type="stop"/g) ?? []).length).toBe(1);
  });
});

describe("ensureTitle", () => {
  it("inserts a work-title when none exists", () => {
    const out = ensureTitle(pageXml([ATTRS + NOTE]), "Kintsugi");
    expect(out).toContain("<work-title>Kintsugi</work-title>");
    expect(out.indexOf("<work>")).toBeLessThan(out.indexOf("<part-list>"));
  });

  it("replaces placeholder titles", () => {
    const xml = pageXml([ATTRS + NOTE]).replace(
      "<score-partwise version=\"3.1\">",
      "<score-partwise version=\"3.1\"><movement-title>Untitled score</movement-title>",
    );
    const out = ensureTitle(xml, "Kintsugi");
    expect(out).toContain("<movement-title>Kintsugi</movement-title>");
  });

  it("keeps a real existing title", () => {
    const xml = `<score-partwise version="3.1"><work><work-title>Ode to Joy</work-title></work><part-list><score-part id="P1"/></part-list><part id="P1"/></score-partwise>`;
    expect(ensureTitle(xml, "some-file-name")).toContain("Ode to Joy");
  });
});

describe("correctDirectionText", () => {
  it("keeps exact terms unchanged", () => {
    expect(correctDirectionText("sostenuto")).toBe("sostenuto");
    expect(correctDirectionText("dolce")).toBe("dolce");
  });
  it("rejects text that matches nothing", () => {
    expect(correctDirectionText("AAAA")).toBeNull();
    expect(correctDirectionText("qwxz 123")).toBeNull();
  });
});

describe("stitchPages", () => {
  it("appends later pages and renumbers measures sequentially", () => {
    const page1 = pageXml([ATTRS + NOTE, NOTE], 1);
    const page2 = pageXml([ATTRS + NOTE, NOTE, NOTE], 7); // wrong numbering on purpose
    const merged = stitchPages([page1, page2]);
    const doc = new DOMParser().parseFromString(merged, "application/xml");
    const measures = Array.from(doc.getElementsByTagName("measure"));
    expect(measures).toHaveLength(5);
    expect(measures.map((m) => m.getAttribute("number"))).toEqual(["1", "2", "3", "4", "5"]);
    // Each page's attributes survive the merge (divisions restated mid-score is valid MusicXML).
    expect(doc.getElementsByTagName("divisions")).toHaveLength(2);
  });

  it("returns a single page unchanged in structure", () => {
    const merged = stitchPages([pageXml([ATTRS + NOTE])]);
    expect(merged).toContain("<score-partwise");
    expect(merged).toContain("</score-partwise>");
  });
});
