// ─────────────────────────────────────────────────────────────────────────────
// tts.js — edge-tts synthesis
//
// Unchanged from the original engine: retry logic, the reverse→trim→reverse
// silence trick (ffmpeg stop_periods cuts at the first INTERNAL pause, so it
// must not be used), parallel batches of 8.
//
// NEW: every clip also returns real WordBoundary events from edge-tts, with the
// leading silence that trimSilence() removed already subtracted. srt.js uses
// these to place captions on absolute positions of the final audio, which is
// what kills the cumulative caption drift.
// ─────────────────────────────────────────────────────────────────────────────
const { Communicate } = require('edge-tts-universal');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { FFMPEG, getAudioDuration, detectLeadingSilence } = require('./ffmpeg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Synthesise one string.
 * @returns {{ buffer: Buffer, boundaries: {text:string,startSec:number,endSec:number}[] }}
 */
async function synthWithBoundaries(text, opts, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const c = new Communicate(text, opts);
      const audio = [];
      const boundaries = [];
      for await (const ch of c.stream()) {
        if (ch.type === 'audio' && ch.data) {
          audio.push(Buffer.from(ch.data));
        } else if (ch.type === 'WordBoundary') {
          // edge-tts reports 100-nanosecond ticks
          const startSec = (ch.offset || 0) / 1e7;
          const endSec = startSec + (ch.duration || 0) / 1e7;
          boundaries.push({ text: ch.text || '', startSec, endSec });
        }
      }
      return { buffer: Buffer.concat(audio), boundaries };
    } catch (e) {
      console.error(`Edge TTS try ${i} failed:`, e.message);
      if (i === tries) throw e;
      await sleep(1000 * i);
    }
  }
}

/** Back-compat: the preview endpoint only wants bytes. */
async function synth(text, opts, tries = 3) {
  const { buffer } = await synthWithBoundaries(text, opts, tries);
  return buffer;
}

// Trim leading AND trailing silence using the reverse/trim/reverse trick.
async function trimSilence(inputPath, outputPath) {
  await new Promise((resolve, reject) => {
    execFile(
      FFMPEG,
      [
        '-y',
        '-i', inputPath,
        '-af',
        [
          'silenceremove=start_periods=1:start_threshold=-50dB',
          'areverse',
          'silenceremove=start_periods=1:start_threshold=-50dB',
          'areverse',
        ].join(','),
        outputPath,
      ],
      (err, _stdout, stderr) => {
        if (err) {
          console.error('[trimSilence error]', String(stderr).slice(-2000));
          return reject(new Error(stderr || err.message));
        }
        resolve();
      }
    );
  });
}

/** Build the edge-tts options object from a voice preset + a user speed offset. */
function buildSynthOpts(voiceOptions = {}, extraRatePercent = 0) {
  const baseRate = 20; // engine base = 1.2x
  const presetRate = parseInt(String(voiceOptions.rate || '+0%').replace('%', ''), 10) || 0;
  const finalRate = baseRate + presetRate + (parseInt(extraRatePercent, 10) || 0);

  let pitch = voiceOptions.pitch || '+0Hz';
  if (!pitch.startsWith('+') && !pitch.startsWith('-')) pitch = '+' + pitch;
  if (!pitch.endsWith('Hz')) pitch = pitch + 'Hz';

  return {
    voice: typeof voiceOptions === 'string' ? voiceOptions : voiceOptions.voice || 'my-MM-NilarNeural',
    rate: `${finalRate >= 0 ? '+' : ''}${finalRate}%`,
    pitch,
    volume: '+0%',
  };
}

/**
 * One clip per block.
 * Adds to each utterance: audioFilePath, audioDuration, wordBoundaries[].
 */
const generateTTSForUtterances = async (utterances, outputDir, voiceOptions = {}, extraRatePercent = 0, onTick) => {
  const processed = [...utterances];
  const BATCH_SIZE = 8;
  const synthOpts = buildSynthOpts(voiceOptions, extraRatePercent);
  let done = 0;

  for (let i = 0; i < processed.length; i += BATCH_SIZE) {
    const batch = processed.slice(i, i + BATCH_SIZE);
    console.log(`[TTS] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(processed.length / BATCH_SIZE)}`);

    await Promise.allSettled(
      batch.map(async (u, b) => {
        const idx = i + b;
        if (!u.translatedText) return;

        const ts = Date.now();
        const rand = Math.random().toString(36).slice(2, 7);
        const rawPath = path.join(outputDir, `raw_tts_${ts}_${idx}_${rand}.mp3`);
        const trimmedPath = path.join(outputDir, `tts_${ts}_${idx}_${rand}.mp3`);

        try {
          const { buffer, boundaries } = await synthWithBoundaries(u.translatedText, synthOpts);

          // edge-tts sometimes returns a ~44-byte empty file for a line it will
          // not voice. Treat that as silence and carry on — never crash the job.
          if (!buffer || buffer.length < 512) {
            console.warn(`[TTS] Empty audio for block ${idx} — treated as silence.`);
            return;
          }

          fs.writeFileSync(rawPath, buffer);
          const lead = await detectLeadingSilence(rawPath);
          await trimSilence(rawPath, trimmedPath);
          fs.unlinkSync(rawPath);

          processed[idx].audioFilePath = trimmedPath;
          processed[idx].audioDuration = await getAudioDuration(trimmedPath);
          processed[idx].wordBoundaries = boundaries.map((w) => ({
            text: w.text,
            startSec: Math.max(0, w.startSec - lead),
            endSec: Math.max(0, w.endSec - lead),
          }));
        } catch (err) {
          console.error(`[TTS] Failed block ${idx}:`, err.message);
          try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch (_) {}
        } finally {
          done++;
          if (onTick) onTick(done, processed.length);
        }
      })
    );

    if (i + BATCH_SIZE < processed.length) await sleep(200);
  }

  return processed;
};

module.exports = { generateTTSForUtterances, synth, synthWithBoundaries, buildSynthOpts };
