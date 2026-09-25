// ─────────────────────────────────────────────────────────────────────────────
// proLanguages.js — the ONE place that defines an output language for
// Pro AI Recap. Adding a new output language means adding one entry here —
// never a new mode, never a new code path. proTranslate.js, proRecap.js, and
// the client's language dropdown all read from this registry.
//
// charsPerSec values are measured at the SAME effective TTS rate (+30% total:
// tts.js's engine base of +20% plus the UI's default +10% voiceRate offset),
// so they're directly comparable to each other:
//   - my: 16 — mirrors the per-block Burmese budget constant already used
//     elsewhere in the engine (gemini.js's buildPrompt: durSec*16).
//   - en: 21 — measured directly in this project (2026-08-27) by synthesizing
//     8 varied English sentences (720 chars total) with edge-tts's
//     en-US-GuyNeural at the same +30% rate and dividing chars by seconds
//     (~20.8 measured; rounded to 21). English runs faster per character
//     than Burmese here because Latin text includes spaces and each spoken
//     syllable is written with more, narrower characters than Myanmar script.
// ─────────────────────────────────────────────────────────────────────────────

const LANGUAGES = {
  my: {
    id: 'my',
    label: 'Burmese',
    fileTag: 'mm', // matches the existing AI Recap / Dubbing output filename convention
    charsPerSec: 16,
    defaultVoiceId: 'thiha',
    script: 'burmese', // selects caption-chunking behaviour and the font-list filter
    defaultFontFamily: 'Noto Sans Myanmar',
    outputRule:
      'Output must be pure Myanmar script only. No English words, no parenthetical notes, no romanization.',
    phraseMarkerRule:
      'SUBTITLE SPLITTING: after each natural phrase boundary, place a Burmese period (။) so the caption system can split long lines into short, readable chunks.',
  },
  en: {
    id: 'en',
    label: 'English',
    fileTag: 'en',
    charsPerSec: 21,
    defaultVoiceId: 'en-guy', // Guy — clear, neutral US male narration voice
    script: 'latin',
    defaultFontFamily: 'Inter',
    outputRule:
      'Output must be natural, fluent spoken English. No stage directions, no parenthetical notes, no non-English words.',
    phraseMarkerRule:
      'SUBTITLE SPLITTING: use normal English punctuation (periods, commas, question marks) — the caption system splits on word and punctuation boundaries automatically.',
  },
};

const DEFAULT_LANGUAGE_ID = 'my';

function getLanguage(id) {
  return LANGUAGES[id] || LANGUAGES[DEFAULT_LANGUAGE_ID];
}

/** Minimal shape the client needs to render the language dropdown and pick sensible defaults. */
function listLanguages() {
  return Object.values(LANGUAGES).map((l) => ({
    id: l.id,
    label: l.label,
    defaultVoiceId: l.defaultVoiceId,
  }));
}

module.exports = { LANGUAGES, DEFAULT_LANGUAGE_ID, getLanguage, listLanguages };
