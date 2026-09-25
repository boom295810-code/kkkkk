// ─────────────────────────────────────────────────────────────────────────────
// Recap Studio v2 — local server
// Single-shared-instance, no accounts: every job/history/settings route is
// open to anyone who can reach the server. The video pipeline runs locally,
// one job at a time.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

dotenv.config();

const { getTranscriptAndTimestamps } = require('./services/assemblyai');
const { translateUtterances } = require('./services/gemini');
const { generateTTSForUtterances, synth, buildSynthOpts } = require('./services/tts');
const {
  probeVideo,
  runFfmpeg,
  getAudioDuration,
  mixAudioOnly,
  mixAudioForRecap,
  verifyNoOverlap,
  probeStreamDurations,
} = require('./services/ffmpeg');
const { buildCaptionChunks, assertChunksValid, writeSrt, writeAss, DEFAULT_STYLE } = require('./services/srt');
const { renderVideo, outputSize } = require('./services/render');
const { listFonts: scanFonts } = require('./services/fonts');
const { runProRecapPipeline } = require('./services/proRecap');
const { listLanguages } = require('./services/proLanguages');
const { downloadFromUrl } = require('./services/download');
const historyApi = require('./services/history');
const jobsApi = require('./services/jobs');
const { createJob, getJob, log, setStage, registerProc, cancelJob, throwIfCancelled, publicView, warnIfTracksMismatch } = jobsApi;

const app = express();
const PORT = process.env.PORT || 5002;
const ROOT = __dirname;
// Overridable so a deploy target's persistent disk (e.g. Render) can be
// mounted outside the app's own code directory — same pattern as
// FFMPEG_PATH/FFPROBE_PATH/YT_DLP_PATH. Falls back to the local folders
// used in dev when unset.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(ROOT, 'outputs-5002');
const FONT_DIR = path.join(ROOT, 'fonts');
const SETTINGS_FILE = path.join(ROOT, 'settings.json');

for (const d of [UPLOAD_DIR, OUTPUT_DIR, FONT_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use('/outputs', express.static(OUTPUT_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7));
      fs.mkdirSync(dir, { recursive: true });
      req.__jobDir = dir;
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'source' + (path.extname(file.originalname) || '.mp4')),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4 GB, local disk
});

// ── settings (local file, replaces the old Mongo Settings model) ─────────────

const DEFAULT_SETTINGS = {
  assemblyAiKey: '',
  geminiKey: '',
  defaultVoice: 'my-MM-ThihaNeural',
  defaultRatio: 'original',
  outputName: '',
};

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}
function writeSettings(patch) {
  const merged = { ...readSettings(), ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  return merged;
}
const mask = (k) => (k ? k.slice(0, 6) + '…' + k.slice(-4) : '');
const ENV_ALIASES = {
  assemblyAiKey: ['ASSEMBLYAI_API_KEY', 'ASSEMBLYAIKEY'],
  geminiKey: ['GEMINI_API_KEY', 'GEMINIKEY', 'OPENROUTER_API_KEY'],
};
const keyFor = (name, fromBody) => {
  if (fromBody && String(fromBody).trim()) return String(fromBody).trim();
  const saved = readSettings()[name];
  if (saved) return saved;
  for (const alias of ENV_ALIASES[name] || []) {
    if (process.env[alias]) return process.env[alias];
  }
  return '';
};

// ── voices ───────────────────────────────────────────────────────────────────

const VOICES = [
  { id: 'thiha', label: 'Thiha (မြန်မာ ယောက်ျား)', voice: 'my-MM-ThihaNeural', rate: '+0%', pitch: '+0Hz', lang: 'my' },
  { id: 'thiha-warm', label: 'Thiha — Warm', voice: 'my-MM-ThihaNeural', rate: '-5%', pitch: '-2Hz', lang: 'my' },
  { id: 'thiha-crisp', label: 'Thiha — Crisp', voice: 'my-MM-ThihaNeural', rate: '+8%', pitch: '+3Hz', lang: 'my' },
  { id: 'nilar', label: 'Nilar (မြန်မာ မိန်းမ)', voice: 'my-MM-NilarNeural', rate: '+0%', pitch: '+0Hz', lang: 'my' },
  { id: 'nilar-soft', label: 'Nilar — Soft', voice: 'my-MM-NilarNeural', rate: '-5%', pitch: '-3Hz', lang: 'my' },
  { id: 'nilar-bright', label: 'Nilar — Bright', voice: 'my-MM-NilarNeural', rate: '+8%', pitch: '+4Hz', lang: 'my' },
  { id: 'en-guy', label: 'English — Guy (US)', voice: 'en-US-GuyNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-aria', label: 'English — Aria (US)', voice: 'en-US-AriaNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-jenny', label: 'English — Jenny (US)', voice: 'en-US-JennyNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-christopher', label: 'English — Christopher (US)', voice: 'en-US-ChristopherNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-sonia', label: 'English — Sonia (UK)', voice: 'en-GB-SoniaNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-ryan', label: 'English — Ryan (UK)', voice: 'en-GB-RyanNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-natasha', label: 'English — Natasha (AU)', voice: 'en-AU-NatashaNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  // Rest of the full en-US/en-GB edge-tts roster (verified live via
  // edge-tts-universal's listVoices(), 2026-08-27) for Pro AI Recap's
  // English output language — the picker filters to en-US/en-GB only there.
  { id: 'en-andrew', label: 'English — Andrew (US)', voice: 'en-US-AndrewNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-andrew-multi', label: 'English — Andrew Multilingual (US)', voice: 'en-US-AndrewMultilingualNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-ava', label: 'English — Ava (US)', voice: 'en-US-AvaNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-ava-multi', label: 'English — Ava Multilingual (US)', voice: 'en-US-AvaMultilingualNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-brian', label: 'English — Brian (US)', voice: 'en-US-BrianNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-brian-multi', label: 'English — Brian Multilingual (US)', voice: 'en-US-BrianMultilingualNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-emma', label: 'English — Emma (US)', voice: 'en-US-EmmaNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-emma-multi', label: 'English — Emma Multilingual (US)', voice: 'en-US-EmmaMultilingualNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-ana', label: 'English — Ana (US)', voice: 'en-US-AnaNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-eric', label: 'English — Eric (US)', voice: 'en-US-EricNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-michelle', label: 'English — Michelle (US)', voice: 'en-US-MichelleNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-roger', label: 'English — Roger (US)', voice: 'en-US-RogerNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-steffan', label: 'English — Steffan (US)', voice: 'en-US-SteffanNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-libby', label: 'English — Libby (UK)', voice: 'en-GB-LibbyNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-maisie', label: 'English — Maisie (UK)', voice: 'en-GB-MaisieNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
  { id: 'en-thomas', label: 'English — Thomas (UK)', voice: 'en-GB-ThomasNeural', rate: '+0%', pitch: '+0Hz', lang: 'en' },
];

// Family name is read from inside each font file — libass matches on family,
// not on filename, and the two often differ (A13_WenYoeRegular.ttf → "A13_WenYoe").
const listFonts = () => scanFonts(FONT_DIR);

// ── routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const s = readSettings();
  res.json({
    ok: true,
    version: 'recap-studio-v2',
    fonts: listFonts(),
    voices: VOICES,
    languages: listLanguages(),
    hasAssemblyKey: !!keyFor('assemblyAiKey'),
    hasGeminiKey: !!keyFor('geminiKey'),
    defaults: { voice: s.defaultVoice, ratio: s.defaultRatio },
  });
});

// Shared, app-wide config (AssemblyAI/Gemini keys, default voice/ratio) — a
// single local settings file, same as before accounts existed.
app.get('/api/settings', (req, res) => {
  const s = readSettings();
  res.json({ ...s, assemblyAiKey: mask(s.assemblyAiKey), geminiKey: mask(s.geminiKey) });
});

app.post('/api/settings', (req, res) => {
  const patch = {};
  for (const k of ['assemblyAiKey', 'geminiKey', 'defaultVoice', 'defaultRatio', 'outputName']) {
    if (typeof req.body[k] === 'string' && !req.body[k].includes('…')) patch[k] = req.body[k].trim();
  }
  const s = writeSettings(patch);
  res.json({ ok: true, settings: { ...s, assemblyAiKey: mask(s.assemblyAiKey), geminiKey: mask(s.geminiKey) } });
});

app.get('/api/voices', (req, res) => res.json({ voices: VOICES, fonts: listFonts(), languages: listLanguages() }));

app.get('/api/history', async (req, res) => {
  const history = await historyApi.listPublic();
  res.json({ history });
});

app.post('/api/tts-preview', async (req, res) => {
  try {
    const { voice, text, rateOffset } = req.body || {};
    const preset = VOICES.find((v) => v.id === voice) || (typeof voice === 'object' ? voice : VOICES[0]);
    const opts = buildSynthOpts(preset, rateOffset || 0);
    const sample =
      text || (preset.lang === 'en'
        ? 'This is a short voice preview for Recap Studio.'
        : 'မင်္ဂလာပါ။ ဒါကတော့ အသံအစမ်း နားထောင်ကြည့်တာပါ။');
    const buf = await synth(String(sample).slice(0, 400), opts);
    res.set('Content-Type', 'audio/mpeg').send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

function ownJobOrRespond(req, res) {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return null;
  }
  return job;
}

app.post('/api/job', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video uploaded.' });
    let settings = {};
    try { settings = JSON.parse(req.body.settings || '{}'); } catch (_) {}

    const job = createJob({
      jobDir: req.__jobDir,
      sourcePath: req.file.path,
      originalName: req.file.originalname,
      settings,
    });
    res.json({ jobId: job.id });
    runPipeline(job).catch((e) => finishWithError(job, e));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ── chunked upload ───────────────────────────────────────────────────────────
// Phones on mobile data drop long single-request uploads (multer then logs
// "Request aborted") and a Cloudflare quick tunnel caps one request at 100 MB.
// So the client sends the file in small pieces: init → PUT each piece at its
// byte offset (a failed piece is simply re-sent) → complete. The assembled
// file then enters the exact same pipeline as POST /api/job.
const CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024; // same cap as multer's
const UPLOAD_IDLE_MS = 60 * 60 * 1000; // abandoned uploads are removed after an hour
const chunkedUploads = new Map(); // uploadId → { dir, file, name, size, received, touched }

function dropStaleUploads() {
  const now = Date.now();
  for (const [id, u] of chunkedUploads) {
    if (now - u.touched > UPLOAD_IDLE_MS) {
      chunkedUploads.delete(id);
      fs.rm(u.dir, { recursive: true, force: true }, () => {});
    }
  }
}

app.post('/api/upload/init', (req, res) => {
  dropStaleUploads();
  const name = String((req.body || {}).name || 'video.mp4');
  const size = Number((req.body || {}).size);
  if (!Number.isInteger(size) || size <= 0 || size > UPLOAD_MAX_BYTES) {
    return res.status(400).json({ error: 'Invalid file size.' });
  }
  const dir = path.join(UPLOAD_DIR, String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'source' + (path.extname(name) || '.mp4'));
  fs.writeFileSync(file, '');
  const uploadId = crypto.randomBytes(12).toString('hex');
  chunkedUploads.set(uploadId, { dir, file, name, size, received: 0, touched: Date.now() });
  res.json({ uploadId });
});

app.put('/api/upload/:id', express.raw({ type: () => true, limit: CHUNK_MAX_BYTES }), async (req, res) => {
  const u = chunkedUploads.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Upload not found — start again.' });
  const offset = Number(req.query.offset);
  const buf = req.body;
  // Pieces arrive in order. Re-sending an already-received piece (its reply
  // was lost) just rewrites the same bytes; skipping ahead is refused with the
  // offset to resume from.
  if (!Number.isInteger(offset) || offset < 0 || offset > u.received) {
    return res.status(409).json({ error: 'Offset mismatch.', received: u.received });
  }
  if (!Buffer.isBuffer(buf) || !buf.length || offset + buf.length > u.size) {
    return res.status(400).json({ error: 'Bad chunk.' });
  }
  try {
    const fh = await fs.promises.open(u.file, 'r+');
    try {
      await fh.write(buf, 0, buf.length, offset);
    } finally {
      await fh.close();
    }
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
  u.received = Math.max(u.received, offset + buf.length);
  u.touched = Date.now();
  res.json({ received: u.received });
});

app.post('/api/upload/:id/complete', (req, res) => {
  const u = chunkedUploads.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Upload not found — start again.' });
  if (u.received !== u.size) {
    return res.status(409).json({ error: 'Upload incomplete.', received: u.received });
  }
  chunkedUploads.delete(req.params.id);
  const job = createJob({
    jobDir: u.dir,
    sourcePath: u.file,
    originalName: u.name,
    settings: (req.body || {}).settings || {},
  });
  res.json({ jobId: job.id });
  runPipeline(job).catch((e) => finishWithError(job, e));
});

app.get('/api/job/:id', (req, res) => {
  const job = ownJobOrRespond(req, res);
  if (!job) return;
  res.json(publicView(job));
});

// ── URL source (YouTube/TikTok/Facebook/Instagram via yt-dlp) ────────────────
// Modeled as a job that PAUSES at status "source-ready" once the file lands —
// the same pattern reviewBeforeVoice already uses (pause at "awaiting-review",
// resume via a follow-up POST) — rather than a separate download-tracking
// system. This means download progress shows up in the exact same processing
// log/percent the rest of the pipeline already reports through, and Cancel
// already works via the same registerProc() mechanism. See services/
// download.js's PORTING NOTES for what was kept/changed from the reference.
app.post('/api/download-url', (req, res) => {
  const url = String((req.body || {}).url || '').trim();
  if (!url) return res.status(400).json({ error: 'Missing url.' });

  const dir = path.join(UPLOAD_DIR, String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7));
  fs.mkdirSync(dir, { recursive: true });

  const job = createJob({ jobDir: dir, sourcePath: null, originalName: null, settings: {} });
  job.status = 'running';
  setStage(job, 'download', 0);
  res.json({ jobId: job.id });

  downloadFromUrl(url, dir, {
    log: (m) => log(job, m),
    setStage: (fraction) => setStage(job, 'download', fraction),
    registerProc: (child) => registerProc(job, child),
  })
    .then(({ path: sourcePath, probe, originalName }) => {
      if (job.status === 'cancelled') return;
      job.sourcePath = sourcePath;
      job.originalName = originalName;
      job.sourceInfo = { duration: probe.duration, width: probe.width, height: probe.height, originalName };
      job.status = 'source-ready';
      setStage(job, 'download', 1);
      log(job, `Downloaded: ${probe.width}x${probe.height}, ${probe.duration.toFixed(1)}s.`);
    })
    .catch((e) => {
      if (job.status === 'cancelled') return;
      finishWithError(job, e);
    });
});

app.post('/api/job/:id/process', (req, res) => {
  const job = ownJobOrRespond(req, res);
  if (!job) return;
  if (job.status !== 'source-ready') return res.status(400).json({ error: 'Job has no downloaded source ready yet.' });
  job.settings = req.body.settings || {};
  job.status = 'running';
  res.json({ ok: true });
  runPipeline(job).catch((e) => finishWithError(job, e));
});

app.get('/api/job/:id/source', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || !job.sourcePath || !fs.existsSync(job.sourcePath)) {
    return res.status(404).json({ error: 'Source not available.' });
  }
  res.sendFile(job.sourcePath);
});

app.post('/api/job/:id/approve', (req, res) => {
  const job = ownJobOrRespond(req, res);
  if (!job) return;
  if (job.status !== 'awaiting-review') return res.status(400).json({ error: 'Job is not awaiting review' });
  if (Array.isArray(req.body.blocks)) {
    job.blocks = job.blocks.map((b, i) => ({
      ...b,
      translatedText: req.body.blocks[i]?.translatedText ?? b.translatedText,
    }));
  }
  job.__approved = true;
  res.json({ ok: true });
});

app.post('/api/job/:id/cancel', (req, res) => {
  const job = ownJobOrRespond(req, res);
  if (!job) return;
  cancelJob(job);
  res.json({ ok: true });
});

// ── the pipeline ─────────────────────────────────────────────────────────────

function finishWithError(job, e) {
  if (String(e.message) === '__CANCELLED__') {
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    return;
  }
  console.error(`(${job.id}) FAILED:`, e);
  job.status = 'error';
  job.error = String(e.message || e);
  job.finishedAt = Date.now();
  log(job, 'ERROR: ' + job.error);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runPipeline(job) {
  const s = {
    mode: 'dubbing',
    ratio: 'original',
    fit: 'crop',
    focus: 'center',
    zoom: 1,
    voice: 'my-MM-ThihaNeural',
    voicePreset: 'thiha',
    voiceRate: 30,
    videoSpeed: 1,
    autoFit: true,
    originalAudio: 'mute',
    fps: 30,
    quality: 'normal',
    reviewBeforeVoice: false,
    subtitles: { enabled: true, burn: true, ...DEFAULT_STYLE },
    blur: { boxes: [], strength: 22, feather: 28, coverSubtitle: false },
    watermark: { enabled: false, text: '', position: 'bottom-right', opacity: 0.65 },
    ...job.settings,
  };
  job.status = 'running';

  // ── 1. probe ───────────────────────────────────────────────────────────────
  setStage(job, 'upload', 0.5);
  const probe = await probeVideo(job.sourcePath);
  if (!probe.hasVideo) throw new Error('That file has no video track.');
  log(job, `Source: ${probe.width}x${probe.height}, ${probe.duration.toFixed(1)}s, ${probe.fps}fps`);
  const mins = probe.duration / 60;
  if (mins > 30 && s.mode === 'recap') {
    log(job, `Note: ${mins.toFixed(0)} min in AI Recap mode builds a very large per-segment filter graph. Dubbing mode is much lighter for sources this long.`);
  } else if (mins > 60) {
    log(job, `Note: ${mins.toFixed(0)} min source — expect roughly ${(mins * 2).toFixed(0)} min of processing.`);
  }
  setStage(job, 'upload', 1);
  throwIfCancelled(job);

  // ── 2. extract audio ───────────────────────────────────────────────────────
  setStage(job, 'extract', 0.1);
  const wavPath = path.join(job.jobDir, 'audio.wav');
  await runFfmpeg(['-y', '-i', job.sourcePath, '-vn', '-ac', '1', '-ar', '16000', wavPath]);
  log(job, 'Audio extracted.');
  setStage(job, 'extract', 1);
  throwIfCancelled(job);

  // ── Pro Recap modes branch off here — everything below this block is the
  //    existing Dubbing/AI Recap pipeline, untouched, both in text and in
  //    execution (pro modes return before reaching it). ─────────────────────
  if (s.mode === 'pro-recap-mm') {
    const assemblyKey = keyFor('assemblyAiKey', s.assemblyAiKey);
    if (!assemblyKey) throw new Error('AssemblyAI API key မထည့်ရသေးပါ။ Settings ထဲမှာ ထည့်ပါ။');
    const geminiKey = keyFor('geminiKey', s.geminiKey);
    if (!geminiKey) throw new Error('Gemini API key မထည့်ရသေးပါ။ Settings ထဲမှာ ထည့်ပါ။');

    const baseName =
      (s.outputName && s.outputName.replace(/[^\w\-.]+/g, '_')) ||
      path.basename(job.originalName || 'recap', path.extname(job.originalName || '')).replace(/[^\w\-.]+/g, '_') ||
      'recap';

    await runProRecapPipeline({
      job,
      settings: s,
      probe,
      wavPath,
      assemblyKey,
      geminiKey,
      voices: VOICES,
      fontDir: FONT_DIR,
      outputDir: OUTPUT_DIR,
      baseName,
      stamp: Date.now(),
    });
    return;
  }

  // ── 3. transcribe (any language, auto-detected) ────────────────────────────
  setStage(job, 'transcribe', 0.05);
  const assemblyKey = keyFor('assemblyAiKey', s.assemblyAiKey);
  if (!assemblyKey) throw new Error('AssemblyAI API key မထည့်ရသေးပါ။ Settings ထဲမှာ ထည့်ပါ။');
  let blocks = await getTranscriptAndTimestamps(wavPath, assemblyKey, false);
  if (!blocks.length) throw new Error('No speech detected in this video.');
  log(job, `Transcribed: ${blocks.length} blocks.`);
  setStage(job, 'transcribe', 1);
  throwIfCancelled(job);

  // ── 4. translate ───────────────────────────────────────────────────────────
  setStage(job, 'translate', 0.05);
  const geminiKey = keyFor('geminiKey', s.geminiKey);
  if (!geminiKey) throw new Error('Gemini API key မထည့်ရသေးပါ။ Settings ထဲမှာ ထည့်ပါ။');
  blocks = await translateUtterances(blocks, geminiKey);
  log(job, 'Translation complete.');
  setStage(job, 'translate', 1);
  throwIfCancelled(job);

  // optional review pause
  if (s.reviewBeforeVoice) {
    job.blocks = blocks.map((b) => ({ start: b.start, end: b.end, text: b.text, translatedText: b.translatedText }));
    job.status = 'awaiting-review';
    log(job, 'Waiting for your review of the translation…');
    while (!job.__approved) {
      throwIfCancelled(job);
      await wait(700);
    }
    blocks = blocks.map((b, i) => ({ ...b, translatedText: job.blocks[i].translatedText }));
    job.status = 'running';
    log(job, 'Review approved — continuing.');
  }

  // ── 5. voice ───────────────────────────────────────────────────────────────
  setStage(job, 'voice', 0.02);
  const preset = VOICES.find((v) => v.id === s.voicePreset) || { voice: s.voice, rate: '+0%', pitch: '+0Hz' };
  // the engine's own base is +20%; s.voiceRate is what the user sees (default +30%)
  const extraRate = Math.round((s.voiceRate ?? 30) - 20);
  blocks = await generateTTSForUtterances(blocks, job.jobDir, preset, extraRate, (done, total) =>
    setStage(job, 'voice', done / total)
  );
  const voiced = blocks.filter((b) => b.audioFilePath);
  if (!voiced.length) throw new Error('Voice generation failed for every line (edge-tts unreachable?).');
  log(job, `Voice ready: ${voiced.length}/${blocks.length} clips.`);
  throwIfCancelled(job);

  // ── 6. timeline ────────────────────────────────────────────────────────────
  setStage(job, 'timeline', 0.2);
  const isRecap = s.mode === 'recap';
  let audioPath;
  let videoPlan;
  let timed;

  if (isRecap) {
    const r = await mixAudioForRecap(blocks, job.jobDir, probe.duration);
    audioPath = r.finalAudioPath;
    timed = r.utterancesForVideo;
    videoPlan = {
      type: 'segments',
      segments: r.utterancesForVideo.map((u) => ({
        origStart: u.origStart,
        origEnd: u.origEnd,
        ttsDuration: u.ttsDuration,
      })),
      totalDuration: r.totalVideoDuration,
      padSeconds: 0,
    };
    log(job, `AI Recap timeline: ${r.totalVideoDuration.toFixed(2)}s.`);
  } else {
    const r = await mixAudioOnly(blocks, job.jobDir, probe.duration);
    audioPath = r.finalAudioPath;
    timed = r.updatedUtterances;
    videoPlan = { type: 'global', speed: s.videoSpeed || 1, padSeconds: 0 };

    // auto-fit: never let the voice run past the picture
    if (s.autoFit) {
      const audioDur = await getAudioDuration(audioPath);
      let videoDur = probe.duration / (videoPlan.speed || 1);
      if (audioDur > videoDur + 0.15) {
        const tempo = Math.min(1.22, audioDur / videoDur);
        if (tempo > 1.005) {
          const fitted = path.join(job.jobDir, 'final_audio_fitted.mp3');
          await runFfmpeg(['-y', '-i', audioPath, '-filter:a', `atempo=${tempo.toFixed(4)}`, fitted]);
          audioPath = fitted;
          // every caption anchor moves with the tempo change
          timed = timed.map((u) => ({
            ...u,
            finalStartSec: u.finalStartSec / tempo,
            speedup: (u.speedup || 1) * tempo,
          }));
          log(job, `Auto-fit: voice tempo ×${tempo.toFixed(3)}.`);
        }
        const newAudioDur = await getAudioDuration(audioPath);
        if (newAudioDur > videoDur + 0.15) {
          const slow = Math.max(0.9, videoDur / newAudioDur);
          videoPlan.speed = (videoPlan.speed || 1) * slow;
          videoDur = probe.duration / videoPlan.speed;
          log(job, `Auto-fit: video speed ${videoPlan.speed.toFixed(3)}×.`);
          if (newAudioDur > videoDur + 0.15) {
            videoPlan.padSeconds = newAudioDur - videoDur;
            log(job, `Auto-fit: freeze-extending ${videoPlan.padSeconds.toFixed(2)}s of the last frame.`);
          }
        }
      }
    }
    log(job, `Dubbing timeline ready (video ${(videoPlan.speed || 1).toFixed(3)}×).`);
  }

  try {
    verifyNoOverlap(timed);
  } catch (e) {
    log(job, 'WARNING: ' + e.message);
  }

  // ── 7. captions ────────────────────────────────────────────────────────────
  const size = outputSize(probe.width, probe.height, s.ratio || 'original');
  const finalDuration =
    videoPlan.type === 'segments'
      ? videoPlan.totalDuration
      : probe.duration / (videoPlan.speed || 1) + (videoPlan.padSeconds || 0);

  const subStyle = { ...DEFAULT_STYLE, ...(s.subtitles || {}) };
  const chunks = buildCaptionChunks(timed, {
    maxWords: subStyle.maxWords,
    fontSize: subStyle.size,
    frameWidth: size.width,
    videoDuration: finalDuration,
  });
  try {
    assertChunksValid(chunks, finalDuration);
  } catch (e) {
    log(job, 'WARNING (captions): ' + e.message);
  }
  log(job, `Captions: ${chunks.length} chunks.`);

  const baseName =
    (s.outputName && s.outputName.replace(/[^\w\-.]+/g, '_')) ||
    path.basename(job.originalName || 'recap', path.extname(job.originalName || '')).replace(/[^\w\-.]+/g, '_') ||
    'recap';
  const stamp = Date.now();
  const srtPath = path.join(OUTPUT_DIR, `${baseName}-mm-${stamp}.srt`);
  writeSrt(chunks, srtPath);

  let assFile = null;
  if (subStyle.enabled !== false && subStyle.burn !== false && chunks.length) {
    const assPath = path.join(job.jobDir, 'captions.ass');
    const picked = subStyle.fontFile ? listFonts().find((f) => f.file === subStyle.fontFile) : null;
    const fontName = subStyle.fontFamily || (picked && picked.family) || DEFAULT_STYLE.font;
    if (subStyle.fontFile) log(job, `Caption font: ${subStyle.fontFile} → family "${fontName}"`);
    writeAss(chunks, assPath, { ...subStyle, font: fontName }, size);
    assFile = { path: assPath, fontsDir: FONT_DIR };
  }
  setStage(job, 'timeline', 1);
  throwIfCancelled(job);

  // ── 8. render ──────────────────────────────────────────────────────────────
  setStage(job, 'render', 0.01);
  const fonts = listFonts();
  const fontFile = subStyle.fontFile
    ? path.join(FONT_DIR, subStyle.fontFile)
    : fonts.length
    ? path.join(FONT_DIR, fonts[0].file)
    : null;

  const outputPath = path.join(OUTPUT_DIR, `${baseName}-mm-${stamp}.mp4`);
  const rendered = await renderVideo({
    jobDir: job.jobDir,
    sourcePath: job.sourcePath,
    audioPath,
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

  // ── 9. verify ──────────────────────────────────────────────────────────────
  // Per-track lengths — the container duration alone can't catch a picture
  // that stops early (see probeStreamDurations).
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
  };
  log(
    job,
    `Verify — A/V delta ${checks.durationDeltaMs}ms · ${checks.captionCount} captions · ` +
      `last caption ${checks.lastCaptionInsideVideo ? 'inside' : 'PAST'} the video · ${checks.fps}fps · ${checks.size}`
  );
  warnIfTracksMismatch(job, checks);

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
    fileName: path.basename(outputPath),
    videoUrl: job.result.videoUrl,
    srtUrl: job.result.srtUrl,
    videoPath: outputPath,
    srtPath,
    sourceName: job.originalName || 'video',
    mode: s.mode,
    outputLanguage: 'my', // Dubbing/AI Recap always output Burmese — see CLAUDE.md §1.4
    duration: rendered.duration,
    createdAt: job.finishedAt,
  });

  // clean the working folder, keep the outputs
  try { fs.rmSync(job.jobDir, { recursive: true, force: true }); } catch (_) {}
}

// ── serve the built client if it exists ──────────────────────────────────────
const CLIENT_DIST = path.join(ROOT, '..', 'client', 'dist');
if (fs.existsSync(CLIENT_DIST)) {
  // Vite puts a content hash in every /assets filename, so those are safe to
  // cache for a year — by the phone, and by Cloudflare's edge when the app is
  // reached through a tunnel, so repeat visits never touch this machine's
  // uplink. index.html stays uncached so a rebuild shows up at once.
  app.use('/assets', express.static(path.join(CLIENT_DIST, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
  app.use(express.static(CLIENT_DIST));
  app.get(/(.*)/, (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/outputs')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

historyApi.reconcileOnStartup();

app.listen(PORT, () => {
  console.log('');
  console.log('  Recap Studio v2  —  THET × DeepLearn AI');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
});
