const BASE = import.meta.env.VITE_API_URL || '';

async function j(url, opts = {}) {
  const r = await fetch(BASE + url, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { error: text }; }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// Small enough that one piece finishes well inside a tunnel's request timeout
// even on a slow phone connection; a stalled piece is aborted and re-sent.
const CHUNK_SIZE = 2 * 1024 * 1024;
const CHUNK_TIMEOUT_MS = 60 * 1000;
const CHUNK_TRIES = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sends the piece starting at `offset`, retrying on failure. Resolves to the next offset. */
async function sendChunk(uploadId, file, offset, onUploadProgress) {
  const piece = file.slice(offset, offset + CHUNK_SIZE);
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHUNK_TIMEOUT_MS);
    try {
      const r = await fetch(`${BASE}/api/upload/${uploadId}?offset=${offset}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: piece,
        signal: ctrl.signal,
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) return data.received;
      if (r.status === 409 && Number.isInteger(data.received)) return data.received; // server says resume from here
      if (r.status === 404 || r.status === 400) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { fatal: true });
    } catch (e) {
      if (e.fatal) throw e;
      // network drop or timeout — fall through and retry
    } finally {
      clearTimeout(timer);
    }
    if (attempt >= CHUNK_TRIES) throw new Error('Upload failed — the connection keeps dropping. Try again on a stronger connection.');
    if (onUploadProgress) onUploadProgress(offset / file.size);
    await sleep(Math.min(15000, 1000 * 2 ** (attempt - 1)));
  }
}

export const api = {
  health: () => j('/api/health'),
  getSettings: () => j('/api/settings'),
  saveSettings: (body) =>
    j('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  previewVoice: async (voiceId, rateOffset) => {
    const r = await fetch(BASE + '/api/tts-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: voiceId, rateOffset }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Preview failed');
    return URL.createObjectURL(await r.blob());
  },

  // Chunked: see the "chunked upload" block in server/index.js for why.
  startJob: async (file, settings, onUploadProgress) => {
    let uploadId;
    try {
      ({ uploadId } = await j('/api/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, size: file.size }),
      }));
    } catch (e) {
      throw new Error('Upload failed — is the server running?');
    }

    let offset = 0;
    while (offset < file.size) {
      offset = await sendChunk(uploadId, file, offset, onUploadProgress);
      if (onUploadProgress) onUploadProgress(offset / file.size);
    }

    return j(`/api/upload/${uploadId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
  },

  job: (id) => j(`/api/job/${id}`),
  downloadUrl: (url) =>
    j('/api/download-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),
  processJob: (id, settings) =>
    j(`/api/job/${id}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    }),
  jobSourceUrl: (id) => BASE + `/api/job/${id}/source`,
  approve: (id, blocks) =>
    j(`/api/job/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    }),
  cancel: (id) => j(`/api/job/${id}/cancel`, { method: 'POST' }),
  history: () => j('/api/history'),
  url: (p) => BASE + p,
};

export default api;
