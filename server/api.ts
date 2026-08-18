import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Local-only API for the Jiali Violin dev server.
 *
 * Keeps every API key on disk (.env) and out of the browser. The browser sends
 * rendered PDF page images here; this proxy calls the selected AI provider to
 * transcribe them into MusicXML, or runs Audiveris locally, and reports token
 * cost per call (where the price is known) so the UI can show spend.
 */

const MAX_OUTPUT_TOKENS = 48000;
const DEFAULT_CLAUDE_MODEL = "claude-opus-5";

// Anthropic list prices per MTok. Sonnet 5 has intro pricing through 2026-08-31.
function claudePrices(model: string): { input: number; output: number } | null {
  if (model === "claude-opus-5") return { input: 5, output: 25 };
  if (model === "claude-sonnet-5") {
    const intro = Date.now() <= Date.parse("2026-08-31T23:59:59Z");
    return intro ? { input: 2, output: 10 } : { input: 3, output: 15 };
  }
  if (model === "claude-haiku-4-5") return { input: 1, output: 5 };
  return null;
}

/** OpenAI-compatible providers (BYOK). The browser only sends a provider id —
 * base URLs and key names are fixed here so the key can never be exfiltrated
 * to an arbitrary URL by client-side code. */
interface CompatProvider {
  label: string;
  baseUrl: (env: Env) => string | null;
  keyEnv: string | null; // env var holding the API key; null = no key needed
  local: boolean;
}
const COMPAT_PROVIDERS: Record<string, CompatProvider> = {
  openai: {
    label: "OpenAI",
    baseUrl: () => "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    local: false,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: () => "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    local: false,
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    local: false,
  },
  ollama: {
    label: "Ollama (local)",
    baseUrl: (env) => env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
    keyEnv: null,
    local: true,
  },
  lmstudio: {
    label: "LM Studio (local)",
    baseUrl: (env) => env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1",
    keyEnv: null,
    local: true,
  },
  custom: {
    label: "Custom endpoint",
    baseUrl: (env) => env.OPENAI_BASE_URL ?? null,
    keyEnv: "OPENAI_API_KEY",
    local: false,
  },
};

const instrumentRule = (instrument: string) =>
  instrument === "piano"
    ? `- Exactly one part: <score-part id="P1">, part-name "Piano". If the page shows a grand staff, transcribe ONLY the upper (right-hand) staff as a single melody line; skip the left-hand accompaniment. If several instruments appear, take the piano's melody staff.`
    : `- Exactly one part: <score-part id="P1">, part-name as printed (default "Violin"). If the page shows several instruments or a piano accompaniment, transcribe ONLY the topmost melody/violin staff.`;

const systemPrompt = (instrument: string) => `You are an expert music engraver converting scanned or photographed printed sheet music into MusicXML.

Output rules — follow exactly:
- Respond with ONLY a complete, well-formed MusicXML 3.1 score-partwise document. No prose, no markdown code fences, no XML comments.
- Begin with <?xml version="1.0" encoding="UTF-8"?> and use <score-partwise version="3.1"> as the root, with a <part-list> and exactly one <part>.
${instrumentRule(instrument)}
- The FIRST measure of your output must state full <attributes>: <divisions>, <key>, <time>, and <clef> — even on continuation pages.
- Choose <divisions> so every printed duration is an integer (4 or more when there are dotted notes or sixteenths; a multiple of 3 when there are triplets). Durations within each measure must sum exactly to the time signature.
- Transcribe exactly what is printed: pitches as <step>/<alter>/<octave> where <alter> reflects the sounding pitch including the key signature and accidentals; rhythms as <duration> plus <type> and <dot/>; rests; ties (both <tie> and <notations><tied>); double stops/chords using <chord/> on the later notes; repeat and final barlines.
- Also transcribe expression marks at their printed positions: dynamics as <direction><direction-type><dynamics><mf/></dynamics></direction-type></direction> (mp, mf, f, p, ff...), hairpins as <wedge type="crescendo"/> / type="diminuendo" with a matching <wedge type="stop"/>, text instructions ("cresc. poco a poco", "sostenuto", "dolce"...) as <direction-type><words>...</words></direction-type>, and a tempo mark (e.g. Andante with a metronome number) as <words> and/or <metronome> in the first measure. Put each <direction> element immediately before the note it applies to.
- Number measures sequentially starting from the number the user gives you.
- Never invent measures that are not printed and never omit printed measures. If a symbol is hard to read, choose the most musically plausible interpretation.
- Include <work><work-title> only if a title is printed on the page.`;

type Env = Record<string, string>;

function loadEnv(root: string): Env {
  const env: Env = {};
  try {
    const text = readFileSync(path.join(root, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n#]+?)"?\s*$/);
      if (m && !m[2].includes("your-key")) env[m[1]] = m[2];
    }
  } catch {
    // no .env file — fine
  }
  for (const k of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "OLLAMA_BASE_URL",
    "LMSTUDIO_BASE_URL",
  ]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  return env;
}

function audiverisBinary(): string | null {
  const candidates = [
    process.env.AUDIVERIS_PATH,
    "/Applications/Audiveris.app/Contents/MacOS/Audiveris",
    "/opt/homebrew/bin/audiveris",
    "/usr/local/bin/audiveris",
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limitBytes = 80_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function buildUserText(body: any): string {
  const page = Number(body.page ?? 1);
  const total = Number(body.total ?? 1);
  const startMeasure = Number(body.startMeasure ?? 1);
  let text = `Page ${page} of ${total}.`;
  if (page > 1) {
    text +=
      " This is a continuation page of the same piece; restate the attributes currently in effect (divisions, key, time, clef) in your first measure.";
  }
  text += ` Start measure numbering at ${startMeasure}. Output the MusicXML document now.`;
  if (body.fixError) {
    text +=
      `\n\nYour previous attempt failed validation with this error:\n${String(body.fixError)}` +
      `\n\nPrevious attempt:\n${String(body.previous ?? "")}` +
      `\n\nOutput the corrected complete MusicXML document only.`;
  }
  return text;
}

async function transcribeAnthropic(env: Env, body: any, res: ServerResponse) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(res, 401, {
      error:
        "No Anthropic API key found. Add ANTHROPIC_API_KEY=sk-ant-... to the .env file " +
        "next to package.json (see .env.example), then restart `npm run dev`.",
    });
  }
  const model = claudePrices(String(body.model)) ? String(body.model) : DEFAULT_CLAUDE_MODEL;
  const instrument = body.instrument === "piano" ? "piano" : "violin";
  const client = new Anthropic({ apiKey });
  const baseParams = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [
      {
        type: "text" as const,
        text: systemPrompt(instrument),
        cache_control: { type: "ephemeral" as const },
      },
    ],
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: "image/png" as const,
              data: String(body.image),
            },
          },
          { type: "text" as const, text: buildUserText(body) },
        ],
      },
    ],
  };

  try {
    let message: any;
    try {
      // Server-side refusal fallback on by default (recommended for claude-opus-5 callers).
      message = await (client.beta.messages as any)
        .stream({
          ...baseParams,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        })
        .finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError && /fallback|beta/i.test(String(e.message))) {
        message = await client.messages.stream(baseParams).finalMessage();
      } else {
        throw e;
      }
    }

    if (message.stop_reason === "refusal") {
      return json(res, 502, { error: "The model declined this request (stop_reason: refusal)." });
    }
    const text = message.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const u: any = message.usage ?? {};
    const price = claudePrices(model)!;
    const costUSD =
      ((u.input_tokens ?? 0) * price.input +
        (u.output_tokens ?? 0) * price.output +
        (u.cache_read_input_tokens ?? 0) * price.input * 0.1 +
        (u.cache_creation_input_tokens ?? 0) * price.input * 1.25) /
      1e6;

    return json(res, 200, {
      musicxml: text,
      truncated: message.stop_reason === "max_tokens",
      model: message.model,
      usage: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
      costUSD,
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      return json(res, 401, { error: "Anthropic rejected the API key in .env — double-check it." });
    }
    if (e instanceof Anthropic.RateLimitError) {
      return json(res, 429, { error: "Rate limited by the Anthropic API — wait a minute and retry." });
    }
    if (e instanceof Anthropic.APIError) {
      return json(res, 502, { error: `Anthropic API error: ${e.message}` });
    }
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

async function transcribeCompat(env: Env, body: any, res: ServerResponse) {
  const provider = COMPAT_PROVIDERS[String(body.provider)];
  if (!provider) return json(res, 400, { error: `Unknown provider: ${body.provider}` });
  const baseUrl = provider.baseUrl(env)?.replace(/\/+$/, "");
  if (!baseUrl) {
    return json(res, 400, {
      error: "Custom endpoint needs OPENAI_BASE_URL=... in .env (then restart `npm run dev`).",
    });
  }
  const key = provider.keyEnv ? env[provider.keyEnv] : null;
  if (provider.keyEnv && !key && !provider.local) {
    return json(res, 401, {
      error: `No key for ${provider.label}. Add ${provider.keyEnv}=... to .env, then restart \`npm run dev\`.`,
    });
  }
  const model = String(body.model ?? "").trim();
  if (!model) return json(res, 400, { error: "Enter a model id for this provider." });

  const instrument = body.instrument === "piano" ? "piano" : "violin";
  const mkBody = (capField: "max_completion_tokens" | "max_tokens") => ({
    model,
    [capField]: MAX_OUTPUT_TOKENS,
    messages: [
      { role: "system", content: systemPrompt(instrument) },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${String(body.image)}` },
          },
          { type: "text", text: buildUserText(body) },
        ],
      },
    ],
  });

  async function call(capField: "max_completion_tokens" | "max_tokens") {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(mkBody(capField)),
      signal: AbortSignal.timeout(240_000),
    });
    const data: any = await r.json().catch(() => null);
    return { r, data };
  }

  try {
    let { r, data } = await call("max_completion_tokens");
    if (!r.ok && JSON.stringify(data ?? "").includes("max_completion_tokens")) {
      ({ r, data } = await call("max_tokens"));
    }
    if (!r.ok) {
      const detail = data?.error?.message ?? data?.error ?? JSON.stringify(data);
      return json(res, 502, {
        error: `${provider.label} error (HTTP ${r.status}): ${String(detail).slice(0, 300)}`,
      });
    }
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    const text = typeof content === "string" ? content : "";
    return json(res, 200, {
      musicxml: text,
      truncated: choice?.finish_reason === "length",
      model: data?.model ?? model,
      usage: {
        input: data?.usage?.prompt_tokens ?? 0,
        output: data?.usage?.completion_tokens ?? 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      costUSD: null, // billed by the provider; price table unknown here
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = provider.local
      ? ` Is ${provider.label.replace(" (local)", "")} running at ${baseUrl}?`
      : "";
    return json(res, 502, { error: `Could not reach ${provider.label}: ${msg}.${hint}` });
  }
}

async function handleTranscribe(root: string, req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
  if (!body.image) return json(res, 400, { error: "Missing page image" });
  const env = loadEnv(root);
  const provider = String(body.provider ?? "anthropic");
  if (provider === "anthropic") return transcribeAnthropic(env, body, res);
  return transcribeCompat(env, body, res);
}

async function probeLocal(url: string | null): Promise<boolean> {
  if (!url) return false;
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(900),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function handleHealth(root: string, res: ServerResponse) {
  const env = loadEnv(root);
  const providers: Record<string, { label: string; ready: boolean; local: boolean; detail?: string }> = {
    anthropic: { label: "Claude (Anthropic)", ready: !!env.ANTHROPIC_API_KEY, local: false },
  };
  for (const [id, p] of Object.entries(COMPAT_PROVIDERS)) {
    const base = p.baseUrl(env);
    let ready: boolean;
    let detail: string | undefined;
    if (p.local) {
      ready = await probeLocal(base);
      detail = ready ? `running at ${base}` : `not detected at ${base}`;
    } else if (id === "custom") {
      ready = !!base;
      detail = base ?? "set OPENAI_BASE_URL in .env";
    } else {
      ready = !!(p.keyEnv && env[p.keyEnv]);
      detail = ready ? undefined : `add ${p.keyEnv} to .env`;
    }
    providers[id] = { label: p.label, ready, local: p.local, detail };
  }
  json(res, 200, { providers, audiveris: !!audiverisBinary() });
}

function findFileWithExt(dir: string, ext: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        const found = findFileWithExt(p, ext);
        if (found) return found;
      } else if (name.toLowerCase().endsWith(ext)) {
        return p;
      }
    } catch {
      // ignore unreadable entries
    }
  }
  return null;
}

function unzipScoreXml(mxlPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "unzip",
      ["-p", mxlPath, "*.xml", "-x", "META-INF/*"],
      { maxBuffer: 64_000_000 },
      (err, stdout) => (err ? reject(new Error(`Could not unzip ${mxlPath}`)) : resolve(stdout)),
    );
  });
}

async function handleOmr(root: string, req: IncomingMessage, res: ServerResponse) {
  const bin = audiverisBinary();
  if (!bin) {
    return json(res, 501, {
      error:
        "Audiveris is not installed. Install it (github.com/Audiveris/audiveris) or set " +
        "AUDIVERIS_PATH, then restart `npm run dev`.",
    });
  }
  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
  const dir = mkdtempSync(path.join(tmpdir(), "jv-omr-"));
  let inputPath: string;
  if (body.pdf) {
    inputPath = path.join(dir, "score.pdf");
    writeFileSync(inputPath, Buffer.from(String(body.pdf), "base64"));
  } else if (body.image) {
    inputPath = path.join(dir, "score.png");
    writeFileSync(inputPath, Buffer.from(String(body.image), "base64"));
  } else {
    return json(res, 400, { error: "Missing PDF or image data" });
  }
  const outDir = path.join(dir, "out");
  try {
    // TESSDATA_PREFIX gives Audiveris OCR language data so text directions
    // ("cresc. poco a poco", "sostenuto") are read, not just note glyphs.
    const tessdata = path.join(root, "server", "tessdata");
    await new Promise<void>((resolve, reject) => {
      execFile(
        bin,
        ["-batch", "-export", "-output", outDir, "--", inputPath],
        {
          timeout: 300_000,
          env: existsSync(path.join(tessdata, "eng.traineddata"))
            ? { ...process.env, TESSDATA_PREFIX: tessdata }
            : process.env,
        },
        (err, _stdout, stderr) =>
          err ? reject(new Error(`Audiveris failed: ${stderr || err.message}`)) : resolve(),
      );
    });
    const mxl = findFileWithExt(outDir, ".mxl");
    if (mxl) return json(res, 200, { musicxml: await unzipScoreXml(mxl) });
    const xml = findFileWithExt(outDir, ".xml");
    if (xml) return json(res, 200, { musicxml: readFileSync(xml, "utf8") });
    return json(res, 502, { error: "Audiveris produced no MusicXML output." });
  } catch (e) {
    return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
  }
}

export function apiPlugin(): Plugin {
  const register = (middlewares: any, root: string) => {
    middlewares.use("/api/health", (_req: IncomingMessage, res: ServerResponse) => {
      void handleHealth(root, res);
    });
    middlewares.use("/api/transcribe", (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      void handleTranscribe(root, req, res);
    });
    middlewares.use("/api/omr", (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      void handleOmr(root, req, res);
    });
  };
  return {
    name: "jiali-violin-api",
    configureServer(server) {
      register(server.middlewares, server.config.root);
    },
    configurePreviewServer(server) {
      register(server.middlewares, server.config.root);
    },
  };
}
