// app.js - screens, the morning session runner, and the M1 modes (Words, Connect).
// No network calls. No API keys. Everything stays in IndexedDB on this device.

import { db, uuid, today, addDays, daysBetween } from './db.js';
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
const SCREENS = ['install','home','words','connect','log','people','person','done','settings'];

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

// ---------------- WORDS ----------------

STEPS.words = {
  label: 'Words',
  note: 'Ten cards, say each one in a sentence',
  run: runWords
};

let wq = [], wIdx = 0, wCorrect = 0, wKnew = false, wSpokenMissed = 0;

async function runWords() {
  const n = results.floor ? 5 : 10;
  wq = await dueWords(n);
  wIdx = 0; wCorrect = 0; wSpokenMissed = 0;
  if (!wq.length) { toast('No cards available'); return nextStep(); }
  show('words');
  renderWordFront();
}

function renderWordFront() {
  const c = wq[wIdx];
  $('words-progress').textContent = (wIdx + 1) + ' of ' + wq.length;
  $('words-tier').textContent = (c.deck === 'verbal_advantage' ? 'Verbal Advantage' : c.tier_label || '');
  $('words-word').textContent = c.word;
  $('words-back').hidden = true;
  $('words-speak').hidden = true;
  $('words-actions').innerHTML = '<button class="primary huge" id="w-reveal">Say what it means, then tap</button>';
  $('w-reveal').onclick = renderWordBack;
}

function renderWordBack() {
  const c = wq[wIdx];
  $('words-def').textContent = c.definition;
  $('words-ex').textContent = c.example_sentence;
  $('words-back').hidden = false;
  $('words-actions').innerHTML =
    '<div class="btnrow"><button id="w-miss">Missed it</button><button class="primary" id="w-knew">Knew it</button></div>';
  $('w-miss').onclick = () => { wKnew = false; finishCard(false, false); };
  $('w-knew').onclick = () => { wKnew = true; askForSentence(); };
}

function askForSentence() {
  $('words-speak').hidden = false;
  $('words-actions').innerHTML =
    '<div class="btnrow"><button id="w-nos">Could not</button><button class="primary" id="w-said">Said it</button></div>';
  $('w-nos').onclick = () => { wSpokenMissed++; finishCard(true, false); };
  $('w-said').onclick = () => finishCard(true, true);
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

  $('words-quit').onclick = () => nextStep('words');

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
window.__artic = { db, show, seedIfNeeded, dueWords, nextCardState, streakInfo, storageInfo };

boot();
