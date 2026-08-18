import { useEffect, useRef, useState } from "react";
import { openPdf, renderPage, type PdfDoc } from "./pdfRender";
import { extractXml, parsePage, sanitizeOmrXml, stitchPages } from "./stitch";

interface ClaudeModel {
  id: string;
  label: string;
}
const CLAUDE_MODELS: ClaudeModel[] = [
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-opus-5", label: "Claude Opus 5 — most reliable" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — cheapest" },
];

interface ProviderMeta {
  id: string;
  label: string;
  defaultModel: string;
  free?: boolean;
}
const PROVIDERS: ProviderMeta[] = [
  { id: "anthropic", label: "Claude (Anthropic)", defaultModel: "claude-sonnet-5" },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-4o" },
  { id: "openrouter", label: "OpenRouter", defaultModel: "openai/gpt-4o" },
  { id: "gemini", label: "Google Gemini", defaultModel: "gemini-2.5-flash" },
  { id: "ollama", label: "Ollama (local, free)", defaultModel: "qwen2.5vl:7b", free: true },
  { id: "lmstudio", label: "LM Studio (local, free)", defaultModel: "qwen/qwen2.5-vl-7b", free: true },
  { id: "custom", label: "Custom endpoint", defaultModel: "" },
];

const SPEND_KEY = "jv-spend";

interface ProviderHealth {
  label: string;
  ready: boolean;
  local: boolean;
  detail?: string;
}
interface Health {
  providers: Record<string, ProviderHealth>;
  audiveris: boolean;
}

interface PageRow {
  num: number;
  selected: boolean;
  thumb?: string;
  status: "idle" | "working" | "done" | "error";
  source?: "cache" | "api";
  xml?: string;
  measures?: number;
  cost?: number | null;
  error?: string;
}

interface TranscribeResponse {
  musicxml: string;
  truncated: boolean;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUSD: number | null;
}

interface Props {
  bytes: Uint8Array;
  fileName: string;
  instrument: string;
  onLoad(content: string, title: string): void;
  onClose(): void;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

async function postTranscribe(payload: unknown): Promise<TranscribeResponse> {
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  if (data.truncated) {
    throw new Error(
      "The response hit the output-token cap — the page may be too dense. Try another model or split the PDF.",
    );
  }
  return data as TranscribeResponse;
}

function cacheGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function cacheSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota exceeded — transcription still works, just not cached
  }
}

export default function PdfImportDialog({ bytes, fileName, instrument, onLoad, onClose }: Props) {
  const docRef = useRef<PdfDoc | null>(null);
  const hashRef = useRef("");
  const cancelRef = useRef(false);

  const [pages, setPages] = useState<PageRow[]>([]);
  const [providerId, setProviderId] = useState(PROVIDERS[0].id);
  const [model, setModel] = useState(PROVIDERS[0].defaultModel);
  const [health, setHealth] = useState<Health | null>(null);
  const [running, setRunning] = useState(false);
  const [omrRunning, setOmrRunning] = useState(false);
  const [error, setError] = useState("");
  const [spent, setSpent] = useState(() => Number(cacheGet(SPEND_KEY) ?? "0"));

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        hashRef.current = await sha256Hex(bytes);
        const doc = await openPdf(bytes);
        if (dead) return;
        docRef.current = doc;
        setPages(
          Array.from({ length: doc.numPages }, (_, i) => ({
            num: i + 1,
            selected: true,
            status: "idle" as const,
          })),
        );
        for (let i = 1; i <= doc.numPages && !dead; i++) {
          const thumb = await renderPage(doc, i, 260);
          setPages((prev) => prev.map((p) => (p.num === i ? { ...p, thumb } : p)));
        }
      } catch (e) {
        setError(`Could not read this PDF: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
    return () => {
      dead = true;
      cancelRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const provider = PROVIDERS.find((p) => p.id === providerId)!;
  const providerHealth = health?.providers?.[providerId];
  const ready = !!providerHealth?.ready;

  // Changing provider or model must invalidate in-memory page results —
  // otherwise a completed page from model A would be silently reused for
  // model B (the localStorage cache is already keyed per provider+model).
  function resetResults() {
    setPages((prev) =>
      prev.map((p) => ({
        ...p,
        status: "idle" as const,
        xml: undefined,
        measures: undefined,
        cost: undefined,
        source: undefined,
        error: undefined,
      })),
    );
  }

  function pickProvider(id: string) {
    setProviderId(id);
    setModel(PROVIDERS.find((p) => p.id === id)!.defaultModel);
    resetResults();
  }

  function pickModel(m: string) {
    setModel(m);
    resetResults();
  }

  // Violin keys keep the historical format so earlier paid transcriptions
  // stay valid; other instruments get their own cache namespace.
  const cacheKey = (n: number) =>
    instrument === "violin"
      ? `jv-page:${hashRef.current}:${providerId}:${model}:${n}`
      : `jv-page:${hashRef.current}:${providerId}:${model}:${instrument}:${n}`;
  const update = (n: number, patch: Partial<PageRow>) =>
    setPages((prev) => prev.map((p) => (p.num === n ? { ...p, ...patch } : p)));

  function addSpend(x: number | null) {
    if (x == null) return;
    setSpent((s) => {
      const v = s + x;
      cacheSet(SPEND_KEY, String(v));
      return v;
    });
  }

  async function transcribeAll() {
    const doc = docRef.current;
    if (!doc || running) return;
    setRunning(true);
    setError("");
    cancelRef.current = false;
    let startMeasure = 1;
    for (const p of pages.filter((x) => x.selected)) {
      if (cancelRef.current) break;
      let xml = p.status === "done" && p.xml ? p.xml : null;
      let cost: number | null = null;
      if (!xml) {
        const cached = cacheGet(cacheKey(p.num));
        if (cached) {
          xml = cached;
          update(p.num, { source: "cache" });
        }
      }
      if (!xml) {
        update(p.num, { status: "working", error: undefined });
        try {
          const image = (await renderPage(doc, p.num, 2576)).split(",")[1];
          const payload = {
            provider: providerId,
            model,
            instrument,
            image,
            page: p.num,
            total: doc.numPages,
            startMeasure,
          };
          const first = await postTranscribe(payload);
          addSpend(first.costUSD);
          cost = first.costUSD;
          try {
            xml = extractXml(first.musicxml);
            parsePage(xml);
          } catch (ve) {
            const retry = await postTranscribe({
              ...payload,
              fixError: ve instanceof Error ? ve.message : String(ve),
              previous: first.musicxml,
            });
            addSpend(retry.costUSD);
            if (retry.costUSD != null) cost = (cost ?? 0) + retry.costUSD;
            xml = extractXml(retry.musicxml);
            parsePage(xml);
          }
          cacheSet(cacheKey(p.num), xml);
          update(p.num, { source: "api" });
        } catch (e) {
          update(p.num, { status: "error", error: e instanceof Error ? e.message : String(e) });
          setRunning(false);
          return;
        }
      }
      const measureCount = parsePage(xml).measures.length;
      update(p.num, { status: "done", xml, measures: measureCount, cost });
      startMeasure += measureCount;
    }
    setRunning(false);
  }

  async function runAudiveris() {
    if (omrRunning) return;
    setOmrRunning(true);
    setError("");
    try {
      const omrKey = `jv-omr:${hashRef.current}`;
      const cached = cacheGet(omrKey);
      if (cached) {
        // Re-sanitize on load so sanitizer improvements reach old cache entries.
        onLoad(sanitizeOmrXml(cached), fileName.replace(/\.pdf$/i, ""));
        return;
      }
      const res = await fetch("/api/omr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pdf: bytesToBase64(bytes), name: fileName }),
      });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const xml = sanitizeOmrXml(String(data.musicxml));
      cacheSet(omrKey, xml);
      onLoad(xml, fileName.replace(/\.pdf$/i, ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOmrRunning(false);
    }
  }

  const selectedPages = pages.filter((p) => p.selected);
  const donePages = selectedPages.filter((p) => p.status === "done" && p.xml);
  const allDone = selectedPages.length > 0 && donePages.length === selectedPages.length;
  const title = fileName.replace(/\.pdf$/i, "");

  function assembled(): string | null {
    try {
      return stitchPages([...donePages].sort((a, b) => a.num - b.num).map((p) => p.xml!));
    } catch (e) {
      setError(`Could not combine pages: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  function loadIntoApp() {
    const xml = assembled();
    if (xml) onLoad(xml, title);
  }

  function saveMusicXml() {
    const xml = assembled();
    if (!xml) return;
    const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}.musicxml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="overlay">
      <div className="card pdfcard">
        <div className="pdfhead">
          <h2>Import PDF · {fileName}</h2>
          <button className="iconbtn" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        {health && !ready && (
          <div className="setupbox">
            <strong>{provider.label} isn’t ready:</strong>{" "}
            {providerId === "anthropic"
              ? "add ANTHROPIC_API_KEY=sk-ant-… to the .env file next to package.json, then restart npm run dev."
              : providerHealth?.detail ??
                "add the key to .env (see .env.example), then restart npm run dev."}
            {providerHealth?.local && " Start the local server, then reopen this dialog."}
          </div>
        )}

        <div className="pdfcontrols">
          <label className="setting">
            provider
            <select
              value={providerId}
              onChange={(e) => pickProvider(e.target.value)}
              disabled={running}
            >
              {PROVIDERS.map((p) => {
                const h = health?.providers?.[p.id];
                return (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {h ? (h.ready ? " ✓" : "") : ""}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="setting">
            model
            {providerId === "anthropic" ? (
              <select value={model} onChange={(e) => pickModel(e.target.value)} disabled={running}>
                {CLAUDE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="modelinput"
                value={model}
                onChange={(e) => pickModel(e.target.value)}
                placeholder="model id"
                disabled={running}
                spellCheck={false}
              />
            )}
          </label>
          <span className="grow" />
          <span className="hint">
            {selectedPages.length} page{selectedPages.length === 1 ? "" : "s"} selected
            {provider.free ? " · free (local)" : ""}
          </span>
        </div>

        <div className="pagegrid">
          {pages.length === 0 && <div className="loading">Reading PDF…</div>}
          {pages.map((p) => (
            <div key={p.num} className={`pagecell ${p.selected ? "" : "off"}`}>
              {p.thumb ? <img src={p.thumb} alt={`page ${p.num}`} /> : <div className="thumbless" />}
              <label className="pagemeta">
                <input
                  type="checkbox"
                  checked={p.selected}
                  disabled={running}
                  onChange={(e) => update(p.num, { selected: e.target.checked })}
                />
                p.{p.num}
                {p.status === "working" && <span className="chip run">reading…</span>}
                {p.status === "done" && (
                  <span className="chip ok">
                    ✓ {p.measures} bars
                    {p.source === "cache"
                      ? " (cached)"
                      : p.cost != null
                        ? ` · $${p.cost.toFixed(2)}`
                        : ""}
                  </span>
                )}
                {p.status === "error" && <span className="chip err">failed</span>}
              </label>
              {p.status === "error" && p.error && <div className="pageerr">{p.error}</div>}
            </div>
          ))}
        </div>

        {error && <div className="banner">{error}</div>}

        <div className="pdfactions">
          <button
            className="btn primary"
            onClick={() => void transcribeAll()}
            disabled={running || selectedPages.length === 0 || !ready}
          >
            {running
              ? "Transcribing…"
              : `🎼 Transcribe ${selectedPages.length} page${selectedPages.length === 1 ? "" : "s"} with AI`}
          </button>
          {health?.audiveris && (
            <button className="btn" onClick={() => void runAudiveris()} disabled={omrRunning}>
              {omrRunning ? "Running Audiveris…" : "Read with Audiveris (free, local)"}
            </button>
          )}
          {allDone && (
            <>
              <button className="btn primary" onClick={loadIntoApp}>
                ▶ Load into practice view
              </button>
              <button className="btn" onClick={saveMusicXml}>
                ⬇ Save MusicXML
              </button>
            </>
          )}
          <span className="grow" />
        </div>
      </div>
    </div>
  );
}
