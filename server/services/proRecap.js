// ─────────────────────────────────────────────────────────────────────────────
// proRecap.js — orchestrator for the "Pro AI Recap" mode. Output language
// (Burmese, English, ...) is a SETTING within this one mode, not a separate
// mode or code path — see proLanguages.js.
//
// For DIALOGUE source videos. Ported from the timing/sync design of the old
// Python dubbing tool (reference-dubbing-timing.py): scene spans TILE the
// entire source with zero gaps — span_i runs from block i's own start to
// block i+1's start (the last one to the end of the video; block 0's start is
// pulled back to 0.0 so any lead-in footage rides inside its own segment).
// Any silence between blocks is simply part of the PRECEDING block's span and
// gets retimed along with it — there is no separate "gap" concept at all.
//
// The voice track is built once, continuously, at a fixed TTS rate, and is
// NEVER tempo-adjusted afterward — it is the fixed master timeline. Each
// block's video segment gets its own INDEPENDENT, UNCLAMPED playback speed
// (speed_i = span_i / voice_dur_i) so that segment's retimed length matches
// that block's own share of the continuous voice track exactly. Because
// voice_dur_i is TELESCOPED from consecutive voice placements (voice_dur_i =
// placement[i+1].start - placement[i].start, last one to the track's end),
// the segments' retimed durations sum EXACTLY to the total voice duration no
// matter how many blocks there are — sync cannot drift by construction, only
// ffmpeg's own frame-boundary snapping can leave a few-millisecond residual,
// which a small fixed safety pad absorbs.
//
// Reuses the same proven engine pieces AI Recap uses: assemblyai.js,
// tts.js's generateTTSForUtterances, ffmpeg.js's mixClipsAtOffsets /
// getAudioDuration, srt.js's buildCaptionChunks / writers, render.js's
// renderVideo — and, deliberately, its `segments` video-plan branch too: the
// per-segment retime formula here (span/voice_dur) is algebraically identical
// to that branch's own ratio=ttsDuration/dur (just the reciprocal), and since
// these spans tile with zero gaps its infill logic simply never triggers.
// AI Recap's own mixAudioForRecap is never called from here — this file is
// fully additive; it does not change how the `segments` branch behaves.
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const fs = require('fs');

const { getTranscriptAndTimestamps } = require('./assemblyai');
const { generateTTSForUtterances } = require('./tts');
const { getAudioDuration, probeStreamDurations, mixClipsAtOffsets } = require('./ffmpeg');
const { translateForProRecap } = require('./proTranslate');
const { buildCaptionChunks, assertChunksValid, writeSrt, writeAss, DEFAULT_STYLE } = require('./srt');
const { renderVideo, outputSize } = require('./render');
const { listFonts } = require('./fonts');
const { getLanguage } = require('./proLanguages');
const { log, setStage, throwIfCancelled, registerProc, warnIfTracksMismatch } = require('./jobs');
const historyApi = require('./history');

// Fixed safety pad on the render, matching the reference tool's tpad — ffmpeg's
// own frame-boundary snapping on each trim can leave the rendered concat a
// hair short even though the segment durations are mathematically exact; this
// small pad plus the encoder's explicit -t (see render.js) guarantees the
// video always has enough frames for the audio to finish over.
const SAFETY_PAD_SEC = 0.12;
const SPEED_WARN_THRESHOLD = 4.0;

/**
 * @param {object} args
 * @param {object} args.job          the job record (jobDir, sourcePath, id, ...)
 * @param {object} args.settings     resolved settings (mode, ratio, subtitles, blur, watermark, fps, quality, voicePreset, voiceRate, ...)
 * @param {object} args.probe        probeVideo() result of the source file
 * @param {string} args.wavPath      extracted mono 16k wav (already built by index.js, same as AI Recap)
 * @param {string} args.assemblyKey
 * @param {string} args.geminiKey
 * @param {Array}  args.voices       VOICES list from index.js
 * @param {string} args.fontDir
 * @param {string} args.outputDir
 * @param {string} args.baseName
 * @param {number} args.stamp
 */
async function runProRecapPipeline({
  job,
  settings: s,
  probe,
  wavPath,
  assemblyKey,
  geminiKey,
  voices,
  fontDir,
  outputDir,
  baseName,
  stamp,
}) {
  // Output language is a setting WITHIN Pro AI Recap, not a separate mode —
  // see proLanguages.js. Everything language-specific (prompt wording,
  // chars/sec budget, voice list, caption font/script) flows from this one
  // lookup; adding a third language never means touching this file's logic.
  const lang = getLanguage(s.outputLanguage);
  log(job, `Output language: ${lang.label} (chars/sec=${lang.charsPerSec}).`);

  // ── 1. transcribe — identical call to AI Recap's ──────────────────────────
  setStage(job, 'transcribe', 0.05);
  const blocks = await getTranscriptAndTimestamps(wavPath, assemblyKey, false);
  if (!blocks.length) throw new Error('No speech detected in this video.');
  log(job, `Transcribed: ${blocks.length} blocks.`);
  setStage(job, 'transcribe', 1);
  throwIfCancelled(job);

  const n = blocks.length;
  const totalDurationMs = probe.duration * 1000;

  // ── 2. scene spans TILE the source — zero gaps, nothing cut ───────────────
  //      span_i = [block[i].start, block[i+1].start), last one to video end.
  //      Silence between blocks is simply part of the preceding block's span.
  for (let i = 0; i < n; i++) {
    const sceneStart = blocks[i].start;
    const sceneEnd = i + 1 < n ? blocks[i + 1].start : totalDurationMs;
    blocks[i].sceneStart = sceneStart;
    blocks[i].sceneEnd = Math.max(sceneEnd, sceneStart + 50);
  }
  // Block 0 absorbs any lead-in: the voice track has no silent gap for
  // lead-in footage to sit in, so it has to ride along inside block 0's span.
  blocks[0].sceneStart = 0;
  log(job, `Timeline: ${n} block(s), spans tile the full ${probe.duration.toFixed(2)}s source — nothing cut.`);
  throwIfCancelled(job);

  // ── 3. translate — faithful, one continuous narrator, budget per block's ─
  //      own spoken duration (not its tiled span, which may include absorbed
  //      silence) so translation length tracks what was actually said.
  const withKeptDur = blocks.map((b) => ({ ...b, keptDurSec: (b.end - b.start) / 1000 }));
  const totalSpokenDurSec = withKeptDur.reduce((sum, b) => sum + b.keptDurSec, 0) || 1;
  const totalBudgetChars = Math.round(totalSpokenDurSec * lang.charsPerSec);

  setStage(job, 'translate', 0.05);
  const { blocks: translated } = await translateForProRecap(withKeptDur, geminiKey, {
    totalDurationSec: totalSpokenDurSec,
    totalBudgetChars,
    totalKeptDurSec: totalSpokenDurSec,
    languageId: lang.id,
  });
  log(job, `Translation complete (${translated.length} block(s), ~${totalBudgetChars} chars budget at ${lang.charsPerSec} chars/sec).`);
  setStage(job, 'translate', 1);
  throwIfCancelled(job);

  // ── 4. voice — ONE continuous track at a fixed TTS rate, NEVER re-tempoed ─
  setStage(job, 'voice', 0.02);
  // Guard against a stale voice selection left over from a different output
  // language (e.g. a Burmese preset still selected after switching to
  // English) — fall back to the language's own default rather than handing
  // mismatched-language text to a voice that can't read it.
  let preset = voices.find((v) => v.id === s.voicePreset && v.lang === lang.id);
  if (!preset) {
    preset = voices.find((v) => v.id === lang.defaultVoiceId) || voices.find((v) => v.lang === lang.id) || voices[0];
    log(job, `Voice preset didn't match ${lang.label} — using ${preset ? preset.label : 'the first available voice'} instead.`);
  }
  const extraRate = Math.round((s.voiceRate ?? 30) - 20); // same convention as AI Recap
  const voiced = await generateTTSForUtterances(translated, job.jobDir, preset, extraRate, (done, total) =>
    setStage(job, 'voice', done / total)
  );

  const anyVoiced = voiced.some((b) => b.audioFilePath && b.translatedText);
  if (!anyVoiced) throw new Error('Voice generation failed for every line (edge-tts unreachable?).');
  throwIfCancelled(job);

  // Continuous placements: block i's voice starts exactly where block i-1's
  // ended (zero gaps, zero inserted silence). A block with no usable audio
  // gets a zero-width placement — it contributes nothing to the track but
  // doesn't break the telescoping math below.
  const placements = [];
  const clips = [];
  const withOffsets = [];
  let voicePos = 0;
  for (const b of voiced) {
    if (b.audioFilePath && b.translatedText) {
      const v = b.audioDuration || 0;
      placements.push({ start: voicePos, end: voicePos + v });
      clips.push({ path: b.audioFilePath, delayMs: voicePos * 1000 });
      withOffsets.push({ ...b, finalStartSec: voicePos, speedup: 1 });
      voicePos += v;
    } else {
      placements.push({ start: voicePos, end: voicePos });
    }
  }
  const totalVoiceDuration = voicePos;

  const voicePath = path.join(job.jobDir, `pro_voice_${Date.now()}.mp3`);
  await mixClipsAtOffsets(clips, job.jobDir, voicePath);
  const V = await getAudioDuration(voicePath);
  if (V < 0.5) throw new Error('Voice track came out too short to continue — TTS likely failed.');
  throwIfCancelled(job);

  // ── 5. per-block video segments: UNCLAMPED speed, telescoped voice_dur ────
  //      video_dur_i = placement[i+1].start - placement[i].start (last one to
  //      the track's end) — these telescope to exactly totalVoiceDuration, so
  //      N independently-retimed segments can never drift no matter how many
  //      blocks there are. The video adapts to the voice; the voice never
  //      adapts to the video.
  const renderSegments = [];
  let speedsAboveWarn = 0;
  for (let i = 0; i < n; i++) {
    const spanSec = Math.max((blocks[i].sceneEnd - blocks[i].sceneStart) / 1000, 0.02);
    const voiceDur = Math.max(i + 1 < n ? placements[i + 1].start - placements[i].start : totalVoiceDuration - placements[i].start, 0.02);
    const speed = spanSec / voiceDur;

    renderSegments.push({ origStart: blocks[i].sceneStart, origEnd: blocks[i].sceneEnd, ttsDuration: voiceDur });

    log(job, `Block ${i}: span=${spanSec.toFixed(2)}s, voice=${voiceDur.toFixed(2)}s, speed=${speed.toFixed(3)}×`);
    if (speed > SPEED_WARN_THRESHOLD) {
      speedsAboveWarn++;
      log(
        job,
        `WARNING: block ${i} speed ${speed.toFixed(2)}× exceeds ${SPEED_WARN_THRESHOLD}× ` +
          `(span=${spanSec.toFixed(2)}s, voice=${voiceDur.toFixed(2)}s) — mostly silence in this span, not clamped.`
      );
    }
  }
  if (speedsAboveWarn) log(job, `${speedsAboveWarn}/${n} block(s) exceeded the ${SPEED_WARN_THRESHOLD}× speed watch line.`);
  setStage(job, 'timeline', 0.3);

  // ── 6. captions from the final voice track's real word boundaries ────────
  const size = outputSize(probe.width, probe.height, s.ratio || 'original');
  const subStyle = { ...DEFAULT_STYLE, ...(s.subtitles || {}) };
  const chunks = buildCaptionChunks(withOffsets, {
    maxWords: subStyle.maxWords,
    fontSize: subStyle.size,
    frameWidth: size.width,
    videoDuration: V,
    script: lang.script,
  });
  try {
    assertChunksValid(chunks, V);
  } catch (e) {
    log(job, 'WARNING (captions): ' + e.message);
  }
  log(job, `Captions: ${chunks.length} chunks.`);

  const srtPath = path.join(outputDir, `${baseName}-${lang.fileTag}-pro-${stamp}.srt`);
  writeSrt(chunks, srtPath);

  let assFile = null;
  if (subStyle.enabled !== false && subStyle.burn !== false && chunks.length) {
    const assPath = path.join(job.jobDir, 'captions.ass');
    const fonts = listFonts(fontDir);
    // Only consider a font file matching this language's script — a leftover
    // Burmese font selection must not be used for English output, or vice versa.
    const picked = subStyle.fontFile ? fonts.find((f) => f.file === subStyle.fontFile && f.script === lang.script) : null;
    const fontName = subStyle.fontFamily || (picked && picked.family) || lang.defaultFontFamily;
    writeAss(chunks, assPath, { ...subStyle, font: fontName }, size);

    // libass scans fontsdir itself, independent of listFonts()'s own
    // filtering, and tries to open every entry it finds as a font file —
    // server/fonts/ has a stray non-font subdirectory that trips that scan
    // with a non-fatal "Is a directory" read error. Hand libass a curated,
    // job-scoped copy containing only the real font files instead; it's
    // cleaned up with the rest of jobDir when the job finishes.
    const curatedFontsDir = path.join(job.jobDir, 'fonts');
    fs.mkdirSync(curatedFontsDir, { recursive: true });
    for (const fnt of fonts) {
      try {
        fs.copyFileSync(path.join(fontDir, fnt.file), path.join(curatedFontsDir, fnt.file));
      } catch (_) {}
    }
    assFile = { path: assPath, fontsDir: curatedFontsDir };
  }
  setStage(job, 'timeline', 1);
  throwIfCancelled(job);

  // ── 7. render — reuses AI Recap's own `segments` video-plan branch ────────
  //      unmodified (see render.js comment): same retime formula, and these
  //      spans tile with zero gaps so its infill logic never triggers.
  setStage(job, 'render', 0.01);
  const fonts = listFonts(fontDir);
  const fontFile = subStyle.fontFile
    ? path.join(fontDir, subStyle.fontFile)
    : fonts.length
    ? path.join(fontDir, fonts[0].file)
    : null;

  const outputPath = path.join(outputDir, `${baseName}-${lang.fileTag}-pro-${stamp}.mp4`);
  const videoPlan = { type: 'segments', segments: renderSegments, totalDuration: V, padSeconds: SAFETY_PAD_SEC };

  const rendered = await renderVideo({
    jobDir: job.jobDir,
    sourcePath: job.sourcePath,
    audioPath: voicePath,
    videoPlan,
    probe,
    settings: s,
    assFile,
    fontFile,
    outputPath,
    onProgress: (fr) => setStage(job, 'render', fr),
    registerProc: (child) => registerProc(job, child),
  });
  throwIfCancelled(job);

  // ── 8. verify — same shape/log AI Recap already prints ───────────────────
  // Per-track lengths — see probeStreamDurations for why not format.duration.
  const tracks = await probeStreamDurations(outputPath).catch(() => ({ video: rendered.duration, audio: rendered.duration }));
  const checks = {
    videoDuration: Number(tracks.video.toFixed(3)),
    audioDuration: Number(tracks.audio.toFixed(3)),
    durationDeltaMs: Math.round(Math.abs(tracks.video - tracks.audio) * 1000),
    captionCount: chunks.length,
    lastCaptionEnd: chunks.length ? Number(chunks[chunks.length - 1].end.toFixed(3)) : 0,
    lastCaptionInsideVideo: !chunks.length || chunks[chunks.length - 1].end <= tracks.video + 0.05,
    fps: rendered.probe.fps,
    size: `${rendered.size.width}x${rendered.size.height}`,
    outputLanguage: lang.id,
    charsPerSec: lang.charsPerSec,
    sourceDurationSec: Number(probe.duration.toFixed(2)),
    blocksTotal: n,
    blocksAboveSpeedWarn: speedsAboveWarn,
  };
  log(
    job,
    `Verify — A/V delta ${checks.durationDeltaMs}ms · ${checks.captionCount} captions · ` +
      `last caption ${checks.lastCaptionInsideVideo ? 'inside' : 'PAST'} the video · ${checks.fps}fps · ${checks.size}`
  );
  warnIfTracksMismatch(job, checks);
  log(
    job,
    `Summary — source ${probe.duration.toFixed(2)}s → output ${rendered.duration.toFixed(2)}s, ` +
      `A/V delta ${checks.durationDeltaMs}ms, ${speedsAboveWarn}/${n} block(s) above ${SPEED_WARN_THRESHOLD}×.`
  );

  job.result = {
    videoUrl: `/outputs/${path.basename(outputPath)}`,
    srtUrl: `/outputs/${path.basename(srtPath)}`,
    fileName: path.basename(outputPath),
    duration: rendered.duration,
    size: rendered.size,
    checks,
  };
  job.status = 'done';
  job.percent = 100;
  job.finishedAt = Date.now();
  log(job, 'Done.');

  await historyApi.addEntry({
    id: job.id,
    userId: job.userId,
    fileName: path.basename(outputPath),
    videoUrl: job.result.videoUrl,
    srtUrl: job.result.srtUrl,
    videoPath: outputPath,
    srtPath,
    sourceName: job.originalName || 'video',
    mode: s.mode,
    outputLanguage: lang.id,
    duration: rendered.duration,
    createdAt: job.finishedAt,
  });

  try { fs.rmSync(job.jobDir, { recursive: true, force: true }); } catch (_) {}
}

module.exports = { runProRecapPipeline };
