// app.js - screens, the morning session runner, and the M1 modes (Words, Connect).
// No network calls. No API keys. Everything stays in IndexedDB on this device.

import { db, uuid, today, addDays, daysBetween } from './db.js';
import {
  splitSentences, enableVoice, speak, stopSpeaking, speechSupported,
  playUrl, playBlob, stopPlayback, sayPassage, Recorder, recordingSupported,
  micPermission, releaseMic, keepAwake, letSleep
} from './audio.js';
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
const SCREENS = ['install','home','shadow','paste','pick','words','connect','log','people','person','done','settings'];

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
  show('done');
}

// M1 keeps this small and rules based. M4 grows the table to ten or more rules.
async function feedbackLine(r, mastery) {
  if (r.floor) return 'Short session, streak intact. Tomorrow is the full one.';
  if (r.cards_total && r.cards_correct / r.cards_total < 0.5) return 'You missed more than half. Those cards come back tomorrow, that is the point.';
  if (r.spoken_missed) return 'You knew ' + r.spoken_missed + ' of them but could not build a sentence. Those went back a box. Knowing is not owning.';
  if (r.ask_made === false) return 'You logged a touch with no ask. Asking is what makes someone part of your life, giving is not.';
  if (mastery.pct >= 50) return 'Half the deck is yours now. Keep going.';
  return 'Done. Same time tomorrow.';
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

async function pickPassage() {
  const texts = await db.all('texts');
  if (!texts.length) return null;
  texts.sort((a, b) => (a.times_used || 0) - (b.times_used || 0) || String(a.id).localeCompare(String(b.id)));
  return texts[0];
}

function renderShadowIntro() {
  $('shadow-intro').hidden = false;
  $('shadow-run').hidden = true;
  $('shadow-rate').hidden = true;
  $('shadow-sub').textContent = sh.text.sentences.length + ' sentences, about 3 minutes';
  $('shadow-title').textContent = sh.text.title;
  $('shadow-preview').textContent = sh.text.body;
  $('shadow-hf').textContent = sh.handsFree ? 'On' : 'Off';
  $('shadow-actions').innerHTML = '<button class="primary huge" id="sh-go">Start</button>';
  $('sh-go').onclick = startShadow;
}

async function startShadow() {
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
    const onTap = (e) => { if (e.target && e.target.id === 'sh-stop') return; e.preventDefault(); e.stopPropagation(); fin(); };
    tapResolver = fin;
    document.addEventListener('click', onTap, true);
    setTimeout(fin, ms);
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

async function openPick() {
  const texts = await db.all('texts');
  $('pick-list').innerHTML = texts.map(t =>
    '<li class="pick-row" data-id="' + t.id + '"><b>' + escapeHtml(t.title) + '</b>' +
    '<div class="small muted">' + t.sentences.length + ' sentences, used ' + (t.times_used || 0) + ' times' +
    ((t.sentence_audio && t.sentence_audio.length) ? ', recorded voice' : ', phone voice') + '</div></li>').join('');
  for (const el of document.querySelectorAll('.pick-row')) {
    el.onclick = async () => { sh.text = await db.get('texts', el.dataset.id); show('shadow'); renderShadowIntro(); };
  }
  show('pick');
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
  $('shadow-change').onclick = openPick;
  $('shadow-paste').onclick = openPaste;
  $('shadow-hf').onclick = async () => {
    sh.handsFree = !sh.handsFree;
    await db.setSetting('hands_free', sh.handsFree);
    $('shadow-hf').textContent = sh.handsFree ? 'On' : 'Off';
  };
  $('paste-cancel').onclick = () => { show('shadow'); renderShadowIntro(); };
  $('paste-save').onclick = savePaste;
  $('pick-cancel').onclick = () => { show('shadow'); renderShadowIntro(); };

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
window.__artic = { db, show, seedIfNeeded, dueWords, nextCardState, streakInfo, storageInfo, STEPS, splitSentences, sh, pickPassage };

boot();
