// ─────────────────────────────────────────────────────────────────────────────
// jobs.js — in-memory job store (single user, one machine, no database)
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const STAGES = ['upload', 'extract', 'transcribe', 'translate', 'voice', 'timeline', 'render'];
const STAGE_RANGE = {
  // URL-sourced jobs use 'download' INSTEAD OF 'upload' as their first stage
  // (same range — it's the same "get the source video onto the server"
  // step, just server-side-fetched instead of browser-uploaded). Purely
  // additive: file-upload jobs never set this stage, so this new key has
  // zero effect on them.
  download: [0, 5],
  upload: [0, 5],
  extract: [5, 10],
  transcribe: [10, 35],
  translate: [35, 55],
  voice: [55, 72],
  timeline: [72, 78],
  render: [78, 100],
};

const jobs = new Map();

function createJob(payload = {}) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    status: 'queued', // queued | running | awaiting-review | done | error | cancelled
    stage: 'upload',
    percent: 0,
    log: [],
    createdAt: Date.now(),
    finishedAt: null,
    error: null,
    blocks: null,
    result: null,
    procs: new Set(),
    ...payload,
  };
  jobs.set(id, job);
  // keep only the 20 most recent jobs in memory
  if (jobs.size > 20) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest && oldest.status !== 'running') jobs.delete(oldest.id);
  }
  return job;
}

const getJob = (id) => jobs.get(id);

/**
 * Loud log line when the finished picture and voice differ in length. Healthy
 * renders measure 0–200 ms apart (a few frames); the threshold is set well
 * above that so it only fires on a real failure like a picture that stops early.
 */
const TRACK_MISMATCH_WARN_MS = 1000;
function warnIfTracksMismatch(job, checks) {
  if (checks.durationDeltaMs <= TRACK_MISMATCH_WARN_MS) return;
  const gap = ((checks.audioDuration - checks.videoDuration)).toFixed(1);
  log(
    job,
    checks.videoDuration < checks.audioDuration
      ? `⚠ PROBLEM: the picture stops ${gap}s before the voice ends (video ${checks.videoDuration.toFixed(1)}s, voice ${checks.audioDuration.toFixed(1)}s). Don't use this video — try a shorter source or close other apps and render again.`
      : `⚠ PROBLEM: picture and voice lengths differ by ${(checks.durationDeltaMs / 1000).toFixed(1)}s. Check this video before using it.`
  );
}

function log(job, message) {
  if (!job) return;
  const line = `[${new Date().toLocaleTimeString('en-GB')}] ${message}`;
  job.log.push(line);
  if (job.log.length > 200) job.log.shift();
  console.log(`(${job.id}) ${message}`);
}

/** Set the stage and an optional 0..1 fraction inside that stage. */
function setStage(job, stage, fraction = 0) {
  if (!job) return;
  job.stage = stage;
  const [lo, hi] = STAGE_RANGE[stage] || [0, 100];
  job.percent = Math.round(lo + (hi - lo) * Math.max(0, Math.min(1, fraction)));
}

function registerProc(job, child) {
  if (!job) return;
  job.procs.add(child);
  child.on('close', () => job.procs.delete(child));
}

function cancelJob(job) {
  if (!job) return false;
  job.status = 'cancelled';
  for (const p of job.procs) {
    try { p.kill('SIGKILL'); } catch (_) {}
  }
  job.procs.clear();
  log(job, 'Cancelled by user.');
  return true;
}

const throwIfCancelled = (job) => {
  if (job.status === 'cancelled') throw new Error('__CANCELLED__');
};

/** Everything the client is allowed to see. */
function publicView(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    log: job.log.slice(-40),
    error: job.error,
    blocks: job.status === 'awaiting-review' ? job.blocks : undefined,
    result: job.result,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    // Set once a URL download finishes (status becomes 'source-ready') so the
    // client can populate its probe/preview state exactly as it would for a
    // locally-picked file. null/undefined for every other kind of job.
    sourceInfo: job.sourceInfo || null,
  };
}

module.exports = {
  STAGES,
  createJob,
  getJob,
  log,
  setStage,
  registerProc,
  cancelJob,
  throwIfCancelled,
  publicView,
  warnIfTracksMismatch,
  jobs,
};
