import { useEffect, useRef, useState } from 'react';
import { CloudUploadIcon } from './icons';

const RATIO_VALUE = { original: null, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9 };

const fmt = (s) => {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Mobile-only corner toolbar (see .canvas-toolbar) — once a video is loaded
// the full header is hidden to reclaim its height, so Change video /
// Settings need a small always-reachable home over the canvas instead.
function SwapIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12a8 8 0 0 1 13.5-5.5L20 9" /><path d="M20 4v5h-5" />
      <path d="M20 12a8 8 0 0 1-13.5 5.5L4 15" /><path d="M4 20v-5h5" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </svg>
  );
}
function BoxAddIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="18" height="12" rx="2" strokeDasharray="3 2.5" />
      <path d="M12 10v4M10 12h4" />
    </svg>
  );
}
function CoverBandIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <rect x="3" y="15" width="18" height="4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function Preview({ fileUrl, probe, settings, patch, onPickFile, onReset, onOpenSettings }) {
  const stageRef = useRef(null);
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [over, setOver] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);

  const srcAspect = probe && probe.width ? probe.width / probe.height : 16 / 9;
  const aspect = RATIO_VALUE[settings.ratio] || srcAspect;
  const isPad = settings.fit === 'pad' && settings.ratio !== 'original';
  const fitClass = isPad ? 'contain' : 'cover';
  const scrubPct = probe?.duration ? Math.min(100, Math.max(0, (t / probe.duration) * 100)) : 0;

  // Approximates render.js's pad-mode inner scale/position: the video is
  // already object-fit:contain'd (letterboxed) inside the stage, which has
  // overflow:hidden — scaling it up here crops the overflow exactly like the
  // real render's overlay-position math, so what's clipped in preview is
  // what's clipped in the output.
  //
  // Mirror is listed LAST (CSS applies the rightmost transform function
  // first) so it happens before zoom/pad here too, matching render.js's
  // pipeline order (hflip runs before zoom/pad/blur there) — a positive pad
  // position pushes content the same direction whether mirror is on or not.
  // Blur boxes are separate DOM siblings of <video>, not children of it, so
  // this transform never touches them — a box drawn at a fixed screen
  // position stays there while the content under it flips, exactly like the
  // render (box coordinates are applied after hflip there too).
  const videoTransform = [
    `scale(${settings.zoom || 1})`,
    isPad && Math.abs((settings.pad?.innerScale ?? 1) - 1) > 0.001 ? `scale(${settings.pad.innerScale})` : '',
    isPad && (settings.pad?.posX || settings.pad?.posY)
      ? `translate(${settings.pad.posX || 0}%, ${settings.pad.posY || 0}%)`
      : '',
    settings.copyright?.mirror ? 'scaleX(-1)' : '',
  ].filter(Boolean).join(' ');

  // Approximates render.js's percentage-based edge feather: an elliptical
  // fade from opaque centre to transparent edge, so a higher softness value
  // visibly eats further into the shape — not pixel-identical to the real
  // per-axis alpha ramp, but the same "0 = hard, 100 = fades to the middle"
  // shape, enough to judge the setting before rendering.
  const featherMask = (pct) => {
    const softness = Math.max(0, Math.min(100, pct ?? 40));
    return `radial-gradient(ellipse, black ${100 - softness}%, transparent 100%)`;
  };

  useEffect(() => {
    setPlaying(false);
    setT(0);
  }, [fileUrl]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); }
  };

  const jumpTo = (time) => {
    setT(time);
    if (videoRef.current) videoRef.current.currentTime = time;
  };

  // ── tap-to-play vs. drag-a-box, by movement not timing ──────────────────
  // Attached to the STAGE (the video's own onClick is removed entirely —
  // native video tap handling is what promotes to fullscreen on iOS), so it
  // only ever sees pointer sequences that started on empty canvas: a box's
  // own onPointerDown calls stopPropagation and never reaches here. A
  // sequence that moves more than a few px before release is a drag/click
  // meant for something else (or a mis-tap) and is ignored; anything under
  // the threshold toggles play/pause.
  const tapRef = useRef(null);
  const TAP_MOVE_THRESHOLD = 8;
  const onStagePointerDown = (e) => {
    tapRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onStagePointerMove = (e) => {
    const p = tapRef.current;
    if (!p) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_MOVE_THRESHOLD) p.moved = true;
  };
  const onStagePointerUp = () => {
    const p = tapRef.current;
    tapRef.current = null;
    if (p && !p.moved) togglePlay();
  };

  // ── blur box dragging ──────────────────────────────────────────────────────
  // Coordinates are normalised against the STAGE, which is exactly the output
  // frame — so what you draw here is what gets blurred in the render.
  const startDrag = (e, index, mode) => {
    e.preventDefault();
    e.stopPropagation();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const boxes = settings.blur.boxes;
    const box = boxes[index];
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { ...box };

    const move = (ev) => {
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      const nextBoxes = boxes.slice();
      if (mode === 'move') {
        nextBoxes[index] = {
          ...origin,
          x: clamp01(Math.min(origin.x + dx, 1 - origin.w)),
          y: clamp01(Math.min(origin.y + dy, 1 - origin.h)),
        };
      } else {
        nextBoxes[index] = {
          ...origin,
          w: Math.max(0.04, Math.min(origin.w + dx, 1 - origin.x)),
          h: Math.max(0.03, Math.min(origin.h + dy, 1 - origin.y)),
        };
      }
      patch({ blur: { ...settings.blur, boxes: nextBoxes } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const removeBox = (i) =>
    patch({ blur: { ...settings.blur, boxes: settings.blur.boxes.filter((_, k) => k !== i) } });

  const toggleBoxKind = (i) => {
    const boxes = settings.blur.boxes.slice();
    boxes[i] = { ...boxes[i], kind: boxes[i].kind === 'caption' ? 'background' : 'caption' };
    patch({ blur: { ...settings.blur, boxes } });
  };

  const sub = settings.subtitles;
  const captionBottom =
    sub.position === 'middle' ? '46%' : sub.position === 'custom' ? `${(1 - (sub.customY ?? 0.8)) * 100}%` : `${sub.marginPct}%`;

  if (!fileUrl) {
    return (
      <div className="canvas">
        <div className="canvas-label">Main canvas</div>
        <label
          className={'dropzone' + (over ? ' over' : '')}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) onPickFile(f);
          }}
        >
          <input
            type="file"
            accept="video/*"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && onPickFile(e.target.files[0])}
          />
          <CloudUploadIcon />
          <h3>ဗီဒီယို ထည့်ပါ</h3>
          <p>ဒီနေရာကို ဖိုင်ဆွဲထည့်ပါ — ဒါမှမဟုတ် နှိပ်ပြီး ရွေးပါ</p>
          <p style={{ opacity: 0.7 }}>mp4 · mov · mkv · webm — အရှည် ကန့်သတ်ချက် မရှိပါ</p>
        </label>
      </div>
    );
  }

  return (
    <div className="canvas">
      <div className="canvas-toolbar">
        <button onClick={onReset} title="Change video" aria-label="Change video"><SwapIcon /></button>
        {onOpenSettings && <button onClick={onOpenSettings} title="Settings" aria-label="Settings"><GearIcon /></button>}
      </div>

      <div className="canvas-label">Main canvas · {settings.ratio === 'original' ? 'Original ratio' : settings.ratio}</div>

      <div
        ref={stageRef}
        className={'stage ' + fitClass}
        style={{ aspectRatio: String(aspect), maxWidth: '100%' }}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={() => { tapRef.current = null; }}
      >
        <video
          ref={videoRef}
          src={fileUrl}
          playsInline
          webkit-playsinline="true"
          onTimeUpdate={(e) => setT(e.target.currentTime)}
          onEnded={() => setPlaying(false)}
          style={{ transform: videoTransform, pointerEvents: 'none' }}
        />

        {settings.blur.coverSubtitle && (
          <div
            className="blurbox band"
            style={{
              left: 0,
              width: '100%',
              height: `${settings.blur.bandHeightPct ?? 14}%`,
              bottom: `${settings.blur.bandBottomPct ?? 6}%`,
            }}
          >
            <div
              className="blurbox-surface"
              style={{ maskImage: featherMask(settings.blur.edgeSoftness), WebkitMaskImage: featherMask(settings.blur.edgeSoftness) }}
            />
            <span className="tag">Cover original subtitle</span>
          </div>
        )}

        {settings.blur.boxes.map((b, i) => (
          <div
            key={i}
            className={'blurbox' + (b.kind === 'caption' ? ' caption' : '')}
            style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
            onPointerDown={(e) => startDrag(e, i, 'move')}
          >
            <div
              className="blurbox-surface"
              style={{ maskImage: featherMask(settings.blur.edgeSoftness), WebkitMaskImage: featherMask(settings.blur.edgeSoftness) }}
            />
            <button
              className="tag kind-toggle"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => toggleBoxKind(i)}
              title="Click to switch between Background and Caption blur"
            >
              {b.kind === 'caption' ? 'Caption' : 'Background'}
            </button>
            <button className="kill" onPointerDown={(e) => e.stopPropagation()} onClick={() => removeBox(i)}>×</button>
            <span className="handle" onPointerDown={(e) => startDrag(e, i, 'resize')} />
          </div>
        ))}

        {sub.enabled && sub.burn && (
          <div
            className="captionghost"
            style={{
              bottom: captionBottom,
              fontSize: `calc(${sub.size / 1080} * var(--stage-h))`,
              color: sub.primary,
              textShadow: `0 0 ${sub.outlineWidth}px ${sub.outline}, 0 0 ${sub.outlineWidth * 2}px ${sub.outline}`,
              WebkitTextStroke: `${Math.max(1, sub.outlineWidth * 0.6)}px ${sub.outline}`,
              paintOrder: 'stroke fill',
            }}
          >
            စာတန်းထိုး နမူနာ စာကြောင်း
          </div>
        )}

        {settings.watermark.enabled && settings.watermark.text && (
          <div
            style={{
              position: 'absolute',
              color: `rgba(255,255,255,${settings.watermark.opacity})`,
              fontSize: 'calc(0.030 * var(--stage-h))',
              fontWeight: 700,
              textShadow: '0 1px 3px rgba(0,0,0,.6)',
              ...(settings.watermark.position === 'top-left' ? { top: '4%', left: '4%' }
                : settings.watermark.position === 'top-right' ? { top: '4%', right: '4%' }
                : settings.watermark.position === 'bottom-left' ? { bottom: '4%', left: '4%' }
                : settings.watermark.position === 'center' ? { top: '48%', left: 0, right: 0, textAlign: 'center' }
                : { bottom: '4%', right: '4%' }),
            }}
          >
            {settings.watermark.text}
          </div>
        )}
      </div>

      <div className="transport">
        <button className="btn small transport-play" onClick={togglePlay}>{playing ? '❚❚' : '▶'}</button>

        <button className="btn small transport-jump" onClick={() => jumpTo(0)} title="Jump to start" aria-label="Jump to start">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="4" y="5" width="2.4" height="14" /><path d="M18 5v14l-10-7z" /></svg>
        </button>

        <div className="scrub-wrap">
          {scrubbing && (
            <div className="scrub-bubble" style={{ left: `${scrubPct}%` }}>{fmt(t)}</div>
          )}
          <input
            className="scrub"
            type="range"
            min={0}
            max={probe?.duration || 0}
            step={0.05}
            value={t}
            style={{ background: `linear-gradient(to right, var(--accent) ${scrubPct}%, var(--canvas-line) ${scrubPct}%)` }}
            onPointerDown={() => setScrubbing(true)}
            onPointerUp={() => setScrubbing(false)}
            onPointerCancel={() => setScrubbing(false)}
            onChange={(e) => jumpTo(Number(e.target.value))}
          />
        </div>

        <button className="btn small transport-jump" onClick={() => jumpTo(Math.max(0, (probe?.duration || 0) - 0.05))} title="Jump to end" aria-label="Jump to end">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="17.6" y="5" width="2.4" height="14" /><path d="M6 5v14l10-7z" /></svg>
        </button>

        <span className="time">{fmt(t)} / {fmt(probe?.duration || 0)}</span>

        <button
          className="btn small transport-tool"
          onClick={() =>
            patch({
              blur: {
                ...settings.blur,
                boxes: [...settings.blur.boxes, { x: 0.12, y: 0.72, w: 0.76, h: 0.12, kind: 'background' }].slice(0, 3),
              },
            })
          }
        >
          <span className="tool-icon"><BoxAddIcon /></span>
          <span className="tool-label">+ Blur box</span>
        </button>
        <button
          className={'btn small transport-tool' + (settings.blur.coverSubtitle ? ' primary' : '')}
          onClick={() => patch({ blur: { ...settings.blur, coverSubtitle: !settings.blur.coverSubtitle } })}
        >
          <span className="tool-icon"><CoverBandIcon /></span>
          <span className="tool-label">Cover subtitle</span>
        </button>
      </div>
    </div>
  );
}
