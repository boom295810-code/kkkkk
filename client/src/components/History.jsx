import { useState } from 'react';
import api from '../api';
import { DownloadIcon } from './icons';

const MODE_LABELS = { dubbing: 'Dubbing', recap: 'AI Recap', 'pro-recap-mm': 'Pro AI Recap' };

const fmtDur = (s) => {
  if (!isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const ss = Math.round(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
};

// Server keeps the last 3 completed renders (MP4 + SRT on disk, indexed in
// history.json) and deletes anything older's files automatically — see
// server/services/history.js. This panel is a thin read-only view over that:
// play (inline), download MP4, download SRT. Survives a server restart
// because the list itself is fetched from the server, not kept client-side.
export default function History({ history, languages }) {
  const [openId, setOpenId] = useState(null);

  if (!history || !history.length) return null;

  const langLabel = (id) => (languages || []).find((l) => l.id === id)?.label || id;

  return (
    <div className="history-panel">
      <div className="history-panel-label">Recent renders</div>
      {history.map((h) => (
        <div key={h.id} className="history-panel-item">
          <div className="history-panel-row">
            <div className="history-panel-info">
              <div className="history-panel-name" title={h.sourceName}>{h.sourceName}</div>
              <div className="history-panel-meta">
                {MODE_LABELS[h.mode] || h.mode} · {langLabel(h.outputLanguage)} · {fmtDur(h.duration)}
              </div>
            </div>
            <div className="history-panel-actions">
              <button className="btn small" onClick={() => setOpenId(openId === h.id ? null : h.id)}>
                {openId === h.id ? '❚❚' : '▶'}
              </button>
              <a className="btn small" href={api.url(h.videoUrl)} download><DownloadIcon /> MP4</a>
              <a className="btn small" href={api.url(h.srtUrl)} download><DownloadIcon /> SRT</a>
            </div>
          </div>
          {openId === h.id && (
            <video className="history-panel-video" src={api.url(h.videoUrl)} controls autoPlay />
          )}
        </div>
      ))}
    </div>
  );
}
