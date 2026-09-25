// ─────────────────────────────────────────────────────────────────────────────
// proTranslate.js — budget-aware RECAP NARRATION translation for Pro modes.
//
// This is deliberately an INDEPENDENT implementation, not a caller of
// gemini.js's translateUtterances. gemini.js's prompt/batch-size/retry-ladder
// are protected engine logic (per the build spec) that must never change —
// so rather than branch inside that file, this file mirrors the same proven
// mechanics (403 fatal, 429/503 backoff ladder 3s/10s/25s, Gemini 3.x
// thought-part filtering, truncated-JSON salvage) on its own. The only thing
// imported from gemini.js is `salvageTranslations`, a pure string utility
// that is already a public export and carries no prompt/timing behavior.
//
// The prompt itself is different in kind from gemini.js's: that one is a
// literal, dialogue-preserving dub; this one asks for a faithful, continuous
// single-narrator translation of a dialogue video, in whichever output
// LANGUAGE proLanguages.js says (see buildPromptTemplate) — one shared
// template with language-specific rule text swapped in, so adding a new
// output language never means writing a new prompt from scratch.
// ─────────────────────────────────────────────────────────────────────────────
const { salvageTranslations } = require('./gemini');
const { getLanguage } = require('./proLanguages');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_OUTPUT_TOKENS = 16384;
const BATCH_SIZE = 10;

async function callGeminiForRecap(apiKey, prompt, retries = 3) {
  const backoffs = [3000, 10000, 25000];
  const cleanKey = apiKey.trim();

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    let response;
    try {
      if (cleanKey.startsWith('AIza')) {
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${cleanKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json',
                maxOutputTokens: MAX_OUTPUT_TOKENS,
              },
            }),
          }
        );
      } else {
        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${cleanKey}`, 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: 'google/gemini-2.5-flash',
            temperature: 0.2,
            max_tokens: MAX_OUTPUT_TOKENS,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
      }
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        if (attempt < retries) {
          console.warn(`[ProRecap/Gemini] Fetch timed out (90s). Retrying ${attempt + 1}/${retries}...`);
          await sleep(3000);
          continue;
        }
        throw new Error('Gemini API timed out on all retries. Please try again.');
      }
      throw fetchErr;
    }
    clearTimeout(timeoutId);

    if (response.status === 403) {
      const errText = await response.text();
      throw new Error(`Gemini key rejected: check billing on this project. Details: ${errText}`);
    }

    // See gemini.js's identical branch — 402 (OpenRouter: no credits) is as
    // unrecoverable as a 403 and must fail immediately, not be retried.
    if (response.status === 402) {
      const errText = await response.text();
      throw new Error(
        `OpenRouter key has no credits — add credits at https://openrouter.ai/settings/credits or switch keys in Settings. Details: ${errText}`
      );
    }

    if (response.status === 429 || response.status === 503) {
      if (attempt < retries) {
        const waitMs = backoffs[attempt] || 25000;
        console.warn(`[ProRecap/Gemini] ${response.status} rate limit. Waiting ${waitMs / 1000}s before retry ${attempt + 1}/${retries}...`);
        await sleep(waitMs);
        continue;
      }
      throw new Error(`Gemini API ${response.status} after ${retries} retries — fatal.`);
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errText}`);
    }

    let content = '';
    let truncated = false;
    const data = await response.json();

    if (cleanKey.startsWith('AIza')) {
      const cand = (data.candidates && data.candidates[0]) || {};
      truncated = cand.finishReason === 'MAX_TOKENS';
      const parts = (cand.content && cand.content.parts) || [];
      const textPart = parts.find((p) => !p.thought) || parts[0] || {};
      content = String(textPart.text || '').trim();
    } else {
      const choice = (data.choices && data.choices[0]) || {};
      truncated = choice.finish_reason === 'length';
      content = String((choice.message && choice.message.content) || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();
    }

    if (content.startsWith('```json')) content = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    else if (content.startsWith('```')) content = content.replace(/^```\s*/, '').replace(/\s*```$/, '');

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch && !truncated) content = jsonMatch[0];

    try {
      JSON.parse(content);
      return content;
    } catch (_) {
      const salvaged = salvageTranslations(content);
      if (salvaged) {
        console.warn(`[ProRecap/Gemini] Reply was cut off — salvaged ${salvaged.length} complete line(s).`);
        return JSON.stringify({ translations: salvaged });
      }
      if (attempt < retries) {
        console.warn(`[ProRecap/Gemini] Invalid JSON on attempt ${attempt + 1}. Retrying...`);
        await sleep(2000);
        continue;
      }
      throw new Error('Gemini returned unusable JSON after all retries.');
    }
  }
  throw new Error('Gemini: exhausted all retries.');
}

function buildPromptTemplate(lang) {
  return `You are producing a continuous ${lang.label} voice-over narration for a DIALOGUE video, spoken by ONE narrator (not separate character voices).

TASK: Translate what is ACTUALLY SAID in each line into natural spoken ${lang.label}, faithfully and in the same order. This is NOT a summary — do not compress, skip, or omit content, and do not invent anything that wasn't said.

CRITICAL RULES:
1. Keep the full meaning of every line. Do not drop lines or shorten content to save space.
2. Because ONE narrator voices everything, phrase the translation so it flows as continuous spoken narration rather than separate labelled character lines — but the WORDS must still faithfully follow what each speaker actually said, in the order they said it.
3. Each input line has a "Budget" — a target character count for PACING/PHRASING TIGHTNESS ONLY. It is not a limit on content: if a faithful translation runs longer than the budget, keep it faithful anyway and let it run long.
4. ${lang.outputRule}
5. CRITICAL: DO NOT use double quotes (") inside your translations. Use single quotes (') if you need to quote something. Unescaped double quotes break the JSON parser.
6. ${lang.phraseMarkerRule}

__PREVIOUS_CONTEXT__
OUTPUT FORMAT: Return ONLY a valid JSON object:
{"translations": ["line 1", "line 2", ...]}
One string per input ID, in order.

INPUTS:
__TRANSCRIPT__`;
}

function buildPrompt(batch, context, lang) {
  const textArray = batch
    .map((u) => {
      const durSec = Math.max((u.end - u.start) / 1000, 0.5);
      return `ID: ${u.__id} | Speaker: ${u.speaker || 'A'} | Scene: ${durSec.toFixed(1)}s | Budget: ~${u.__budgetChars} chars | Text: "${u.text}"`;
    })
    .join('\n');

  return buildPromptTemplate(lang)
    .replace('__PREVIOUS_CONTEXT__', context ? `CONTEXT (last narrated line for flow): "${context}"\n` : '')
    .replace('__TRANSCRIPT__', textArray);
}

const isFatal = (msg) => /rejected|PERMISSION_DENIED|billing|API key|no credits/i.test(String(msg));

async function translateChunk(batch, key, context, lang) {
  try {
    const content = await callGeminiForRecap(key, buildPrompt(batch, context, lang));
    const parsed = JSON.parse(content);
    const arr = Array.isArray(parsed.translations) ? parsed.translations : [];

    if (arr.length >= batch.length) return arr.slice(0, batch.length);

    if (arr.length > 0) {
      console.warn(`[ProRecap/Gemini] Got ${arr.length}/${batch.length} lines — requesting the rest.`);
      await sleep(800);
      const rest = await translateChunk(batch.slice(arr.length), key, arr[arr.length - 1], lang);
      return [...arr, ...rest];
    }
    throw new Error('empty translations array');
  } catch (e) {
    if (isFatal(e.message)) throw e;

    if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      console.warn(`[ProRecap/Gemini] Batch of ${batch.length} failed (${e.message}) — splitting into ${mid} + ${batch.length - mid}.`);
      await sleep(1000);
      const a = await translateChunk(batch.slice(0, mid), key, context, lang);
      await sleep(800);
      const b = await translateChunk(batch.slice(mid), key, a.filter(Boolean).pop() || context, lang);
      return [...a, ...b];
    }

    console.error(`[ProRecap/Gemini] Line could not be translated (${e.message}) — keeping the source text.`);
    return [null];
  }
}

/**
 * @param {Array} blocks  utterances with {start,end,text,speaker,keptDurSec}
 * @param {string} geminiKey
 * @param {{totalDurationSec:number, totalBudgetChars:number, totalKeptDurSec:number, initialContext?:string, languageId?:string}} opts
 * @returns {Promise<{blocks:Array, lastContext:string}>} blocks with .translatedText added,
 *          plus the last translated line (for threading narrative context into the next call)
 */
const translateForProRecap = async (blocks, geminiKey, opts = {}) => {
  if (!blocks || blocks.length === 0) return { blocks: [], lastContext: opts.initialContext || '' };
  if (!geminiKey || geminiKey.trim() === '') {
    throw new Error('Gemini API Key မပေးမိသေးပါ။ Settings ထဲမှာ Gemini API Key ထည့်သွင်းပေးပါ။');
  }

  const lang = getLanguage(opts.languageId);
  const key = geminiKey.trim();
  const totalSeconds = opts.totalDurationSec || 1;
  const totalBudgetChars = opts.totalBudgetChars || Math.round(totalSeconds * lang.charsPerSec);
  const totalKeptDurSec = opts.totalKeptDurSec || totalSeconds;

  const withBudget = blocks.map((b, i) => ({
    ...b,
    __id: i,
    __budgetChars: Math.max(4, Math.round(((b.keptDurSec || 0) / totalKeptDurSec) * totalBudgetChars)),
  }));

  const results = [];
  let previousTranslation = opts.initialContext || '';
  let failed = 0;

  for (let i = 0; i < withBudget.length; i += BATCH_SIZE) {
    const batch = withBudget.slice(i, i + BATCH_SIZE);
    console.log(`[ProRecap/Gemini] Translating batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(withBudget.length / BATCH_SIZE)} (${lang.label})...`);

    const translations = await translateChunk(batch, key, previousTranslation, lang);

    batch.forEach((b, idx) => {
      const t = translations[idx];
      if (!t) failed++;
      results.push({ ...b, translatedText: t || b.text });
    });

    const last = translations.filter(Boolean).pop();
    if (last) previousTranslation = last;

    if (i + BATCH_SIZE < withBudget.length) await sleep(1000);
  }

  if (failed > 0) {
    const pct = (failed / withBudget.length) * 100;
    if (pct > 15) {
      throw new Error(`Translation failed for ${failed}/${withBudget.length} lines (${pct.toFixed(0)}%) — too many to continue.`);
    }
    console.warn(`[ProRecap/Gemini] ${failed}/${withBudget.length} line(s) kept their source text.`);
  }

  return { blocks: results, lastContext: previousTranslation };
};

module.exports = { translateForProRecap };
