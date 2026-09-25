// ─────────────────────────────────────────────────────────────────────────────
// download.js — URL-sourced video downloads (YouTube/TikTok/Facebook/
// Instagram) via yt-dlp.
//
// Ported from a proven Python reference (reference-url-download.py, an
// older project of the user's, in daily use) — see the PORTING NOTES at the
// bottom of this file for exactly what was kept, changed, and why. Node's
// child_process instead of Python's subprocess; progress is reported through
// this app's existing job log/stage mechanism (log()/setStage()) instead of
// the reference's own separate polling endpoint, since this app already has
// one general-purpose "background operation with progress" tracker (jobs.js)
// and every other pipeline stage already reports through it.
//
// This file has no knowledge of the render/translate/voice pipeline at all —
// it hands back a local file path and a probe result; index.js decides what
// to do with them. Nothing here touches the timing engine or any mode's own
// code path.
// ─────────────────────────────────────────────────────────────────────────────
const { spawn, execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');
const { probeVideo } = require('./ffmpeg');

const YT_DLP_BIN = process.env.YT_DLP_PATH || 'yt-dlp';

// Install/upgrade hints for error messages — the platform's own package
// manager first, pip as the fallback that works everywhere.
const YT_DLP_HINTS =
  process.platform === 'win32'
    ? { install: 'winget install yt-dlp.yt-dlp', upgrade: 'winget upgrade yt-dlp.yt-dlp' }
    : process.platform === 'darwin'
      ? { install: 'brew install yt-dlp', upgrade: 'brew upgrade yt-dlp' }
      : { install: 'pip install -U yt-dlp', upgrade: 'pip install -U yt-dlp' };
const withPip = (cmd) => (cmd.startsWith('pip ') ? cmd : `${cmd} (or: pip install -U yt-dlp)`);

// "Cap the download at a sensible size and duration so a mistake can't fill
// the disk" — not present in the reference at all; added here.
const MAX_DURATION_SEC = 60 * 60; // 1 hour
const MAX_FILESIZE = '2G'; // yt-dlp's own --max-filesize syntax

// TikTok/Douyin often reject requests that don't look like a real browser
// navigation — a plausible Referer and desktop Chrome UA make even the plain
// (no-cookies) attempt look like one. Kept verbatim from the reference.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const EXTRA_ARGS = ['--add-header', 'Referer: https://www.tiktok.com/', '--user-agent', USER_AGENT];

const isTikTokUrl = (url) => /tiktok\.com|douyin\.com/i.test(url);

/** A short, readable default name for output-file naming (job.originalName). */
function deriveNameFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
    return host || 'video';
  } catch (_) {
    return 'video';
  }
}

/** yt-dlp missing → a clear, actionable error instead of a cryptic ENOENT deep in a spawn call. */
function checkYtDlpInstalled() {
  return new Promise((resolve, reject) => {
    execFile(YT_DLP_BIN, ['--version'], (err) => {
      if (err && err.code === 'ENOENT') {
        reject(
          new Error(
            `yt-dlp isn't installed (or not on PATH as "${YT_DLP_BIN}"). Install it with: ` +
              `${withPip(YT_DLP_HINTS.install)}, then try the link again.`
          )
        );
      } else {
        resolve(); // any other error (bad flags, etc.) isn't "not installed" — let the real attempt surface it
      }
    });
  });
}

/**
 * tikwm.com is a public TikTok/Douyin video-fetch API — it does its own
 * challenge-solving server-side and just hands back a clean, watermark-free,
 * audio-included download link, sidestepping fighting TikTok's anti-bot
 * measures through yt-dlp entirely. Ported near-verbatim from the reference
 * (its own comment: "far more reliable than driving yt-dlp against TikTok
 * directly"). Returns true on success, false on any failure — the caller
 * always falls back to the yt-dlp attempts either way.
 */
async function tryTikwmDownload(url, destPath) {
  try {
    const apiRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30000),
    });
    if (!apiRes.ok) return false;
    const data = await apiRes.json();
    const playUrl = data && data.data && data.data.play;
    if (!playUrl) return false;

    const videoRes = await fetch(playUrl, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(120000) });
    if (!videoRes.ok || !videoRes.body) return false;

    // A size cap here too — tikwm.com bypasses yt-dlp entirely, so yt-dlp's
    // own --max-filesize never sees this path. Checked before committing to
    // the full download when the server reports it up front.
    const declaredLen = Number(videoRes.headers.get('content-length') || 0);
    if (declaredLen > 2 * 1024 * 1024 * 1024) return false;

    // Streamed straight to disk (not buffered in memory) — a video can be up
    // to the size cap, and this project already assumes local-disk-sized
    // files, not RAM-sized ones (see server/index.js's own multer limit).
    await pipeline(Readable.fromWeb(videoRes.body), fs.createWriteStream(destPath));
    return true;
  } catch (_) {
    try { fs.unlinkSync(destPath); } catch (_) {}
    return false;
  }
}

/**
 * Runs one yt-dlp invocation, reporting [download] NN.N% progress lines as
 * they arrive. `registerProc` (if given) is called IMMEDIATELY after spawn —
 * before waiting for the process to finish — so Cancel can actually kill a
 * download that's still in progress, the same registerProc() mechanism
 * every ffmpeg child process in this app already uses.
 */
function runYtDlp(args, { onProgress, registerProc } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(YT_DLP_BIN, args);
    } catch (e) {
      reject(e);
      return;
    }
    registerProc && registerProc(child);

    let output = '';
    let lastReportedPct = -100;
    const handleChunk = (buf) => {
      const text = buf.toString();
      output += text;
      if (!onProgress) return;
      for (const line of text.split(/\r|\n/)) {
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) {
          const pct = parseFloat(m[1]);
          // Throttled to every ~10% so the log doesn't flood — yt-dlp emits
          // a progress line multiple times a second.
          if (pct - lastReportedPct >= 10 || pct >= 99.9) {
            lastReportedPct = pct;
            onProgress(pct, line.trim());
          }
        }
      }
    };
    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output.slice(-2000) || `yt-dlp exited with code ${code}`));
    });
  });
}

/**
 * @param {string} url
 * @param {string} jobDir            already-created, empty working directory for this job
 * @param {{log?:Function, setStage?:Function, registerProc?:Function}} hooks
 * @returns {Promise<{path:string, probe:object, originalName:string}>}
 */
async function downloadFromUrl(url, jobDir, { log, setStage, registerProc } = {}) {
  await checkYtDlpInstalled();

  const outTemplate = path.join(jobDir, 'source.%(ext)s');
  const expectedPath = path.join(jobDir, 'source.mp4');
  const originalName = deriveNameFromUrl(url);

  const clearPartials = () => {
    for (const f of fs.readdirSync(jobDir)) {
      if (f.startsWith('source.')) {
        try { fs.unlinkSync(path.join(jobDir, f)); } catch (_) {}
      }
    }
  };

  const findDownloaded = () => {
    if (fs.existsSync(expectedPath)) return expectedPath;
    const cands = fs.readdirSync(jobDir).filter((f) => f.startsWith('source.')).sort();
    return cands.length ? path.join(jobDir, cands[0]) : null;
  };

  // Format selection is "bv*+ba/b" (best video + best audio, merged; fall
  // back to best pre-combined) — NEVER a bare "mp4" first, since that also
  // matches a video-only mp4 stream and yt-dlp will happily pick it without
  // ever adding audio. Kept verbatim from the reference, including the
  // --no-playlist safety and the --match-filter/--max-filesize caps added
  // for this port.
  const baseArgs = [
    '-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '--no-playlist',
    '--max-filesize', MAX_FILESIZE, '--match-filter', `duration<=${MAX_DURATION_SEC}`,
    ...EXTRA_ARGS, '-o', outTemplate, url,
  ];
  const chromeArgs = [...baseArgs, '--cookies-from-browser', 'chrome'];

  const onProgress = (pct, line) => {
    setStage && setStage(pct / 100);
    log && log(line);
  };

  const tryAttempt = async (args, label) => {
    clearPartials();
    log && log(`Trying download (${label})...`);
    try {
      await runYtDlp(args, { onProgress, registerProc });
    } catch (e) {
      log && log(`${label} attempt failed: ${String(e.message || e).slice(-400)}`);
      return null;
    }
    return findDownloaded();
  };

  let downloaded = null;

  // TikTok/Douyin: try tikwm.com first (see tryTikwmDownload) — falls
  // through to the yt-dlp attempts below on any failure.
  if (isTikTokUrl(url)) {
    clearPartials();
    log && log('TikTok/Douyin link — trying tikwm.com first...');
    if (await tryTikwmDownload(url, expectedPath)) {
      downloaded = expectedPath;
      log && log('Downloaded via tikwm.com.');
    }
  }

  if (!downloaded) downloaded = await tryAttempt(baseArgs, 'plain');
  if (!downloaded) downloaded = await tryAttempt(chromeArgs, 'Chrome cookies');

  if (!downloaded) {
    // Last resort before giving up: the extractor itself may just be behind
    // for this site — update in place and give the Chrome-cookies attempt
    // one final try. Kept verbatim from the reference.
    log && log('Both attempts failed — updating yt-dlp and trying once more...');
    try { await runYtDlp(['-U']); } catch (_) {}
    downloaded = await tryAttempt(chromeArgs, 'Chrome cookies, after update');
  }

  if (!downloaded) {
    clearPartials();
    throw new Error(
      'Could not download this video (the site may be blocking anonymous downloads, or yt-dlp is out of date for it). ' +
        `Try: ${withPip(YT_DLP_HINTS.upgrade)}, then try the link again.`
    );
  }

  // Verify it actually has audio and is inside the duration cap — catches a
  // video-only stream (a bad format match) or a tikwm.com download that
  // slipped past the header-only size pre-check.
  let probe = await probeVideo(downloaded);
  if (probe.duration > MAX_DURATION_SEC) {
    clearPartials();
    throw new Error(`Downloaded video is ${(probe.duration / 60).toFixed(0)} min, over the ${MAX_DURATION_SEC / 60}-minute cap.`);
  }

  if (!probe.hasAudio) {
    log && log('Downloaded file has no audio track — retrying once with a forced combined format...');
    const forcedArgs = [
      '-f', 'best', '--merge-output-format', 'mp4', '--no-playlist',
      '--max-filesize', MAX_FILESIZE, '--match-filter', `duration<=${MAX_DURATION_SEC}`,
      ...EXTRA_ARGS, '--cookies-from-browser', 'chrome', '-o', outTemplate, url,
    ];
    const forced = await tryAttempt(forcedArgs, 'forced combined format');
    if (!forced) {
      clearPartials();
      throw new Error('Downloaded video has no audio track — nothing to transcribe. Try a different link.');
    }
    probe = await probeVideo(forced);
    if (!probe.hasAudio) {
      clearPartials();
      throw new Error('Downloaded video has no audio track — nothing to transcribe. Try a different link.');
    }
    downloaded = forced;
  }

  return { path: downloaded, probe, originalName };
}

module.exports = { downloadFromUrl, checkYtDlpInstalled, isTikTokUrl, deriveNameFromUrl };

// ─────────────────────────────────────────────────────────────────────────────
// PORTING NOTES — reference-url-download.py → this file
//
// KEPT (proven behavior, ported as directly as the language change allows):
//   - The retry ladder: plain attempt → Chrome-cookies attempt → `yt-dlp -U`
//     (self-update) → one more Chrome-cookies attempt.
//   - tikwm.com as the FIRST attempt for TikTok/Douyin specifically, before
//     ever invoking yt-dlp for those hosts — the reference's own comment
//     calls this "far more reliable than driving yt-dlp against TikTok
//     directly," and it's a real, working proven trick, not guesswork.
//   - Format selection "bv*+ba/b" / --merge-output-format mp4 / --no-playlist,
//     and specifically NEVER a bare "mp4" fallback (the reference explains
//     why: it would match a video-only stream and yt-dlp wouldn't add audio).
//   - The Referer + desktop Chrome User-Agent headers for TikTok.
//   - clear_partials(): wiping stale source.f<id>.<ext> intermediate files
//     between retry attempts, so a later glob can't pick up a half-merged
//     leftover from an earlier failed attempt.
//   - Post-download audio verification via ffprobe, with one forced-format
//     retry if the first successful download turns out to have no audio
//     track at all.
//   - Downloading straight into the job's own working directory as
//     source.<ext> — this app's multer upload path already uses that exact
//     convention for picked files, so a downloaded source needs no special
//     casing anywhere else in the pipeline.
//
// CHANGED, and why:
//   - Python subprocess.run/Popen → Node child_process spawn/execFile. No
//     behavioral difference intended; this is purely the language port.
//   - The reference tracks downloads in its OWN separate `jobs{}` dict with
//     dedicated /download-url + /download-status polling endpoints, decoupled
//     from its main processing job. This app already has one general-purpose
//     "background operation with progress" tracker (server/services/jobs.js —
//     createJob/log/setStage/registerProc, the SAME thing every pipeline
//     stage already reports through) and an existing precedent for a job
//     PAUSING and being RESUMED by a later request (reviewBeforeVoice's
//     awaiting-review → /approve). A download is modeled the same way: a job
//     that pauses at status "source-ready" once the file lands, resumed by
//     POST /api/job/:id/process once the user has picked their settings.
//     This means download progress shows up in the SAME processing log the
//     rest of the pipeline already uses, for free, and Cancel already works
//     via the same registerProc() mechanism — no new UI plumbing needed.
//   - Size and duration caps ("a mistake can't fill the disk") are NOT in the
//     reference at all — added here via yt-dlp's own --max-filesize and
//     --match-filter flags (checked before a byte downloads, where
//     possible), plus a post-download ffprobe duration check as a backstop
//     for whichever path (tikwm.com or yt-dlp) didn't have that metadata
//     available up front.
//   - The reference resolves the yt-dlp binary as a path relative to its own
//     Python venv (Path(sys.executable).parent / "yt-dlp") — that's specific
//     to how ITS OWN server is deployed. This app just runs `yt-dlp` on PATH
//     (overridable via YT_DLP_PATH, matching how FFMPEG_PATH/FFPROBE_PATH
//     are already made overridable in services/ffmpeg.js), and fails with a
//     clear install message if it's missing, rather than assuming any one
//     install method.
//
// NOT ported:
//   - Everything in the reference that isn't about downloading a source
//     video at all — it also runs an entire separate translate/voice/render
//     pipeline as a Python subprocess (app.py), intro/outro clip upload,
//     font listing, and edge-tts voice preview endpoints. All of that is
//     already handled by this project's OWN existing, protected pipeline and
//     services — porting any of it would mean duplicating logic this app
//     already has, proven a different way.
// ─────────────────────────────────────────────────────────────────────────────
