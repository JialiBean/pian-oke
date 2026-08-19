import { useEffect, useRef, useState } from "react";
import { AudioEngine, type AudioFrame } from "./audio/engine";
import { midiToFreq, midiToName, toReading } from "./audio/noteUtils";
import { buildSchedule, PlaybackEngine, type InstrumentMode } from "./audio/playback";
import PdfImportDialog from "./pdf/PdfImportDialog";
import { ensureTitle } from "./pdf/stitch";
import { Follower } from "./score/follower";
import { ScoreManager } from "./score/manager";
import type { EventResult } from "./score/types";

const SAMPLES = [
  { id: "open-strings", label: "Open strings (G · D · A · E)" },
  { id: "d-major-scale", label: "D major scale" },
  { id: "twinkle", label: "Twinkle, Twinkle (A major)" },
  { id: "ode-to-joy", label: "Ode to Joy (D major)" },
];

const RESULT_COLORS: Record<EventResult, string | null> = {
  pending: null,
  correct: "#16a34a",
  corrected: "#d97706",
  skipped: "#94a3b8",
};
const WRONG_COLOR = "#dc2626";

const SENSITIVITY_RMS: Record<string, number> = {
  low: 0.009,
  med: 0.0035,
  high: 0.0015,
};

const MODES: Record<InstrumentMode, { name: string; minFreq: number; maxFreq: number }> = {
  violin: { name: "🎻 Violin-oke", minFreq: 150, maxFreq: 3200 },
  piano: { name: "🎹 Pian-oke", minFreq: 70, maxFreq: 4300 },
};

interface LibraryEntry {
  id: string;
  title: string;
}
const LIB_KEY = "jv-library";
const LAST_KEY = "jv-last-score";

function readLibrary(): LibraryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(LIB_KEY) ?? "[]") as LibraryEntry[];
  } catch {
    return [];
  }
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readScoreFile(file: File): Promise<string> {
  if (file.name.toLowerCase().endsWith(".mxl")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let s = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return s; // binary string starting with "PK": OSMD unzips it
  }
  return file.text();
}

function levelPercent(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

export default function App() {
  const sheetRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<ScoreManager | null>(null);
  const followerRef = useRef<Follower | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const playbackRef = useRef<PlaybackEngine | null>(null);

  const resultsRef = useRef<EventResult[]>([]);
  const startRef = useRef(-1);
  const flashTimer = useRef(0);
  const msgTimer = useRef(0);
  const a4Ref = useRef(440);
  const wrongCountRef = useRef(0);
  const progressKeyRef = useRef("");
  const showMistakesRef = useRef(false);

  const noteEl = useRef<HTMLDivElement>(null);
  const centsEl = useRef<HTMLDivElement>(null);
  const needleEl = useRef<HTMLDivElement>(null);
  const levelEl = useRef<HTMLDivElement>(null);
  const recentMidiRef = useRef<number[]>([]);

  const [scoreTitle, setScoreTitle] = useState("");
  const [eventCount, setEventCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [results, setResults] = useState<EventResult[]>([]);
  const [listening, setListening] = useState(false);
  const [finished, setFinished] = useState(false);
  const [elapsedS, setElapsedS] = useState(0);
  const [wrongCount, setWrongCount] = useState(0);
  const [wrongMsg, setWrongMsg] = useState("");
  const [error, setError] = useState("");
  const [loadingScore, setLoadingScore] = useState(false);
  const [sample, setSample] = useState(SAMPLES[0].id);
  const [library, setLibrary] = useState<LibraryEntry[]>(readLibrary);
  const [mode, setMode] = useState<InstrumentMode>(() => {
    try {
      return localStorage.getItem("jv-mode") === "piano" ? "piano" : "violin";
    } catch {
      return "violin";
    }
  });
  const [tolerance, setTolerance] = useState(50);
  const [a4, setA4] = useState(440);
  const [sensitivity, setSensitivity] = useState("med");
  const [showMistakes, setShowMistakes] = useState(() => {
    try {
      return localStorage.getItem("jv-show-mistakes") === "1";
    } catch {
      return false;
    }
  });
  const [fullChords, setFullChords] = useState(() => {
    try {
      return localStorage.getItem("jv-full-chords") === "1";
    } catch {
      return false;
    }
  });
  const [pdfImport, setPdfImport] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [tempoFactor, setTempoFactor] = useState(1);
  const [micInputs, setMicInputs] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [micDevice, setMicDevice] = useState(() => {
    try {
      return localStorage.getItem("jv-mic-device") ?? "";
    } catch {
      return "";
    }
  });

  function colorFor(result: EventResult): string | null {
    if (result === "pending") return null;
    if (result === "skipped") return RESULT_COLORS.skipped;
    // With mistake-marking off, every completed note is plain green.
    if (!showMistakesRef.current) return RESULT_COLORS.correct;
    return RESULT_COLORS[result];
  }

  function saveProgress() {
    const key = progressKeyRef.current;
    const follower = followerRef.current;
    if (!key || !follower || resultsRef.current.length === 0) return;
    try {
      const compact = resultsRef.current
        .map((r) => (r === "correct" ? "c" : r === "corrected" ? "x" : r === "skipped" ? "s" : "p"))
        .join("");
      localStorage.setItem(
        key,
        JSON.stringify({ r: compact, i: follower.index, w: wrongCountRef.current }),
      );
    } catch {
      // persistence is best-effort
    }
  }

  useEffect(() => {
    const manager = new ScoreManager();
    manager.attach(sheetRef.current!);
    managerRef.current = manager;

    const follower = new Follower({
      onMatched(i, firstTry) {
        const result: EventResult = firstTry ? "correct" : "corrected";
        resultsRef.current[i] = result;
        manager.colorEvent(i, colorFor(result));
        manager.moveCursorToEvent(i + 1);
        if (startRef.current < 0) startRef.current = performance.now();
        setResults([...resultsRef.current]);
        setCurrentIndex(i + 1);
        saveProgress();
      },
      onWrong(i, playedMidi) {
        wrongCountRef.current += 1;
        setWrongCount((c) => c + 1);
        setWrongMsg(`heard ${midiToName(playedMidi)}`);
        if (showMistakesRef.current) {
          manager.flashEvent(i, WRONG_COLOR);
          window.clearTimeout(flashTimer.current);
          flashTimer.current = window.setTimeout(() => manager.restoreEvent(i), 450);
        }
        window.clearTimeout(msgTimer.current);
        msgTimer.current = window.setTimeout(() => setWrongMsg(""), 1600);
      },
      onSkipped(i) {
        resultsRef.current[i] = "skipped";
        manager.colorEvent(i, RESULT_COLORS.skipped);
        manager.moveCursorToEvent(i + 1);
        setResults([...resultsRef.current]);
        setCurrentIndex(i + 1);
        saveProgress();
      },
      onFinished() {
        const start = startRef.current;
        setElapsedS(
          start > 0 ? Math.round((performance.now() - start) / 1000) : 0,
        );
        setFinished(true);
      },
    });
    followerRef.current = follower;

    const playback = new PlaybackEngine();
    playback.onTick = (i) => manager.moveCursorToEvent(i);
    playback.onEnd = () => {
      setPlaying(false);
      manager.moveCursorToEvent(follower.index);
    };
    playbackRef.current = playback;

    const audio = new AudioEngine();
    audio.onFrame = (frame: AudioFrame) => {
      const r = frame.reading;
      if (levelEl.current) {
        levelEl.current.style.width = `${levelPercent(frame.rms)}%`;
      }
      if (r && r.clarity >= 0.7) {
        // Median of the last 3 readings for the display only — kills the
        // one-frame flicker that percussive attacks (piano) cause. The
        // follower gets raw frames and applies its own hold logic.
        const recent = recentMidiRef.current;
        recent.push(r.midiFloat);
        if (recent.length > 3) recent.shift();
        const median = [...recent].sort((a, b) => a - b)[Math.floor((recent.length - 1) / 2)];
        const midi = Math.round(median);
        const cents = (median - midi) * 100;
        if (noteEl.current) noteEl.current.textContent = midiToName(midi);
        if (centsEl.current) {
          centsEl.current.textContent = `${cents >= 0 ? "+" : ""}${Math.round(cents)}¢`;
        }
        if (needleEl.current) {
          const c = Math.max(-50, Math.min(50, cents));
          needleEl.current.style.left = `${50 + c}%`;
          needleEl.current.style.opacity = "1";
        }
      } else {
        recentMidiRef.current.length = 0;
        if (noteEl.current) noteEl.current.textContent = "–";
        if (centsEl.current) centsEl.current.textContent = "";
        if (needleEl.current) needleEl.current.style.opacity = "0";
      }
      follower.feed(frame);
    };
    audioRef.current = audio;

    // Restore whatever was loaded last visit; fall back to the first sample.
    const last = localStorage.getItem(LAST_KEY);
    if (last?.startsWith("lib:") && localStorage.getItem(`jv-score:${last.slice(4)}`)) {
      loadLibraryScore(last.slice(4));
    } else if (last?.startsWith("sample:") && SAMPLES.some((s) => s.id === last.slice(7))) {
      void loadSampleById(last.slice(7));
    } else {
      void loadSampleById(SAMPLES[0].id);
    }

    return () => {
      audio.stop();
      playback.stop();
      manager.dispose();
      window.clearTimeout(flashTimer.current);
      window.clearTimeout(msgTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const f = followerRef.current;
    if (f) f.cfg.centsTol = tolerance;
  }, [tolerance]);
  useEffect(() => {
    const f = followerRef.current;
    if (f) f.cfg.rmsMin = SENSITIVITY_RMS[sensitivity] ?? 0.0035;
  }, [sensitivity]);
  useEffect(() => {
    a4Ref.current = a4;
    if (audioRef.current) audioRef.current.a4 = a4;
  }, [a4]);
  useEffect(() => {
    const engine = audioRef.current;
    const playback = playbackRef.current;
    if (engine) {
      engine.minFreq = MODES[mode].minFreq;
      engine.maxFreq = MODES[mode].maxFreq;
    }
    if (playback) playback.instrument = mode;
  }, [mode]);

  useEffect(() => {
    const f = followerRef.current;
    if (f) f.cfg.requireAllTones = fullChords && mode === "piano";
    try {
      localStorage.setItem("jv-full-chords", fullChords ? "1" : "0");
    } catch {
      // best-effort
    }
  }, [fullChords, mode]);

  // Tell the engine which chord to gather spectral evidence for: the current
  // event, whenever full-chord verification is in effect for it.
  useEffect(() => {
    const engine = audioRef.current;
    if (!engine) return;
    const event = managerRef.current?.events[currentIndex];
    const active = mode === "piano" && fullChords && event && event.midis.length >= 2;
    engine.setChordTargets(active ? event.midis : null);
  }, [currentIndex, fullChords, mode, eventCount, scoreTitle]);

  useEffect(() => {
    showMistakesRef.current = showMistakes;
    try {
      localStorage.setItem("jv-show-mistakes", showMistakes ? "1" : "0");
    } catch {
      // best-effort
    }
    // Recolor completed notes under the new palette.
    const manager = managerRef.current;
    if (manager) {
      resultsRef.current.forEach((r, i) => {
        if (r !== "pending") manager.colorEvent(i, colorFor(r));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMistakes]);

  function switchMode(next: InstrumentMode) {
    if (next === mode) return;
    setMode(next);
    try {
      localStorage.setItem("jv-mode", next);
    } catch {
      // best-effort
    }
    stopPlayback();
    if (listening) {
      // Re-open the mic so the detector picks up the new frequency range.
      stopListening();
      window.setTimeout(() => void startListening(), 50);
    }
  }

  // Dev-only hooks so the follow logic can be exercised without a violin.
  // Simulated frames carry per-tone chord evidence, so full-chord mode is
  // testable too: hit() supplies every written tone, partial() only the
  // first one (must NOT advance a 2+ note event when full chords is on).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const simulate = (correct: boolean, tones: "all" | "first" = "all") => {
      const follower = followerRef.current;
      if (!follower || follower.index >= follower.events.length) return;
      const event = follower.events[follower.index];
      const midi = correct ? event.midis[0] : event.midis[0] + 1;
      const freq = midiToFreq(midi, a4Ref.current);
      const t0 = performance.now();
      const silent = (t: number): AudioFrame => ({ time: t, rms: 0, reading: null });
      const loud = (t: number): AudioFrame => ({
        time: t,
        rms: 0.06,
        reading: toReading(freq, 0.97, 0.06, a4Ref.current),
        chord: event.midis.map((m, i) => ({
          midi: m,
          evidence: correct && (tones === "all" || i === 0) ? 0.9 : 0.05,
          degenerate: false,
        })),
      });
      follower.feed(silent(t0));
      follower.feed(silent(t0 + 60));
      const span = correct ? 240 : 340; // miss must outlast wrongMs to report
      for (let ms = 61; ms <= span; ms += 20) follower.feed(loud(t0 + ms));
    };
    (window as any).__jv = {
      hit: (n = 1) => {
        for (let k = 0; k < n; k++) simulate(true);
      },
      miss: () => simulate(false),
      partial: () => simulate(true, "first"),
      state: () => ({
        index: followerRef.current?.index,
        total: followerRef.current?.events.length,
        names: followerRef.current?.events.map((e) => e.names.join("+")),
      }),
    };
    return () => {
      delete (window as any).__jv;
    };
  }, []);

  function stopPlayback() {
    playbackRef.current?.stop();
    setPlaying(false);
  }

  function togglePlayback() {
    const manager = managerRef.current;
    const follower = followerRef.current;
    const playback = playbackRef.current;
    if (!manager || !follower || !playback) return;
    if (playing) {
      stopPlayback();
      manager.moveCursorToEvent(follower.index);
      return;
    }
    if (manager.events.length === 0) return;
    if (listening) stopListening();
    const from = Math.min(follower.index, manager.events.length - 1);
    playback.start(buildSchedule(manager.events, manager.tempoBpm, tempoFactor, a4), from);
    setPlaying(true);
  }

  async function applyScore(content: string, fallbackTitle: string, remember = true) {
    const manager = managerRef.current!;
    stopPlayback();
    setLoadingScore(true);
    setError("");
    try {
      if (content.includes("<score-partwise")) {
        content = ensureTitle(content, fallbackTitle);
      }
      await manager.load(content);
      const contentHash = await hashText(content);
      progressKeyRef.current = `jv-progress:${contentHash}`;
      setScoreTitle(manager.title || fallbackTitle);
      setEventCount(manager.events.length);
      setWrongMsg("");
      setElapsedS(0);
      startRef.current = -1;

      // Restore saved progress for this exact score content, if any.
      let restored = false;
      try {
        const saved = JSON.parse(localStorage.getItem(progressKeyRef.current) ?? "null");
        if (saved && typeof saved.r === "string" && saved.r.length === manager.events.length) {
          const map: Record<string, EventResult> = {
            c: "correct",
            x: "corrected",
            s: "skipped",
            p: "pending",
          };
          resultsRef.current = [...(saved.r as string)].map((ch) => map[ch] ?? "pending");
          const idx = Math.min(Math.max(0, Number(saved.i) || 0), manager.events.length);
          followerRef.current!.start(manager.events, idx);
          resultsRef.current.forEach((r, i) => {
            if (r !== "pending") manager.colorEvent(i, colorFor(r));
          });
          manager.moveCursorToEvent(idx);
          setResults([...resultsRef.current]);
          setCurrentIndex(idx);
          wrongCountRef.current = Number(saved.w) || 0;
          setWrongCount(wrongCountRef.current);
          setFinished(idx >= manager.events.length);
          restored = true;
        }
      } catch {
        // corrupt entry — start fresh
      }
      if (!restored) {
        followerRef.current!.start(manager.events);
        resultsRef.current = manager.events.map(() => "pending");
        setResults([...resultsRef.current]);
        setCurrentIndex(0);
        setFinished(false);
        wrongCountRef.current = 0;
        setWrongCount(0);
      }

      if (manager.events.length === 0) {
        setError("No playable notes found in this score.");
      } else if (remember) {
        // Save to the local score library so it survives reloads and shows
        // up in the score picker — no re-import needed next visit.
        try {
          const id = contentHash;
          localStorage.setItem(`jv-score:${id}`, content);
          setLibrary((prev) => {
            const next = [{ id, title: fallbackTitle }, ...prev.filter((e) => e.id !== id)].slice(0, 20);
            localStorage.setItem(LIB_KEY, JSON.stringify(next));
            return next;
          });
          localStorage.setItem(LAST_KEY, `lib:${id}`);
          setSample(`lib:${id}`);
        } catch {
          // quota exceeded — the score still loaded, it just won't persist
        }
      }
    } catch (e) {
      setError(`Could not load score: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingScore(false);
    }
  }

  function loadLibraryScore(id: string) {
    const xml = localStorage.getItem(`jv-score:${id}`);
    const entry = readLibrary().find((e) => e.id === id);
    if (!xml) {
      setError("That saved score is no longer in this browser's storage — re-import it.");
      return;
    }
    void applyScore(xml, entry?.title ?? "Imported score");
  }

  async function loadSampleById(id: string) {
    const meta = SAMPLES.find((s) => s.id === id);
    try {
      const res = await fetch(`/scores/${id}.musicxml`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await applyScore(await res.text(), meta?.label ?? id, false);
      try {
        localStorage.setItem(LAST_KEY, `sample:${id}`);
      } catch {
        // best-effort
      }
      setSample(id);
    } catch (e) {
      setError(`Could not fetch sample: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function importFile(file: File) {
    const name = file.name.toLowerCase();
    if (!/\.(pdf|xml|musicxml|mxl)$/.test(name)) {
      setError(`Unsupported file "${file.name}" — drop a .musicxml, .xml, .mxl, or .pdf file.`);
      return;
    }
    setSample("");
    if (name.endsWith(".pdf")) {
      setPdfImport({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name });
      return;
    }
    await applyScore(
      await readScoreFile(file),
      file.name.replace(/\.(xml|musicxml|mxl)$/i, ""),
    );
  }

  async function onFileChosen(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (file) await importFile(file);
  }

  async function startListening(deviceId = micDevice) {
    stopPlayback();
    try {
      await audioRef.current!.start(deviceId || undefined);
      if (startRef.current < 0) startRef.current = performance.now();
      setListening(true);
      setError("");
      // Labels become available after permission — refresh the device list.
      setMicInputs(await audioRef.current!.listInputs());
    } catch (e) {
      const noDevice = e instanceof DOMException && e.name === "NotFoundError";
      setError(
        noDevice
          ? "No microphone exists in this browser context — the embedded preview pane has none. " +
            "Open http://localhost:5173 in Chrome or Safari and press Start listening there; " +
            "the real permission prompt will appear."
          : `Microphone unavailable: ${e instanceof Error ? e.message : String(e)}. ` +
            "Allow the mic in the browser prompt, and check macOS System Settings → Privacy → Microphone.",
      );
    }
  }

  function stopListening() {
    audioRef.current?.stop();
    setListening(false);
  }

  async function pickMicDevice(deviceId: string) {
    setMicDevice(deviceId);
    try {
      localStorage.setItem("jv-mic-device", deviceId);
    } catch {
      // persistence is best-effort
    }
    if (listening) {
      stopListening();
      await startListening(deviceId);
    }
  }

  function restart() {
    const manager = managerRef.current!;
    stopPlayback();
    manager.resetProgress();
    followerRef.current!.start(manager.events);
    resultsRef.current = manager.events.map(() => "pending");
    setResults([...resultsRef.current]);
    setCurrentIndex(0);
    setFinished(false);
    wrongCountRef.current = 0;
    setWrongCount(0);
    setWrongMsg("");
    setElapsedS(0);
    startRef.current = -1;
    try {
      if (progressKeyRef.current) localStorage.removeItem(progressKeyRef.current);
    } catch {
      // best-effort
    }
  }

  function skipNote() {
    stopPlayback();
    followerRef.current?.skip();
  }

  function backNote() {
    stopPlayback();
    const i = followerRef.current?.back();
    if (i === null || i === undefined) return;
    resultsRef.current[i] = "pending";
    managerRef.current!.colorEvent(i, null);
    managerRef.current!.moveCursorToEvent(i);
    setResults([...resultsRef.current]);
    setCurrentIndex(i);
    setFinished(false);
    saveProgress();
  }

  const target = managerRef.current?.events[currentIndex];
  const done = results.filter((r) => r !== "pending").length;
  const firstTry = results.filter((r) => r === "correct").length;
  const accuracy = done > 0 ? Math.round((100 * firstTry) / done) : 100;
  const skipped = results.filter((r) => r === "skipped").length;

  return (
    <div
      className={`app ${dragOver ? "dragover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void importFile(file);
      }}
    >
      <header className="header">
        <h1>{MODES[mode].name}</h1>
        <span className="sub">
          {scoreTitle || "sheet-music karaoke — play the note to advance"}
        </span>
        <span className="grow" />
        <div className="modeswitch">
          <button className={mode === "violin" ? "on" : ""} onClick={() => switchMode("violin")}>
            🎻 Violin
          </button>
          <button className={mode === "piano" ? "on" : ""} onClick={() => switchMode("piano")}>
            🎹 Piano
          </button>
        </div>
        <button className="iconbtn" title="Zoom out" onClick={() => managerRef.current?.setZoom(-0.15)}>−</button>
        <button className="iconbtn" title="Zoom in" onClick={() => managerRef.current?.setZoom(0.15)}>+</button>
      </header>

      {error && (
        <div className="banner">
          <span>{error}</span>
          <button className="linkbtn" onClick={() => setError("")}>dismiss</button>
        </div>
      )}

      <section className="controls">
        <select
          value={sample}
          onChange={(e) => {
            const v = e.target.value;
            setSample(v);
            if (v.startsWith("lib:")) loadLibraryScore(v.slice(4));
            else if (v) void loadSampleById(v);
          }}
        >
          {sample === "" && <option value="">(unsaved)</option>}
          <optgroup label="Samples">
            {SAMPLES.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </optgroup>
          {library.length > 0 && (
            <optgroup label="Imported">
              {library.map((e) => (
                <option key={e.id} value={`lib:${e.id}`}>{e.title}</option>
              ))}
            </optgroup>
          )}
        </select>
        <label className="btn">
          Open file…
          <input
            type="file"
            accept=".xml,.musicxml,.mxl,.pdf"
            onChange={onFileChosen}
            style={{ display: "none" }}
          />
        </label>
        {!listening ? (
          <button className="btn primary" onClick={() => void startListening()}>
            ● Start listening
          </button>
        ) : (
          <button className="btn listening" onClick={stopListening}>
            ■ Stop
          </button>
        )}
        <button className="btn" onClick={togglePlayback} disabled={eventCount === 0}>
          {playing ? "■ Stop playback" : "▶ Play"}
        </button>
        <button className="btn" onClick={restart} disabled={eventCount === 0}>↺ Restart</button>
        <button className="btn" onClick={backNote} disabled={currentIndex === 0}>‹ Back</button>
        <button className="btn" onClick={skipNote} disabled={eventCount === 0 || finished}>Skip ›</button>
        <span className="grow" />
        <label className="setting">
          tuning
          <select value={a4} onChange={(e) => setA4(Number(e.target.value))}>
            <option value={440}>A = 440</option>
            <option value={441}>A = 441</option>
            <option value={442}>A = 442</option>
          </select>
        </label>
        <label className="setting">
          tolerance
          <select value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))}>
            <option value={10}>precise ±10¢</option>
            <option value={30}>strict ±30¢</option>
            <option value={50}>normal ±50¢</option>
          </select>
        </label>
        <label className="setting checkbox">
          <input
            type="checkbox"
            checked={showMistakes}
            onChange={(e) => setShowMistakes(e.target.checked)}
          />
          mistakes
        </label>
        {mode === "piano" && (
          <label
            className="setting checkbox"
            title="Require every written chord tone before advancing (not just one)"
          >
            <input
              type="checkbox"
              checked={fullChords}
              onChange={(e) => setFullChords(e.target.checked)}
            />
            full chords
          </label>
        )}
        <label className="setting">
          speed
          <select
            value={tempoFactor}
            onChange={(e) => {
              stopPlayback();
              setTempoFactor(Number(e.target.value));
            }}
          >
            <option value={0.5}>50%</option>
            <option value={0.75}>75%</option>
            <option value={1}>100%</option>
            <option value={1.25}>125%</option>
          </select>
        </label>
        <label className="setting">
          mic
          <select value={sensitivity} onChange={(e) => setSensitivity(e.target.value)}>
            <option value="low">quiet room</option>
            <option value="med">normal</option>
            <option value="high">sensitive</option>
          </select>
        </label>
        {micInputs.length > 0 && (
          <label className="setting">
            input
            <select value={micDevice} onChange={(e) => void pickMicDevice(e.target.value)}>
              <option value="">Default</option>
              {micInputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section className="tuner">
        <div className="panel">
          <div className="label">next note {target && `· measure ${target.measure}`}</div>
          <div className="value target">
            {finished ? "🎉" : target ? target.names.join(" + ") : "—"}
          </div>
          <div className="hint">
            {finished
              ? "score complete"
              : listening
                ? "listening…"
                : "press start listening, then play"}
          </div>
        </div>
        <div className="panel">
          <div className="label">
            hearing {wrongMsg && <em className="wrong">{wrongMsg}</em>}
          </div>
          <div className="value" ref={noteEl}>–</div>
          <div className="needle-track">
            <div
              className="zone"
              style={{ left: `${50 - tolerance}%`, width: `${tolerance * 2}%` }}
            />
            <div className="center-tick" />
            <div className="needle" ref={needleEl} />
          </div>
          <div className="cents" ref={centsEl} />
        </div>
        <div className="panel">
          <div className="label">mic level</div>
          <div className="level-track">
            <div className="level-fill" ref={levelEl} />
          </div>
          <div className="hint">{listening ? "live" : "mic off"}</div>
        </div>
        <div className="panel">
          <div className="label">progress</div>
          <div className="value">
            {Math.min(currentIndex, eventCount)}<span className="dim">/{eventCount}</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: eventCount ? `${(100 * currentIndex) / eventCount}%` : 0 }}
            />
          </div>
          <div className="hint">
            {accuracy}% first try · {wrongCount} slips{skipped > 0 && ` · ${skipped} skipped`}
          </div>
        </div>
      </section>

      <section className="sheetWrap">
        {loadingScore && <div className="loading">Loading score…</div>}
        <div className="sheet" ref={sheetRef} />
      </section>

      {pdfImport && (
        <PdfImportDialog
          bytes={pdfImport.bytes}
          fileName={pdfImport.name}
          instrument={mode}
          onClose={() => setPdfImport(null)}
          onLoad={(content, title) => {
            setPdfImport(null);
            void applyScore(content, title);
          }}
        />
      )}

      {finished && (
        <div className="overlay">
          <div className="card">
            <div className="big">🎉</div>
            <h2>{scoreTitle || "Score"} complete!</h2>
            <p className="stats-line">
              {firstTry} of {eventCount} notes on the first try ({accuracy}%)
              {wrongCount > 0 && <> · {wrongCount} slips</>}
              {skipped > 0 && <> · {skipped} skipped</>}
              {elapsedS > 0 && <> · {Math.floor(elapsedS / 60)}m {elapsedS % 60}s</>}
            </p>
            <button className="btn primary" onClick={restart}>↺ Play again</button>
          </div>
        </div>
      )}
    </div>
  );
}
