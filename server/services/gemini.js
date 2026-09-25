// ─────────────────────────────────────────────────────────────────────────────
// gemini.js — translation (Gemini ONLY; Groq is forbidden for translation)
//
// The PROMPT and the retry ladder are unchanged from the working engine.
// What changed (Aug 2026, after "Unterminated string in JSON at position 333"):
//   • output token budget raised 4096 → 16384 (Burmese costs 3–4× the source)
//   • a truncated reply is SALVAGED (complete strings are kept) instead of thrown away
//   • a batch that still fails is SPLIT in half and retried, down to one line
//   • one unfixable line no longer kills a job that already took minutes —
//     it keeps the source text and the job only aborts if >15% of lines failed
// ─────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_OUTPUT_TOKENS = 16384;

/**
 * Rescue the complete strings out of a truncated `{"translations":[ ... ]}` reply.
 * Returns the array of whole strings, or null if nothing usable is there.
 */
function salvageTranslations(raw) {
  const start = raw.indexOf('[');
  if (start === -1) return null;
  const out = [];
  let i = start + 1;

  while (i < raw.length) {
    while (i < raw.length && /[\s,]/.test(raw[i])) i++;
    if (i >= raw.length || raw[i] === ']') break;
    if (raw[i] !== '"') break;
    i++;

    let s = '';
    let closed = false;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '\\') {
        const n = raw[i + 1];
        s += n === 'n' ? '\n' : n === 't' ? '\t' : n === undefined ? '' : n;
        i += 2;
        continue;
      }
      if (ch === '"') {
        closed = true;
        i++;
        break;
      }
      s += ch;
      i++;
    }
    if (!closed) break; // truncated mid-string — drop this partial one
    out.push(s);
  }
  return out.length ? out : null;
}

// Retry on 429/503 with backoff. 403 = fatal, stop immediately.
async function callGeminiWithRetry(apiKey, prompt, retries = 3) {
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
                temperature: 0.1,
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
            temperature: 0.1,
            max_tokens: MAX_OUTPUT_TOKENS,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
      }
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        if (attempt < retries) {
          console.warn(`[Gemini] Fetch timed out (90s). Retrying ${attempt + 1}/${retries}...`);
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

    // 402 (OpenRouter: no credits on this account) is exactly as unrecoverable
    // as a 403 rejection — every subsequent request will fail identically, so
    // this must be thrown immediately, not retried. Without this branch it
    // fell into the generic !response.ok case below, which isFatal() doesn't
    // recognize — translateChunk then wastefully re-split and retried a
    // batch already known to be doomed, all the way down to single lines,
    // once per line in the whole job, before finally giving up.
    if (response.status === 402) {
      const errText = await response.text();
      throw new Error(
        `OpenRouter key has no credits — add credits at https://openrouter.ai/settings/credits or switch keys in Settings. Details: ${errText}`
      );
    }

    if (response.status === 429 || response.status === 503) {
      if (attempt < retries) {
        const waitMs = backoffs[attempt] || 25000;
        console.warn(`[Gemini] ${response.status} rate limit. Waiting ${waitMs / 1000}s before retry ${attempt + 1}/${retries}...`);
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
      // Gemini 3.x returns a THINKING part first — keep only parts where thought is not true
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
      // Truncated or malformed. Salvage whatever whole strings came through —
      // the caller re-requests only the lines that are still missing.
      const salvaged = salvageTranslations(content);
      if (salvaged) {
        console.warn(`[Gemini] Reply was cut off — salvaged ${salvaged.length} complete line(s).`);
        return JSON.stringify({ translations: salvaged });
      }
      if (attempt < retries) {
        console.warn(`[Gemini] Invalid JSON on attempt ${attempt + 1}. Retrying...`);
        await sleep(2000);
        continue;
      }
      throw new Error('Gemini returned unusable JSON after all retries.');
    }
  }
  throw new Error('Gemini: exhausted all retries.');
}

// ── prompt (unchanged) ───────────────────────────────────────────────────────

const PROMPT_TEMPLATE = `You are a professional video dubbing translator for a TikTok recap video.

TASK: Translate each block into natural spoken Burmese (Myanmar script ONLY — no English, no romanization).

CRITICAL RULES:
1. Translate WHAT IS ACTUALLY SAID. Keep first-person ("I did X") as first-person. Do NOT rewrite into third-person ("the male lead did X").
2. Where characters are talking to each other, translate each person's actual spoken lines — do not flatten into narration.
3. Each block has a "Budget" (target character count for the Burmese output). A faithful translation that runs a little long is acceptable; a choppy one that loses meaning is not.
4. Output must be pure Myanmar script only. No English words, no parenthetical notes.
5. CRITICAL: DO NOT use double quotes (") inside your translations. If you need to quote something, use single quotes ('). Unescaped double quotes will break the JSON parser.
6. SUBTITLE SPLITTING: After each natural sentence or phrase boundary, place a Burmese period (။). This allows the subtitle system to split long translations into short, readable lines. For example, if the text has two ideas: "ပထမအကြောင်းအချက်။ ဒုတိယအကြောင်းအချက်။" — one ။ per phrase. SHORT phrases (1–3 seconds) may have just one phrase with one ။ at the end.

__PREVIOUS_CONTEXT__
OUTPUT FORMAT: Return ONLY a valid JSON object:
{"translations": ["မြန်မာ ၁", "မြန်မာ ၂", ...]}
One string per input ID, in order.

INPUTS:
__TRANSCRIPT__`;

function buildPrompt(batch, offset, context) {
  const textArray = batch
    .map((u, idx) => {
      const durSec = Math.max((u.end - u.start) / 1000, 0.5);
      const charBudget = Math.round(durSec * 16);
      return `ID: ${offset + idx} | Speaker: ${u.speaker || 'A'} | Type: ${u.tag || 'narration'} | Scene: ${durSec.toFixed(1)}s | Budget: ~${charBudget} chars | Text: "${u.text}"`;
    })
    .join('\n');

  return PROMPT_TEMPLATE.replace(
    '__PREVIOUS_CONTEXT__',
    context ? `CONTEXT (last translated line for flow): "${context}"\n` : ''
  ).replace('__TRANSCRIPT__', textArray);
}

const isFatal = (msg) => /rejected|PERMISSION_DENIED|billing|API key|no credits/i.test(String(msg));

/**
 * Translate one group of blocks. On failure the group is split in half and
 * retried, down to a single line; a single line that still fails returns null
 * so the pipeline can fall back to its source text.
 */
async function translateChunk(batch, offset, key, context, depth = 0) {
  try {
    const content = await callGeminiWithRetry(key, buildPrompt(batch, offset, context));
    const parsed = JSON.parse(content);
    const arr = Array.isArray(parsed.translations) ? parsed.translations : [];

    if (arr.length >= batch.length) return arr.slice(0, batch.length);

    if (arr.length > 0) {
      // partial reply — ask again only for the lines that are still missing
      console.warn(`[Gemini] Got ${arr.length}/${batch.length} lines — requesting the rest.`);
      await sleep(800);
      const rest = await translateChunk(
        batch.slice(arr.length),
        offset + arr.length,
        key,
        arr[arr.length - 1],
        depth + 1
      );
      return [...arr, ...rest];
    }
    throw new Error('empty translations array');
  } catch (e) {
    if (isFatal(e.message)) throw e;

    if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      console.warn(`[Gemini] Batch of ${batch.length} failed (${e.message}) — splitting into ${mid} + ${batch.length - mid}.`);
      await sleep(1000);
      const a = await translateChunk(batch.slice(0, mid), offset, key, context, depth + 1);
      await sleep(800);
      const b = await translateChunk(
        batch.slice(mid),
        offset + mid,
        key,
        a.filter(Boolean).pop() || context,
        depth + 1
      );
      return [...a, ...b];
    }

    console.error(`[Gemini] Line ${offset} could not be translated (${e.message}) — keeping the source text.`);
    return [null];
  }
}

const translateUtterances = async (utterances, geminiKey) => {
  if (!utterances || utterances.length === 0) return [];
  if (!geminiKey || geminiKey.trim() === '') {
    throw new Error('Gemini API Key မပေးမိသေးပါ။ Settings ထဲမှာ Gemini API Key ထည့်သွင်းပေးပါ။');
  }

  const BATCH_SIZE = 10;
  const key = geminiKey.trim();
  const results = [];
  let previousTranslation = '';
  let failed = 0;

  for (let i = 0; i < utterances.length; i += BATCH_SIZE) {
    const batch = utterances.slice(i, i + BATCH_SIZE);
    console.log(`[Gemini] Translating batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(utterances.length / BATCH_SIZE)}...`);

    const translations = await translateChunk(batch, i, key, previousTranslation);

    batch.forEach((u, idx) => {
      const t = translations[idx];
      if (!t) failed++;
      results.push({ ...u, translatedText: t || u.text });
    });

    const last = translations.filter(Boolean).pop();
    if (last) previousTranslation = last;

    if (i + BATCH_SIZE < utterances.length) await sleep(1000);
  }

  if (failed > 0) {
    const pct = (failed / utterances.length) * 100;
    if (pct > 15) {
      throw new Error(`Translation failed for ${failed}/${utterances.length} lines (${pct.toFixed(0)}%) — too many to continue.`);
    }
    console.warn(`[Gemini] ${failed}/${utterances.length} line(s) kept their source text.`);
  }

  return results;
};

module.exports = { translateUtterances, salvageTranslations };
