import { useEffect, useRef, useState } from 'react';
import api from '../api';
import { primeAudio, playTick, playChime, loadSoundPref, saveSoundPref } from '../sound';
import krecapLogo from '../assets/k-recap-logo.png';
import { DownloadIcon } from './icons';

const STAGES = [
  ['upload', 'Upload'],
  ['extract', 'Extract audio'],
  ['transcribe', 'Transcribe'],
  ['translate', 'Translate'],
  ['voice', 'Voice'],
  ['timeline', 'Timeline + captions'],
  ['render', 'Render video'],
];

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Tweens the displayed percent toward the real value instead of snapping —
// "the percentage counts up smoothly, never jumps". Chains from whatever
// is currently on screen, so a target change mid-animation never causes a
// visible jump backward or a restart-from-zero.
function useSmooth(target) {
  const [value, setValue] = useState(target);
  const valueRef = useRef(target);
  const rafRef = useRef(null);
  useEffect(() => {
    if (reducedMotion()) {
      valueRef.current = target;
      setValue(target);
      return;
    }
    cancelAnimationFrame(rafRef.current);
    const startVal = valueRef.current;
    const diff = target - startVal;
    if (Math.abs(diff) < 0.05) {
      valueRef.current = target;
      setValue(target);
      return;
    }
    const duration = 650;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = startVal + diff * eased;
      valueRef.current = v;
      setValue(v);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return value;
}

function Ring({ percent, stage, alive }) {
  const smooth = useSmooth(percent);
  const r = 56;
  const c = 2 * Math.PI * r;
  return (
    <div className={'ring' + (alive ? ' ring-alive' : '')}>
      <svg width="152" height="152" viewBox="0 0 152 152">
        <circle cx="76" cy="76" r={r} className="ring-track" fill="none" />
        <circle
          cx="76" cy="76" r={r} className="ring-progress" fill="none"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(0, Math.min(100, smooth)) / 100)}
        />
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#5b6ee8" />
            <stop offset="100%" stopColor="#8b6ef0" />
          </linearGradient>
        </defs>
      </svg>
      <div className="ring-center">
        <img className="ring-logo" src={krecapLogo} alt="K Recap" />
        <div className="pct">{Math.round(smooth)}%</div>
        <div className="stage-name">{stage}</div>
      </div>
    </div>
  );
}

// A short stroke that draws itself in on first mount (see the CSS
// keyframes) — used both tiny (stage-row dots) and large (the completion
// badge) so the two moments share the same motif.
function DotCheck() {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10">
      <path className="dot-check" d="M5 12.5l4.5 4.5L19 7" fill="none" strokeDasharray={21} />
    </svg>
  );
}

function CheckBadge() {
  return (
    <div className="check-badge">
      <svg viewBox="0 0 64 64" width="64" height="64">
        <circle className="check-badge-circle" cx="32" cy="32" r="27" fill="none" strokeDasharray={170} />
        <path className="check-badge-check" d="M19 33l9 9 17-17" fill="none" strokeDasharray={38} />
      </svg>
    </div>
  );
}

function SoundIcon({ on }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10v4h3.5l4.7 3.8V6.2L7.5 10H4z" fill="currentColor" stroke="none" />
      {on ? <path d="M16.3 8.7a5 5 0 0 1 0 6.6M19 6.2a8.7 8.7 0 0 1 0 11.6" /> : <path d="M16.5 9.2l5 5.6M21.5 9.2l-5 5.6" />}
    </svg>
  );
}

function SoundToggle({ on, onToggle }) {
  return (
    <button
      className={'sound-toggle' + (on ? ' on' : '')}
      onClick={onToggle}
      title={on ? 'Sound on — click to mute' : 'Sound off — click to enable'}
      aria-label="Toggle sound"
    >
      <SoundIcon on={on} />
    </button>
  );
}

export default function Processing({ job, uploadPct, onCancel, onReset, history }) {
  const [blocks, setBlocks] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [soundOn, setSoundOn] = useState(loadSoundPref);
  const prevStageRef = useRef(null);
  const prevStatusRef = useRef(null);
  // A URL-sourced job (TikTok/Douyin/yt-dlp) passes through 'download'
  // before the normal pipeline even starts — a locally-uploaded file never
  // does. Tracked as state (not just checked against the current job.stage)
  // because once the job moves on to 'upload'/'extract'/etc., 'download' is
  // no longer job.stage but should still show as a completed step, not
  // disappear from the list.
  const [sawDownload, setSawDownload] = useState(false);

  useEffect(() => {
    if (job?.status === 'awaiting-review' && job.blocks && !blocks) setBlocks(job.blocks);
    if (job?.status !== 'awaiting-review' && blocks) setBlocks(null);
  }, [job, blocks]);

  useEffect(() => {
    if (job?.stage === 'download') setSawDownload(true);
    if (!job) setSawDownload(false);
  }, [job]);

  useEffect(() => {
    if (!job || ['done', 'error', 'cancelled'].includes(job.status)) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [job]);

  // A soft tick each time the pipeline moves to a new stage, a warmer chime
  // once when it finishes. Both are no-ops while sound is off, and both
  // fail silently if the browser refuses playback (see sound.js).
  useEffect(() => {
    if (!job) {
      prevStageRef.current = null;
      prevStatusRef.current = null;
      return;
    }
    if (
      soundOn &&
      prevStageRef.current &&
      prevStageRef.current !== job.stage &&
      !['done', 'error', 'cancelled'].includes(job.status)
    ) {
      playTick();
    }
    prevStageRef.current = job.stage;

    if (soundOn && job.status === 'done' && prevStatusRef.current !== 'done') {
      playChime();
    }
    prevStatusRef.current = job.status;
  }, [job, soundOn]);

  const toggleSound = () => {
    setSoundOn((v) => {
      const next = !v;
      saveSoundPref(next);
      if (next) primeAudio();
      return next;
    });
  };

  if (!job) return null;

  // Only URL-sourced jobs get the extra leading row — a locally-uploaded
  // file's stageIdx must stay based on the plain STAGES list, or its
  // never-visited 'download' step would be miscounted as already done.
  const stages = sawDownload ? [['download', 'Download'], ...STAGES] : STAGES;

  const percent = job.status === 'uploading' ? Math.round(uploadPct * 5) : job.percent || 0;
  const stageIdx = stages.findIndex(([k]) => k === job.stage);
  const eta = percent > 4 ? Math.max(0, Math.round((elapsed / percent) * (100 - percent))) : null;
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // ── review ────────────────────────────────────────────────────────────────
  if (job.status === 'awaiting-review' && blocks) {
    return (
      <div className="overlay">
        <div className="sheet">
          <h3>ဘာသာပြန်ကို စစ်ပါ</h3>
          <p className="hint">ပြင်ချင်တာ ပြင်ပြီး Continue နှိပ်ပါ။ ဒီအဆင့်ပြီးမှ အသံထုတ်ပါမယ်။</p>
          <div className="reviewlist">
            {blocks.map((b, i) => (
              <div className="reviewitem" key={i}>
                <div className="src">{(b.start / 1000).toFixed(1)}s — {b.text}</div>
                <textarea
                  value={b.translatedText}
                  onChange={(e) => {
                    const next = blocks.slice();
                    next[i] = { ...next[i], translatedText: e.target.value };
                    setBlocks(next);
                  }}
                />
              </div>
            ))}
          </div>
          <div className="btn-row">
            <button className="btn primary" style={{ width: 'auto', flex: 1 }} onClick={() => api.approve(job.id, blocks)}>
              Continue → Voice
            </button>
            <button className="btn ghost" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  // ── finished ──────────────────────────────────────────────────────────────
  if (job.status === 'done' && job.result) {
    const c = job.result.checks || {};
    return (
      <div className="overlay">
        <div className="sheet sheet-result">
          <SoundToggle on={soundOn} onToggle={toggleSound} />
          <CheckBadge />
          <h3 style={{ textAlign: 'center' }}>ပြီးပါပြီ</h3>
          <video className="result-video" src={api.url(job.result.videoUrl)} controls />
          <div className="checks">
            <span>A/V delta</span><b>{c.durationDeltaMs} ms</b>
            <span>Captions</span><b>{c.captionCount} chunks</b>
            <span>Last caption</span><b>{c.lastCaptionInsideVideo ? 'inside video ✓' : 'PAST video ✗'}</b>
            <span>Output</span><b>{c.size} · {c.fps} fps</b>
            <span>Length</span><b>{Math.round(job.result.duration)}s</b>
          </div>
          <div className="btn-row">
            <a className="btn" href={api.url(job.result.videoUrl)} download><DownloadIcon /> Download MP4</a>
            <a className="btn" href={api.url(job.result.srtUrl)} download><DownloadIcon /> Download SRT</a>
            <button className="btn primary" style={{ width: 'auto', flex: 1 }} onClick={onReset}>+ New video</button>
          </div>
          {history?.length > 1 && (
            <div className="history">
              {history.slice(1, 4).map((h) => (
                <a key={h.videoUrl} href={api.url(h.videoUrl)} target="_blank" rel="noreferrer">{h.fileName}</a>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── error / cancelled ─────────────────────────────────────────────────────
  if (job.status === 'error' || job.status === 'cancelled') {
    return (
      <div className="overlay">
        <div className="sheet">
          <h3>{job.status === 'error' ? 'အမှားတစ်ခု ဖြစ်သွားပါတယ်' : 'ရပ်လိုက်ပါပြီ'}</h3>
          {job.error && <div className="banner bad">{job.error}</div>}
          {job.log?.length > 0 && <div className="logbox">{job.log.join('\n')}</div>}
          <button className="btn primary" onClick={onReset}>ပြန်စမယ်</button>
        </div>
      </div>
    );
  }

  // ── running ───────────────────────────────────────────────────────────────
  return (
    <div className="overlay">
      <div className="sheet">
        <SoundToggle on={soundOn} onToggle={toggleSound} />
        <Ring percent={percent} stage={(stages.find(([k]) => k === job.stage) || [, 'Working'])[1]} alive />
        <div className="stagelist">
          {stages.map(([k, label], i) => {
            const isDone = i < stageIdx;
            const isNow = i === stageIdx;
            return (
              <div key={k} className={'stagerow' + (isDone ? ' done' : isNow ? ' now' : '')}>
                <span className={'dot' + (isDone ? ' dot-done' : '')}>{isDone && <DotCheck />}</span>
                <span>
                  {label}
                  {k === 'upload' && job.status === 'uploading' && ` ${Math.round(uploadPct * 100)}%`}
                </span>
              </div>
            );
          })}
        </div>
        <div className="row">
          <span className="hint">ကြာချိန် {fmt(elapsed)}</span>
          {eta !== null && <span className="hint">ခန့်မှန်း ကျန် {fmt(eta)}</span>}
        </div>
        {job.log?.length > 0 && (
          <div className="logbox">
            {job.log.slice(-12).map((line) => (
              <div key={line} className="log-line">{line}</div>
            ))}
          </div>
        )}
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
