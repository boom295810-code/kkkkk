// ─────────────────────────────────────────────────────────────────────────────
// ffmpeg.js — audio mixing + shared ffmpeg helpers
//
// The MIXING MATHS in mixAudioOnly() and mixAudioForRecap() is unchanged from
// the original be-recamp engine (it works). The only additions are extra fields
// in the return values (speedup, finalStartSec, wordBoundaries passthrough) so
// that srt.js can place captions on ABSOLUTE positions of the final audio.
// ─────────────────────────────────────────────────────────────────────────────
const { execFile, spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const path = require('path');
const fs = require('fs');

const FFMPEG = process.env.FFMPEG_PATH || ffmpegPath;
const FFPROBE = process.env.FFPROBE_PATH || ffprobePath;

// ── helpers ──────────────────────────────────────────────────────────────────

const runFfmpeg = (args, { onStderr } = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(FFMPEG, args, { maxBuffer: 1024 * 1024 * 64 }, (err, _out, stderr) => {
      if (err) {
        console.error('[ffmpeg error]', String(stderr).slice(-4000));
        return reject(new Error(String(stderr || err.message).slice(-2000)));
      }
      resolve();
    });
    if (onStderr && child.stderr) child.stderr.on('data', (d) => onStderr(String(d)));
  });

const ffprobeJson = (filePath, extra = []) =>
  new Promise((resolve, reject) => {
    execFile(
      FFPROBE,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', ...extra, filePath],
      { maxBuffer: 1024 * 1024 * 16 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error('Could not parse ffprobe output: ' + e.message));
        }
      }
    );
  });

const getAudioDuration = async (filePath) => {
  const info = await ffprobeJson(filePath);
  return parseFloat(info.format.duration);
};

/** Full probe of a video: duration, dimensions, fps, has-audio. */
const probeVideo = async (filePath) => {
  const info = await ffprobeJson(filePath);
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  let fps = 30;
  if (v && v.r_frame_rate && v.r_frame_rate.includes('/')) {
    const [n, d] = v.r_frame_rate.split('/').map(Number);
    if (d > 0 && n > 0) fps = n / d;
  }
  return {
    duration: parseFloat(info.format.duration) || 0,
    width: v ? v.width : 0,
    height: v ? v.height : 0,
    fps: Math.round(fps * 1000) / 1000,
    hasAudio: !!a,
    hasVideo: !!v,
  };
};

/**
 * Length of each track in a finished file. The container's format.duration is
 * the LONGER of the two, so comparing it with itself can't reveal a picture
 * that stops early — the A/V check must compare these per-stream lengths.
 */
const probeStreamDurations = async (filePath) => {
  const info = await ffprobeJson(filePath);
  const whole = parseFloat(info.format.duration) || 0;
  const len = (type) => {
    const s = (info.streams || []).find((x) => x.codec_type === type);
    if (!s) return 0;
    return parseFloat(s.duration) || whole;
  };
  return { video: len('video'), audio: len('audio') };
};

/**
 * Seconds of silence at the START of a clip, measured with silencedetect.
 * Needed because trimSilence() shifts every edge-tts word offset earlier.
 */
const detectLeadingSilence = (filePath) =>
  new Promise((resolve) => {
    execFile(
      FFMPEG,
      ['-hide_banner', '-i', filePath, '-af', 'silencedetect=noise=-50dB:d=0.03', '-f', 'null', '-'],
      { maxBuffer: 1024 * 1024 * 16 },
      (_err, _stdout, stderr) => {
        const text = String(stderr || '');
        const startMatch = text.match(/silence_start:\s*(-?[\d.]+)/);
        if (!startMatch || parseFloat(startMatch[1]) > 0.05) return resolve(0);
        const endMatch = text.match(/silence_end:\s*([\d.]+)/);
        resolve(endMatch ? Math.max(0, parseFloat(endMatch[1])) : 0);
      }
    );
  });

/** Long filter graphs must go through a file — macOS truncates huge argv silently. */
const writeFilterScript = (dir, name, graph) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, graph);
  return p;
};

// Which GPU H.264 encoders this ffmpeg binary was built with. Cached for the
// life of the process — `ffmpeg -encoders` is the same answer every call, and
// asking costs a process spawn. This only says the encoder is REGISTERED in
// the binary, not that a working GPU/driver is behind it — render.js still
// falls back to libx264 if an encoder that reports as present fails to open.
let _encoderCapsPromise = null;
const detectEncoders = () => {
  if (!_encoderCapsPromise) {
    _encoderCapsPromise = new Promise((resolve) => {
      execFile(FFMPEG, ['-hide_banner', '-encoders'], { maxBuffer: 1024 * 1024 * 8 }, (_err, stdout) => {
        const text = String(stdout || '');
        resolve({
          nvenc: /\bh264_nvenc\b/.test(text),
          qsv: /\bh264_qsv\b/.test(text),
          amf: /\bh264_amf\b/.test(text),
        });
      });
    });
  }
  return _encoderCapsPromise;
};

// The option that reads a filter graph from a file. FFmpeg 8 removed
// -filter_complex_script; its replacement "-/filter_complex <file>" doesn't
// exist before FFmpeg 7. Ask the binary once which one it lists, so the
// bundled 6.1 keeps getting exactly the same command as before.
let _filterScriptOptPromise = null;
const filterScriptOption = () => {
  if (!_filterScriptOptPromise) {
    _filterScriptOptPromise = new Promise((resolve) => {
      execFile(FFMPEG, ['-hide_banner', '-h', 'full'], { maxBuffer: 1024 * 1024 * 32 }, (_err, stdout) => {
        resolve(/filter_complex_script/.test(String(stdout || '')) ? '-filter_complex_script' : '-/filter_complex');
      });
    });
  }
  return _filterScriptOptPromise;
};

// ── shared clip mixer ────────────────────────────────────────────────────────
// One ffmpeg input per voice clip is fine for a short video, but a 1-hour
// source produces ~900 clips and macOS's default open-file limit is 256 — the
// mix would die with "Too many open files". So beyond MIX_GROUP clips the mix
// is done in groups and the groups are then summed. The MATHS is unchanged:
// every clip still carries its own absolute adelay, so grouping cannot move it.
const MIX_GROUP = 60;

const buildMixGraph = (clips, startIdx = 0) => {
  const lines = [];
  const labels = [];
  clips.forEach((c, i) => {
    const label = `m${startIdx + i}`;
    let chain = `[${i}:a]asetpts=PTS-STARTPTS`;
    if (c.atempo && Math.abs(c.atempo - 1) > 0.0001) chain += `,atempo=${c.atempo.toFixed(4)}`;
    const d = Math.max(0, Math.round(c.delayMs || 0));
    chain += `,adelay=${d}|${d}[${label}];`;
    lines.push(chain);
    labels.push(`[${label}]`);
  });
  return (
    lines.join('') +
    labels.join('') +
    `amix=inputs=${clips.length}:dropout_transition=1000:normalize=0[aout]`
  );
};

const mixOnePass = async (clips, outputDir, outPath, startIdx = 0) => {
  const inputArgs = [];
  clips.forEach((c) => inputArgs.push('-i', c.path));
  const graph = buildMixGraph(clips, startIdx);
  const scriptPath = writeFilterScript(outputDir, `mix_${startIdx}_${Date.now()}.txt`, graph);
  await runFfmpeg([
    ...inputArgs,
    await filterScriptOption(), scriptPath,
    '-map', '[aout]',
    '-ar', '44100', '-ac', '2',
    '-y', outPath,
  ]);
  try { fs.unlinkSync(scriptPath); } catch (_) {}
};

/**
 * Sum a list of clips, each at its own absolute offset, into one track.
 * @param {{path:string, delayMs:number, atempo?:number}[]} clips
 */
const mixClipsAtOffsets = async (clips, outputDir, finalPath) => {
  const valid = clips.filter((c) => c.path && fs.existsSync(c.path));

  if (valid.length === 0) {
    console.warn('[mix] No valid clips — returning 1s of silence.');
    await runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1', '-y', finalPath]);
    return finalPath;
  }

  if (valid.length <= MIX_GROUP) {
    await mixOnePass(valid, outputDir, finalPath);
    return finalPath;
  }

  // group pass — WAV intermediates so no mp3 encoder delay creeps into the timing
  const groups = [];
  for (let i = 0; i < valid.length; i += MIX_GROUP) groups.push(valid.slice(i, i + MIX_GROUP));
  console.log(`[mix] ${valid.length} clips → ${groups.length} groups of ≤${MIX_GROUP}`);

  const groupFiles = [];
  for (let g = 0; g < groups.length; g++) {
    const gp = path.join(outputDir, `mixgrp_${g}_${Date.now()}.wav`);
    await mixOnePass(groups[g], outputDir, gp, g * MIX_GROUP);
    groupFiles.push(gp);
  }

  // each group track already starts at 0 with its clips in place — just sum them
  await mixOnePass(groupFiles.map((p) => ({ path: p, delayMs: 0 })), outputDir, finalPath, 900000);
  groupFiles.forEach((p) => { try { fs.unlinkSync(p); } catch (_) {} });
  return finalPath;
};

// ── Dubbing mixer ────────────────────────────────────────────────────────────
// Each clip sits at its ORIGINAL timestamp and is sped up (1.2x–1.6x) to fit
// its slot. Video keeps its own timing. (Maths unchanged.)
const mixAudioOnly = async (utterances, outputDir, _videoDuration) => {
  const finalAudioPath = path.join(outputDir, `final_audio_${Date.now()}.mp3`);

  const clips = [];
  const updatedUtterances = [];

  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i];
    if (!u.audioFilePath || !fs.existsSync(u.audioFilePath)) continue;

    const audioDur = u.audioDuration || (await getAudioDuration(u.audioFilePath));
    const span = (u.end - u.start) / 1000;

    // Speedup logic: default 1.2x (matches TTS base rate), max 1.6x — unchanged
    const speedup = Math.max(1.2, Math.min(audioDur / span, 1.6));
    const newDur = audioDur / speedup;

    clips.push({ path: u.audioFilePath, delayMs: Math.round(u.start), atempo: speedup });

    updatedUtterances.push({
      ...u,
      speedup,                        // srt.js divides word offsets by this
      finalStartSec: u.start / 1000,  // absolute anchor on the final track
      newStartSec: u.start / 1000,
      newEndSec: u.start / 1000 + newDur,
    });
  }

  console.log(`[mixAudioOnly] ${clips.length}/${utterances.length} TTS clips ready for mixing.`);
  await mixClipsAtOffsets(clips, outputDir, finalAudioPath);

  const totalAudioDuration = await getAudioDuration(finalAudioPath);
  return { finalAudioPath, updatedUtterances, totalAudioDuration };
};

// ── AI Recap mixer ───────────────────────────────────────────────────────────
// No audio speedup. Voice is the master: every clip plays at its natural pace,
// original gaps are preserved, and the VIDEO gets stretched to match.
// (Maths unchanged.)
const mixAudioForRecap = async (utterances, outputDir, originalVideoDuration) => {
  const finalAudioPath = path.join(outputDir, `recap_audio_${Date.now()}.mp3`);

  const sorted = [...utterances].sort((a, b) => a.start - b.start);

  const withDurations = [];
  for (const u of sorted) {
    let ttsDuration = (u.end - u.start) / 1000;
    if (u.audioFilePath && fs.existsSync(u.audioFilePath)) {
      try {
        ttsDuration = u.audioDuration || (await getAudioDuration(u.audioFilePath));
      } catch (e) {
        console.warn('[Recap] Could not measure duration:', u.audioFilePath, e.message);
      }
    }
    withDurations.push({ ...u, ttsDuration });
  }

  let videoPos = 0;
  let lastOrigEndSec = 0;
  const utterancesForVideo = [];

  for (const u of withDurations) {
    const origStartSec = u.start / 1000;
    const origEndSec = u.end / 1000;
    const gapDur = origStartSec - lastOrigEndSec;

    if (gapDur > 0.01) videoPos += gapDur; // gap plays at original speed

    const newVideoStart = videoPos;
    videoPos += u.ttsDuration;

    utterancesForVideo.push({
      ...u,
      origStart: u.start,
      origEnd: u.end,
      ttsDuration: u.ttsDuration,
      newVideoStart,
      newVideoEnd: videoPos,
      speedup: 1,                    // ← recap never speeds a clip up
      finalStartSec: newVideoStart,  // ← absolute anchor on the final track
    });

    lastOrigEndSec = origEndSec;
  }

  const origTotalSec = originalVideoDuration || lastOrigEndSec;
  if (origTotalSec > lastOrigEndSec + 0.01) videoPos += origTotalSec - lastOrigEndSec;
  const totalVideoDuration = videoPos;

  const clips = utterancesForVideo
    .filter((u) => u.audioFilePath && fs.existsSync(u.audioFilePath))
    .map((u) => ({ path: u.audioFilePath, delayMs: Math.round(u.newVideoStart * 1000) }));

  console.log(`[mixAudioForRecap] ${clips.length}/${utterancesForVideo.length} clips will be mixed.`);
  await mixClipsAtOffsets(clips, outputDir, finalAudioPath);

  return { finalAudioPath, utterancesForVideo, totalVideoDuration };
};

/** Assert no two clips overlap on the final track. Throws if they do. */
const verifyNoOverlap = (items) => {
  const sorted = [...items].sort((a, b) => a.finalStartSec - b.finalStartSec);
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].finalStartSec + (sorted[i - 1].audioDuration || 0) / (sorted[i - 1].speedup || 1);
    if (sorted[i].finalStartSec + 0.001 < prevEnd - 0.05) {
      throw new Error(
        `Voice clips overlap: clip ${i} starts at ${sorted[i].finalStartSec.toFixed(3)}s ` +
          `but clip ${i - 1} ends at ${prevEnd.toFixed(3)}s`
      );
    }
  }
  return true;
};

module.exports = {
  FFMPEG,
  mixClipsAtOffsets,
  FFPROBE,
  runFfmpeg,
  spawnFfmpeg: (args, opts) => spawn(FFMPEG, args, opts),
  ffprobeJson,
  getAudioDuration,
  probeVideo,
  probeStreamDurations,
  detectLeadingSilence,
  writeFilterScript,
  filterScriptOption,
  detectEncoders,
  mixAudioOnly,
  mixAudioForRecap,
  verifyNoOverlap,
};
