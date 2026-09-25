// ─────────────────────────────────────────────────────────────────────────────
// history.js — last N completed renders, in a local JSON file
// (server/history.json, gitignored). One shared list for the whole app — no
// accounts, so no per-user scoping. The output files themselves still live
// on local disk (OUTPUT_DIR); this is just an index over them plus the
// metadata the UI wants: source name, mode, output language, duration.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

// Overridable so this can live alongside OUTPUT_DIR on a mounted persistent
// disk (e.g. Render) — same pattern as UPLOAD_DIR/OUTPUT_DIR in index.js.
const FILE = process.env.HISTORY_FILE || path.join(__dirname, '..', 'history.json');
const KEEP = 3;

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

function writeAll(rows) {
  fs.writeFileSync(FILE, JSON.stringify(rows, null, 2));
}

// Deletes an entry's MP4 + SRT from disk. Never throws — a missing/already-
// gone file is not an error here, it's the goal.
function deleteFiles(row) {
  for (const p of [row.videoPath, row.srtPath]) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      console.error(`history.js: failed to delete ${p}:`, e.message || e);
    }
  }
}

function toPublic(row) {
  const { videoPath, srtPath, ...pub } = row;
  return pub;
}

/** Most recent renders first. Never throws — a broken history panel
 * shouldn't take down the rest of the app. */
async function listPublic() {
  try {
    return readAll().map(toPublic);
  } catch (e) {
    console.error('history.js: failed to list history:', e.message || e);
    return [];
  }
}

/**
 * Records a finished render and prunes anything past the last KEEP,
 * deleting the pruned entries' MP4/SRT from disk.
 *
 * @param {object} entry
 * @param {string} entry.id             job id
 * @param {string} entry.fileName
 * @param {string} entry.videoUrl       e.g. /outputs/foo.mp4 (served path)
 * @param {string} entry.srtUrl
 * @param {string} entry.videoPath      absolute path, used only for deletion
 * @param {string} entry.srtPath        absolute path, used only for deletion
 * @param {string} entry.sourceName
 * @param {string} entry.mode
 * @param {string} entry.outputLanguage
 * @param {number} entry.duration
 * @param {number} entry.createdAt
 */
async function addEntry(entry) {
  const rows = [entry, ...readAll()];
  const overflow = rows.slice(KEEP);
  overflow.forEach(deleteFiles);
  writeAll(rows.slice(0, KEEP));
}

/** Startup pass: drop rows whose files were removed out-of-band, so the
 * history panel never offers a dead link. */
async function reconcileOnStartup() {
  try {
    const rows = readAll();
    const alive = rows.filter((r) => r.videoPath && fs.existsSync(r.videoPath));
    if (alive.length !== rows.length) {
      writeAll(alive);
      console.log(`history.js: reconciled ${rows.length - alive.length} stale history row(s) on startup.`);
    }
  } catch (e) {
    console.error('history.js: startup reconcile failed:', e.message || e);
  }
}

module.exports = { addEntry, listPublic, reconcileOnStartup };
