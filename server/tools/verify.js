#!/usr/bin/env node
/**
 * verify.js — offline self-test of the render path.
 *
 * Builds a synthetic video + voice track and pushes them through the SAME
 * code the real pipeline uses (caption chunking → ass → renderVideo), then
 * reports the five checks from CLAUDE.md §8. No API keys, no network.
 *
 *   node tools/verify.js
 */
const fs = require('fs');
const path = require('path');
const { runFfmpeg, probeVideo, probeStreamDurations, getAudioDuration, mixAudioForRecap, mixAudioOnly } = require('../services/ffmpeg');
const { buildCaptionChunks, assertChunksValid, writeSrt, writeAss } = require('../services/srt');
const { renderVideo, outputSize } = require('../services/render');

const TMP = path.join(__dirname, '..', 'uploads', 'verify');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const say = (...a) => console.log(' ', ...a);

async function main() {
  // ── fixtures ───────────────────────────────────────────────────────────────
  const source = path.join(TMP, 'source.mp4');
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source,
  ]);
  const probe = await probeVideo(source);
  say(`fixture video: ${probe.width}x${probe.height} ${probe.duration.toFixed(2)}s ${probe.fps}fps`);

  // three fake "voice clips"
  const blocks = [];
  const spans = [[500, 3200], [4000, 7000], [8000, 11500]];
  for (let i = 0; i < spans.length; i++) {
    const clip = path.join(TMP, `clip${i}.mp3`);
    const dur = (spans[i][1] - spans[i][0]) / 1000 - 0.3;
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 90}:duration=${dur}`, clip]);
    blocks.push({
      start: spans[i][0],
      end: spans[i][1],
      text: `line ${i}`,
      translatedText: 'မြန်မာ စာကြောင်း တစ်ကြောင်း။ နောက်ထပ် စာကြောင်း တစ်ကြောင်း။',
      audioFilePath: clip,
      audioDuration: await getAudioDuration(clip),
      wordBoundaries: [],
    });
  }

  const results = [];

  for (const mode of ['dubbing', 'recap']) {
    say('');
    say(`── ${mode.toUpperCase()} ─────────────────────────────`);
    let audioPath, videoPlan, timed;

    if (mode === 'recap') {
      const r = await mixAudioForRecap(blocks, TMP, probe.duration);
      audioPath = r.finalAudioPath;
      timed = r.utterancesForVideo;
      videoPlan = {
        type: 'segments',
        segments: r.utterancesForVideo.map((u) => ({ origStart: u.origStart, origEnd: u.origEnd, ttsDuration: u.ttsDuration })),
        totalDuration: r.totalVideoDuration,
      };
    } else {
      const r = await mixAudioOnly(blocks, TMP, probe.duration);
      audioPath = r.finalAudioPath;
      timed = r.updatedUtterances;
      videoPlan = { type: 'global', speed: 1 };
    }

    const settings = {
      ratio: '9:16',
      fit: 'crop',
      focus: 'center',
      zoom: 1.02,
      fps: 30,
      quality: 'draft',
      originalAudio: 'mute',
      blur: { boxes: [{ x: 0.1, y: 0.7, w: 0.8, h: 0.1 }], strength: 20, feather: 24, coverSubtitle: true, bandHeightPct: 12, bandBottomPct: 5 },
      watermark: { enabled: false },
    };

    const size = outputSize(probe.width, probe.height, settings.ratio);
    const finalDuration = videoPlan.type === 'segments' ? videoPlan.totalDuration : probe.duration;
    const chunks = buildCaptionChunks(timed, { maxWords: 6, fontSize: 46, frameWidth: size.width, videoDuration: finalDuration });
    assertChunksValid(chunks, finalDuration);
    say(`captions: ${chunks.length} chunks, last ends ${chunks[chunks.length - 1].end.toFixed(2)}s`);

    const assPath = path.join(TMP, `captions-${mode}.ass`);
    writeAss(chunks, assPath, { font: 'Sans', size: 46 }, size);
    writeSrt(chunks, path.join(TMP, `captions-${mode}.srt`));

    const out = path.join(TMP, `out-${mode}.mp4`);
    const rendered = await renderVideo({
      jobDir: TMP,
      sourcePath: source,
      audioPath,
      videoPlan,
      probe,
      settings,
      assFile: { path: assPath, fontsDir: path.join(__dirname, '..', 'fonts') },
      fontFile: null,
      outputPath: out,
      onProgress: () => {},
    });

    const tracks = await probeStreamDurations(out); // per-track, not the container's length
    const checks = {
      mode,
      deltaMs: Math.round(Math.abs(tracks.video - tracks.audio) * 1000),
      captions: chunks.length,
      lastCaptionInside: chunks[chunks.length - 1].end <= tracks.video + 0.05,
      fps: rendered.probe.fps,
      size: `${rendered.size.width}x${rendered.size.height}`,
      duration: rendered.duration.toFixed(2),
    };
    results.push(checks);
    say(`A/V delta ${checks.deltaMs}ms · ${checks.fps}fps · ${checks.size} · ${checks.duration}s · last caption ${checks.lastCaptionInside ? 'inside ✓' : 'PAST ✗'}`);
  }

  console.log('\n', JSON.stringify(results, null, 2));
  const bad = results.filter((r) => r.deltaMs > 150 || !r.lastCaptionInside || Math.abs(r.fps - 30) > 0.2);
  if (bad.length) {
    console.error('\nFAILED checks:', bad);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
