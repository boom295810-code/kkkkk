// Web Audio–generated UI sounds for the processing screen — no audio files
// to bundle. Two short, restrained tones: a soft tick on each finished
// pipeline stage, a warmer chime on completion. Off by default; every
// call here is wrapped so a refused/blocked AudioContext (autoplay policy,
// no Web Audio support, whatever) just does nothing instead of throwing.

let ctx = null;

function getCtx() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  } catch (_) {
    return null;
  }
}

// Call from a direct user-gesture handler (the sound toggle's onClick) so
// the context is allowed to start under browser autoplay rules. Safe to
// call repeatedly.
export function primeAudio() {
  try {
    const c = getCtx();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  } catch (_) {}
}

function tone(freq, { start = 0, duration = 0.14, gain = 0.06, type = 'sine' } = {}) {
  try {
    const c = ctx;
    if (!c) return;
    const t0 = c.currentTime + start;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(amp).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  } catch (_) {}
}

// A soft, high, short blip — macOS-style stage-complete tick.
export function playTick() {
  try {
    if (!ctx || ctx.state !== 'running') return;
    tone(880, { duration: 0.09, gain: 0.045, type: 'sine' });
  } catch (_) {}
}

// A warmer three-note rise for the final render — restrained, not a jingle.
export function playChime() {
  try {
    if (!ctx || ctx.state !== 'running') return;
    tone(587.33, { start: 0, duration: 0.5, gain: 0.05, type: 'sine' }); // D5
    tone(880, { start: 0.09, duration: 0.55, gain: 0.045, type: 'sine' }); // A5
    tone(1174.66, { start: 0.19, duration: 0.6, gain: 0.035, type: 'sine' }); // D6
  } catch (_) {}
}

const KEY = 'rs2-sound-enabled';

export function loadSoundPref() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch (_) {
    return false;
  }
}

export function saveSoundPref(on) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch (_) {}
}
