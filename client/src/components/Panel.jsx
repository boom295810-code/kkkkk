import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import api from '../api';

const ICONS = {
  Source: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M10 9.5v5l4.5-2.5z" fill="currentColor" stroke="none" />
    </svg>
  ),
  Voice: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3M9 21h6" />
    </svg>
  ),
  Subtitles: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <line x1="7" y1="10.5" x2="17" y2="10.5" />
      <line x1="7" y1="14" x2="13" y2="14" />
    </svg>
  ),
  Advanced: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="7" x2="20" y2="7" /><circle cx="15" cy="7" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="12" x2="20" y2="12" /><circle cx="9" cy="12" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="17" x2="20" y2="17" /><circle cx="13" cy="17" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
};

const TABS = ['Source', 'Voice', 'Subtitles', 'Advanced'];

// Measures the active tab button's box within its own nav container and
// returns {left,width} so a sliding pill can be positioned with a CSS
// transition instead of hard-swapping a highlight. Used independently for
// the desktop top strip and the mobile bottom bar — only one of the two is
// ever actually visible (the other is display:none via CSS), so each keeps
// its own measurement and just re-measures on tab change / window resize.
function usePillRect(containerRef, activeKey) {
  const [rect, setRect] = useState({ left: 0, width: 0 });
  const measure = () => {
    const container = containerRef.current;
    if (!container) return;
    const btn = container.querySelector(`[data-tab="${activeKey}"]`);
    if (!btn) return;
    setRect({ left: btn.offsetLeft, width: btn.offsetWidth });
  };
  useLayoutEffect(measure, [activeKey]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);
  return rect;
}

function Seg({ value, options, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Every slider in the panel routes through here, so the − / + buttons, the
// touch-vs-scroll fix (touch-action: pan-y on the native input, in CSS),
// and the press-and-hold repeat are all defined exactly once.
function Slider({ label, value, min, max, step, buttonStep, onChange, format }) {
  const bStep = buttonStep ?? step;
  const decimals = (String(bStep).split('.')[1] || '').length;
  const valueRef = useRef(value);
  const holdRef = useRef(null);
  useEffect(() => { valueRef.current = value; }, [value]);
  useEffect(() => () => clearTimeout(holdRef.current), []);

  const stepOnce = (dir) => {
    const raw = valueRef.current + dir * bStep;
    const clamped = Math.min(max, Math.max(min, raw));
    const next = Number(clamped.toFixed(decimals));
    valueRef.current = next;
    onChange(next);
  };

  const clearHold = () => { clearTimeout(holdRef.current); holdRef.current = null; };

  const startHold = (dir) => {
    stepOnce(dir);
    const startedAt = Date.now();
    const scheduleNext = () => {
      const rate = Date.now() - startedAt > 1000 ? 70 : 170;
      holdRef.current = setTimeout(() => { stepOnce(dir); scheduleNext(); }, rate);
    };
    scheduleNext();
  };

  return (
    <div className="group" style={{ gap: 6 }}>
      <div className="row">
        <label>{label}</label>
        <span className="value">{format ? format(value) : value}</span>
      </div>
      <div className="slider-row">
        <button
          type="button" className="stepbtn" disabled={value <= min}
          onPointerDown={(e) => { e.preventDefault(); startHold(-1); }}
          onPointerUp={clearHold} onPointerLeave={clearHold} onPointerCancel={clearHold}
          aria-label={`Decrease ${label}`}
        >
          −
        </button>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        <button
          type="button" className="stepbtn" disabled={value >= max}
          onPointerDown={(e) => { e.preventDefault(); startHold(1); }}
          onPointerUp={clearHold} onPointerLeave={clearHold} onPointerCancel={clearHold}
          aria-label={`Increase ${label}`}
        >
          +
        </button>
      </div>
    </div>
  );
}

function Switch({ label, checked, onChange }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span>{label}</span>
    </label>
  );
}

export default function Panel({ settings, patch, meta, probe, onStart, busy, hasFile }) {
  const [tab, setTab] = useState('Source');
  const [previewing, setPreviewing] = useState(false);
  const tabsRef = useRef(null);
  const tabbarRef = useRef(null);
  const tabsPill = usePillRect(tabsRef, tab);
  const tabbarPill = usePillRect(tabbarRef, tab);

  // The bottom tab bar switches on a clean tap only — same movement
  // threshold as the canvas tap-to-play, not a timing heuristic. A scroll
  // gesture that happens to start or end over the fixed bar must never
  // change tabs, so this ignores onClick entirely and judges purely by how
  // far the pointer travelled between down and up.
  const tabTapRef = useRef(null);
  const TAB_TAP_THRESHOLD = 8;
  const onTabbarPointerDown = (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    tabTapRef.current = { x: e.clientX, y: e.clientY, moved: false, tab: btn.dataset.tab };
  };
  const onTabbarPointerMove = (e) => {
    const p = tabTapRef.current;
    if (!p) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAB_TAP_THRESHOLD) p.moved = true;
  };
  const onTabbarPointerUp = () => {
    const p = tabTapRef.current;
    tabTapRef.current = null;
    if (p && !p.moved) setTab(p.tab);
  };

  const playVoice = async () => {
    setPreviewing(true);
    try {
      const url = await api.previewVoice(settings.voicePreset, Math.round(settings.voiceRate - 20));
      const a = new Audio(url);
      a.onended = () => setPreviewing(false);
      a.onerror = () => setPreviewing(false);
      await a.play();
    } catch (e) {
      alert(e.message);
      setPreviewing(false);
    }
  };

  const sub = settings.subtitles;
  const patchSub = (p) => patch({ subtitles: { ...sub, ...p } });
  const patchBlur = (p) => patch({ blur: { ...settings.blur, ...p } });
  const patchWm = (p) => patch({ watermark: { ...settings.watermark, ...p } });
  const patchPad = (p) => patch({ pad: { ...settings.pad, ...p } });
  const patchCopyright = (p) => patch({ copyright: { ...settings.copyright, ...p } });

  // Output language lives INSIDE Pro AI Recap (not a separate mode) — see
  // server/services/proLanguages.js. Switching it resets voice + font to
  // that language's own defaults so a stale Burmese/English pick can't leak
  // across languages.
  const isProRecap = settings.mode === 'pro-recap-mm';
  const changeOutputLanguage = (langId) => {
    const langMeta = (meta.languages || []).find((l) => l.id === langId);
    patch({
      outputLanguage: langId,
      voicePreset: langMeta?.defaultVoiceId || settings.voicePreset,
      subtitles: { ...settings.subtitles, fontFile: '' },
    });
  };
  const voiceList = isProRecap
    ? (meta.voices || []).filter(
        (v) => v.lang === settings.outputLanguage && (settings.outputLanguage !== 'en' || /^en-(US|GB)-/.test(v.voice))
      )
    : meta.voices || [];
  const fontScript = settings.outputLanguage === 'en' ? 'latin' : 'burmese';
  const fontList = isProRecap ? (meta.fonts || []).filter((f) => f.script === fontScript) : meta.fonts || [];

  return (
    <div className="panel">
      <div className="tabs" ref={tabsRef}>
        <div className="tab-pill" style={{ transform: `translateX(${tabsPill.left}px)`, width: tabsPill.width }} />
        {TABS.map((t) => (
          <button key={t} data-tab={t} className={'tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="panel-body">
        {/* ── SOURCE ─────────────────────────────────────────────────────── */}
        {tab === 'Source' && (
          <>
            {probe && (
              <div className="group">
                <h4>Source</h4>
                <div className="meta">
                  <span>Duration</span><b>{Math.round(probe.duration)}s</b>
                  <span>Resolution</span><b>{probe.width}×{probe.height}</b>
                </div>
              </div>
            )}

            <div className="group">
              <h4>Processing mode</h4>
              <button className={'modecard' + (settings.mode === 'recap' ? ' on' : '')} onClick={() => patch({ mode: 'recap' })}>
                <b>AI Recap</b>
                <span>Narration / recap ဗီဒီယို — အသံက master ဖြစ်ပြီး ဗီဒီယိုကို အသံနဲ့ကိုက်အောင် ဆွဲချိန်တယ်။</span>
              </button>
              <button className={'modecard' + (settings.mode === 'pro-recap-mm' ? ' on' : '')} onClick={() => patch({ mode: 'pro-recap-mm' })}>
                <b>Pro AI Recap</b>
                <span>Dialogue ဗီဒီယိုအတွက် — ဘာမှ မဖြတ်ဘူး။ block တစ်ခုစီရဲ့ ဗီဒီယို အပိုင်းကို အသံ length နဲ့ အတိအကျ ကိုက်အောင် independent speed နဲ့ ချိန်တယ်။</span>
              </button>
            </div>

            {isProRecap && (
              <div className="group">
                <h4>Output language</h4>
                <select value={settings.outputLanguage} onChange={(e) => changeOutputLanguage(e.target.value)}>
                  {(meta.languages || []).map((l) => (
                    <option key={l.id} value={l.id}>{l.label}</option>
                  ))}
                </select>
                <p className="hint">ဘာသာစကား ပြောင်းရင် voice နဲ့ font ကို အဲဒီဘာသာရဲ့ default ကို ပြန်ချိန်ပေးပါတယ်။</p>
              </div>
            )}

            <div className="group">
              <h4>Aspect ratio</h4>
              <Seg
                value={settings.ratio}
                onChange={(v) => patch({ ratio: v })}
                options={[
                  { value: 'original', label: 'Original' },
                  { value: '9:16', label: '9:16' },
                  { value: '1:1', label: '1:1' },
                  { value: '4:5', label: '4:5' },
                  { value: '16:9', label: '16:9' },
                ]}
              />
              {settings.ratio !== 'original' && (
                <>
                  <Seg
                    value={settings.fit}
                    onChange={(v) => patch({ fit: v })}
                    options={[
                      { value: 'crop', label: 'Crop (fill)' },
                      { value: 'pad', label: 'Pad (blur bg)' },
                    ]}
                  />
                  {settings.fit === 'crop' && (
                    <Seg
                      value={settings.focus}
                      onChange={(v) => patch({ focus: v })}
                      options={[
                        { value: 'top', label: 'Top' },
                        { value: 'center', label: 'Center' },
                        { value: 'bottom', label: 'Bottom' },
                      ]}
                    />
                  )}
                  {settings.fit === 'pad' && (
                    <>
                      <Slider
                        label="Inner scale"
                        value={settings.pad.innerScale}
                        min={1} max={1.6} step={0.01} buttonStep={0.05}
                        onChange={(v) => patchPad({ innerScale: v })}
                        format={(v) => `${v.toFixed(2)}×`}
                      />
                      <Slider
                        label="Vertical position"
                        value={settings.pad.posY}
                        min={-100} max={100} step={1}
                        onChange={(v) => patchPad({ posY: v })}
                        format={(v) => `${v > 0 ? '+' : ''}${v}%`}
                      />
                      <Slider
                        label="Horizontal position"
                        value={settings.pad.posX}
                        min={-100} max={100} step={1}
                        onChange={(v) => patchPad({ posX: v })}
                        format={(v) => `${v > 0 ? '+' : ''}${v}%`}
                      />
                      <p className="hint">Source ကို pad frame ထဲမှာ ချဲ့/ရွှေ့ချင်ရင် — ပြင်ပကျော်တဲ့ အပိုင်းကို crop လုပ်ပါတယ်။ Preview မှာ တိုက်ရိုက် မြင်ရပါတယ်။</p>
                    </>
                  )}
                </>
              )}
            </div>

            <div className="group">
              <h4>Copyright</h4>
              <Switch
                label="Mirror horizontally"
                checked={settings.copyright.mirror}
                onChange={(v) => patchCopyright({ mirror: v })}
              />
              <Slider
                label="Zoom (copyright nudge)"
                value={settings.zoom}
                min={1} max={1.15} step={0.01} buttonStep={0.05}
                onChange={(v) => patch({ zoom: v })}
                format={(v) => `${v.toFixed(2)}×`}
              />
              <Switch
                label="Small random crop offset"
                checked={settings.copyright.randomCrop}
                onChange={(v) => patchCopyright({ randomCrop: v })}
              />
              <p className="hint">Mirror ကို bounding box/pad position တွေထက် အရင်ချမှတ်ပါတယ် — box တွေနဲ့ pad position ဟာ မှန်ရိပ်ပြီးတဲ့ frame အတိုင်းသာ အလုပ်လုပ်ပါတယ်။ Random crop က render တစ်ခါစီ pixel အနည်းငယ် ကွဲပြားစေတယ်။</p>
            </div>
          </>
        )}

        {/* ── VOICE ──────────────────────────────────────────────────────── */}
        {tab === 'Voice' && (
          <>
            <div className="group">
              <h4>Voice</h4>
              <select value={settings.voicePreset} onChange={(e) => patch({ voicePreset: e.target.value })}>
                {voiceList.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
              <div className="btn-row">
                <button className="btn small" onClick={playVoice} disabled={previewing}>
                  {previewing ? 'Playing…' : '▶ Preview voice'}
                </button>
              </div>
              <p className="hint">
                {isProRecap
                  ? 'Pro AI Recap ရဲ့ Output language အလိုက် voice list ကို filter လုပ်ထားပါတယ်။'
                  : 'Burmese = Thiha / Nilar (edge-tts). English အသံတွေလည်း ရွေးလို့ရပါတယ်။'}
              </p>
            </div>

            <div className="group">
              <h4>Speed</h4>
              <Slider
                label="Voice speed"
                value={settings.voiceRate}
                min={-10} max={45} step={1}
                onChange={(v) => patch({ voiceRate: v })}
                format={(v) => `${v >= 0 ? '+' : ''}${v}%`}
              />
              <Slider
                label="Video speed"
                value={settings.videoSpeed}
                min={0.85} max={1.15} step={0.01} buttonStep={0.05}
                onChange={(v) => patch({ videoSpeed: v })}
                format={(v) => `${v.toFixed(2)}×`}
              />
              {(settings.mode === 'recap' || isProRecap) && (
                <p className="hint">AI Recap / Pro Recap မှာ ဗီဒီယို speed ကို engine က အလိုအလျောက် ချိန်ပါတယ် — ဒီ slider က dubbing mode အတွက်ပါ။</p>
              )}
              <Switch
                label="Auto-fit (အသံက ဗီဒီယိုထက် မကျော်အောင်)"
                checked={settings.autoFit}
                onChange={(v) => patch({ autoFit: v })}
              />
            </div>

            <div className="group">
              <h4>Original audio</h4>
              <Seg
                value={settings.originalAudio}
                onChange={(v) => patch({ originalAudio: v })}
                options={[
                  { value: 'mute', label: 'Mute' },
                  { value: 'duck', label: 'Duck −18dB' },
                ]}
              />
              <p className="hint">Duck က dubbing mode မှာသာ အလုပ်လုပ်ပါတယ် (AI Recap မှာ ဗီဒီယို retime လုပ်လို့ မူရင်းအသံ မကိုက်တော့ပါ)။</p>
            </div>

            <div className="group">
              <h4>Review</h4>
              <Switch
                label="အသံမထုတ်ခင် ဘာသာပြန်ကို ပြင်ချင်တယ်"
                checked={settings.reviewBeforeVoice}
                onChange={(v) => patch({ reviewBeforeVoice: v })}
              />
            </div>
          </>
        )}

        {/* ── SUBTITLES / EFFECTS ────────────────────────────────────────── */}
        {tab === 'Subtitles' && (
          <>
            <div className="group">
              <h4>Captions</h4>
              <Switch label="Captions ထည့်မယ်" checked={sub.enabled} onChange={(v) => patchSub({ enabled: v })} />
              {sub.enabled && (
                <>
                  <Seg
                    value={sub.burn ? 'burn' : 'srt'}
                    onChange={(v) => patchSub({ burn: v === 'burn' })}
                    options={[
                      { value: 'burn', label: 'Burn into video' },
                      { value: 'srt', label: '.srt only' },
                    ]}
                  />
                  <p className="hint">.srt ဖိုင်ကို ဘယ်လိုရွေးရွေး အမြဲ ထုတ်ပေးပါတယ်။</p>
                  <select value={sub.fontFile || ''} onChange={(e) => patchSub({ fontFile: e.target.value })}>
                    <option value="">{isProRecap && settings.outputLanguage === 'en' ? 'Default (Inter)' : 'Default Myanmar font'}</option>
                    {fontList.map((f) => (
                      <option key={f.file} value={f.file}>{f.name}</option>
                    ))}
                  </select>
                  <Slider label="Font size" value={sub.size} min={24} max={80} step={1} buttonStep={2} onChange={(v) => patchSub({ size: v })} />
                  <div className="row">
                    <label>Text colour</label>
                    <input type="color" value={sub.primary} onChange={(e) => patchSub({ primary: e.target.value })} />
                  </div>
                  <div className="row">
                    <label>Outline colour</label>
                    <input type="color" value={sub.outline} onChange={(e) => patchSub({ outline: e.target.value })} />
                  </div>
                  <Slider label="Outline width" value={sub.outlineWidth} min={0} max={8} step={1} onChange={(v) => patchSub({ outlineWidth: v })} />
                  <Seg
                    value={sub.position}
                    onChange={(v) => patchSub({ position: v })}
                    options={[
                      { value: 'bottom', label: 'Bottom' },
                      { value: 'middle', label: 'Middle' },
                      { value: 'custom', label: 'Custom' },
                    ]}
                  />
                  {sub.position === 'bottom' && (
                    <Slider label="Bottom margin" value={sub.marginPct} min={2} max={40} step={1} onChange={(v) => patchSub({ marginPct: v })} format={(v) => `${v}%`} />
                  )}
                  {sub.position === 'custom' && (
                    <Slider label="Vertical position" value={sub.customY ?? 0.8} min={0.05} max={0.95} step={0.01} onChange={(v) => patchSub({ customY: v })} format={(v) => `${Math.round(v * 100)}%`} />
                  )}
                  <Slider label="Words per caption" value={sub.maxWords} min={3} max={10} step={1} onChange={(v) => patchSub({ maxWords: v })} />
                </>
              )}
            </div>

            <div className="group">
              <h4>Caption blur</h4>
              <p className="hint">မူရင်း burned-in caption ကို ဖုံးဖို့ full-width band တစ်ခု။</p>
              <Switch
                label="Cover original subtitle (full-width band)"
                checked={settings.blur.coverSubtitle}
                onChange={(v) => patchBlur({ coverSubtitle: v })}
              />
              {settings.blur.coverSubtitle && (
                <>
                  <Slider label="Band height" value={settings.blur.bandHeightPct ?? 14} min={5} max={35} step={1} onChange={(v) => patchBlur({ bandHeightPct: v })} format={(v) => `${v}%`} />
                  <Slider label="Band bottom offset" value={settings.blur.bandBottomPct ?? 6} min={0} max={40} step={1} onChange={(v) => patchBlur({ bandBottomPct: v })} format={(v) => `${v}%`} />
                </>
              )}
              <Slider label="Caption blur strength" value={settings.blur.captionStrength} min={5} max={50} step={1} onChange={(v) => patchBlur({ captionStrength: v })} />
            </div>

            <div className="group">
              <h4>Background blur</h4>
              <p className="hint">Watermark၊ logo၊ မျက်နှာ စတာတွေအတွက် box ဆွဲပါ — box ရဲ့ label ကို နှိပ်ရင် Caption blur အဖြစ် ပြောင်းနိုင်ပါတယ်။</p>
              <div className="btn-row">
                <button
                  className="btn small"
                  onClick={() => patchBlur({ boxes: [...settings.blur.boxes, { x: 0.12, y: 0.72, w: 0.76, h: 0.12, kind: 'background' }].slice(0, 3) })}
                >
                  + Add box ({settings.blur.boxes.length}/3)
                </button>
                <button className="btn small" onClick={() => patchBlur({ boxes: [] })}>Clear</button>
              </div>
              <Slider label="Background blur strength" value={settings.blur.backgroundStrength} min={5} max={50} step={1} onChange={(v) => patchBlur({ backgroundStrength: v })} />
            </div>

            <div className="group">
              <h4>Blur softness</h4>
              <Slider label="Edge softness (both kinds)" value={settings.blur.edgeSoftness} min={0} max={100} step={1} onChange={(v) => patchBlur({ edgeSoftness: v })} format={(v) => `${v}%`} />
              <p className="hint">0 = hard edge, 100 = box/band ရဲ့ အလယ်ထိ gradient ဖြစ်သွားတယ် — box အရွယ်အစား မတူလည်း အချိုးကျ softness တူတယ်။</p>
            </div>

            <div className="group">
              <h4>Watermark</h4>
              <Switch label="Watermark ထည့်မယ်" checked={settings.watermark.enabled} onChange={(v) => patchWm({ enabled: v })} />
              {settings.watermark.enabled && (
                <>
                  <input type="text" placeholder="@yourchannel" value={settings.watermark.text} onChange={(e) => patchWm({ text: e.target.value })} />
                  <Seg
                    value={settings.watermark.position}
                    onChange={(v) => patchWm({ position: v })}
                    options={[
                      { value: 'top-left', label: '↖' },
                      { value: 'top-right', label: '↗' },
                      { value: 'center', label: '◉' },
                      { value: 'bottom-left', label: '↙' },
                      { value: 'bottom-right', label: '↘' },
                    ]}
                  />
                  <Slider label="Opacity" value={settings.watermark.opacity} min={0.1} max={1} step={0.05} onChange={(v) => patchWm({ opacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
                </>
              )}
            </div>
          </>
        )}

        {/* ── ADVANCED ───────────────────────────────────────────────────── */}
        {tab === 'Advanced' && (
          <>
            <div className="group">
              <h4>Output</h4>
              <input
                type="text"
                placeholder="ဖိုင်နာမည် (ရိုက်မထည့်ရင် မူရင်းနာမည်)"
                value={settings.outputName || ''}
                onChange={(e) => patch({ outputName: e.target.value })}
              />
              <Seg
                value={settings.quality}
                onChange={(v) => patch({ quality: v })}
                options={[
                  { value: 'draft', label: 'Draft (fast)' },
                  { value: 'normal', label: 'Normal' },
                  { value: 'high', label: 'High' },
                ]}
              />
              <Seg
                value={String(settings.fps)}
                onChange={(v) => patch({ fps: Number(v) })}
                options={[
                  { value: '24', label: '24 fps' },
                  { value: '30', label: '30 fps' },
                  { value: '60', label: '60 fps' },
                ]}
              />
              <p className="hint">Output က CFR (constant frame rate) ဖြစ်ပြီး အသံကို −16 LUFS အထိ normalize လုပ်ပါတယ်။</p>
            </div>
          </>
        )}
      </div>

      <div className="panel-foot">
        <button className="btn primary" disabled={!hasFile || busy} onClick={onStart}>
          {busy ? 'Processing…' : 'Start Processing'}
        </button>
      </div>

      {/* ── mobile-only bottom tab bar — same `tab` state as the desktop nav
           above, just rendered as fixed icon+label segments. Hidden on
           desktop via CSS; `.tabs` above is hidden on mobile the same way. ── */}
      <div
        className="tabbar"
        ref={tabbarRef}
        onPointerDown={onTabbarPointerDown}
        onPointerMove={onTabbarPointerMove}
        onPointerUp={onTabbarPointerUp}
        onPointerCancel={() => { tabTapRef.current = null; }}
      >
        <div className="tabbar-pill" style={{ transform: `translateX(${tabbarPill.left}px)`, width: tabbarPill.width }} />
        {TABS.map((t) => (
          <button key={t} data-tab={t} className={'tabbar-item' + (tab === t ? ' active' : '')}>
            {ICONS[t]}
            <span>{t}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
