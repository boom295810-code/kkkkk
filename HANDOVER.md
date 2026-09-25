# Recap Studio v3 — Handover

Read this fully before touching any code. It records design decisions
and traps that were expensive to discover.

## What this is

A local web app that turns a source video into a Burmese (or English)
voiced-over video with burned-in captions.

- `server/` — Node backend. Runs the pipeline and ffmpeg.
- `client/` — React + Vite frontend.
- Backend port **5002**, frontend dev port **5174**.

External services: AssemblyAI (transcription), Gemini (translation),
edge-tts (voice), yt-dlp (URL download), ffmpeg (render).

## Modes

**AI Recap** — the original, approved mode. Narration/recap style.
**PROTECTED: do not modify its code path.** It has been validated on
real output and any change risks breaking a working product.

**Pro AI Recap** — for dialogue videos. Translates what is actually
said, faithfully and in order, delivered as one continuous narrator
voice. Has an output-language dropdown (Burmese default, English
available; more languages are config entries in
`server/services/proLanguages.js`).

**Dubbing** — code exists server-side but has no UI entry point. Left
in place deliberately. Do not delete it, do not surface it.

## The timing engine — read this before changing anything

This took many failed attempts. The current design is correct. Do not
"improve" it without a specific, reproduced bug.

### How it works

1. **Scene spans tile the source with zero gaps.** Span i runs from
   block i's start to block i+1's start; the last runs to the end of
   the video; block 0's span starts at 0.0.

   This is the key insight. There is no separate concept of a "gap" or
   "silence". Silence between blocks is simply part of the preceding
   block's span, and gets sped up along with it, automatically.

2. **The voice track is master.** Built once at a fixed TTS rate,
   continuous, never re-tempoed afterwards.

3. **voice_dur_i is telescoped**, not taken from each block's raw TTS
   duration: it is placement[i+1].start - placement[i].start (last one
   to the track's end). This is what makes drift structurally
   impossible — segment durations sum exactly to the total voice
   duration by pure arithmetic.

4. **speed_i = span_i / voice_dur_i, fully unclamped.** Clamping is
   what caused every earlier failure: a clamped segment overruns, the
   overrun pushes later segments, and lateness accumulates through the
   video. Do not reintroduce a clamp. Log speeds above 4x as a
   warning, but never clamp.

5. **Render** reuses AI Recap's own `segments` branch in render.js —
   its ratio = ttsDuration/dur formula is algebraically identical to
   speed = span/voice_dur.

6. **Ending**: a safety pad (padSeconds, 0.12s) plus -t <duration> so
   audio and video end together.

### Approaches that were tried and FAILED — do not repeat

- Cutting silence out entirely, then fitting. Removing silence removes
  the slack that absorbs Burmese running ~40% longer than the source.
  13 of 21 segments clamped and the voice drifted late.
- Per-segment speed with a 0.90-1.15 clamp. Same accumulation problem.
- Gap "absorb then speed up" with carry-forward debt. The debt grows
  instead of clearing; audio runs out before the picture.
- One global speed factor for the whole video. Any per-segment
  mismatch drifts.

### Reference

`reference-dubbing-timing.py` in the project root is an extract of the
older Python tool whose dubbing timing was excellent. The current
design was ported from it. Keep it for reference; it is not executed.

## Known traps

**-shortest cuts the picture off early.** Do not use it on the mux.
Use the existing padSeconds + -t <duration> approach.

**FFmpeg 6.1 (the bundled ffmpeg-static) runs out of memory on long AI
Recap renders.** The segments branch feeds one decoded stream into one
`trim` per block (234 for a 7-min source); 6.1's scheduler lets the idle
branches' frames pile up, ~30 MB per output second. On an 8 GB PC a
512 s render lost its picture at 278 s (`get_buffer() failed`) while the
voice ran on. FFmpeg 7+/8 runs the identical graph at a flat ~200 MB. Set
`FFMPEG_PATH` to an FFmpeg 7+ build (this Windows PC: `FFMPEG_PATH=ffmpeg`
in server/.env, the winget build). FFmpeg 8 dropped
`-filter_complex_script`; `filterScriptOption()` in services/ffmpeg.js
picks the spelling the binary supports. The Dockerfile still uses
ffmpeg-static 6.1 — fix that before deploying long videos.

**The A/V check must compare track lengths, not format.duration.** The
container duration is the longer track, so comparing it with itself
always read "0ms" — that is how the 278 s picture above passed. Use
`probeStreamDurations()`.

**Font family name is not the filename.** libass matches on the font's
internal family name. A13_WenYoeRegular.ttf has family A13_WenYoe.
services/fonts.js reads the real family name from the file — keep it.

**libass will try to open a directory as a font.** The font loader
must skip anything that is not a regular .ttf/.otf. Pro Recap copies
only real font files into a job-scoped folder and points libass there.

**zoom > 1 combined with a full-width blur box or the cover-subtitle
band crashes ffmpeg.** The zoom crop shrinks the frame, but the blur
math is computed from the source probe dimensions, so the blur crop
overflows. Fixed by inserting
scale=<W>:<H>:force_original_aspect_ratio=disable,setsar=1 right
before the blur crop, gated on exactly three conditions:
boxes.length > 0 && zoom > 1.001 && !needsResize. Any other
combination must emit an identical filter graph to before.

**npm blocks install scripts by default (npm 12+).** ffmpeg-static
needs its install script to fetch the binary. After npm install:
    npm install-scripts approve ffmpeg-static
    npm install-scripts approve ffprobe-static
    npm rebuild
approve only records permission — npm rebuild actually runs it.

**edge-tts may be blocked from data-centre IPs.** It works from a home
connection. On a VPS it may return 403. Untested. If it fails, the
Azure TTS fallback path is the mitigation (an AZURE_SPEECH_KEY field
already exists).

**YouTube download is unreliable.** TikTok/Douyin has a working
fast-path via tikwm.com. YouTube goes through yt-dlp directly and hits
"Sign in to confirm you're not a bot" — worse from data-centre IPs.
File upload is always available as the fallback.

## Regression discipline

AI Recap and Dubbing must produce byte-identical filter graphs before
and after any change. Every change to shared code has been verified
this way. Keep doing it: dump the filter graph for the protected
branches before and after, and diff them. If they differ, the change
is wrong.

## What is built

- Pro AI Recap timing (A/V delta 0ms on real videos)
- Output language: Burmese + English
- Caption blur and background blur as separate kinds, each with its
  own strength, plus a shared edge-softness (feathered, proportional
  to box size — not fixed pixels)
- Pad mode inner scale and vertical/horizontal position
- Copyright: mirror, zoom nudge, small random crop offset
- URL download (TikTok fast-path + yt-dlp)
- History of the last 3 renders, with real file deletion on disk and
  reconciliation on server start
- Light theme, mobile layout with pinned canvas and bottom tab bar,
  premium processing screen with optional Web Audio sounds

## Auth — added, then removed again (2026-09-23)

A Supabase Auth layer (email+password / Google OAuth, per-user history) was added at one point.
It was **removed again at the owner's explicit request**, specifically to make the deployed app
open with zero friction: no sign-up, no email, direct access straight into the editor.

**What this means, concretely, and the risk it accepts:** every route is open to anyone who can
reach the URL. That includes `/api/job` (submits a real render, consuming the shared AssemblyAI/
Gemini API quota) and `/api/settings` (views/edits those shared keys — there is no admin gate).
The owner was warned of this explicitly before the removal and chose to accept it, trading cost/
abuse exposure for frictionless access. If that tradeoff ever needs revisiting (e.g. abuse shows
up in AssemblyAI/Gemini billing), the lightest fix is a single shared access code checked in
Express middleware — not a reintroduction of Supabase/accounts, unless the owner asks for that
specifically.

Concrete state of the code today:
- No `requireAuth`/`requireAdmin` anywhere; `server/services/supabaseAuth.js` is deleted.
- `server/services/history.js` is back to a single local `server/history.json` file (last 3
  renders, shared — not per-user). `server/supabase/` (the old schema) is deleted.
- `client/src/components/Auth.jsx` and `client/src/supabaseClient.js` are deleted; `App.jsx`
  renders the studio directly, no session state, no "Sign out" button.
- `@supabase/supabase-js` removed from both `server/package.json` and `client/package.json`.
- `SUPABASE_*`/`ADMIN_EMAILS`/`VITE_SUPABASE_*` env vars are gone from both `.env`/`.env.example`
  files — don't reintroduce them without the owner asking for auth back first.
- The render engine itself is untouched by any of this: still one job at a time, still the same
  local ffmpeg pipeline, timing engine unchanged.

## What is not built

- Any access control at all — no auth, no rate limiting, no admin gate. Deliberate, see "Auth" above.
- Licensing/billing.
- Multi-user concurrency — the app assumes one job at a time; a second visitor submitting a job
  while one is running will queue behind it, not run in parallel.

## Setup on a new machine

Requires Node 20+, ffmpeg, and yt-dlp on PATH. No accounts/auth to set up — see "Auth" above.

    cd server
    npm install
    npm install-scripts approve ffmpeg-static   # or: npm approve-scripts --all (npm 11+ command name)
    npm install-scripts approve ffprobe-static
    npm rebuild
    cp .env.example .env
    npm start          # http://localhost:5002

    cd client
    npm install
    cp .env.example .env
    npm run dev        # http://localhost:5174

Opens directly into the editor — no sign-up, no login. Click Settings (open to anyone who can
reach the app) and enter the AssemblyAI and Gemini API keys. They are stored in
server/settings.json, which is gitignored and must never be committed or shipped.

Verify without API keys — the offline render self-test only:
    cd server && node tools/verify.js

### Windows notes — UNTESTED

This has only ever run on macOS. Before assuming it works on Windows:

- Check that ffmpeg-static resolves to a real .exe. If not, install
  ffmpeg separately and set FFMPEG_PATH / FFPROBE_PATH.
- Install yt-dlp and confirm it is on PATH, or set YT_DLP_PATH.
- Bundled fonts live in server/fonts/. Confirm libass loads them.
- Run a short video end to end before trusting it.

## Working style that worked

- One change at a time. Build, then stop and test before the next.
- State explicitly what must not change, every time.
- When a theory about a bug is wrong, dump the real artifact (the
  actual filter graph, the actual log) rather than reasoning from the
  code. Two wrong diagnoses were corrected exactly this way.
- Commit after every working change.
