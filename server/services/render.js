// ─────────────────────────────────────────────────────────────────────────────
// render.js — server-side video render (replaces the old browser ffmpeg.wasm)
//
// One ffmpeg pass, in this order:
//   retime → aspect ratio/zoom → blur boxes → cover-subtitle band → watermark
//   → burned captions → encode (CFR) + loudness-normalised audio
//
// Blur box coordinates are NORMALISED 0..1 against the OUTPUT frame, which is
// exactly the frame the user sees in the preview. That is why ratio is applied
// before blur.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { FFMPEG, spawnFfmpeg, writeFilterScript, filterScriptOption, probeVideo, detectEncoders } = require('./ffmpeg');

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const f = (n) => Number(n).toFixed(4);

const RATIOS = {
  original: null,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
  '16:9': 16 / 9,
};

/** Escape a path for use inside a filter argument (ass=, fontfile=). */
function esc(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** Escape text for drawtext. */
function escText(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\%');
}

/** Work out the output frame size for the requested ratio. */
function outputSize(srcW, srcH, ratioKey) {
  const target = RATIOS[ratioKey];
  if (!target) return { width: even(srcW), height: even(srcH) };
  const longSide = Math.min(1920, Math.max(srcW, srcH));
  if (target < 1) {
    const h = even(longSide);
    return { width: even(h * target), height: h };
  }
  const w = even(longSide);
  return { width: w, height: even(w / target) };
}

// ── filter graph ─────────────────────────────────────────────────────────────

/**
 * @returns {{ graph:string, outLabel:string, audioLabel:string, size:{width,height}, expectedDuration:number }}
 */
function buildFilterGraph({ probe, videoPlan, settings, assFile, fontFile }) {
  const parts = [];
  let cur = '[0:v]';
  let n = 0;
  const next = () => `[v${++n}]`;

  // ── 1. retiming ────────────────────────────────────────────────────────────
  let expectedDuration;
  if (videoPlan.type === 'segments') {
    // AI Recap: each spoken segment stretches/compresses to its voice length,
    // gaps between them keep the original speed. Also used, unmodified, by
    // Pro AI Recap: its segments tile the whole source with zero gaps (each
    // block's span runs to the next block's start), so the infill-gap logic
    // below simply never triggers for it — same math (ratio = ttsDuration/
    // dur is algebraically the reference tool's speed=span/voice_dur, just
    // inverted), same proven branch, zero duplication.
    const segs = [...videoPlan.segments].sort((a, b) => a.origStart - b.origStart);
    const labels = [];
    let lastEnd = 0;
    let idx = 0;

    for (const s of segs) {
      const startSec = s.origStart / 1000;
      const endSec = s.origEnd / 1000;
      const dur = endSec - startSec;

      if (startSec - lastEnd > 0.05) {
        parts.push(`[0:v]trim=start=${f(lastEnd)}:end=${f(startSec)},setpts=PTS-STARTPTS[s${idx}];`);
        labels.push(`[s${idx}]`);
        idx++;
      }
      const ratio = dur > 0.01 ? s.ttsDuration / dur : 1;
      parts.push(
        `[0:v]trim=start=${f(startSec)}:end=${f(endSec)},setpts=${ratio.toFixed(6)}*(PTS-STARTPTS)[s${idx}];`
      );
      labels.push(`[s${idx}]`);
      idx++;
      lastEnd = endSec;
    }
    if (probe.duration - lastEnd > 0.05) {
      parts.push(`[0:v]trim=start=${f(lastEnd)}:end=${f(probe.duration)},setpts=PTS-STARTPTS[s${idx}];`);
      labels.push(`[s${idx}]`);
      idx++;
    }
    const out = next();
    parts.push(`${labels.join('')}concat=n=${idx}:v=1:a=0${out};`);
    cur = out;
    expectedDuration = videoPlan.totalDuration;
  } else {
    const speed = clamp(videoPlan.speed || 1, 0.5, 2);
    if (Math.abs(speed - 1) > 0.001) {
      const out = next();
      parts.push(`${cur}setpts=PTS/${f(speed)}${out};`);
      cur = out;
    }
    expectedDuration = probe.duration / speed;
  }

  // ── 1b. freeze-extend (last resort so the voice never outruns the picture) ─
  const pad = Math.max(0, videoPlan.padSeconds || 0);
  if (pad > 0.05) {
    const out = next();
    parts.push(`${cur}tpad=stop_mode=clone:stop_duration=${f(pad)}${out};`);
    cur = out;
    expectedDuration += pad;
  }

  // ── 1c. copyright: mirror + tiny random crop ──────────────────────────────
  // Deliberately BEFORE zoom/ratio/pad/blur: every later stage's coordinates
  // (blur box positions, pad's posX/posY, watermark position) are expressed
  // against whatever frame it receives — putting mirror here means they're
  // all working on the frame the user actually sees, so a box drawn on the
  // left still covers the same content once mirrored, and a positive pad
  // posX still pushes content right regardless of mirror state. Gated so
  // that with both off (the default) this emits nothing — byte-identical to
  // before.
  const copyrightCfg = settings.copyright || {};
  if (copyrightCfg.mirror) {
    const out = next();
    parts.push(`${cur}hflip${out};`);
    cur = out;
  }
  if (copyrightCfg.randomCrop) {
    // A few pixels, generated once per render — imperceptible, but enough to
    // shift the exact pixel content at the edges. scale back to the source's
    // own size afterward so nothing downstream sees a different resolution.
    const margin = 4;
    const dx = margin + Math.round((Math.random() * 2 - 1) * margin);
    const dy = margin + Math.round((Math.random() * 2 - 1) * margin);
    const srcW = even(probe.width);
    const srcH = even(probe.height);
    const out = next();
    parts.push(
      `${cur}crop=${srcW - 2 * margin}:${srcH - 2 * margin}:${dx}:${dy},scale=${srcW}:${srcH}${out};`
    );
    cur = out;
  }

  // ── 2. zoom (copyright nudge) ──────────────────────────────────────────────
  const zoom = clamp(settings.zoom || 1, 1, 1.3);
  if (zoom > 1.001) {
    const out = next();
    parts.push(`${cur}crop=iw/${f(zoom)}:ih/${f(zoom)}:(iw-iw/${f(zoom)})/2:(ih-ih/${f(zoom)})/2${out};`);
    cur = out;
  }

  // ── 3. aspect ratio ────────────────────────────────────────────────────────
  const size = outputSize(probe.width, probe.height, settings.ratio || 'original');
  const { width: W, height: H } = size;
  const needsResize =
    (settings.ratio && settings.ratio !== 'original') || W !== even(probe.width) || H !== even(probe.height);

  if (needsResize) {
    const fit = settings.fit || 'crop';
    if (fit === 'pad') {
      // blurred background instead of black bars
      const bg = next();
      parts.push(`${cur}split=2[padsrc][padbg];`);
      parts.push(
        `[padbg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=25${bg};`
      );

      // Inner scale/position: how the source sits inside the pad frame.
      // Gated so that at the defaults (1.00x, centred) this emits the EXACT
      // same two lines as before — nothing here can change AI Recap's or
      // Dubbing's output unless they actually opt into these new controls.
      const padCfg = settings.pad || {};
      const innerScale = clamp(padCfg.innerScale ?? 1, 1, 1.6);
      const posX = clamp(padCfg.posX ?? 0, -100, 100);
      const posY = clamp(padCfg.posY ?? 0, -100, 100);
      const hasInnerAdjust = Math.abs(innerScale - 1) > 0.001 || posX !== 0 || posY !== 0;

      if (hasInnerAdjust) {
        const fitted = next();
        const fg = next();
        const out = next();
        parts.push(`[padsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease${fitted};`);
        // Scale the already-fitted source up further; whatever now overflows
        // the frame is simply what the position-aware overlay below crops —
        // ffmpeg's overlay only draws the part that intersects the base frame.
        parts.push(`${fitted}scale=trunc(iw*${f(innerScale)}/2)*2:trunc(ih*${f(innerScale)}/2)*2${fg};`);
        parts.push(
          `${bg}${fg}overlay=(W-w)/2*${f(1 + posX / 100)}:(H-h)/2*${f(1 + posY / 100)}:format=auto${out};`
        );
        cur = out;
      } else {
        const fg = next();
        const out = next();
        parts.push(`[padsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease${fg};`);
        parts.push(`${bg}${fg}overlay=(W-w)/2:(H-h)/2${out};`);
        cur = out;
      }
    } else {
      const focus = settings.focus || 'center';
      const y = focus === 'top' ? '0' : focus === 'bottom' ? '(ih-oh)' : '(ih-oh)/2';
      const out = next();
      parts.push(
        `${cur}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)/2:${y}${out};`
      );
      cur = out;
    }
  }

  // ── 4. blur ────────────────────────────────────────────────────────────────
  // Two independent kinds, each with its own strength: 'caption' (the
  // cover-subtitle band, plus any manually-drawn box explicitly tagged as
  // caption blur) and 'background' (a manually-drawn box for a watermark,
  // logo, or face — the default kind for a new box). `mode` (band vs box)
  // is a SEPARATE, shape-driven concern — it only decides the feather
  // geometry below (band feathers top/bottom only, since it's always full
  // width; box feathers all four sides) — a box tagged 'caption' still
  // renders with box-shaped feathering, just at the caption strength.
  const blur = settings.blur || {};
  const captionSigma = clamp(blur.captionStrength ?? blur.strength ?? 22, 1, 60);
  const backgroundSigma = clamp(blur.backgroundStrength ?? blur.strength ?? 22, 1, 60);
  // Edge softness is a PERCENTAGE of the box's own half-extent, not a fixed
  // pixel count — a fixed px feather looked hard-edged on a large box (too
  // small a fraction of it) and blew past a small one. At 100 the gradient
  // reaches all the way to the shape's centre ("fades out well inside the
  // box"); at 0 it's a genuine hard edge. Computed per-box below since it
  // depends on that box's own size.
  const edgeSoftnessPct = clamp(blur.edgeSoftness ?? 40, 0, 100);
  const boxes = [];

  (blur.boxes || []).slice(0, 3).forEach((b) => {
    const bw = even(clamp(b.w, 0.02, 1) * W);
    const bh = even(clamp(b.h, 0.02, 1) * H);
    const bx = even(clamp(b.x, 0, 1) * W);
    const by = even(clamp(b.y, 0, 1) * H);
    const kind = b.kind === 'caption' ? 'caption' : 'background';
    const featherPx = Math.max(0.5, (edgeSoftnessPct / 100) * Math.min(bw, bh) / 2);
    boxes.push({
      x: Math.min(bx, W - bw), y: Math.min(by, H - bh), w: bw, h: bh,
      mode: 'box', sigma: kind === 'caption' ? captionSigma : backgroundSigma, featherPx,
    });
  });

  if (blur.coverSubtitle) {
    // Full width — source captions vary in width per clip, a narrow box always
    // leaves the ends of the foreign text visible.
    const bh = even(clamp((blur.bandHeightPct ?? 14) / 100, 0.03, 0.5) * H);
    const by = even(clamp(1 - (blur.bandBottomPct ?? 6) / 100, 0, 1) * H - bh);
    // Band only ever feathers top/bottom (it's always full width), so its
    // basis is its own height alone, not min(w,h).
    const featherPx = Math.max(0.5, (edgeSoftnessPct / 100) * bh / 2);
    boxes.push({ x: 0, y: Math.max(0, by), w: W, h: bh, mode: 'band', sigma: captionSigma, featherPx });
  }

  // Blur box/band coordinates are computed against W×H (the ratio-stage
  // output size). That's only guaranteed to be the ACTUAL current frame size
  // when the ratio stage itself already normalised it back to W×H (needsResize
  // true — both the crop-fit and pad-fit paths end in a literal W×H) or when
  // no zoom crop ran at all. If zoom shrank the frame (stage 2) and ratio was
  // 'original' (no resize, so nothing re-normalised it), the actual frame
  // reaching here is smaller than W×H — a literal box/band crop sized for W×H
  // then exceeds it (ffmpeg: "Invalid too big or non positive size"). Scale
  // back to the exact W×H only in that specific case, so every other
  // combination (zoom=1, blur off, or a ratio that already self-corrected)
  // emits the exact same graph as before.
  if (boxes.length && zoom > 1.001 && !needsResize) {
    const out = next();
    parts.push(`${cur}scale=${W}:${H}:force_original_aspect_ratio=disable,setsar=1${out};`);
    cur = out;
  }

  boxes.forEach((b, i) => {
    const keep = `[k${i}]`;
    const src = `[bsrc${i}]`;
    const patch = `[patch${i}]`;
    const out = next();
    // Feathered alpha is what makes the blur seamless — never overlay an opaque
    // crop (that reads as a glass rectangle sitting on top of the picture).
    const alpha =
      b.mode === 'band'
        ? `255*min(1,min(Y,H-Y)/${f(b.featherPx)})`
        : `255*min(1,min(min(X,W-X),min(Y,H-Y))/${f(b.featherPx)})`;
    parts.push(`${cur}split=2${keep}${src};`);
    parts.push(
      `${src}crop=${b.w}:${b.h}:${b.x}:${b.y},gblur=sigma=${f(b.sigma)}:steps=3,format=yuva420p,` +
        `geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='${alpha}'${patch};`
    );
    parts.push(`${keep}${patch}overlay=${b.x}:${b.y}:format=auto${out};`);
    cur = out;
  });

  // ── 5. watermark ───────────────────────────────────────────────────────────
  const wm = settings.watermark || {};
  if (wm.enabled && wm.text && fontFile) {
    const pos = wm.position || 'bottom-right';
    const m = Math.round(W * 0.04);
    const xy =
      pos === 'top-left' ? `x=${m}:y=${m}`
      : pos === 'top-right' ? `x=w-tw-${m}:y=${m}`
      : pos === 'bottom-left' ? `x=${m}:y=h-th-${m}`
      : pos === 'center' ? 'x=(w-tw)/2:y=(h-th)/2'
      : `x=w-tw-${m}:y=h-th-${m}`;
    const fsize = Math.round(H * 0.030);
    const out = next();
    parts.push(
      `${cur}drawtext=fontfile='${esc(fontFile)}':text='${escText(wm.text)}':fontcolor=white@${f(
        clamp(wm.opacity ?? 0.65, 0.05, 1)
      )}:fontsize=${fsize}:borderw=2:bordercolor=black@0.5:${xy}${out};`
    );
    cur = out;
  }

  // ── 6. burned captions ─────────────────────────────────────────────────────
  if (assFile) {
    const out = next();
    const fontsDir = path.dirname(assFile.fontsDir || assFile.path);
    parts.push(
      `${cur}ass='${esc(assFile.path)}'${assFile.fontsDir ? `:fontsdir='${esc(assFile.fontsDir)}'` : `:fontsdir='${esc(fontsDir)}'`}${out};`
    );
    cur = out;
  }

  const outLabel = '[vout]';
  parts.push(`${cur}format=yuv420p${outLabel};`);

  // ── audio ──────────────────────────────────────────────────────────────────
  // Input 1 is the finished Burmese voice track.
  const audioParts = [];
  const keepOriginal = settings.originalAudio || 'mute'; // mute | duck
  const canKeepOriginal = keepOriginal === 'duck' && videoPlan.type === 'global' && probe.hasAudio;

  if (canKeepOriginal) {
    const speed = clamp(videoPlan.speed || 1, 0.5, 2);
    const tempo = Math.abs(speed - 1) > 0.001 ? `,atempo=${f(speed)}` : '';
    audioParts.push(`[0:a]volume=-18dB${tempo}[oa];`);
    audioParts.push(`[1:a]volume=1.0[na];`);
    audioParts.push(`[oa][na]amix=inputs=2:dropout_transition=0:normalize=0[amix];`);
    // apad + an explicit -t keeps the track exactly as long as the picture:
    // -shortest would cut the video off where the last voice clip ends.
    audioParts.push(`[amix]loudnorm=I=-16:TP=-1.5:LRA=11,apad[aout];`);
  } else {
    audioParts.push(`[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,apad[aout];`);
  }

  const graph = parts.join('\n') + '\n' + audioParts.join('\n');
  return {
    graph: graph.replace(/;\s*$/, ''),
    outLabel,
    audioLabel: '[aout]',
    size,
    expectedDuration,
  };
}

// ── runner ───────────────────────────────────────────────────────────────────

function runWithProgress(args, { cwd, totalSeconds, onProgress, registerProc }) {
  return new Promise((resolve, reject) => {
    const child = spawnFfmpeg(args, { cwd });
    if (registerProc) registerProc(child);
    let tail = '';

    child.stdout.on('data', (d) => {
      const s = String(d);
      const m = [...s.matchAll(/out_time_us=(\d+)/g)].pop();
      if (m && totalSeconds > 0 && onProgress) {
        onProgress(clamp(Number(m[1]) / 1e6 / totalSeconds, 0, 1));
      }
    });
    child.stderr.on('data', (d) => {
      tail = (tail + String(d)).slice(-6000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}\n${tail}`));
    });
  });
}

// ── encoder selection ────────────────────────────────────────────────────────
// GPU encoders first (fastest wall-clock), CPU libx264 always last as the
// guaranteed-working fallback. "Available" from detectEncoders() only means
// ffmpeg was BUILT with that encoder — it says nothing about whether a real
// GPU/driver is behind it, so renderVideo() below still tries each candidate
// in order and falls through to the next on failure. CRF (0-51 scale, lower =
// higher quality) is reused as-is for the GPU quality knobs (-cq / -global_
// quality / -qp_i/-qp_p) — not a perfect equivalence with x264's CRF, but the
// same scale and a reasonable proxy.
async function pickVideoEncoderCandidates(crf) {
  const caps = await detectEncoders().catch(() => ({ nvenc: false, qsv: false, amf: false }));
  const candidates = [];
  if (caps.nvenc) {
    candidates.push({
      name: 'h264_nvenc',
      args: ['-c:v', 'h264_nvenc', '-profile:v', 'high', '-preset', 'p1', '-tune', 'hq', '-rc', 'vbr', '-cq', crf, '-b:v', '0'],
    });
  }
  if (caps.qsv) {
    candidates.push({
      name: 'h264_qsv',
      args: ['-c:v', 'h264_qsv', '-profile:v', 'high', '-preset', 'veryfast', '-global_quality', crf],
    });
  }
  if (caps.amf) {
    candidates.push({
      name: 'h264_amf',
      args: ['-c:v', 'h264_amf', '-profile:v', 'high', '-quality', 'speed', '-rc', 'cqp', '-qp_i', crf, '-qp_p', crf],
    });
  }
  // CPU fallback — always present. -threads 0 lets libx264 use every core;
  // -preset ultrafast + -tune fastdecode trade some compression efficiency
  // (bigger file at the same CRF) for a much faster encode.
  candidates.push({
    name: 'libx264',
    args: ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'ultrafast', '-tune', 'fastdecode', '-threads', '0', '-crf', crf],
  });
  return candidates;
}

/**
 * Render the final video.
 * @returns {{ outputPath:string, size:{width,height}, duration:number }}
 */
async function renderVideo({
  jobDir,
  sourcePath,
  audioPath,
  videoPlan,
  probe,
  settings,
  assFile,     // { path, fontsDir } or null
  fontFile,    // absolute path to a ttf, for the watermark
  outputPath,
  onProgress,
  registerProc,
}) {
  const { graph, outLabel, audioLabel, size, expectedDuration } = buildFilterGraph({
    probe,
    videoPlan,
    settings,
    assFile,
    fontFile,
  });

  const scriptPath = writeFilterScript(jobDir, 'filtergraph.txt', graph);
  const graphFileOpt = await filterScriptOption();
  const fps = clamp(settings.fps || 30, 24, 60);
  const crf = settings.quality === 'high' ? '18' : settings.quality === 'draft' ? '26' : '20';

  const tail = [
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    '-t', String(Math.max(0.5, expectedDuration).toFixed(3)),
    '-progress', 'pipe:1',
    '-nostats',
    outputPath,
  ];

  const buildArgs = (encoderArgs) => [
    '-hide_banner',
    '-y',
    '-i', sourcePath,
    '-i', audioPath,
    graphFileOpt, scriptPath,
    '-map', outLabel,
    '-map', audioLabel,
    ...encoderArgs,
    ...tail,
  ];

  // -fps_mode is the modern spelling; older builds only know -vsync.
  const runOneEncoder = async (encoderArgs) => {
    const base = buildArgs(encoderArgs);
    const withCfr = [...base];
    withCfr.splice(withCfr.indexOf('-r'), 0, '-fps_mode', 'cfr');
    try {
      await runWithProgress(withCfr, { cwd: jobDir, totalSeconds: expectedDuration, onProgress, registerProc });
    } catch (e) {
      if (/fps_mode|Unrecognized option|Option not found/i.test(e.message)) {
        const legacy = [...base];
        legacy.splice(legacy.indexOf('-r'), 0, '-vsync', 'cfr');
        await runWithProgress(legacy, { cwd: jobDir, totalSeconds: expectedDuration, onProgress, registerProc });
      } else {
        throw e;
      }
    }
  };

  // GPU encoders (NVENC/QSV/AMF) first if this ffmpeg binary has them, CPU
  // libx264 always last as the guaranteed-working fallback — a candidate
  // that's merely REGISTERED in the binary can still fail to open (no GPU,
  // no driver, wrong ffmpeg build), so each one is actually tried in order.
  const candidates = await pickVideoEncoderCandidates(crf);
  let lastErr;
  let usedEncoder = null;
  for (const candidate of candidates) {
    try {
      await runOneEncoder(candidate.args);
      usedEncoder = candidate.name;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[render] ${candidate.name} failed, falling back:`, String(e.message).split('\n')[0]);
    }
  }
  if (!usedEncoder) throw lastErr;

  try { fs.unlinkSync(scriptPath); } catch (_) {}

  const outProbe = await probeVideo(outputPath);
  return { outputPath, size, duration: outProbe.duration, probe: outProbe };
}

module.exports = { renderVideo, buildFilterGraph, outputSize, RATIOS, FFMPEG };
