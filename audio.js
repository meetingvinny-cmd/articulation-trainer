// audio.js - everything that makes noise or listens.
// Speech synthesis, pre rendered mp3 playback, recording, wake lock.
// No network calls except loading our own mp3 files from our own origin.

import { db } from './db.js';

// ---------- sentence splitting ----------
// Deliberately simple and predictable. Handles the abbreviations that actually
// show up in the kind of text he pastes, and never returns an empty sentence.
const ABBREV = /\b(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|inc|ltd|co|approx|no|fig|eg|ie|us|u\.s|a\.m|p\.m)\.$/i;

export function splitSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[.!?])\s+/);
  const out = [];
  for (const p of parts) {
    if (out.length && ABBREV.test(out[out.length - 1])) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out.map(s => s.trim()).filter(Boolean);
}

// ---------- speech synthesis ----------
// iOS will not hand over the voice list until after a user gesture, and the
// first getVoices() call routinely returns an empty array. So: never call this
// outside a tap, and poll a few times before giving up.

let voicesReady = false;
let chosenVoice = null;

function rawVoices() {
  try { return window.speechSynthesis ? window.speechSynthesis.getVoices() : []; }
  catch (e) { return []; }
}

export function speechSupported() {
  return typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
}

// Call this from inside a real tap handler, once, before the first spoken word.
export async function enableVoice() {
  if (!speechSupported()) return { ok: false, reason: 'This browser has no built in voice.' };

  // The unlock: a silent utterance inside the gesture.
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch (e) { /* the poll below is the real test */ }

  for (let i = 0; i < 12; i++) {
    const list = rawVoices();
    if (list.length) { voicesReady = true; break; }
    await new Promise(r => setTimeout(r, 120));
  }
  if (!voicesReady) return { ok: false, reason: 'The voice list never loaded. Pre recorded passages still work.' };

  const savedUri = await db.setting('voice_uri', null);
  const list = rawVoices();
  chosenVoice = list.find(v => v.voiceURI === savedUri) || pickBestVoice(list);
  if (chosenVoice) await db.setSetting('voice_uri', chosenVoice.voiceURI);
  return { ok: true, voice: chosenVoice ? chosenVoice.name : 'the default voice' };
}

function pickBestVoice(list) {
  const en = list.filter(v => /^en(-|_|$)/i.test(v.lang || ''));
  const pool = en.length ? en : list;
  // Prefer a local voice: it works with no signal, which is the point in the car.
  const preferred = ['Samantha', 'Daniel', 'Alex', 'Karen', 'Moira', 'Google US English'];
  for (const name of preferred) {
    const hit = pool.find(v => v.name === name && v.localService !== false);
    if (hit) return hit;
  }
  return pool.find(v => v.localService !== false) || pool[0] || null;
}

export function voicesAvailable() { return voicesReady; }

export function speak(text, { rate = 0.95, onEnd } = {}) {
  return new Promise((resolve) => {
    if (!speechSupported() || !text) { if (onEnd) onEnd(); return resolve(false); }
    try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    const u = new SpeechSynthesisUtterance(String(text));
    if (chosenVoice) u.voice = chosenVoice;
    u.rate = rate;
    u.pitch = 1;
    let done = false;
    const finish = (ok) => { if (done) return; done = true; if (onEnd) onEnd(); resolve(ok); };
    u.onend = () => finish(true);
    u.onerror = () => finish(false);
    // iOS sometimes drops onend entirely. A length based guard means a dropped
    // event never freezes the session.
    const guard = Math.max(2500, String(text).length * 90);
    setTimeout(() => finish(false), guard);
    try { window.speechSynthesis.speak(u); } catch (e) { finish(false); }
  });
}

export function stopSpeaking() {
  try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
}

// ---------- audio file playback ----------

let currentEl = null;

export function stopPlayback() {
  if (currentEl) {
    try { currentEl.pause(); } catch (e) { /* ignore */ }
    if (currentEl.dataset.objurl) URL.revokeObjectURL(currentEl.src);
    currentEl = null;
  }
}

// maxMs is not optional in spirit. A MediaRecorder blob frequently carries no
// duration metadata, and an element playing such a blob can sit there forever
// without ever firing `ended`. That hung a whole Shadow session in testing, so
// every playback now has a hard ceiling and the session always moves on.
export function playUrl(url, { isObjectUrl = false, maxMs = 30000 } = {}) {
  return new Promise((resolve) => {
    stopPlayback();
    const el = new Audio();
    currentEl = el;
    if (isObjectUrl) el.dataset.objurl = '1';
    el.preload = 'auto';
    el.src = url;
    let done = false;
    let guard = null;
    const finish = (ok) => {
      if (done) return; done = true;
      if (guard) clearTimeout(guard);
      try { el.pause(); } catch (e) { /* ignore */ }
      if (isObjectUrl) { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }
      if (currentEl === el) currentEl = null;
      resolve(ok);
    };
    el.onended = () => finish(true);
    el.onerror = () => finish(false);
    // Once real metadata arrives, tighten the ceiling to the actual length.
    el.onloadedmetadata = () => {
      const d = el.duration;
      if (isFinite(d) && d > 0) {
        clearTimeout(guard);
        guard = setTimeout(() => finish(true), d * 1000 + 1500);
      }
    };
    guard = setTimeout(() => finish(true), maxMs);
    el.play().catch(() => finish(false));
  });
}

export async function playBlob(blob, durationSec) {
  if (!blob) return false;
  const cap = durationSec ? (durationSec * 1000 + 2500) : 20000;
  return playUrl(URL.createObjectURL(blob), { isObjectUrl: true, maxMs: cap });
}

// Does this passage have a pre rendered mp3 sitting next to the app?
export async function hasRenderedAudio(path) {
  if (!path) return false;
  try {
    const r = await fetch(path, { method: 'HEAD' });
    return r.ok;
  } catch (e) { return false; }
}

// Say a passage the best way available: the recorded voice if we rendered one,
// otherwise the phone's own voice. Never fails silently.
export async function sayPassage(text, audioPath) {
  if (audioPath) {
    const ok = await playUrl(audioPath);
    if (ok) return 'mp3';
  }
  const ok = await speak(text);
  return ok ? 'tts' : 'none';
}

// ---------- recording ----------
// Safari gives audio/mp4, most examples assume audio/webm. Never hardcode a
// container: ask the browser what it supports and store whatever it actually gave us.

const MIME_ORDER = [
  'audio/mp4',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mpeg'
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_ORDER) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* keep looking */ }
  }
  return '';   // empty string means "let the browser choose"
}

export function recordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
}

let stream = null;

export async function micPermission() {
  if (!recordingSupported()) return { ok: false, reason: 'This browser cannot record audio.' };
  if (stream && stream.active) return { ok: true };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'NotAllowedError'
      ? 'The microphone is blocked. Allow it in Settings, then reopen the app.'
      : 'The microphone did not open: ' + (e && e.message || e) };
  }
}

export function releaseMic() {
  if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
}

export class Recorder {
  constructor() { this.rec = null; this.chunks = []; this.startedAt = 0; this.mime = null; }

  async start() {
    const p = await micPermission();
    if (!p.ok) throw new Error(p.reason);
    this.mime = pickMime();
    this.chunks = [];
    const opts = this.mime ? { mimeType: this.mime } : {};
    try { this.rec = new MediaRecorder(stream, opts); }
    catch (e) { this.rec = new MediaRecorder(stream); this.mime = ''; }
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start();
    this.startedAt = Date.now();
    return true;
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state === 'inactive') return resolve(null);
      this.rec.onstop = () => {
        // Read the container back off the recorder, never off our wish list.
        const actual = (this.rec && this.rec.mimeType) || this.mime || 'audio/mp4';
        const blob = new Blob(this.chunks, { type: actual });
        resolve({ blob, mime: actual, duration_sec: Math.max(0.1, (Date.now() - this.startedAt) / 1000) });
      };
      try { this.rec.stop(); } catch (e) { resolve(null); }
    });
  }

  get running() { return !!this.rec && this.rec.state === 'recording'; }
}

// ---------- wake lock ----------
// The screen going dark mid drill kills speech synthesis on iOS. Ask for a lock
// where it exists, shrug where it does not, never depend on it.

let lock = null;

export async function keepAwake() {
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) {
      lock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', reacquire);
      return true;
    }
  } catch (e) { /* not available, carry on */ }
  return false;
}

async function reacquire() {
  if (document.visibilityState === 'visible' && !lock) { try { await keepAwake(); } catch (e) { /* ignore */ } }
}

export async function letSleep() {
  document.removeEventListener('visibilitychange', reacquire);
  if (lock) { try { await lock.release(); } catch (e) { /* ignore */ } lock = null; }
}
