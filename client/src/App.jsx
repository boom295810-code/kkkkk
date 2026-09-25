import { useEffect, useRef, useState } from 'react';
import api from './api';
import Preview from './components/Preview';
import Panel from './components/Panel';
import Processing from './components/Processing';
import History from './components/History';

const DEFAULTS = {
  mode: 'recap',
  outputLanguage: 'my', // Pro AI Recap only — see server/services/proLanguages.js
  ratio: 'original',
  fit: 'crop',
  focus: 'center',
  zoom: 1,
  pad: { innerScale: 1, posX: 0, posY: 0 }, // fit:'pad' only
  copyright: { mirror: false, randomCrop: false },
  voicePreset: 'thiha',
  voiceRate: 30,
  videoSpeed: 1,
  autoFit: true,
  originalAudio: 'mute',
  reviewBeforeVoice: false,
  fps: 30,
  quality: 'normal',
  outputName: '',
  subtitles: {
    enabled: true,
    burn: true,
    fontFile: '',
    size: 46,
    primary: '#FFE600',
    outline: '#000000',
    outlineWidth: 3,
    position: 'bottom',
    marginPct: 12,
    customY: 0.8,
    maxWords: 6,
  },
  blur: { boxes: [], captionStrength: 22, backgroundStrength: 22, edgeSoftness: 40, coverSubtitle: false, bandHeightPct: 14, bandBottomPct: 6 },
  watermark: { enabled: false, text: '', position: 'bottom-right', opacity: 0.65 },
};

const load = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('rs2-settings') || '{}');
    return {
      ...DEFAULTS,
      ...saved,
      subtitles: { ...DEFAULTS.subtitles, ...(saved.subtitles || {}) },
      blur: { ...DEFAULTS.blur, ...(saved.blur || {}), boxes: [] },
      watermark: { ...DEFAULTS.watermark, ...(saved.watermark || {}) },
      pad: { ...DEFAULTS.pad, ...(saved.pad || {}) },
      copyright: { ...DEFAULTS.copyright, ...(saved.copyright || {}) },
    };
  } catch (_) {
    return DEFAULTS;
  }
};

export default function App() {
  const [settings, setSettings] = useState(load);
  const [meta, setMeta] = useState({ voices: [], fonts: [], languages: [], hasAssemblyKey: false, hasGeminiKey: false });
  const [file, setFile] = useState(null);
  const [fileUrl, setFileUrl] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [sourceJobId, setSourceJobId] = useState(null); // set when the source came from a URL download, not a local pick
  const [probe, setProbe] = useState(null);
  const [job, setJob] = useState(null);
  const [uploadPct, setUploadPct] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [keys, setKeys] = useState({ assemblyAiKey: '', geminiKey: '' });
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);
  const [serverHistory, setServerHistory] = useState([]);
  const pollRef = useRef(null);
  const hasSource = !!file || !!sourceJobId;

  const patch = (p) => setSettings((s) => ({ ...s, ...p }));

  // Server-persisted "last 3 renders" panel — survives a restart because the
  // list itself lives on the server (server/history.json), not in this
  // component's state. Refetched on load and again whenever a job finishes.
  const refreshHistory = () => api.history().then((r) => setServerHistory(r.history)).catch(() => {});

  useEffect(() => {
    refreshHistory();
  }, []);

  useEffect(() => {
    const { blur, ...rest } = settings;
    localStorage.setItem('rs2-settings', JSON.stringify({ ...rest, blur: { ...blur, boxes: [] } }));
  }, [settings]);

  useEffect(() => {
    Promise.all([
      api.health().catch(() => {
        setError('Server ကို မတွေ့ပါ — server folder ထဲမှာ `npm start` ကို အရင် run ပါ။');
        return null;
      }),
      api.getSettings().catch(() => null),
    ]).then(([h, s]) => {
      if (h) setMeta(h);
      if (s) {
        setKeys({ assemblyAiKey: s.assemblyAiKey, geminiKey: s.geminiKey });
        if (h && (!h.hasAssemblyKey || !h.hasGeminiKey)) setShowSettings(true);
      }
    });
  }, []);

  const pickFile = (f) => {
    setError('');
    setSourceJobId(null);
    setFile(f);
    setSourceName(f.name);
    const url = URL.createObjectURL(f);
    setFileUrl(url);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => setProbe({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.src = url;
  };

  const start = async () => {
    if (!file && !sourceJobId) return;
    setError('');
    if (sourceJobId) {
      setJob({ id: sourceJobId, status: 'running', stage: 'extract', percent: 5, log: [] });
      try {
        await api.processJob(sourceJobId, settings);
        poll(sourceJobId);
      } catch (e) {
        setJob({ status: 'error', error: e.message, log: [] });
      }
      return;
    }
    setUploadPct(0);
    setJob({ id: null, status: 'uploading', stage: 'upload', percent: 0, log: [] });
    try {
      const { jobId } = await api.startJob(file, settings, setUploadPct);
      poll(jobId);
    } catch (e) {
      setJob({ status: 'error', error: e.message, log: [] });
    }
  };

  const poll = (id) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const j = await api.job(id);
        setJob(j);
        if (['done', 'error', 'cancelled'].includes(j.status)) {
          clearInterval(pollRef.current);
          if (j.status === 'done' && j.result) {
            setHistory((h) => [j.result, ...h].slice(0, 6));
            refreshHistory();
          }
        }
      } catch (e) {
        clearInterval(pollRef.current);
        setJob((prev) => ({ ...(prev || {}), status: 'error', error: e.message }));
      }
    }, 1000);
  };

  useEffect(() => () => clearInterval(pollRef.current), []);

  const cancel = async () => {
    if (job?.id) await api.cancel(job.id).catch(() => {});
    clearInterval(pollRef.current);
    setJob(null);
  };

  const reset = () => {
    clearInterval(pollRef.current);
    setJob(null);
    setFile(null);
    setFileUrl('');
    setSourceName('');
    setSourceJobId(null);
    setProbe(null);
    patch({ outputName: '' });
  };

  const saveKeys = async () => {
    const body = {};
    if (keys.assemblyAiKey && !keys.assemblyAiKey.includes('…')) body.assemblyAiKey = keys.assemblyAiKey;
    if (keys.geminiKey && !keys.geminiKey.includes('…')) body.geminiKey = keys.geminiKey;
    await api.saveSettings(body);
    const h = await api.health();
    setMeta(h);
    const s = await api.getSettings();
    setKeys({ assemblyAiKey: s.assemblyAiKey, geminiKey: s.geminiKey });
    setShowSettings(false);
  };

  const busy = !!job && !['done', 'error', 'cancelled'].includes(job.status);

  return (
    <div className="app">
      <header className={'topbar' + (hasSource ? ' has-source' : '')}>
        <div className="brand">
          <div className="brand-mark">K</div>
          <div>
            <div className="brand-name">K RECAP</div>
            <div className="brand-sub">K RECAP မှကြိုဆိုပါသည်</div>
          </div>
        </div>
        <div className="topbar-spacer" />
        {hasSource && (
          <span className="hint" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sourceName}
          </span>
        )}
        {hasSource && <button className="btn small ghost" onClick={reset}>Change video</button>}
        <button className="btn small" onClick={() => setShowSettings(true)}>⚙ Settings</button>
      </header>

      {error && <div className="banner bad" style={{ margin: '12px 18px 0' }}>{error}</div>}

      <div className="layout">
        <Preview
          fileUrl={fileUrl}
          probe={probe}
          settings={settings}
          patch={patch}
          onPickFile={pickFile}
          onReset={reset}
          onOpenSettings={() => setShowSettings(true)}
        />
        <Panel settings={settings} patch={patch} meta={meta} probe={probe} onStart={start} busy={busy} hasFile={hasSource} />
        <History history={serverHistory} languages={meta.languages} />
      </div>

      <Processing job={job} uploadPct={uploadPct} onCancel={cancel} onReset={reset} history={history} />

      {showSettings && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setShowSettings(false)}>
          <div className="sheet">
            <h3>Settings</h3>
            <div className="group">
              <h4>AssemblyAI key (transcription)</h4>
              <input
                type="text"
                value={keys.assemblyAiKey}
                placeholder="အသစ်ထည့်ရင် ဒီမှာ ရိုက်ထည့်ပါ"
                onChange={(e) => setKeys({ ...keys, assemblyAiKey: e.target.value })}
              />
            </div>
            <div className="group">
              <h4>Gemini key (translation)</h4>
              <input
                type="text"
                value={keys.geminiKey}
                placeholder="AIza… (Google) သို့မဟုတ် OpenRouter key"
                onChange={(e) => setKeys({ ...keys, geminiKey: e.target.value })}
              />
              <div className="btn-row">
                <a className="btn small ghost" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">
                  Get Google AI Studio key ↗
                </a>
                <a className="btn small ghost" href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">
                  Get OpenRouter key ↗
                </a>
              </div>
            </div>
            <p className="hint">
              Key တွေကို server/settings.json ထဲမှာသာ သိမ်းပါတယ် — browser ထဲ မရောက်ပါ။ ဗီဒီယိုအားလုံးက ကိုယ့်စက်ထဲမှာပဲ process လုပ်ပါတယ်။
            </p>
            <div className="btn-row">
              <button className="btn primary" style={{ width: 'auto', flex: 1 }} onClick={saveKeys}>Save</button>
              <button className="btn ghost" onClick={() => setShowSettings(false)}>Close</button>
            </div>
            <div className="checks">
              <span>Fonts</span><b>{meta.fonts?.length || 0} ဖိုင်</b>
              <span>Voices</span><b>{meta.voices?.length || 0}</b>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
