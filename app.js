// app.js - screens, the morning session runner, and all five modes.
// No network calls. No API keys. Everything stays in IndexedDB on this device.

import { db, uuid, today, addDays, daysBetween } from './db.js';
import {
  splitSentences, enableVoice, speak, stopSpeaking, speechSupported,
  playUrl, playBlob, stopPlayback, sayPassage, Recorder, recordingSupported,
  micPermission, releaseMic, keepAwake, letSleep,
  recognitionSupported, listen, stopListening, speechSelfTest, analyseWaveform, isStandalone as inStandalone
} from './audio.js';
import { scoreTake, feedbackFor, fillerRate, coverage, wpm as calcWpm, paceVerdict } from './score.js';
import { dailySeries, trend, sparkline, skipReport } from './progress.js';
import * as grading from './grade.js';
import {
  seedIfNeeded, dueWords, nextCardState, deckMastery, streakInfo,
  todaysDrill, coldestPerson, daysSince, connectStats, storageInfo, pruneClips
} from './logic.js';

const $ = (id) => document.getElementById(id);

// Every string that came from him (a name, an error message) goes through this
// before it can reach innerHTML. Self inflicted or not, no raw markup gets in.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const SCREENS = ['install','home','shadow','paste','pick','fgroup','frame','clear','progress','help','grade','words','connect','log','people','person','done','settings'];

let session = null;      // the live session row
let queue = [];          // remaining step names
let results = {};        // per-step numbers for the Done screen

// ---------------- shell ----------------

function show(name) {
  for (const s of SCREENS) $('s-' + s).hidden = (s !== name);
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), ms);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function prettyBytes(n) {
  if (n == null) return 'unknown';
  const u = ['B','KB','MB','GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

function longDate(d = new Date()) {
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

// ---------------- boot ----------------

async function boot() {
  try {
    await db.ready();
  } catch (e) {
    document.getElementById('app').innerHTML =
      '<div class="card"><h2>Storage is blocked</h2><p>This browser will not let the app save anything, so nothing you do would be remembered. Private browsing is the usual cause. Open it in a normal window, or install it to the Home Screen.</p><p class="small muted">' +
      escapeHtml(String(e && e.message || e)) + '</p></div>';
    return;
  }

  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) { /* best effort only */ }
  }

  await seedIfNeeded();
  await pruneClips();

  wire();

  // Register before any early return, otherwise sitting on the install screen
  // means the offline cache never gets built.
  if ('serviceWorker' in navigator) {
    // When a new version takes over, reload once so he is never drilling against
    // yesterday's build. The guard stops the reload loop.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus, never a blocker */ });
  }

  const hideInstall = await db.setting('hide_install', false);
  if (!isStandalone() && !hideInstall) { show('install'); return; }
  await renderHome();
  show('home');
}

// ---------------- home ----------------

async function renderHome() {
  const st = await streakInfo();
  $('home-streak').textContent = st.streak;
  $('home-date').textContent = longDate();

  const floor = st.missedYesterday && !st.doneToday;
  $('home-len').textContent = floor ? '2 min' : '10 min';
  $('home-streak-note').textContent =
    st.doneToday ? 'Done today. Anything else is a bonus.'
    : floor ? 'You missed yesterday, so today is the short version. Two minutes keeps the streak.'
    : st.streak > 0 ? 'Keep it going.' : 'Start it today.';

  const m = await deckMastery();
  $('home-mastery').textContent = m.pct + '%';
  $('home-due').textContent = (await dueWords(999)).filter(w => !w.due_date || w.due_date <= today()).length;

  const cold = await coldestPerson();
  const cd = cold ? daysSince(cold.last_touch_date) : null;
  $('home-cold').textContent = cold ? (cd == null ? 'new' : cd) : '-';

  const drill = todaysDrill();
  const plan = planFor(floor, drill);
  $('home-plan').innerHTML = plan.map(p => '<li><b>' + p.label + '</b><div class="small muted">' + p.note + '</div></li>').join('');
  $('home-start').textContent = st.doneToday ? 'Go again' : 'Start';
}

// The plan is data, so M2 and M3 add steps here and nothing else changes.
// STEPS holds every step the build currently knows how to run.
const STEPS = {};

function planFor(floor, drill) {
  const order = floor ? ['words'] : ['drill', 'words', 'connect'];
  const out = [];
  for (const key of order) {
    if (key === 'drill') {
      const s = STEPS[drill.mode];
      if (s) out.push({ key: drill.mode, label: s.label, note: drill.open ? s.note + '. Weekend pick, this is the default' : s.note });
      continue;
    }
    const s = STEPS[key];
    if (s) out.push({ key, label: s.label, note: floor ? 'Five cards is enough today' : s.note });
  }
  return out;
}

async function startSession() {
  const st = await streakInfo();
  const floor = st.missedYesterday && !st.doneToday;
  const drill = todaysDrill();
  const plan = planFor(floor, drill);

  session = {
    id: new Date().toISOString(),
    date: today(),
    started_at: new Date().toISOString(),
    ended_at: null,
    duration_sec: 0,
    modes_run: [],
    modes_skipped: [],
    completed: false,
    floor_session: floor,
    streak_after: 0
  };
  results = { floor };
  queue = plan.map(p => p.key);
  await db.put('sessions', session);
  nextStep();
}

// M5: the session row carries which group and which scenario he actually spoke,
// so the /redevelop skill can read the log later and know what was drilled.
async function noteScenario(mode, group, groupLabel, name) {
  if (!session) return;
  session.scenarios = session.scenarios || [];
  session.scenarios.push({ mode, group: group || null, group_label: groupLabel || null, name: name || null });
  if (!session.scenario_group) { session.scenario_group = group || null; session.scenario_group_label = groupLabel || null; }
  if (!session.scenario_name) session.scenario_name = name || null;
  await db.put('sessions', session);
}

async function nextStep(skipped) {
  if (skipped) session.modes_skipped.push(skipped);
  const key = queue.shift();
  if (!key) return endSession();
  session.modes_run.push(key);
  await db.put('sessions', session);
  STEPS[key].run();
}

async function endSession() {
  session.ended_at = new Date().toISOString();
  session.duration_sec = Math.round((Date.parse(session.ended_at) - Date.parse(session.started_at)) / 1000);
  session.completed = true;
  await db.put('sessions', session);
  const st = await streakInfo();
  session.streak_after = st.streak;
  await db.put('sessions', session);

  $('done-streak').textContent = st.streak;
  const nums = [];
  if (results.cards_total) nums.push(['Cards', results.cards_correct + '/' + results.cards_total]);
  const m = await deckMastery();
  nums.push(['Mastered', m.pct + '%']);
  if (results.connected) nums.push(['Touched', results.connected]);
  if (results.wpm) nums.push(['Words per min', results.wpm]);
  if (results.filler_rate != null) nums.push(['Filler a min', results.filler_rate]);
  $('done-numbers').innerHTML = nums.map(([k, v]) =>
    '<div><div class="bignum">' + escapeHtml(v) + '</div><div class="small muted">' + escapeHtml(k) + '</div></div>').join('');
  $('done-feedback').textContent = await feedbackLine(results, m);
  renderDonts();
  show('done');
}

// The DON'Ts belong to the scenario he just spoke in Frame. No scenario, or a
// scenario that ships without them, means the card stays hidden.
function renderDonts() {
  const list = results.donts || [];
  $('done-donts-card').hidden = list.length === 0;
  if (!list.length) return;
  $('done-donts-head').textContent = results.donts_scenario
    ? 'Do not, ' + results.donts_scenario : 'Do not';
  $('done-donts').innerHTML = list.map(d => '<li>' + escapeHtml(d) + '</li>').join('');
}

// The one line of feedback comes from the visible rules table in score.js.
// It is never a network call and never a model.
async function feedbackLine(r, mastery) {
  const prev = await previousFillerRate();
  return feedbackFor({ ...r, mastery_pct: mastery.pct, prev_filler_rate: prev });
}

async function previousFillerRate() {
  const reps = await db.all('reps');
  const rated = reps
    .filter(x => x.filler_rate != null && x.session_id !== (session && session.id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return rated.length ? rated[0].filler_rate : null;
}

// The written answer to the standalone versus tab question, recorded from a real
// run on his phone rather than assumed. Both results are kept so the two modes
// can be compared.
async function runSpeechTest() {
  $('speech-note').textContent = 'Listening for up to 12 seconds. Say: this is a test of the dictation.';
  const r = await speechSelfTest();
  const all = await db.setting('speech_tests', {});
  all[r.mode] = r;
  await db.setSetting('speech_tests', all);
  const line = r.ok
    ? 'Works in ' + r.mode + '. It heard: ' + r.transcript
    : 'Did NOT work in ' + r.mode + '. Reason: ' + (r.reason || 'unknown') + '. Scores fall back to counting fillers yourself, which still works.';
  const other = r.mode === 'standalone' ? all['browser tab'] : all['standalone'];
  $('speech-note').textContent = line + (other ? ' Previously in ' + other.mode + ': ' + (other.ok ? 'worked' : 'did not work') + '.' : ' Now run it in the other mode too.');
  if (!r.ok && r.mode === 'standalone') {
    await db.setSetting('use_dictation', false);
    toast('Dictation off. You count your own fillers, which trains the ear better anyway.', 5000);
  }
}


// ---------------- clips ----------------

async function saveClip(repId, rec) {
  if (!rec || !rec.blob) return null;
  const id = uuid();
  await db.put('clips', {
    id, rep_id: repId, created_at: new Date().toISOString(),
    mime: rec.mime, blob: rec.blob, duration_sec: rec.duration_sec, keep: false
  });
  return id;
}

// ---------------- SHADOW ----------------

STEPS.shadow = {
  label: 'Shadow',
  note: 'Repeat after the voice, sentence by sentence',
  run: runShadow
};

const sh = {
  text: null, idx: 0, rec: null, handsFree: true, running: false,
  modelClip: null, myClip: null, aborted: false, reps: 0
};

async function runShadow() {
  sh.handsFree = await db.setting('hands_free', true);
  sh.aborted = false;
  sh.reps = 0;
  sh.text = await pickPassage();
  if (!sh.text) { toast('No passages loaded'); return nextStep(); }
  show('shadow');
  renderShadowIntro();
}

// The weekday rotation default is a SCENARIO, not a generic passage. The
// generic bank is still there, it is just the fallback and the "More passages"
// group in the picker.
async function pickPassage() {
  const texts = await db.all('texts');
  if (!texts.length) return null;
  const scen = texts.filter(t => t.kind === 'scenario' || t.kind === 'monologue');
  const pool = scen.length ? scen : texts;
  pool.sort((a, b) => (a.times_used || 0) - (b.times_used || 0) || String(a.id).localeCompare(String(b.id)));
  return pool[0];
}

function renderShadowIntro() {
  $('shadow-intro').hidden = false;
  $('shadow-run').hidden = true;
  $('shadow-rate').hidden = true;
  $('shadow-sub').textContent = sh.text.sentences.length + ' sentences, about 3 minutes';
  $('shadow-title').textContent = sh.text.title;
  $('shadow-preview').textContent = sh.text.body;
  $('shadow-hf').textContent = sh.handsFree ? 'On' : 'Off';
  $('shadow-group').textContent = sh.text.group_label || 'More passages';
  $('shadow-actions').innerHTML = '<button class="primary huge" id="sh-go">Start</button>';
  $('sh-go').onclick = startShadow;
}

async function startShadow() {
  await noteScenario('shadow', sh.text.group, sh.text.group_label, sh.text.title);
  // Everything that needs a user gesture happens right here, in the tap.
  await enableVoice();
  const mic = await micPermission();
  if (!mic.ok) toast(mic.reason, 4000);
  await keepAwake();
  sh.idx = 0;
  sh.running = true;
  $('shadow-intro').hidden = true;
  $('shadow-run').hidden = false;
  $('shadow-actions').innerHTML = '<button class="huge" id="sh-stop">Stop</button>';
  $('sh-stop').onclick = abortShadow;
  shadowLoop();
}

function shadowState(s) { $('shadow-state').textContent = s; }

async function shadowLoop() {
  while (sh.running && sh.idx < sh.text.sentences.length) {
    const line = sh.text.sentences[sh.idx];
    $('shadow-count').textContent = (sh.idx + 1) + ' of ' + sh.text.sentences.length;
    $('shadow-line').textContent = line;

    // 1. the model says it
    shadowState('Listen');
    const audioPath = (sh.text.sentence_audio || [])[sh.idx] || null;
    await sayPassage(line, audioPath);
    if (!sh.running) break;

    // 2. his turn, recorded
    shadowState('Your turn');
    const r = new Recorder();
    let got = null;
    try {
      await r.start();
      const ms = Math.max(2500, line.length * 75);
      if (sh.handsFree) await waitOrTap(ms);
      else await waitForTap('Done');
      got = await r.stop();
    } catch (e) {
      // no microphone is not a reason to stop drilling
      shadowState('No mic, say it anyway');
      await waitOrTap(Math.max(2500, line.length * 75));
    }
    if (!sh.running) break;

    // 3. model then self, back to back
    if (got && got.blob && got.blob.size > 800) {
      shadowState('Model');
      await sayPassage(line, audioPath);
      if (!sh.running) break;
      shadowState('You');
      await playBlob(got.blob, got.duration_sec);
      const repId = uuid();
      const clipId = await saveClip(repId, got);
      await db.put('reps', {
        id: repId, session_id: session.id, mode: 'shadow', created_at: new Date().toISOString(),
        prompt_id: sh.text.id, target_text: line, transcript: null, transcript_source: 'none',
        duration_sec: got.duration_sec, clip_id: clipId, self_rating: null, notes: null
      });
      sh.reps++;
    }
    sh.idx++;
  }
  if (!sh.running) return;
  await coldRead();
}

async function coldRead() {
  $('shadow-count').textContent = 'Cold read';
  $('shadow-line').textContent = sh.text.body;
  shadowState('Read the whole thing');
  const r = new Recorder();
  let got = null;
  try {
    await r.start();
    const ms = Math.max(8000, sh.text.body.length * 60);
    if (sh.handsFree) await waitOrTap(ms); else await waitForTap('Done');
    got = await r.stop();
  } catch (e) { await waitOrTap(6000); }

  if (got && got.blob && got.blob.size > 800) {
    const repId = uuid();
    const clipId = await saveClip(repId, got);
    await db.put('reps', {
      id: repId, session_id: session.id, mode: 'shadow', created_at: new Date().toISOString(),
      prompt_id: sh.text.id, target_text: sh.text.body, transcript: null, transcript_source: 'none',
      duration_sec: got.duration_sec, clip_id: clipId, self_rating: null, notes: 'cold read'
    });
    sh.reps++;
    sh.myClip = got.blob;
  }
  await db.put('texts', { ...sh.text, times_used: (sh.text.times_used || 0) + 1 });
  finishShadow();
}

function finishShadow() {
  sh.running = false;
  letSleep();
  releaseMic();
  stopSpeaking();
  stopPlayback();
  $('shadow-run').hidden = true;
  $('shadow-rate').hidden = false;
  $('shadow-sub').textContent = sh.reps + ' takes recorded';
  $('shadow-rate-btns').innerHTML = [1, 2, 3, 4, 5]
    .map(n => '<button id="sh-r' + n + '">' + n + '</button>').join('');
  $('shadow-actions').innerHTML = '<div class="small muted center" style="width:100%">1 is nothing like it, 5 is word for word</div>';
  for (const n of [1, 2, 3, 4, 5]) {
    $('sh-r' + n).onclick = async () => {
      results.shadow_rating = n;
      await db.put('reps', {
        id: uuid(), session_id: session.id, mode: 'shadow', created_at: new Date().toISOString(),
        prompt_id: sh.text.id, target_text: null, transcript: null, transcript_source: 'none',
        self_rating: n, notes: 'session self rating'
      });
      nextStep();
    };
  }
}

function abortShadow() {
  sh.running = false;
  stopSpeaking();
  stopPlayback();
  letSleep();
  releaseMic();
  if (sh.reps > 0) return finishShadow();
  nextStep('shadow');
}

// A wait that any tap can cut short. This is what makes hands free bearable:
// the timer is the default, the tap is the override.
let tapResolver = null;
function waitOrTap(ms) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; tapResolver = null; document.removeEventListener('click', onTap, true); resolve(); };
    const onTap = (e) => {
      // Stop is a real button and must keep working. Everything else just means
      // "I am done, move on", and is swallowed so it cannot also press something.
      if (e.target && e.target.closest && e.target.closest('#sh-stop')) return;
      e.preventDefault(); e.stopPropagation(); fin();
    };
    tapResolver = fin;
    document.addEventListener('click', onTap, true);
    setTimeout(fin, ms);
  });
}
// Ends when the clock runs out or when one specific button is pressed. Every
// other tap on the screen is left alone, so beat taps and filler taps still work.
function waitTimerOrButton(ms, buttonId) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; clearTimeout(t); resolve(); };
    const t = setTimeout(fin, ms);
    const btn = $(buttonId);
    if (btn) btn.onclick = (e) => { e.stopPropagation(); fin(); };
  });
}

function waitForTap(label) {
  return new Promise((resolve) => {
    $('shadow-actions').innerHTML =
      '<div class="btnrow"><button id="sh-stop">Stop</button><button class="primary" id="sh-next">' + label + '</button></div>';
    $('sh-stop').onclick = abortShadow;
    $('sh-next').onclick = () => resolve();
  });
}

// ---------------- paste and pick ----------------

async function openPaste() {
  $('paste-title').value = '';
  $('paste-body').value = '';
  show('paste');
}

async function savePaste() {
  const body = $('paste-body').value.trim();
  if (body.length < 20) { toast('That is too short to shadow'); return; }
  const t = {
    id: uuid(), title: $('paste-title').value.trim() || 'My text', body,
    source_type: 'own_paste', license_note: 'His own text, typed into the app on this device.',
    sentences: splitSentences(body), sentence_audio: [], audio: null,
    added_at: new Date().toISOString(), times_used: 0
  };
  await db.put('texts', t);
  sh.text = t;
  show('shadow');
  renderShadowIntro();
}

// Pick a group first, then a scenario inside it. The generic 20 live under
// "More passages" at the bottom, still there, no longer the front door.
const GROUP_ORDER = ['coffee', 'coworkers', 'cafe', 'networking', 'podcast', 'mine', 'more'];

async function groupedTexts() {
  const texts = await db.all('texts');
  const groups = new Map();
  for (const t of texts) {
    const id = t.group || 'more';
    const label = t.group_label || 'More passages';
    if (!groups.has(id)) groups.set(id, { id, label, rows: [] });
    groups.get(id).rows.push(t);
  }
  const out = [...groups.values()];
  out.sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a.id), ib = GROUP_ORDER.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.label.localeCompare(b.label);
  });
  for (const g of out) {
    g.rows.sort((a, b) => (a.times_used || 0) - (b.times_used || 0) || String(a.id).localeCompare(String(b.id)));
  }
  return out;
}

let pickGroups = [];

async function openPick() {
  pickGroups = await groupedTexts();
  $('pick-head').textContent = 'Scenarios';
  $('pick-cancel').textContent = 'Cancel';
  $('pick-list').hidden = true;
  $('pick-groups').hidden = false;
  $('pick-groups').innerHTML = pickGroups.map(g =>
    '<li class="pick-grp" data-gid="' + escapeHtml(g.id) + '"><b>' + escapeHtml(g.label) + '</b>' +
    '<div class="small muted">' + g.rows.length + (g.rows.length === 1 ? ' item' : ' items') + '</div></li>').join('');
  for (const el of document.querySelectorAll('.pick-grp')) {
    el.onclick = () => openPickGroup(el.dataset.gid);
  }
  show('pick');
}

function openPickGroup(gid) {
  const g = pickGroups.find(x => x.id === gid);
  if (!g) return openPick();
  $('pick-head').textContent = g.label;
  $('pick-cancel').textContent = 'Back';
  $('pick-groups').hidden = true;
  $('pick-list').hidden = false;
  $('pick-list').innerHTML = g.rows.map(t =>
    '<li class="pick-row" data-id="' + escapeHtml(t.id) + '"><b>' + escapeHtml(t.title) + '</b>' +
    '<div class="small muted">' + t.sentences.length + ' lines, used ' + (t.times_used || 0) + ' times' +
    ((t.sentence_audio && t.sentence_audio.length) ? ', recorded voice' : ', phone voice') + '</div></li>').join('');
  for (const el of document.querySelectorAll('.pick-row')) {
    el.onclick = async () => { sh.text = await db.get('texts', el.dataset.id); show('shadow'); renderShadowIntro(); };
  }
}

function pickBack() {
  if (!$('pick-list').hidden) return openPick();
  show('shadow');
  renderShadowIntro();
}


// ---------------- shared take runner ----------------
// One place that records a take, tries for a transcript, and always produces a
// score row. Every branch of it ends in a score, including the branch where
// there is no microphone, no dictation and no network.

async function runTake({ maxMs, target = null, onTick, onPartial, doneId = null }) {
  const r = new Recorder();
  let recording = false;
  try { await r.start(); recording = true; } catch (e) { /* keep going without audio */ }

  const wantAsr = recognitionSupported() && navigator.onLine && (await db.setting('use_dictation', true));
  const asrPromise = wantAsr ? listen({ maxMs: maxMs + 2000, onPartial }) : Promise.resolve({ ok: false, transcript: null, reason: 'off or unavailable' });

  const startedAt = Date.now();
  let ticker = null;
  if (onTick) ticker = setInterval(() => onTick(Math.round((Date.now() - startedAt) / 1000)), 250);

  // Frame and Clear must NOT end on any old tap: he taps beats mid sentence and
  // he taps the filler counter. Only the explicit Done button, or the clock.
  if (doneId) await waitTimerOrButton(maxMs, doneId);
  else await waitOrTap(maxMs);
  if (ticker) clearInterval(ticker);
  stopListening();

  const rec = recording ? await r.stop() : null;
  const asr = await asrPromise;
  const wall = (Date.now() - startedAt) / 1000;
  const wave = rec && rec.blob ? await analyseWaveform(rec.blob) : null;
  const duration = (wave && wave.duration_sec) || (rec && rec.duration_sec) || wall;

  const s = scoreTake({ transcript: asr.transcript, durationSec: duration, target });
  s.transcript_source = asr.transcript ? 'asr' : 'none';
  s.silence_pct = wave ? wave.silence_pct : null;
  s.pauses = wave ? wave.pauses : null;
  s.longest_pause_sec = wave ? wave.longest_pause_sec : null;
  s.asr_reason = asr.reason || null;
  return { score: s, rec };
}

// ---------------- FRAME ----------------

STEPS.frame = {
  label: 'Frame',
  note: 'Three beats in thirty seconds, then say it',
  run: runFrame
};

const fr = { prompt: null, structure: null, beats: [], hit: [], round: 0, timer: null };

// Timings live in settings so the test harness can run a real session in seconds
// and so a length can be changed later without touching code.
async function timing(key, fallback) { return await db.setting(key, fallback); }

async function runFrame() {
  fr.round = 0;
  show('frame');
  await nextFrameRound();
}

// Which slice of the prompt bank Frame draws from. The default is the scenario
// prompts, so the weekday Frame default is a real scenario, not a generic prompt.
async function pickFramePrompt() {
  const prompts = await db.all('prompts');
  const want = await db.setting('frame_group', 'scenarios');
  const scen = prompts.filter(p => p.scenario_id);
  let pool;
  if (want === 'scenarios') pool = scen;
  else if (want === 'more') pool = prompts.filter(p => !p.scenario_id);
  else pool = prompts.filter(p => p.group === want);
  if (!pool.length) pool = scen.length ? scen : prompts;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function frameGroupLabel() {
  const want = await db.setting('frame_group', 'scenarios');
  if (want === 'scenarios') return 'Scenarios';
  if (want === 'more') return 'More prompts';
  const groups = await db.setting('scenario_groups', []);
  const g = groups.find(x => x.id === want);
  return g ? g.label : 'Scenarios';
}

async function nextFrameRound() {
  fr.round++;
  const structures = await db.setting('structures', []);
  fr.prompt = await pickFramePrompt();
  fr.structure = structures.find(s => s.id === fr.prompt.structure_hint) || structures[0];
  fr.beats = fr.structure.beats.map(() => '');
  fr.hit = fr.structure.beats.map(() => false);

  $('frame-sub').textContent = 'Round ' + fr.round + ' of ' + (await timing('frame_rounds', 2));
  $('frame-group').textContent = await frameGroupLabel();
  $('frame-scenario').textContent = fr.prompt.scenario
    ? (fr.prompt.group_label || '') + ((fr.prompt.group_label ? ' - ' : '') + fr.prompt.scenario) : '';
  $('frame-prompt').textContent = fr.prompt.text;
  $('frame-structure').textContent = fr.structure.name;
  $('frame-speak-card').hidden = true;
  $('frame-beats-card').hidden = false;
  $('frame-beats').innerHTML = fr.structure.beats.map((b, i) =>
    '<div><label>' + escapeHtml(b) + '</label><input id="fb' + i + '" autocomplete="off" placeholder="a word or two"></div>').join('');
  $('frame-actions').innerHTML = '<button class="primary huge" id="fr-speak">Ready, say it</button>';
  $('fr-speak').onclick = frameSpeak;

  let left = await timing('frame_beats_seconds', 30);
  $('frame-timer').textContent = left;
  clearInterval(fr.timer);
  fr.timer = setInterval(() => {
    left--;
    $('frame-timer').textContent = Math.max(0, left);
    if (left <= 0) { clearInterval(fr.timer); if (!$('s-frame').hidden && $('frame-speak-card').hidden) frameSpeak(); }
  }, 1000);
}

let firstWordAt = null;

async function frameSpeak() {
  clearInterval(fr.timer);
  firstWordAt = null;
  for (let i = 0; i < fr.beats.length; i++) {
    const el = $('fb' + i);
    fr.beats[i] = el ? el.value.trim() : '';
  }
  await enableVoice();
  await keepAwake();

  $('frame-beats-card').hidden = true;
  $('frame-speak-card').hidden = false;
  $('frame-beat-taps').innerHTML = fr.structure.beats.map((b, i) =>
    '<button id="ft' + i + '" class="ghost">' + escapeHtml(b) + (fr.beats[i] ? ': ' + escapeHtml(fr.beats[i]) : '') + '</button>').join('');
  for (let i = 0; i < fr.structure.beats.length; i++) {
    $('ft' + i).onclick = (e) => {
      e.stopPropagation();
      fr.hit[i] = true;
      $('ft' + i).classList.add('primary');
      if (firstWordAt == null) firstWordAt = Date.now();
    };
  }
  $('frame-actions').innerHTML = '<button class="primary huge" id="fr-done">Done</button>';

  const startedAt = Date.now();
  const { score, rec } = await runTake({
    maxMs: (await timing('frame_speak_seconds', 60)) * 1000,
    doneId: 'fr-done',
    onTick: (s) => { $('frame-clock').textContent = s + 's'; },
    onPartial: (t) => { if (t && firstWordAt == null) firstWordAt = Date.now(); }
  });

  const beatsHit = fr.hit.filter(Boolean).length;
  const repId = uuid();
  const clipId = rec ? await saveClip(repId, rec) : null;
  await db.put('reps', {
    id: repId, session_id: session.id, mode: 'frame', created_at: new Date().toISOString(),
    prompt_id: fr.prompt.id, structure_id: fr.structure.id, target_text: fr.prompt.text,
    beats_text: fr.beats.join(' | '), beats_hit: beatsHit, beats_total: fr.structure.beats.length,
    time_to_first_word_ms: firstWordAt ? (firstWordAt - startedAt) : null,
    clip_id: clipId, ...score
  });

  // the DON'Ts of the scenario he just spoke land on the done screen
  if (fr.prompt.donts && fr.prompt.donts.length) {
    results.donts = fr.prompt.donts;
    results.donts_scenario = fr.prompt.scenario || null;
  }
  await noteScenario('frame', fr.prompt.group, fr.prompt.group_label, fr.prompt.scenario || fr.prompt.text);

  results.beats_hit = beatsHit;
  results.beats_total = fr.structure.beats.length;
  results.time_to_first_word_ms = firstWordAt ? (firstWordAt - startedAt) : null;
  if (score.wpm) results.wpm = score.wpm;
  if (score.filler_rate != null) results.filler_rate = score.filler_rate;

  letSleep();
  if (fr.round < (await timing('frame_rounds', 2))) return nextFrameRound();
  releaseMic();
  nextStep();
}

async function openFrameGroup() {
  clearInterval(fr.timer);
  const groups = await db.setting('scenario_groups', []);
  const prompts = await db.all('prompts');
  const count = (id) => id === 'scenarios' ? prompts.filter(p => p.scenario_id).length
    : id === 'more' ? prompts.filter(p => !p.scenario_id).length
    : prompts.filter(p => p.group === id).length;
  const rows = [{ id: 'scenarios', label: 'Scenarios, all of them' }]
    .concat(groups.filter(g => count(g.id) > 0).map(g => ({ id: g.id, label: g.label })))
    .concat([{ id: 'more', label: 'More prompts' }]);
  const want = await db.setting('frame_group', 'scenarios');
  $('fgroup-list').innerHTML = rows.map(r =>
    '<li class="fgroup-row' + (r.id === want ? ' on' : '') + '" data-gid="' + escapeHtml(r.id) + '">' +
    '<b>' + escapeHtml(r.label) + '</b><div class="small muted">' + count(r.id) + ' prompts' +
    (r.id === want ? ', in use' : '') + '</div></li>').join('');
  for (const el of document.querySelectorAll('.fgroup-row')) {
    el.onclick = async () => {
      await db.setSetting('frame_group', el.dataset.gid);
      show('frame');
      fr.round--;               // re-render this same round with the new group
      await nextFrameRound();
    };
  }
  show('fgroup');
}

function abortFrame() {
  clearInterval(fr.timer);
  stopListening(); letSleep(); releaseMic();
  nextStep('frame');
}

// ---------------- CLEAR ----------------

STEPS.clear = {
  label: 'Clear',
  note: 'Three sixty second takes, one rule added each time',
  run: runClear
};

const TAKE_RULES = [
  { label: 'Take 1, baseline', rule: 'No rules. Just talk for sixty seconds.' },
  { label: 'Take 2', rule: 'Pause instead of saying um. Silence is allowed.' },
  { label: 'Take 3', rule: 'One idea per sentence. Full stop before the next one.' }
];

const cl = { topic: null, takes: [], n: 0, tally: 0 };

async function runClear() {
  cl.takes = []; cl.n = 0;
  cl.topic = await randomPrompt();
  show('clear');
  renderClearSetup();
}

async function randomPrompt() {
  const prompts = await db.all('prompts');
  const generic = prompts.filter(p => !p.scenario_id);
  const pool = generic.length ? generic : prompts;
  return pool[Math.floor(Math.random() * pool.length)];
}

function renderClearSetup() {
  $('clear-setup').hidden = false;
  $('clear-take').hidden = true;
  $('clear-tally').hidden = true;
  $('clear-results').hidden = true;
  $('clear-sub').textContent = 'Three takes, about four minutes';
  $('clear-topic').textContent = cl.topic.text;
  $('clear-actions').innerHTML = '<button class="primary huge" id="cl-go">Start take 1</button>';
  $('cl-go').onclick = startTake;
}

async function startTake() {
  await enableVoice();
  await keepAwake();
  const t = TAKE_RULES[cl.n];
  $('clear-setup').hidden = true;
  $('clear-results').hidden = true;
  $('clear-take').hidden = false;
  $('clear-takelabel').textContent = t.label;
  $('clear-rule').textContent = t.rule;
  $('clear-clock').textContent = '0s';
  $('clear-live').textContent = '';
  $('clear-actions').innerHTML = '<button class="primary huge" id="cl-done">Done</button>';
  $('clear-sub').textContent = 'Take ' + (cl.n + 1) + ' of 3';

  const { score, rec } = await runTake({
    maxMs: (await timing('take_seconds', 60)) * 1000,
    doneId: 'cl-done',
    onTick: (s) => { $('clear-clock').textContent = s + 's'; },
    onPartial: (txt) => { $('clear-live').textContent = txt.slice(-90); }
  });

  const repId = uuid();
  const clipId = rec ? await saveClip(repId, rec) : null;
  const row = { take: cl.n + 1, repId, clipId, blob: rec ? rec.blob : null, ...score };

  // No transcript means no machine filler count. The manual tally is the
  // fallback, and hearing yourself say them is arguably the better trainer.
  if (score.transcript == null) {
    letSleep();
    await manualTally(row);
  }
  cl.takes.push(row);

  await db.put('reps', {
    id: repId, session_id: session.id, mode: 'clear', created_at: new Date().toISOString(),
    prompt_id: cl.topic.id, target_text: cl.topic.text, take: row.take,
    clip_id: clipId, ...score,
    filler_count: row.filler_count, filler_rate: row.filler_rate,
    transcript_source: row.transcript_source
  });

  cl.n++;
  letSleep();
  if (cl.n < 3) return startTake();
  releaseMic();
  showClearResults();
}

function manualTally(row) {
  return new Promise((resolve) => {
    cl.tally = 0;
    $('clear-take').hidden = true;
    $('clear-tally').hidden = false;
    $('tally-count').textContent = '0';
    $('clear-actions').innerHTML = '<button class="primary huge" id="tally-done">Done counting</button>';
    if (row.blob) playBlob(row.blob, row.duration_sec);
    $('tally-hit').onclick = (e) => { e.stopPropagation(); cl.tally++; $('tally-count').textContent = cl.tally; };
    $('tally-undo').onclick = (e) => { e.stopPropagation(); cl.tally = Math.max(0, cl.tally - 1); $('tally-count').textContent = cl.tally; };
    $('tally-done').onclick = () => {
      stopPlayback();
      row.filler_count = cl.tally;
      row.filler_rate = fillerRate(cl.tally, row.duration_sec);
      row.transcript_source = 'manual';
      $('clear-tally').hidden = true;
      resolve();
    };
  });
}

function showClearResults() {
  $('clear-take').hidden = true;
  $('clear-tally').hidden = true;
  $('clear-results').hidden = false;
  $('clear-sub').textContent = 'Three takes done';

  const head = '<tr><th style="text-align:left">Take</th><th>Fillers a min</th><th>Words a min</th><th>Silence</th><th>How</th></tr>';
  const rows = cl.takes.map(t =>
    '<tr><td>' + t.take + '</td><td class="center">' + (t.filler_rate == null ? '-' : t.filler_rate) +
    '</td><td class="center">' + (t.wpm == null ? '-' : t.wpm) +
    '</td><td class="center">' + (t.silence_pct == null ? '-' : t.silence_pct + '%') +
    '</td><td class="center small muted">' + (t.transcript_source === 'asr' ? 'heard' : t.transcript_source === 'manual' ? 'you counted' : 'audio only') +
    '</td></tr>').join('');
  $('clear-table').innerHTML = head + rows;

  const first = cl.takes[0], last = cl.takes[cl.takes.length - 1];
  let delta = null;
  if (first && last && first.filler_rate != null && last.filler_rate != null) {
    delta = Math.round((first.filler_rate - last.filler_rate) * 10) / 10;
  }
  results.take_delta = delta;
  if (last) {
    if (last.wpm) results.wpm = last.wpm;
    if (last.filler_rate != null) results.filler_rate = last.filler_rate;
  }
  $('clear-verdict').textContent = delta == null
    ? 'No filler numbers this time, so the takes are stored on pace and silence only.'
    : delta > 0
      ? 'Take three had ' + delta + ' fewer fillers a minute than take one. That is the drill working.'
      : delta === 0
        ? 'Same filler rate across all three takes. The rule did not change anything yet, run it again tomorrow.'
        : 'Take three had ' + Math.abs(delta) + ' more fillers a minute than take one. That happens when the rule makes you self conscious. Slow down.';

  const hasTranscript = cl.takes.some(t => t.transcript);
  $('clear-actions').innerHTML =
    (grading.gradingOn() && hasTranscript
      ? '<div class="btnrow"><button id="cl-grade">Deeper read</button><button class="primary" id="cl-close">Done</button></div>'
      : '<button class="primary huge" id="cl-close">Done</button>');
  if ($('cl-grade')) $('cl-grade').onclick = () => { renderGrade(); gradeLastTake(); };
  $('cl-close').onclick = () => nextStep();
}

function abortClear() {
  stopListening(); stopPlayback(); letSleep(); releaseMic();
  if (cl.takes.length) return showClearResults();
  nextStep('clear');
}

// ---------------- WORDS ----------------

STEPS.words = {
  label: 'Words',
  note: 'Ten cards, say each one in a sentence',
  run: runWords
};

let wq = [], wIdx = 0, wCorrect = 0, wKnew = false, wSpokenMissed = 0, wHandsFree = false;

async function runWords() {
  const n = results.floor ? 5 : 10;
  wq = await dueWords(n);
  wIdx = 0; wCorrect = 0; wSpokenMissed = 0;
  wHandsFree = await db.setting('words_hands_free', false);
  $('words-hf').textContent = wHandsFree ? 'On' : 'Off';
  if (!wq.length) { toast('No cards available'); return nextStep(); }
  show('words');
  if (wHandsFree) { await enableVoice(); await keepAwake(); }
  renderWordFront();
}

function renderWordFront() {
  const c = wq[wIdx];
  wSpeakQueue(c);
  $('words-progress').textContent = (wIdx + 1) + ' of ' + wq.length;
  $('words-tier').textContent = (c.deck === 'verbal_advantage' ? 'Verbal Advantage' : c.tier_label || '');
  $('words-word').textContent = c.word;
  $('words-back').hidden = true;
  $('words-speak').hidden = true;
  $('words-actions').innerHTML = '<button class="primary huge" id="w-reveal">Say what it means, then tap</button>';
  $('w-reveal').onclick = renderWordBack;
}

// Hands free words: the phone says the word, gives him room to answer out loud,
// then reads the meaning and the example. He only ever taps knew or missed, and
// both targets fill half the screen.
let wTimer = null;
function wClearTimer() { if (wTimer) { clearTimeout(wTimer); wTimer = null; } }

async function wSpeakQueue(c) {
  wClearTimer();
  if (!wHandsFree) return;
  await speak(c.word, { rate: 0.9 });
  wTimer = setTimeout(() => { if (!$('s-words').hidden && $('words-back').hidden) renderWordBack(); }, 4500);
}

async function renderWordBack() {
  wClearTimer();
  const c = wq[wIdx];
  $('words-def').textContent = c.definition;
  $('words-ex').textContent = c.example_sentence;
  $('words-back').hidden = false;
  $('words-actions').innerHTML =
    '<div class="btnrow"><button id="w-miss">Missed it</button><button class="primary" id="w-knew">Knew it</button></div>';
  $('w-miss').onclick = () => { wClearTimer(); wKnew = false; finishCard(false, false); };
  $('w-knew').onclick = () => { wClearTimer(); wKnew = true; askForSentence(); };
  if (wHandsFree) await speak(c.definition + '. ' + c.example_sentence, { rate: 0.95 });
}

function askForSentence() {
  $('words-speak').hidden = false;
  $('words-actions').innerHTML =
    '<div class="btnrow"><button id="w-nos">Could not</button><button class="primary" id="w-said">Said it</button></div>';
  $('w-nos').onclick = () => { wClearTimer(); wSpokenMissed++; finishCard(true, false); };
  $('w-said').onclick = () => { wClearTimer(); finishCard(true, true); };
  if (wHandsFree) speak('Say it in a sentence', { rate: 1 });
}

async function finishCard(knew, spoke) {
  const c = wq[wIdx];
  const updated = nextCardState(c, knew, spoke);
  await db.put('words', updated);
  await db.put('reps', {
    id: uuid(), session_id: session.id, mode: 'words', created_at: new Date().toISOString(),
    prompt_id: updated.id, target_text: c.word, transcript: null, transcript_source: 'none',
    self_rating: knew ? (spoke ? 5 : 3) : 1, notes: null
  });
  if (knew) wCorrect++;
  wIdx++;
  if (wIdx >= wq.length) {
    wClearTimer(); stopSpeaking(); letSleep();
    results.cards_total = wq.length;
    results.cards_correct = wCorrect;
    results.spoken_missed = wSpokenMissed || 0;
    return nextStep();
  }
  renderWordFront();
}

// ---------------- CONNECT ----------------

STEPS.connect = {
  label: 'Connect',
  note: 'One person, read the card, then go talk to them',
  run: runConnect
};

let currentPerson = null;
let logAsk = false;

async function runConnect() {
  currentPerson = await coldestPerson();
  show('connect');
  $('connect-empty').hidden = !!currentPerson;
  $('connect-card').hidden = !currentPerson;
  if (!currentPerson) return;
  const d = daysSince(currentPerson.last_touch_date);
  $('connect-name').textContent = currentPerson.name;
  $('connect-since').textContent = d == null ? 'never talked' : ('last talked ' + d + (d === 1 ? ' day ago' : ' days ago'));
  $('connect-rel').textContent = currentPerson.relationship || '';
  $('connect-said').textContent = currentPerson.last_said || 'nothing logged yet, log one today';
  $('connect-ask').textContent = currentPerson.open_ask || 'no ask written yet, write one';
  $('connect-involve').textContent = currentPerson.involve_in || 'pick one decision to hand them';
  $('connect-owns').textContent = currentPerson.owns || 'name the thing they are the authority on';
}

function openLog() {
  logAsk = false;
  $('log-said').value = '';
  $('log-working').value = '';
  $('log-need').value = '';
  $('log-ask-state').textContent = 'No';
  show('log');
}

async function saveLog() {
  const t = {
    id: uuid(), person_id: currentPerson.id, date: today(),
    channel: $('log-channel').value,
    what_they_said: $('log-said').value.trim(),
    what_they_are_working_on: $('log-working').value.trim(),
    what_they_need: $('log-need').value.trim(),
    made_an_ask: logAsk, duration_min: null
  };
  await db.put('touches', t);
  const p = { ...currentPerson };
  p.last_touch_date = today();
  p.touch_count = (p.touch_count || 0) + 1;
  if (logAsk) p.ask_count = (p.ask_count || 0) + 1;
  if (t.what_they_said) p.last_said = t.what_they_said;
  if (t.what_they_are_working_on) p.involve_in = t.what_they_are_working_on;
  await db.put('people', p);
  results.connected = p.name;
  results.ask_made = logAsk;
  nextStep();
}

// ---------------- people editor ----------------

let editingPerson = null;

async function renderPeople() {
  const people = await db.all('people');
  const stats = await connectStats();
  const rows = people
    .sort((a, b) => (daysSince(b.last_touch_date) ?? 9999) - (daysSince(a.last_touch_date) ?? 9999))
    .map(p => {
      const d = daysSince(p.last_touch_date);
      return '<li data-id="' + p.id + '" class="person-row"><div class="spread"><b>' + escapeHtml(p.name) +
        '</b><span class="small muted">' + (d == null ? 'never' : d + 'd') + '</span></div>' +
        '<div class="small muted">' + escapeHtml(p.relationship || '') + '</div></li>';
    }).join('');
  $('people-list').innerHTML = rows ||
    '<li class="muted small">Nobody yet. Add five to ten people you actually want in your life.</li>';
  if (stats.touches) {
    $('people-list').insertAdjacentHTML('beforeend',
      '<li class="small muted">' + stats.touches + ' touches logged. Ask rate ' + stats.askRate +
      '%. ' + (stats.askRate < 50 ? 'Under fifty percent means you are still only giving.' : 'Good, keep asking.') + '</li>');
  }
  for (const el of document.querySelectorAll('.person-row')) {
    el.onclick = async () => { editPerson(await db.get('people', el.dataset.id)); };
  }
  show('people');
}

function editPerson(p) {
  editingPerson = p || null;
  $('person-title').textContent = p ? 'Edit person' : 'Add a person';
  $('person-name').value = p ? p.name : '';
  $('person-rel').value = p ? (p.relationship || '') : '';
  $('person-said').value = p ? (p.last_said || '') : '';
  $('person-ask').value = p ? (p.open_ask || '') : '';
  $('person-involve').value = p ? (p.involve_in || '') : '';
  $('person-owns').value = p ? (p.owns || '') : '';
  $('person-delete').hidden = !p;
  show('person');
}

async function savePerson() {
  const name = $('person-name').value.trim();
  if (!name) { toast('A name at least'); return; }
  const p = editingPerson || { id: uuid(), touch_count: 0, ask_count: 0, last_touch_date: null };
  p.name = name;
  p.relationship = $('person-rel').value.trim();
  p.last_said = $('person-said').value.trim();
  p.open_ask = $('person-ask').value.trim();
  p.involve_in = $('person-involve').value.trim();
  p.owns = $('person-owns').value.trim();
  await db.put('people', p);
  editingPerson = null;
  renderPeople();
}


// ---------------- PROGRESS ----------------

async function renderProgress() {
  const [reps, sessions, people, st, mastery, cstats] = await Promise.all([
    db.all('reps'), db.all('sessions'), db.all('people'), streakInfo(), deckMastery(), connectStats()
  ]);
  const cutoff = addDays(today(), -30);
  const recentSessions = sessions.filter(s => s.completed && s.date >= cutoff);
  const minutes = Math.round(sessions.reduce((n, s) => n + (s.duration_sec || 0), 0) / 60);

  $('pr-streak').textContent = st.streak;
  $('pr-sessions').textContent = recentSessions.length;
  $('pr-minutes').textContent = minutes;

  const fSeries = dailySeries(reps, 'filler_rate', 30, today());
  const fT = trend(fSeries);
  $('pr-filler-chart').innerHTML = sparkline(fSeries, { lowerIsBetter: true });
  $('pr-filler-now').textContent = fT.latest == null ? 'no data' : fT.latest + ' a min';
  $('pr-filler-note').textContent = fT.delta == null
    ? 'Two mornings of data and the trend line starts.'
    : fT.delta < -0.5 ? 'Down ' + Math.abs(fT.delta) + ' a minute across the month. That is real.'
    : fT.delta > 0.5 ? 'Up ' + fT.delta + ' a minute across the month. Pause instead of filling.'
    : 'Flat across the month. Push the pause rule harder in Clear.';

  const wSeries = dailySeries(reps, 'wpm', 30, today());
  const wT = trend(wSeries);
  const low = await db.setting('target_wpm_low', 130);
  const high = await db.setting('target_wpm_high', 160);
  $('pr-wpm-chart').innerHTML = sparkline(wSeries, { band: [low, high] });
  $('pr-wpm-now').textContent = wT.latest == null ? 'no data' : wT.latest + ' a min';
  $('pr-wpm-note').textContent = wT.latest == null
    ? 'The shaded band is the ' + low + ' to ' + high + ' target.'
    : (wT.latest < low ? 'Under the band. You sound unsure when you drag.'
      : wT.latest > high ? 'Over the band. Slow down, one idea per sentence.'
      : 'Inside the ' + low + ' to ' + high + ' band. Hold it there.');

  $('pr-mastery').textContent = mastery.pct + '%';
  $('pr-mastery-bar').style.width = mastery.pct + '%';
  $('pr-deck-note').textContent = mastery.mastered + ' of ' + mastery.total + ' cards in box 4 or 5.';

  $('pr-ask').textContent = cstats.askRate == null ? 'no touches' : cstats.askRate + '% asks';
  const rows = people
    .map(p => ({ p, d: daysSince(p.last_touch_date) }))
    .sort((a, b) => (b.d == null ? 9999 : b.d) - (a.d == null ? 9999 : a.d))
    .slice(0, 8)
    .map(({ p, d }) => '<li><div class="spread"><b>' + escapeHtml(p.name) + '</b><span class="small muted">' +
      (d == null ? 'never' : d + ' days') + '</span></div></li>').join('');
  $('pr-people').innerHTML = rows || '<li class="small muted">No people yet.</li>';
  $('pr-ask-note').textContent = cstats.askRate == null
    ? 'Log a touch and the ask rate appears.'
    : cstats.askRate < 50
      ? 'Under fifty percent. You are still only giving. Ask them for something.'
      : 'Above fifty percent. That is what makes people feel part of your life.';

  $('pr-skips').textContent = skipReport(sessions);
  show('progress');
}

// ---------------- HELP ----------------

const HELP = [
  ['What this is', 'A short speaking drill for the morning. Five minutes in the car, five at the desk. It scores three things that actually make speech land: structure, filler, pace.'],
  ['When to run it', 'Shadow and Words are the car modes, hands free, they read to you and advance themselves. Frame, Clear and Connect are the desk modes, 7:00 to 7:45 or 8:30 to 9:00. Weekends the same.'],
  ['The one rule', 'Never miss twice. One missed day does not break the streak. After a miss the next morning is the two minute version, and the app shortens it for you.'],
  ['Shadow', 'A voice reads one sentence, you repeat it, then you hear the model and yourself back to back. It ends with a cold read of the whole passage. You can paste your own text, a supplier email or a script, and shadow that instead.'],
  ['Scenarios', 'Shadow opens on a real scenario, not a random passage. Tap Scenarios to pick the group first, coffee with her, coworkers, cafe, networking, or Podcast style, then the scenario. The old general passages are still there under More passages.'],
  ['Words', 'Ten cards. Say what it means out loud, tap to check, then say it in a sentence. A card you know but cannot use in a sentence goes back a box. That is on purpose. Knowing a word is not owning it.'],
  ['Frame', 'The prompt now comes from a scenario by default. Tap the button beside The prompt to change which group it draws from. After the take you get that scenario\'s do nots. A prompt, a structure, and thirty seconds to fill three beats. Then you talk for a minute with the beats on screen and tap each one as you hit it. The training is the thirty seconds, not the minute.'],
  ['Clear', 'Three takes on one topic. Take one is you. Take two adds pause instead of um. Take three adds one idea per sentence. You see the difference in numbers.'],
  ['Connect', 'One person card before a real conversation. What they said last time, one ask you can make, something to involve them in, and the thing they own. Then twenty seconds to log it after. The ask is the field that matters.'],
  ['If dictation does not work', 'Then the app plays your take back and you tap a counter every time you hear yourself say um. That is a better trainer anyway, because you have to hear it.'],
  ['What dictation does with your voice', 'Dictation is the phone built in speech to text. When it is on, your spoken audio goes to Apple or Google to be turned into words, exactly like dictating a text message. That is the one thing in this app that leaves the phone, and the one thing that needs a signal. Turn it off in Settings and nothing leaves at all. You then count your own fillers, which is the better drill.'],
  ['Your data', 'Your recordings, your scores, your streak and your people never leave this phone. No account, no upload, no sync. The two exceptions are both things you switch on yourself: dictation, above, and the optional deeper read. Export a backup every few weeks from Settings, because Safari can clear a site it has not seen in a while.'],
  ['The reminder', 'iOS cannot reliably schedule a notification from a web app with no server. The calendar block is the real reminder. The notification here is a nice to have, not the system.'],
  ['Deeper read', 'Optional, off, and the app is complete without it. If you turn it on and paste your own key, the WORDS you said get sent to Claude for a three line critique. Your recordings never leave the phone.']
];

function renderHelp() {
  $('help-body').innerHTML = HELP.map(([h, p]) =>
    '<div><h3 style="margin:0 0 4px">' + escapeHtml(h) + '</h3><p style="margin:0">' + escapeHtml(p) + '</p></div>').join('');
  show('help');
}

// ---------------- REMINDER ----------------
// Honest about what a web app can and cannot do here.

async function askForNotifications() {
  if (!('Notification' in window)) {
    $('notify-note').textContent = 'This browser has no notifications. Use the calendar block instead.';
    return;
  }
  let perm = Notification.permission;
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch (e) { perm = 'denied'; }
  }
  if (perm !== 'granted') {
    $('notify-note').textContent = 'Notifications are off. The calendar block is the reminder that actually works.';
    return;
  }
  await db.setSetting('notify', true);
  try {
    new Notification('Articulation Trainer', { body: 'Reminders on. Five minutes tomorrow morning.', icon: 'icons/icon-192.png' });
  } catch (e) { /* some iOS builds need a service worker registration for this */ }
  $('notify-note').textContent =
    'On. Be straight about the limit: iOS cannot schedule a daily notification from a web app with no server, so this only fires while the app is open. The calendar block is the real reminder.';
}

// ---------------- GRADING ----------------

function renderGrade() {
  $('grade-toggle').textContent = grading.gradingOn() ? 'On' : 'Off';
  $('grade-key').value = '';
  $('grade-note').textContent = grading.keyHint();
  $('grade-result').hidden = true;
  show('grade');
}

async function gradeLastTake() {
  const reps = (await db.all('reps'))
    .filter(r => r.transcript && r.transcript.length > 20)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (!reps.length) {
    $('grade-note').textContent = 'No take with a transcript yet, so there is nothing to send.';
    return;
  }
  $('grade-note').textContent = 'Sending the words only, no audio.';
  const r = await grading.grade({ transcript: reps[0].transcript, prompt: reps[0].target_text });
  if (r.ok) {
    $('grade-text').textContent = r.text;
    $('grade-result').hidden = false;
    $('grade-note').textContent = grading.keyHint();
    await db.put('reps', { ...reps[0], claude_note: r.text });
  } else {
    $('grade-result').hidden = true;
    $('grade-note').textContent = r.reason;
  }
}

// ---------------- settings ----------------

async function renderSettings() {
  const s = await storageInfo();
  $('storage-bar').style.width = (s.pct == null ? 0 : s.pct) + '%';
  $('storage-note').textContent =
    (s.usage == null ? 'Storage size is not reported by this browser.' :
      prettyBytes(s.usage) + ' used of ' + prettyBytes(s.quota) + '. ' + s.clips + ' recordings kept.');

  const words = await db.all('words');
  const vaOn = words.some(w => w.deck === 'verbal_advantage' && w.active !== false);
  $('deck-va-state').textContent = vaOn ? 'on' : 'off';
  $('deck-counts').textContent =
    words.filter(w => w.deck === 'seed300').length + ' core words, ' +
    words.filter(w => w.deck === 'verbal_advantage').length + ' Verbal Advantage words.';

  $('dictation-toggle').textContent = (await db.setting('use_dictation', true)) ? 'On' : 'Off';
  $('voice-note').textContent = speechSupported()
    ? 'Tap once, then the app can read to you. iOS will not release the voice list until you do.'
    : 'This browser has no built in voice. Pre recorded passages still work.';
  $('audio-note').textContent = recordingSupported()
    ? 'The microphone is available on this browser.'
    : 'This browser cannot record. Shadow still plays, it just will not record you.';

  const inst = await db.setting('install_date', today());
  $('about-note').textContent = 'Installed ' + inst + '. Everything is stored on this device only. Nothing is uploaded, there is no account and no key in this app.';
  show('settings');
}

async function toggleVaDeck() {
  const words = await db.all('words');
  const va = words.filter(w => w.deck === 'verbal_advantage');
  const turningOn = !va.some(w => w.active !== false);
  await db.putAll('words', va.map(w => ({ ...w, active: turningOn })));
  renderSettings();
}

async function downloadAllAudio() {
  const texts = await db.all('texts');
  const urls = [];
  for (const t of texts) {
    if (t.audio) urls.push(t.audio);
    for (const s of (t.sentence_audio || [])) urls.push(s);
  }
  if (!urls.length) { $('audio-note').textContent = 'No recorded audio in this build.'; return; }
  $('audio-note').textContent = 'Downloading 0 of ' + urls.length + '.';
  let ok = 0, failed = 0;
  for (let i = 0; i < urls.length; i++) {
    try {
      const r = await fetch(urls[i], { cache: 'reload' });
      if (r.ok) ok++; else failed++;
    } catch (e) { failed++; }
    if (i % 10 === 0 || i === urls.length - 1) {
      $('audio-note').textContent = 'Downloading ' + (i + 1) + ' of ' + urls.length + '.';
    }
  }
  $('audio-note').textContent = ok + ' files cached, ' + failed + ' failed. Shadow now works with no signal.';
}

async function doExport() {
  const data = await db.exportJson();
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'articulation-backup-' + today() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Backup saved. Put it somewhere you will find it.');
}

async function doImport(file) {
  try {
    const text = await file.text();
    const counts = await db.importJson(JSON.parse(text));
    toast('Restored ' + Object.values(counts).reduce((a, b) => a + b, 0) + ' rows.');
    await seedIfNeeded();
    renderSettings();
  } catch (e) {
    toast('That did not restore: ' + (e.message || e), 4000);
  }
}

// ---------------- wiring ----------------

function wire() {
  $('install-continue').onclick = async () => { await renderHome(); show('home'); };
  $('install-never').onclick = async () => { await db.setSetting('hide_install', true); await renderHome(); show('home'); };

  $('home-start').onclick = startSession;
  $('to-settings').onclick = renderSettings;

  $('words-quit').onclick = () => { wClearTimer(); stopSpeaking(); letSleep(); nextStep('words'); };
  $('words-hf').onclick = async () => {
    wHandsFree = !wHandsFree;
    await db.setSetting('words_hands_free', wHandsFree);
    $('words-hf').textContent = wHandsFree ? 'On' : 'Off';
    if (wHandsFree) { await enableVoice(); await keepAwake(); toast('Hands free on. It reads to you and advances itself.'); }
    else { stopSpeaking(); wClearTimer(); }
  };

  $('shadow-quit').onclick = abortShadow;
  $('frame-quit').onclick = abortFrame;
  $('frame-group').onclick = openFrameGroup;
  $('fgroup-cancel').onclick = () => show('frame');
  $('clear-quit').onclick = abortClear;
  $('clear-change').onclick = async () => { cl.topic = await randomPrompt(); $('clear-topic').textContent = cl.topic.text; };
  $('speech-test').onclick = runSpeechTest;
  $('dictation-toggle').onclick = async () => {
    const on = !(await db.setting('use_dictation', true));
    await db.setSetting('use_dictation', on);
    $('dictation-toggle').textContent = on ? 'On' : 'Off';
    toast(on ? 'Dictation on. Your voice goes to Apple or Google to be turned into words.'
             : 'Dictation off. Nothing leaves the phone. You count your own fillers.', 4000);
  };
  $('to-progress').onclick = renderProgress;
  $('progress-back').onclick = async () => { await renderHome(); show('home'); };
  $('done-progress').onclick = renderProgress;
  $('to-help').onclick = renderHelp;
  $('help-back').onclick = renderSettings;
  $('notify-ask').onclick = askForNotifications;
  $('to-grade').onclick = renderGrade;
  $('grade-back').onclick = renderSettings;
  $('grade-toggle').onclick = () => {
    const next = !grading.gradingOn();
    if (next && !grading.hasKey()) { toast('Paste a key first. With no key nothing can be sent.'); return; }
    grading.setGradingOn(next);
    $('grade-toggle').textContent = grading.gradingOn() ? 'On' : 'Off';
  };
  $('grade-save').onclick = () => {
    const k = $('grade-key').value.trim();
    if (!k) { toast('Nothing to save'); return; }
    grading.setKey(k);
    $('grade-key').value = '';
    $('grade-note').textContent = grading.keyHint() + ' Turn it on to use it.';
  };
  $('grade-clear').onclick = () => {
    grading.setKey('');
    grading.setGradingOn(false);
    $('grade-toggle').textContent = 'Off';
    $('grade-note').textContent = grading.keyHint();
  };
  $('shadow-change').onclick = openPick;
  $('shadow-paste').onclick = openPaste;
  $('shadow-hf').onclick = async () => {
    sh.handsFree = !sh.handsFree;
    await db.setSetting('hands_free', sh.handsFree);
    $('shadow-hf').textContent = sh.handsFree ? 'On' : 'Off';
  };
  $('paste-cancel').onclick = () => { show('shadow'); renderShadowIntro(); };
  $('paste-save').onclick = savePaste;
  $('pick-cancel').onclick = pickBack;

  $('enable-voice').onclick = async () => {
    const r = await enableVoice();
    $('voice-note').textContent = r.ok
      ? 'On. Reading with ' + r.voice + '.'
      : r.reason;
  };
  $('download-audio').onclick = downloadAllAudio;

  $('connect-quit').onclick = () => nextStep('connect');
  $('connect-snooze').onclick = async () => {
    if (currentPerson) {
      // a snooze is not a touch, it just moves them out of first place for a day
      const p = { ...currentPerson, snoozed_until: addDays(today(), 1) };
      p.last_touch_date = p.last_touch_date || addDays(today(), -6);
      await db.put('people', p);
    }
    nextStep('connect');
  };
  $('connect-done').onclick = openLog;
  $('connect-edit').onclick = () => editPerson(currentPerson);
  $('connect-add-first').onclick = () => editPerson(null);

  $('log-cancel').onclick = () => runConnect();
  $('log-ask').onclick = () => { logAsk = !logAsk; $('log-ask-state').textContent = logAsk ? 'Yes' : 'No'; };
  $('log-save').onclick = saveLog;

  $('people-back').onclick = renderSettings;
  $('people-add').onclick = () => editPerson(null);
  $('person-cancel').onclick = renderPeople;
  $('person-save').onclick = savePerson;
  $('person-delete').onclick = async () => {
    if (editingPerson && confirm('Delete ' + editingPerson.name + '?')) {
      await db.del('people', editingPerson.id);
      editingPerson = null;
      renderPeople();
    }
  };

  $('done-close').onclick = async () => { await renderHome(); show('home'); };

  $('settings-back').onclick = async () => { await renderHome(); show('home'); };
  $('settings-people').onclick = renderPeople;
  $('deck-va').onclick = toggleVaDeck;
  $('export-btn').onclick = doExport;
  $('import-btn').onclick = () => $('import-file').click();
  $('import-file').onchange = (e) => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ''; };
  $('prune-btn').onclick = async () => { const n = await pruneClips(); toast(n + ' old recordings cleared'); renderSettings(); };
  $('settings-reset').onclick = async () => {
    if (!confirm('This erases every word, person and recording on this device. Export a backup first. Continue?')) return;
    await db.wipeAll();
    location.reload();
  };
}

// expose a few things for the harness tests, never used by the UI
window.__artic = { db, show, seedIfNeeded, dueWords, nextCardState, streakInfo, storageInfo, STEPS, splitSentences, sh, fr, cl, pickPassage, pickFramePrompt, groupedTexts, openPick, openPickGroup, openFrameGroup, feedbackFor, scoreTake, renderProgress, renderHelp, grading, session: () => session, results: () => results };

boot();
