# Recap Studio v2 — Build Spec (THET × DeepLearn AI)

> This file is the contract for Claude Code working in this repo.
> Read it fully before editing anything. Do not invent new behaviour that is not in here.

---

## 0. What this project is

A **single-shared-instance web app** (no accounts, no sign-in) that turns any source video, in
**any spoken language**, into a **Burmese-voiced video** ready to post on TikTok. Anyone who can
reach the deployed URL can use it — see §1.2. The video engine runs on one machine, one job at a
time.

The **engine already exists and works** (it comes from the `be-recamp` repo). This rebuild:

1. **Keeps** the engine: AssemblyAI transcription → Gemini translation → edge-tts voice → ffmpeg audio mixing/timing.
2. **Removed**: the original `be-recamp` had its own Mongo/JWT auth, admin dashboard, payments,
   and Telegram integration — all deleted. A Supabase-Auth layer (email/Google sign-in, per-user
   history) was added later and then **deliberately removed again** (2026-09-23) at the owner's
   request, to make the tool frictionless to access — see §1.2.
3. **Moves** video rendering from browser `ffmpeg.wasm` to **server-side ffmpeg** (fast, unlimited length).
4. **Rebuilds the UI** as a two-panel studio, and adds four new feature groups:
   **BLUR**, **SRT / captions**, **ASPECT RATIO**, **SPEED**.

---

## 1. Hard rules

1. **Never change the engine's proven logic** unless this spec says so. Specifically do not "improve":
   - `services/assemblyai.js` block grouping (speaker change → new block; split at ≥3 s on punctuation / ≥900 ms pause / ≥10 s hard cap; drop blocks over 45 chars/sec).
   - `services/gemini.js` prompt, batch size 10, retry/back-off ladder (3 s / 10 s / 25 s), 403 = fatal, `thought`-part filtering, `။` phrase markers.
   - `services/tts.js` silence trimming via the `areverse` trick (ffmpeg `stop_periods` triggers on the first internal pause — do not use it).
   - `services/ffmpeg.js` `mixAudioOnly` (Dubbing) and `mixAudioForRecap` (AI Recap) timing maths.
2. **No auth — never re-introduce ANY auth stack (old or Supabase) without the owner explicitly
   asking for it again.** As of 2026-09-23 every route is open: no sign-in, no session, no
   per-user isolation. (A shared-password gate was added for the Hugging Face deploy and removed
   again the same day, 2026-09-23, at the owner's request — the public deploy is deliberately
   open too.) `server/services/supabaseAuth.js`, `client/src/components/Auth.jsx`,
   `client/src/supabaseClient.js`, and `server/supabase/` were deleted; `server/services/
   history.js` is back to a single local `server/history.json` (last 3 renders, shared by
   everyone who uses the deployed URL — see HANDOVER.md's "Auth" section for why and the risk
   this accepts). Any code that references `jsonwebtoken`, `google-auth-library`, `passport`,
   `mongoose`, `cloudinary`, a hand-rolled `Payment`/`Settings`(mongoose) model, an admin
   dashboard, or `@supabase/supabase-js` must be deleted, not commented out. AssemblyAI/Gemini
   keys stay a single shared, app-wide config (`server/settings.json`), editable by anyone who
   can reach the app (Settings modal has no gate either) — don't add per-user key storage or an
   admin gate without the owner asking for it first.
3. **API keys** live in `server/.env` and in a local `server/settings.json` editable from the UI Settings modal. Never in the browser bundle, never in git.
4. **All source languages → Burmese.** Never force a source language; AssemblyAI runs with `language_detection: true`.
5. **Verification means watching, not counting.** "Audio duration == video duration" is NOT proof of sync. Every timing change must be checked against the rules in §8.
6. When something is broken, **fix it forward** in the current code. Do not roll back to a backup, and do not rewrite a working stage to fix an unrelated stage.
7. Old files are kept as `*.legacy.js*` for reference only. Never import from them.

---

## 2. Repo layout after the rebuild

```
server/
  index.js                  ← Express, job API. No auth on any route — see §1.2.
  settings.json             ← runtime (gitignored). Shared app-wide API keys, written by Settings modal.
  history.json               ← runtime (gitignored). Local "last 3 renders" list, shared by everyone.
  services/
    assemblyai.js           ← KEEP untouched (called with isFreeUser = false)
    gemini.js               ← KEEP as-is
    tts.js                  ← UPGRADED: also returns real word boundaries per clip
    ffmpeg.js               ← KEEP (mixAudioOnly, mixAudioForRecap) + shared helpers
    timeline.js             ← NEW. Builds the final unified timeline (voice + video + caption)
    srt.js                  ← NEW. Chunks captions, writes .srt and .ass
    render.js               ← NEW. Server-side video render: retime → ratio → blur → hardsub → watermark → mux
    jobs.js                 ← NEW. In-memory job store + progress
    history.js              ← local-file-backed (server/history.json), no per-user scoping
  fonts/                    ← Myanmar caption fonts (.ttf), used by the ASS renderer
  uploads/                  ← temp working files (gitignored)
  outputs/                  ← finished mp4/srt, served at /outputs (gitignored)
client/
  src/
    App.jsx                 ← shell + all app state; renders the studio directly, no session gate
    api.js                  ← plain fetch wrapper, no auth headers
    components/Preview.jsx  ← NEW main canvas: video, draggable blur boxes, caption box
    components/Panel.jsx    ← NEW right properties panel (4 tabs)
    components/Processing.jsx ← NEW progress overlay
    index.css               ← NEW theme tokens
```

Everything else from the old client (`AdminDashboard.jsx`, `context/AuthContext.jsx`, the
`@react-oauth/google` / `jwt-decode` / `@ffmpeg/*` dependencies, `public/ffmpeg/*`) is deleted, as
is the later Supabase-based `Auth.jsx`/`supabaseClient.js` layer (removed 2026-09-23).

---

## 3. Pipeline (one job, seven stages)

```
upload      →  video saved to server/uploads/<jobId>/source.mp4, ffprobe → duration, w, h, fps
extract     →  ffmpeg -vn -ac 1 -ar 16000 source.mp4 → audio.wav
transcribe  →  services/assemblyai.js          → blocks [{start,end,text,speaker,tag,words}]
translate   →  services/gemini.js              → blocks + translatedText   (Burmese)
voice       →  services/tts.js                 → one mp3 per block + wordBoundaries[]
timeline    →  services/timeline.js            → final audio track + per-segment video timing + caption chunks
render      →  services/render.js              → final mp4 (+ .srt sidecar)
```

Progress percentages reported to the UI: upload 0-5, extract 5-10, transcribe 10-35,
translate 35-55, voice 55-72, timeline 72-78, render 78-100.

### Optional review pause
If `settings.reviewBeforeVoice === true`, the job halts after **translate** with
`status: "awaiting-review"` and returns the blocks. `POST /api/job/:id/approve` with the
(possibly edited) blocks resumes it. This is the only interactive break in the pipeline.

---

## 4. Two modes (unchanged semantics)

| | **Dubbing** | **AI Recap** |
|---|---|---|
| For | real dialogue videos | narration / recap videos |
| Voice | each block sits at its **original** timestamp; clip is sped up (1.2×–1.6×) to fit its slot | each block plays at its natural pace, back-to-back with the original gaps preserved |
| Video | plays at one global speed (default 1.0×, user 0.9–1.1×) | each block's video segment is **stretched/compressed** to its voice length (`setpts`), gaps stay at original speed |
| Mixer | `mixAudioOnly()` | `mixAudioForRecap()` |
| Truth | video is the master | **voice is the master** |

`mixAudioForRecap` already returns `utterancesForVideo[{origStart, origEnd, ttsDuration, newVideoStart, newVideoEnd}]`
and `totalVideoDuration`. `render.js` consumes exactly that — the same segment/`setpts`/`concat` graph the
old browser code built, moved server-side.

---

## 5. New feature — BLUR

Two independent things, both optional, both server-side:

### 5a. Manual blur boxes (up to 3)
- Stored **normalized 0–1** relative to the video frame: `{x, y, w, h}` + global `strength` (1–50, default 22)
  and `feather` (0–60 px, default 28).
- Drawn on the preview by dragging; the preview must letterbox-compensate
  (`getVideoContentRect()`): the box the user draws is exactly the box that gets blurred.
- **The blur must be seamless** — no visible rectangle edge, no sheen, no mosaic. Implementation:

```
[base]split=2[keep][src];
[src]crop=W:H:X:Y,gblur=sigma=S:steps=3,format=yuva420p,
     geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':
     a='255*min(1,min(min(X,W-X),min(Y,H-Y))/F)'[patch];
[keep][patch]overlay=X:Y:format=auto
```
  where `F` = feather px. The alpha ramp is what removes the hard edge — never overlay an opaque crop.
  **Do not use `boxblur`** (streaky) and **do not use `pixelize`/mosaic** (Thet rejected it: visible squares,
  text still readable).

### 5b. "Cover original subtitle" band (one click)
A **full-width** feathered blur band at the caption height, because source captions vary in width per clip
and a narrow box leaves both ends of the foreign text visible. Params: `bottomOffsetPct` (default 6 %),
`heightPct` (default 14 %), same feather/strength. Full width = `x:0, w:in_w`, so the band always covers the
whole line. Feather top and bottom only.

---

## 6. New feature — SRT / CAPTIONS

### Chunking
- Captions are **short phrase chunks, 5–7 words, one line**, never a wall of text.
- Split each translated block at `။` first, then at spaces if a chunk is still over the limit.
- Limit by **rendered pixel width**, not character count: max 82 % of frame width, max 2 lines.
  Reduce font size by up to 12 % before allowing a second line.

### Timing — this is the part that has always broken. Rules:
1. Times come from the **final mixed voice track**, never from the original transcript, and never
   from an accumulated running offset.
2. `services/tts.js` records real **WordBoundary** events from edge-tts (`offset`/`duration`, 100 ns units).
   Leading silence removed by `trimSilence` must be **subtracted** from every offset — measure it with
   `silencedetect` on the raw clip before trimming.
3. If the mixer sped a clip up by `k` (Dubbing mode `atempo`), divide its word offsets by `k`.
4. Each chunk's absolute time = `block.finalStartSec + (wordOffset after the two corrections above)`.
   This makes every caption an **absolute** position on the final audio — cumulative drift becomes
   impossible by construction.
5. Extend each chunk's end up to the next chunk's start (max +200 ms hold) so captions don't flicker.
6. Assert before render: chunks are monotonic, non-overlapping, and the last chunk ends ≤ video end.

### Output
- Always write `<name>.srt` next to the mp4 and offer it as a download.
- If `subtitles.burn === true`, also burn in: generate an **`.ass`** (not `subtitles=` on an srt — ASS gives
  font/outline/position control and renders Myanmar correctly) and apply `ass=<file>:fontsdir=server/fonts`.
- Style controls in the UI: font (picker over `server/fonts/*.ttf`), size, primary colour, outline colour +
  width, shadow, position (bottom / middle / custom Y), margin. Default: Myanmar font, size 46 for 1080-tall,
  yellow `&H0000FFFF`, black outline 3, bottom margin 12 % (captions must sit **above** the bottom edge,
  the old build put them too low).

---

## 7. New features — ASPECT RATIO and SPEED

### Ratio
`ratio ∈ original | 9:16 | 1:1 | 4:5 | 16:9`, with `fit ∈ crop | pad` and `focus ∈ center | top | bottom`.
- `crop`: `scale` to cover, then `crop` to the target box at the chosen focus.
- `pad`: `scale` to fit, then `pad` with a blurred copy of the frame as the background
  (`scale=W:H,gblur=sigma=20` behind `overlay`), not black bars — looks better on TikTok.
- Ratio is applied **after** retiming and **before** blur/captions, so blur box coordinates
  are interpreted against the **output** frame the user sees in the preview.
- Also expose `zoom` (1.00–1.15) — the copyright-bypass nudge.

### Speed
- `voiceRate`: −10 % … +45 %, default **+30 %** (his standard). Passed into edge-tts as `rate`.
  This is on top of the engine's own base rate; the UI shows the effective value.
- `videoSpeed`: 0.85× … 1.15×, default **1.00×**. Applied globally in Dubbing mode
  (`setpts=PTS/{speed}`); ignored in AI Recap mode (per-segment stretch owns the timing there).
- `autoFit` (default on): after the voice track is built, if the total voice runs past the video,
  binary-search the smallest extra global tempo up to 1.22×, then slow the video to at most 0.90×,
  then freeze-extend the last frame. Never let the voice run past the end of the picture.
- Audio finishing: `loudnorm=I=-16:TP=-1.5:LRA=11` on the final track (old output was ~-25 LUFS, too quiet).

---

## 8. Definition of done for any timing change

A change is only "working" when **all** of these hold, checked by a script in `server/tools/verify.js`:

1. `|duration(video) − duration(audio)| < 100 ms`.
2. No two voice clips overlap (assert while building the mix).
3. Caption drift: for 10 sampled chunks spread across the file, the chunk start is within **±150 ms**
   of the nearest speech onset found by `silencedetect` on the final audio — **measured at the end
   of the file as well as the start** (this is the drift bug's fingerprint).
4. Last caption ends before the video ends; nothing is cut off.
5. Output is true CFR 30 fps (`-r 30 -vsync cfr`) — the old output claimed 30 fps with ~6.7 % frame gaps.

Report all five numbers after a render. Do not claim success without them.

---

## 9. API surface

No route requires auth (removed 2026-09-23 — see §1.2 and HANDOVER.md's "Auth" section for the
accepted risk: anyone who can reach the deployed URL can use every route below, including
viewing/editing the shared AssemblyAI/Gemini keys).

```
GET  /api/health                 → { ok, ffmpeg, fonts: [...] }
GET  /api/settings                → { assemblyAiKey: masked, geminiKey: masked, defaults }  — shared, app-wide
POST /api/settings                → save keys/defaults to server/settings.json              — shared, app-wide
GET  /api/voices                 → voice presets (edge-tts Burmese + English)
POST /api/tts-preview            → mp3 buffer  { voice, rate, pitch, text }
POST /api/job       (multipart)   → { jobId }   fields: video (file), settings (JSON string)
GET  /api/job/:id                 → { status, stage, percent, log[], blocks?, result? }
POST /api/job/:id/approve         → resume a job that is awaiting-review
POST /api/job/:id/cancel          → kill ffmpeg/child processes, mark cancelled
GET  /api/history                 → the shared last 3 renders (server/history.json)
GET  /api/job/:id/source         → source video for the in-browser preview
GET  /outputs/<file>             → finished mp4 / srt
```

`status ∈ queued | running | awaiting-review | done | error | cancelled`.
Jobs live in memory; on restart, anything unfinished is dropped — a single job-processing engine,
one job at a time, same as before accounts ever existed.

---

## 10. UI

**No sign-in**: `App.jsx` renders the studio directly on load — there is no auth gate and no
Auth component. Settings (gear icon, top right) is visible to everyone.

Two panels, dark theme, brand **"Recap Studio"** / subtitle **"THET × DeepLearn AI"** in the topbar and
Settings modal, accent **cornflower/royal blue** (`#4C6FFF` → `#7C4DFF` gradient) throughout the rest of
the UI. The **processing screen's progress ring is the one exception**: its center shows the
**"K Recap" logo** (`client/src/assets/k-recap-logo.png`, a red "K" + chrome "MOVIE RECAP" wordmark,
background removed) above the percent/stage-name text — this intentionally includes red. The old
"never red" rule from this project's original single-brand era no longer applies; the two identities
(Recap Studio chrome, K Recap processing-screen mark) now coexist deliberately, not by oversight.
Sizing that logo is NOT "scale to fit a box" — the box is the circular ring track (`Processing.jsx`'s
`Ring`), so `.ring-logo`'s width and `.pct`/`.stage-name`'s font sizes in index.css were set by
measuring actual rendered `getBoundingClientRect()`s against the track's inner safe radius (r=56 minus
the 4px stroke), not eyeballed — re-measure the same way if any of those change.

**Left — MAIN CANVAS**: video preview with the chosen ratio applied live, draggable/resizable blur boxes
and caption box overlaid, play/pause, scrub bar, a "cover original subtitle" quick button.

**Right — PROPERTIES**, four tabs:
1. **Source** — drop/pick file, detected duration + resolution, mode (Dubbing / AI Recap), ratio + fit + focus, zoom.
2. **Voice** — voice picker with preview button, voice speed, pitch, video speed, auto-fit toggle, review-before-voice toggle.
3. **Subtitles** — captions on/off, burn-in vs .srt only, font picker, size, colours, outline, position, max words per chunk; blur boxes list + strength + feather + cover-subtitle band; watermark text/position/opacity.
4. **Advanced** — output name, CFR fps, loudness normalise, keep original audio (mute / duck −18 dB / off), quality preset, Start Processing button.

**Processing screen**: circular percent, the seven stage names with a tick as each completes, a live log tail,
elapsed + ETA, Cancel. On completion: inline player, Download MP4, Download SRT, "New video" reset,
and a history strip of the last 3 outputs — **this signed-in user's** last 3, not a global list.

Settings modal (gear, top right): AssemblyAI key, Gemini key, default voice, default ratio, output
folder — one shared, app-wide config every signed-in user sees the same values for (§1.2).

---

## 11. Known traps (learned the hard way — do not re-discover these)

- Gemini 3.x puts a **thinking part first**; read only parts where `thought` is not true.
- A literal `%` inside a prompt breaks `printf`-style formatting — use placeholder + `.replace()`.
- `edge-tts` returns a 44-byte empty mp3 for some lines. Treat as silence and continue; never crash the job.
- ffmpeg `silenceremove` with `stop_periods` cuts at the first internal pause — use reverse→trim→reverse.
- Preview→output coordinate bugs come from **letterboxing**; always compute against the video content rect,
  not the element rect.
- Long ffmpeg filter graphs must be passed with `-filter_complex_script` (a file) once they exceed ~4 KB,
  or macOS argument limits truncate them silently.
- `-shortest` on the final mux cuts the PICTURE off where the last voice clip ends. The audio chain ends
  with `apad` and the encoder gets an explicit `-t <expectedDuration>` instead — do not reintroduce `-shortest`.
- Do not offer the user two alternative approaches to choose between mid-build. Build one, make it work.
- A `<video src>` or `<a download>` element makes its own browser-issued GET request — it cannot
  attach an `Authorization` header. That's WHY `/api/job/:id/source` and `/outputs/<file>` are not
  behind `requireAuth` (§9) — putting them there would just break playback/downloads, not add real
  security (job ids and output filenames are already unguessable random strings, same trust model
  as before auth existed). Don't "fix" this by gating them; if real per-file access control is ever
  needed, it has to be signed URLs, not a Bearer header.
- `services/history.js`'s functions are `async` now (Supabase, not a local JSON file) — every
  caller must `await` them. A silently-dropped promise there means a finished render never shows
  up in that user's history panel, with no error anywhere.

---

## 12. Self-test

`node tools/verify.js` (in `server/`) builds a synthetic clip and pushes it through the real
mixers → caption chunker → ASS → `renderVideo`, in both modes, with blur + ratio + zoom on.
It needs no API keys and no network. It must print `All checks passed.` before you call a
render change done. Extend it rather than testing by hand.
