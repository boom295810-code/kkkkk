// ─────────────────────────────────────────────────────────────────────────────
// srt.js — caption chunking + .srt / .ass writers
//
// THE RULE THAT MATTERS: every chunk time is ABSOLUTE on the final mixed voice
// track. It is built from (block.finalStartSec) + (real edge-tts word offset,
// corrected for trimmed leading silence and for any atempo speed-up applied by
// the mixer). Nothing is accumulated, so cumulative drift cannot happen.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');

const DEFAULT_STYLE = {
  font: 'Noto Sans Myanmar',
  size: 46,            // for a 1080-tall frame; scaled by frame height below
  primary: '#FFE600',  // vivid yellow
  outline: '#000000',
  outlineWidth: 3,
  shadow: 0,
  position: 'bottom',  // bottom | middle | custom
  marginPct: 12,       // distance from the bottom edge, % of frame height
  maxWords: 6,
  bold: true,
};

// ── helpers ──────────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function toSrtTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function toAssTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** #RRGGBB → &HAABBGGRR (ASS wants BGR with an alpha byte in front). */
function toAssColour(hex, alpha = 0) {
  const h = String(hex || '#FFFFFF').replace('#', '').padEnd(6, '0');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  const a = Math.round(clamp(alpha, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/**
 * Map edge-tts WordBoundary events back onto the original Burmese string so the
 * caption keeps the real spacing and the ။ punctuation instead of a naive join.
 */
function mapBoundariesToText(text, boundaries) {
  let cursor = 0;
  return boundaries.map((w) => {
    const needle = (w.text || '').trim();
    let from = -1;
    if (needle) {
      from = text.indexOf(needle, cursor);
      if (from === -1) from = text.indexOf(needle);
    }
    if (from === -1) {
      return { ...w, from: cursor, to: cursor };
    }
    const to = from + needle.length;
    cursor = to;
    return { ...w, from, to };
  });
}

/** Rough Burmese glyph width so we can limit by PIXELS, not character count. */
function fitsOnOneLine(str, fontSize, frameWidth) {
  const avgGlyph = fontSize * 0.55;
  return str.length * avgGlyph <= frameWidth * 0.82;
}

// ── chunking ─────────────────────────────────────────────────────────────────

/**
 * @param {Array} blocks   utterances carrying finalStartSec, speedup, audioDuration,
 *                         wordBoundaries[], translatedText
 * @param {Object} opts    { maxWords, fontSize, frameWidth, videoDuration, script }
 *                         `script` ('burmese' default | 'latin') only affects the
 *                         no-word-boundaries fallback split below — the normal,
 *                         boundary-driven path already works for either script.
 *                         Every existing caller (AI Recap, Dubbing) omits it, so
 *                         they get the exact same 'burmese' behavior as before.
 * @returns {Array<{start:number,end:number,text:string}>}
 */
function buildCaptionChunks(blocks, opts = {}) {
  const maxWords = opts.maxWords || DEFAULT_STYLE.maxWords;
  const fontSize = opts.fontSize || DEFAULT_STYLE.size;
  const frameWidth = opts.frameWidth || 1080;
  const script = opts.script || 'burmese';
  const chunks = [];

  for (const b of blocks) {
    const text = (b.translatedText || '').trim();
    if (!text) continue;

    const anchor = typeof b.finalStartSec === 'number' ? b.finalStartSec : b.start / 1000;
    const speed = b.speedup || 1;
    const clipDur = (b.audioDuration || (b.end - b.start) / 1000) / speed;

    let words = Array.isArray(b.wordBoundaries) ? b.wordBoundaries : [];

    if (words.length === 0) {
      // Fallback: no boundaries (TTS failed / older clip) — distribute the block
      // duration proportionally by visual character count. Burmese phrases
      // often have no spaces at all (relying on ။/၊ for breaks); English
      // always does — so the split rule differs, only here.
      const pieces = (script === 'latin' ? text.split(/\s+/) : text.split(/(?<=။|၊)\s*|\s+/)).filter(Boolean);
      const totalChars = pieces.reduce((n, p) => n + p.length, 0) || 1;
      let t = 0;
      words = pieces.map((p) => {
        const d = (p.length / totalChars) * clipDur;
        const w = { text: p, startSec: t, endSec: t + d, from: -1, to: -1 };
        t += d;
        return w;
      });
    } else {
      words = mapBoundariesToText(text, words).map((w) => ({
        ...w,
        startSec: w.startSec / speed,
        endSec: w.endSec / speed,
      }));
    }

    // group words → chunks
    let group = [];
    const flush = () => {
      if (group.length === 0) return;
      const first = group[0];
      const last = group[group.length - 1];
      let str;
      if (first.from >= 0 && last.to > first.from) str = text.slice(first.from, last.to).trim();
      else str = group.map((w) => w.text).join(' ').trim();
      if (str) {
        chunks.push({
          start: anchor + first.startSec,
          end: anchor + Math.max(last.endSec, first.startSec + 0.35),
          text: str,
        });
      }
      group = [];
    };

    for (const w of words) {
      group.push(w);
      const joined = group.map((g) => g.text).join(' ');
      const endsPhrase = /[။၊.!?]$/.test((w.text || '').trim());
      if (endsPhrase || group.length >= maxWords || !fitsOnOneLine(joined, fontSize, frameWidth)) {
        flush();
      }
    }
    flush();
  }

  // ── global cleanup ─────────────────────────────────────────────────────────
  // Order matters here. The minimum-readable-time bump must be applied BEFORE
  // the no-overlap ceiling, never after — doing it after is what pushed a very
  // short caption past the start of the next one ("Captions overlap at #29").
  chunks.sort((a, b) => a.start - b.start);

  const limit = opts.videoDuration ? opts.videoDuration - 0.05 : Infinity;

  // starts must be strictly increasing
  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i].start < chunks[i - 1].start + 0.05) chunks[i].start = chunks[i - 1].start + 0.05;
  }

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const next = chunks[i + 1];
    const ceiling = next ? next.start - 0.01 : limit; // hard, never crossed
    if (c.end < c.start + 0.4) c.end = c.start + 0.4; // minimum readable time (a wish)
    c.end = Math.min(c.end + 0.2, ceiling);           // hold against flicker, capped
    if (c.end <= c.start) c.end = Math.min(c.start + 0.15, ceiling);
  }

  // finally clamp to the video and drop anything that no longer fits
  const out = [];
  for (const c of chunks) {
    if (c.start >= limit) break;
    c.end = Math.min(c.end, limit);
    if (c.end > c.start + 0.05) out.push(c);
  }
  return out;
}

/** Throws if the chunk list is not clean. Called before every render. */
function assertChunksValid(chunks, videoDuration) {
  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i].start < chunks[i - 1].start) throw new Error(`Captions out of order at #${i}`);
    if (chunks[i].start + 0.001 < chunks[i - 1].end) throw new Error(`Captions overlap at #${i}`);
  }
  if (videoDuration && chunks.length && chunks[chunks.length - 1].end > videoDuration + 0.05) {
    throw new Error('Last caption ends after the video does');
  }
  return true;
}

// ── writers ──────────────────────────────────────────────────────────────────

function writeSrt(chunks, filePath) {
  const body = chunks
    .map((c, i) => `${i + 1}\n${toSrtTime(c.start)} --> ${toSrtTime(c.end)}\n${c.text}\n`)
    .join('\n');
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

/**
 * ASS is used for burn-in (never `subtitles=file.srt`) — it is the only way to
 * control font, outline, and exact vertical position, and it renders Myanmar
 * correctly with a fontsdir.
 */
function writeAss(chunks, filePath, style = {}, frame = { width: 1080, height: 1920 }) {
  const s = { ...DEFAULT_STYLE, ...style };
  const scale = frame.height / 1080;
  const fontSize = Math.round((s.size || DEFAULT_STYLE.size) * scale);
  const outline = Math.max(0, Math.round((s.outlineWidth ?? 3) * scale));
  const shadow = Math.max(0, Math.round((s.shadow ?? 0) * scale));

  let alignment = 2; // bottom-center
  let marginV = Math.round((frame.height * (s.marginPct ?? 12)) / 100);
  if (s.position === 'middle') {
    alignment = 5;
    marginV = 10;
  } else if (s.position === 'custom') {
    alignment = 2;
    marginV = Math.round(frame.height * (1 - clamp((s.customY ?? 0.8), 0.05, 0.95)));
  }

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${frame.width}
PlayResY: ${frame.height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,${s.font},${fontSize},${toAssColour(s.primary)},${toAssColour(s.primary)},${toAssColour(s.outline)},${toAssColour('#000000', 0.4)},${s.bold ? -1 : 0},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${Math.round(frame.width * 0.06)},${Math.round(frame.width * 0.06)},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = chunks
    .map((c) => {
      const line = c.text.replace(/\r?\n/g, '\\N');
      return `Dialogue: 0,${toAssTime(c.start)},${toAssTime(c.end)},Main,,0,0,0,,${line}`;
    })
    .join('\n');

  fs.writeFileSync(filePath, header + events + '\n', 'utf8');
  return filePath;
}

module.exports = {
  DEFAULT_STYLE,
  buildCaptionChunks,
  assertChunksValid,
  writeSrt,
  writeAss,
  toSrtTime,
  toAssColour,
};
