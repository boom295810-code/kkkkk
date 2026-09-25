// ─────────────────────────────────────────────────────────────────────────────
// fonts.js — read the REAL family name out of a .ttf/.otf file.
//
// libass matches by family name, not by filename. "A13_WenYoeRegular.ttf" may
// actually be family "A13 WenYoe" — using the filename there silently falls
// back to a default font and the Burmese captions come out wrong.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

/** Parse the sfnt `name` table and return the typographic family name. */
function readFamilyName(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (_) {
    return null;
  }
  if (buf.length < 12) return null;

  let offset = 0;
  const tag = buf.readUInt32BE(0);
  if (tag === 0x74746366) {
    // 'ttcf' — TrueType collection: use the first font in it
    if (buf.length < 16) return null;
    offset = buf.readUInt32BE(12);
    if (offset + 12 > buf.length) return null;
  }

  const numTables = buf.readUInt16BE(offset + 4);
  let nameOffset = 0;
  let nameLength = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = offset + 12 + i * 16;
    if (rec + 16 > buf.length) break;
    if (buf.toString('ascii', rec, rec + 4) === 'name') {
      nameOffset = buf.readUInt32BE(rec + 8);
      nameLength = buf.readUInt32BE(rec + 12);
      break;
    }
  }
  if (!nameOffset || nameOffset + 6 > buf.length) return null;

  const count = buf.readUInt16BE(nameOffset + 2);
  const stringOffset = nameOffset + buf.readUInt16BE(nameOffset + 4);

  // nameID 16 = typographic family (preferred), 1 = family
  const found = { 16: null, 1: null };

  for (let i = 0; i < count; i++) {
    const rec = nameOffset + 6 + i * 12;
    if (rec + 12 > buf.length) break;
    const platformId = buf.readUInt16BE(rec);
    const nameId = buf.readUInt16BE(rec + 6);
    if (nameId !== 1 && nameId !== 16) continue;

    const length = buf.readUInt16BE(rec + 8);
    const strOff = stringOffset + buf.readUInt16BE(rec + 10);
    if (strOff + length > buf.length) continue;

    const raw = buf.subarray(strOff, strOff + length);
    const value =
      platformId === 3 || platformId === 0
        ? raw.swap16 && length % 2 === 0
          ? Buffer.from(raw).swap16().toString('utf16le')
          : raw.toString('utf16le')
        : raw.toString('latin1');

    const clean = value.replace(/\0/g, '').trim();
    if (!clean) continue;
    // prefer a Windows/Unicode record over a Mac one
    if (!found[nameId] || platformId === 3) found[nameId] = clean;
  }

  return found[16] || found[1] || null;
}

// Which script each bundled font covers, for the font picker's language
// filter. Every font shipped so far has been Myanmar, so that's the safe
// default for anything not listed here — add one entry when bundling a font
// for a new script.
const LATIN_FONT_FILES = new Set(['Inter-Regular.ttf']);
function scriptFor(filename) {
  return LATIN_FONT_FILES.has(filename) ? 'latin' : 'burmese';
}

/** List every font in a directory with its real family name. */
function listFonts(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => {
      if (!/\.(ttf|otf)$/i.test(f)) return false;
      // A .ttf/.otf-suffixed DIRECTORY (or a broken entry) is not a font —
      // only a regular file can actually be read as one.
      try {
        return fs.statSync(path.join(dir, f)).isFile();
      } catch (_) {
        return false;
      }
    })
    .map((f) => {
      const family = readFamilyName(path.join(dir, f));
      return {
        file: f,
        family: family || path.basename(f, path.extname(f)),
        name: family || path.basename(f, path.extname(f)).replace(/[-_]/g, ' '),
        script: scriptFor(f),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listFonts, readFamilyName };
