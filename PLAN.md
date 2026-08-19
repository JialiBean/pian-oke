# Violin-oke — build plan

Goal: a local web app that loads sheet music, listens to the violin through the
microphone, and follows the player note-by-note like karaoke — the cursor waits
on each note and advances only when the correct pitch is played.

## Phases

- [x] **Phase 1 — Scaffold**: Vite + React + TypeScript app, local only.
- [x] **Phase 2 — Score engine**: MusicXML load/render (OpenSheetMusicDisplay),
      note-sequence extraction (ties merged, rests skipped, double stops kept),
      cursor control + per-note coloring, bundled beginner scores.
- [x] **Phase 3 — The ear**: microphone capture with music-friendly constraints
      (AGC / echo cancellation / noise suppression off), McLeod (MPM/NSDF) pitch
      detector implemented from scratch, live tuner display.
- [x] **Phase 4 — The follower**: wait-mode matcher (±cents tolerance, ~70 ms
      hold to confirm, re-articulation rule for repeated notes, wrong-note
      flash + "heard X" feedback), skip/back controls, progress + accuracy,
      finish report.
- [x] **Phase 5 — Verify**: unit tests (pitch detector, note math, follower
      state machine), production build, live browser smoke test.

## v1.1 — PDF import (shipped 2026-08-17)

- [x] PDF upload → pdf.js page rendering → import dialog.
- [x] AI transcription via local proxy (key in .env, never in the browser):
      Opus 5 read the test page 42/42 in one shot ($0.14); Sonnet 5 hit 42/42
      after one auto-repair retry; per-page cost + running total in the UI;
      per-PDF+model result caching; Save MusicXML export.
- [x] Classic OMR via Audiveris 5.11 (installed to /Applications,
      auto-detected): free/local, 39/42 on the test page.

## v1.2 — BYOK providers + robustness (shipped 2026-08-17)

- [x] Multi-provider AI transcription (BYOK): Anthropic + OpenAI-compatible
      engine covering OpenAI, OpenRouter, Gemini, local Ollama / LM Studio
      (auto-detected when running), and custom endpoints. Keys only in .env;
      the browser sends a provider id, never a URL or key.
- [x] Audiveris kept and hardened: output sanitizer (divisions=0 defect),
      direct-image input support, full real-score read verified (559 notes,
      100 measures). Root cause of the 39/42: its system detection misses
      single-measure orphan systems — a layout artifact, not resolution.
- [x] Drag & drop import (PDF / MusicXML), output cap raised to 48k tokens
      for dense pages, cost estimates removed from UI (real per-call cost
      shown on each page chip instead).

## v1.3 — Playback + mic access (shipped 2026-08-17)

- [x] Score playback: Web Audio synth (filtered saw+triangle, ADSR), lookahead
      scheduler, plays from the practice cursor with the on-screen cursor
      following, tempo control 50–125% of the score's printed tempo, exclusive
      with mic listening, practice progress untouched.
- [x] Timing extraction: per-event timestamps + durations (whole-note units)
      from the OSMD iterator; rests stay silent via gap clamping.
- [x] Mic access: input-device picker (persisted), post-permission label
      refresh, clearer permission errors incl. macOS privacy hint.

## To verify with a real instrument (user)

- [x] Mic path end-to-end — CONFIRMED by user (AirPods input): open the app, press
      "Start listening", allow the mic, play/whistle/sing — the "hearing"
      panel should track the note and the cursor should advance on correct
      pitches. (The embedded test browser has no mic device; the DSP itself
      is unit-tested with synthesized violin-range tones.)

## v1.4 — Dual mode + tuner robustness (shipped 2026-08-18)

- [x] Violin-oke / Pian-oke switch (persisted): per-mode detector range,
      per-mode playback voice (bowed: detuned saws + swell + delayed vibrato;
      struck: inharmonic partials + hammer attack + natural ring), per-mode
      transcription staff hint. Piano following = melody line (monophonic).
- [x] Tuner robustness after piano testing: 4096-sample window, detector
      floor to 70 Hz in piano mode, octave-error resistance for
      2nd-harmonic-dominant spectra (McLeod ratio 0.86, unit-tested),
      median-of-3 display smoothing.
- [x] Score library with auto-restore; title injection (ensureTitle) + OMR
      credit/title junk stripping; app renamed Violin-oke; mic confirmed
      working end-to-end by user (AirPods input).

## v1.5 — Practice comfort (shipped 2026-08-18)

- [x] Mistake marking is now a toggle (default OFF): sheet shows only green
      for completed notes; enabling "mistakes" restores red flashes + amber
      corrected-after-slip coloring. Slip counter and "heard X" always on.
- [x] Per-score progress persists across refreshes (localStorage, keyed by
      score content hash); Restart clears it.
- [x] Tolerance tiers: precise ±10¢ / strict ±30¢ / normal ±50¢ (±70 removed).
- [x] Visual polish: soft shadows, larger radii, button transitions, focus
      rings, gradient background.

## v1.6 — Full-chord verification in piano mode (shipped 2026-08-19)

- [x] Score-guided polyphonic ear (src/audio/chordVerify.ts): instead of
      transcribing, it asks only "is there energy where each WRITTEN tone's
      harmonics belong". 8192-point spectrum (~5.9 Hz bins at 48 kHz),
      harmonic comb k=1..6 with 1/k weights, interpolated peak vs local
      background median (worse side wins), shoulder rejection so a
      neighbouring peak's slope can't fake evidence.
- [x] Octave degeneracy handled honestly: a tone whose comb rides another
      expected tone's partial series (octaves, twelfths, and major-third
      partials over a deep bass — real physics at FFT resolution) is flagged
      degenerate → optimistic spectral credit plus a required fresh attack.
      Strictness degrades toward the old any-tone behavior, never below it.
- [x] Engine: second AnalyserNode taps the mic for spectra only while chord
      targets are registered; the monophonic detector path (tuner display,
      violin mode) is untouched.
- [x] Follower `requireAllTones` (default off): every written tone must show
      evidence within a rolling ~400 ms window (tones may arrive in
      different frames — rolled chords are fine); hold/re-articulation
      logic unchanged; wrong-note reporting stays monophonic; frames
      without evidence fall back to any-tone so nothing can brick.
- [x] UI: "full chords" checkbox, piano mode only, persisted
      (jv-full-chords), default off. Dev hook __jv extended (hit() carries
      full evidence, partial() supplies one tone and must not advance).
- [x] Verified: 70 unit tests (12 chordVerify on analytically synthesized
      Blackman-windowed spectra, 10 new follower tests) + live e2e pass on
      the To Zanarkand score (partial chord holds, full chord advances,
      slips still reported, fallback on uncheck). Needs a real-piano test
      by the user. If the classical ear proves too weak on real audio,
      phase B is Basic Pitch (Spotify, Apache-2.0, ONNX in browser).

## v1.7 — AI polyphonic ear + mobile web (shipped 2026-08-19)

- [x] Basic Pitch (Spotify, Apache-2.0) as a second chord-verification ear:
      runs fully locally via TensorFlow.js (model vendored in
      public/models/basic-pitch, ~0.9 MB with its LICENSE; tfjs code-split
      into a lazy chunk the violin mode never loads). An AudioWorklet feeds
      a gapless 22050 Hz stream (drift-free chunk-invariant resampler,
      unit-tested); inference runs every ~450 ms over the last ~2 s; note
      posteriors reduce to the same ChordEvidence interface the spectral
      comb uses, so the follower is untouched.
- [x] The ML ear separates octaves — verified in-browser on To Zanarkand's
      B1+B2+D4+F#4+B4: B1 0.80 / B2 0.77, control tone 0.11, follower
      advanced with requireAllTones. Ear picker ("AI" default / "spectral")
      appears in piano mode with full chords on; spectral comb remains the
      automatic fallback while the model loads or goes stale.
- [x] Mobile web: responsive layout below 720 px (2×2 tuner grid, one-row
      thumb-scrollable settings, grouped zoom, safe-area insets), 44 px
      touch targets on coarse pointers, iOS focus-zoom guard (16 px
      selects), tap-highlight/touch-action hygiene. Verified at 375×812
      portrait and 812×375 landscape with zero horizontal overflow.
- [x] PWA shell: manifest + generated icons (192/512/apple-touch),
      standalone display, theme color. No service worker yet — the dev
      server is the only origin today; revisit if the app gets deployed.
- [x] `npm run dev:phone`: HTTPS + LAN host via @vitejs/plugin-basic-ssl
      (dev-only dep) so a real phone can open the mic — getUserMedia
      requires a secure context off-localhost. Accept the self-signed
      cert once on the phone.
- [x] 78 tests green; production build clean. Real-piano test of both ears
      still owed by the user (mic hardware never existed in the test pane).

## Later (roadmap, not in v1)

- iOS app: wrap the web app with Capacitor (WKWebView supports getUserMedia +
  Web Audio); mic needs NSMicrophoneUsageDescription; PDF transcription would
  call providers directly with a key stored in the iOS Keychain (no local
  Node proxy on device), or scores get imported on desktop and synced.
  BLOCKED on this Mac (2026-08-19): only CommandLineTools present — no
  full Xcode, no simulators, no CocoaPods. Once Xcode is installed and
  `sudo xcode-select -s /Applications/Xcode.app` run, the wrap is:
  `npm i @capacitor/{core,cli,ios} && npx cap init violin-oke
  studio.jiali.violinoke --web-dir dist && npx cap add ios && npm run build
  && npx cap sync`, then add NSMicrophoneUsageDescription to
  ios/App/App/Info.plist. Meanwhile the phone path that works today:
  `npm run dev:phone` → https://<mac-ip>:5173, or Add to Home Screen (PWA).

- OMR expression placement: Audiveris's mp/mf values and hairpin (cresc/dim
  wedge) extents are sometimes wrong or misaligned — classifier-level, not
  fixable by post-processing. Candidate fix: AI expression-repair pass that
  keeps OMR's notes and replaces the dynamics layer from the page image.
- Tempo mode: metronome-driven karaoke with rhythm grading.
- Intonation report per note (average cents error), practice history.
- Section looping (practice measures N–M), transposition.
- Other instruments (cello/viola tunings, then polyphonic instruments).

## Key decisions

- **MusicXML first**: it is the interchange format every notation app exports
  (MuseScore is free). OMR from photos is a separate hard problem — phased later.
- **Wait mode** (not tempo mode) matches the requested behavior: advance on
  correct note, no matter how long it takes.
- **McLeod pitch method** on an `AnalyserNode` ring buffer: robust for bowed
  monophonic strings, ~10 ms of math per frame, zero dependencies.
- **Repeated notes** need an onset (re-articulation) or a brief gap — otherwise
  one sustained bow would race through "A A A A".
- Strictly local: no GitHub remotes/identities, no telemetry.
