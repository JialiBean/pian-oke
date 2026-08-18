# 🎻 Violin-oke / 🎹 Pian-oke

Sheet-music karaoke for instrument practice, running entirely on your machine.
The header switch flips between **Violin-oke** and **Pian-oke** — each mode
tunes the pitch detector's range (violin 150–3200 Hz; piano 70–4300 Hz with
octave-error resistance for struck strings), the playback voice (bowed synth
with swell + vibrato vs struck piano with natural ring), and the AI
transcription hint (top melody staff vs right-hand staff). Piano following is
melody-line only — the pitch detector is monophonic by design.
Load a score, press **Start listening**, and play: the cursor waits on each
note and only advances when you play it correctly — correct notes turn green,
slips flash red and show what was heard instead.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173 and allow microphone access when asked.

## Using it

1. Pick a bundled score (open strings, D major scale, Twinkle, Ode to Joy) or
   load your own file — MusicXML (`.musicxml`, `.xml`, compressed `.mxl`) or a
   **PDF** (see below). Every notation app exports MusicXML —
   [MuseScore](https://musescore.org) is free, and musescore.com has thousands
   of scores.
2. Press **Start listening** and play the highlighted note.
   - In tune within the tolerance → the note turns green and the cursor moves on.
   - A wrong note held briefly → flashes red and shows what was heard.
   - Fixed after a slip → the note turns amber (counted, but not "first try").
3. **Skip** if you're stuck, **Back** to redo a note, **Restart** to start over.
4. **▶ Play** performs the loaded score aloud (MuseScore-style) with the
   cursor following, starting from wherever your practice cursor is — the
   speed control (50–125%) scales the score's printed tempo. Playback and
   listening are exclusive; playing stops the mic and never touches your
   practice progress.
5. If you have several microphones, an **input** picker appears next to the
   mic sensitivity once permission is granted (your choice is remembered).

### Tips

- Repeated notes (A A A…) need a fresh bow stroke or a tiny gap — one long
  sustained note deliberately doesn't count twice.
- Double stops accept either of the written notes (the detector is monophonic).
- Practicing in a quiet room helps; raise "mic" sensitivity if the level bar
  barely moves, lower it if background noise triggers readings.
- Tuning reference is configurable (A = 440/441/442).
- Echo cancellation / noise suppression / auto-gain are disabled on purpose —
  they are built for speech and mangle violin sound.

## PDF import

Open a `.pdf` (file picker or **drag & drop onto the window**) to get the
import dialog with two independent readers:

- **Audiveris (free, local)** — classic optical music recognition. Installed at
  `/Applications/Audiveris.app` (auto-detected; or set `AUDIVERIS_PATH`). No
  network, no cost. Its output is auto-repaired for known defects (e.g. the
  `divisions=0` it emits on barely-detected mini-systems). Measured: 39/42
  notes on the synthetic test page (it can't see single-measure orphan
  systems), and a full 559-note read of a real 100-measure engraved score.
- **AI transcription (BYOK — bring your own key)** — each selected page is
  rendered to a high-res image and sent to the provider you pick:
  - *Claude (Anthropic)*: Sonnet 5 / Opus 5 / Haiku 4.5. Measured on the test
    page: Opus 42/42 in one shot ($0.14); Sonnet 42/42 after one automatic
    self-repair retry.
  - *Local models, free*: Ollama (`ollama pull qwen2.5vl:7b`) or LM Studio —
    auto-detected when running; no key, no network.
  - *OpenAI / OpenRouter / Google Gemini / any OpenAI-compatible endpoint*:
    add the matching key to `.env` (note: a ChatGPT Plus subscription does not
    include API access — API billing is separate).
  Invalid XML triggers one automatic retry with the validation error fed back
  to the model; multi-page PDFs are stitched with continuous measure numbers.

Keys and endpoints live only in `.env` (copy `.env.example`) and are read by
the local dev-server proxy ([server/api.ts](server/api.ts)) — the browser
never sees them, and nothing is sent anywhere until you click Transcribe. The
exact cost of each Claude call is shown on the page chip afterwards, and
results are cached locally (keyed by PDF hash + provider + model) so
re-importing the same PDF is free. **Save MusicXML** exports the result.

Try it: `public/test-twinkle.pdf` is a one-page scan-like test score.

## How it works

- **Score**: [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/)
  renders the MusicXML; the app walks the score cursor to extract the expected
  note sequence (ties merged, rests skipped, grace notes ignored, double stops
  kept as chords) — see `src/score/manager.ts`.
- **Ear**: the microphone feeds an `AnalyserNode`; ~60×/second a 2048-sample
  window goes through a from-scratch McLeod Pitch Method detector
  (`src/audio/pitch.ts`) — normalized square difference + key-maximum picking,
  robust for bowed strings from G3 (196 Hz) up past E7.
- **Follower**: a wait-mode state machine (`src/score/follower.ts`) — the
  correct pitch held ~65 ms advances; a stable wrong pitch is reported once;
  repeated notes require re-articulation (gap or bow-attack onset).

## Tests

```bash
npm test
```

Covers the pitch detector (synthesized violin-range tones), note math, and the
follower state machine (hold-to-advance, repeated notes, wrong-note reporting,
double stops, skip/back).

## Roadmap

- Photo import (camera snaps of paper sheets — the PDF pipeline generalizes).
- Tempo mode: metronome-driven karaoke with rhythm grading.
- Per-note intonation report (average cents error), practice history.
- Section looping and transposition.
- More instruments (viola/cello tunings, then polyphonic).

Local-only by design: no accounts, no telemetry, no GitHub required.
