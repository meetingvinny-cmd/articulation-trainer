// logic.js - pure app logic with no DOM and no network.
// Seeding, the Leitner scheduler, the streak, storage accounting.
// Everything here is testable on its own.

import { db, uuid, today, addDays, daysBetween } from './db.js';

export const LEITNER_DAYS = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 };
export const MASTERY_BOX = 4;      // box 4 or 5 counts as mastered
export const CLIP_RETENTION_DAYS = 14;
// Bump when data/texts.json gains fields the app needs.
export const TEXTS_VERSION = 2;

// ---------- seeding ----------

async function loadJson(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error('Could not load ' + path);
  return r.json();
}

function cardToRow(deckId, c) {
  return {
    id: deckId + '::' + c.word,
    deck: deckId,
    word: c.word,
    definition: c.definition,
    example_sentence: c.example,
    tier: c.tier,
    tier_label: c.tier_label,
    box: 1,
    due_date: today(),
    seen_count: 0,
    correct_count: 0,
    miss_count: 0,
    last_seen: null,
    spoken_ok: false,
    active: deckId === 'seed300',   // VA deck ships switched off until he turns it on
    source: deckId
  };
}

// Seeds anything missing. Safe to call on every launch: it never overwrites a
// card he has already studied, it only adds cards that are not there yet.
export async function seedIfNeeded() {
  const report = { words: 0, prompts: 0, texts: 0, structures: 0 };

  const haveWords = await db.count('words');
  const seedVersion = await db.setting('seed_version', 0);
  if (haveWords === 0 || seedVersion < 1) {
    const [core, va] = await Promise.all([loadJson('data/words.json'), loadJson('data/words_va.json')]);
    const existing = new Set((await db.all('words')).map(w => w.id));
    const fresh = [];
    for (const deck of [core, va]) {
      for (const c of deck.cards) {
        const row = cardToRow(deck.deck_id, c);
        if (!existing.has(row.id)) fresh.push(row);
      }
    }
    await db.putAll('words', fresh);
    report.words = fresh.length;
    await db.setSetting('seed_version', 1);
  }

  if ((await db.count('prompts')) === 0) {
    const p = await loadJson('data/prompts.json');
    await db.putAll('prompts', p.prompts);
    report.prompts = p.prompts.length;
  }

  // Bundled passages are re-seeded when the data version moves, so an existing
  // install picks up new fields (sentence audio paths) without losing his own
  // pasted texts, which carry a uuid id and are never in the bundle.
  const textsVersion = await db.setting('texts_version', 0);
  if ((await db.count('texts')) === 0 || textsVersion < TEXTS_VERSION) {
    const t = await loadJson('data/texts.json');
    const own = (await db.all('texts')).filter(x => x.source_type === 'own_paste');
    await db.putAll('texts', t.texts);
    await db.putAll('texts', own);
    report.texts = t.texts.length;
    await db.setSetting('texts_version', TEXTS_VERSION);
  }

  if (!(await db.setting('structures'))) {
    const s = await loadJson('data/structures.json');
    await db.setSetting('structures', s.structures);
    report.structures = s.structures.length;
  }

  if (!(await db.setting('install_date'))) await db.setSetting('install_date', today());
  if ((await db.setting('target_wpm_low')) === undefined) await db.setSetting('target_wpm_low', 130);
  if ((await db.setting('target_wpm_high')) === undefined) await db.setSetting('target_wpm_high', 160);
  return report;
}

// ---------- Leitner ----------

export async function dueWords(limit = 10) {
  const all = await db.all('words');
  const t = today();
  const active = all.filter(w => w.active !== false);
  const due = active.filter(w => !w.due_date || w.due_date <= t);
  // hardest first: lowest box, then most missed, then longest unseen
  due.sort((a, b) => (a.box - b.box) || (b.miss_count - a.miss_count) || String(a.last_seen).localeCompare(String(b.last_seen)));
  if (due.length >= limit) return due.slice(0, limit);
  // not enough due: top up with the lowest boxes so a session is never short
  const rest = active.filter(w => !due.includes(w)).sort((a, b) => a.box - b.box);
  return due.concat(rest.slice(0, limit - due.length));
}

// knew: did he recall the meaning. spoke: did he produce a sentence out loud.
// A card he "knows" but cannot use in a sentence goes back a box. That rule is
// from the design and it is the whole reason the spoken rep is mandatory.
export function nextCardState(card, knew, spoke) {
  const c = { ...card };
  c.seen_count = (c.seen_count || 0) + 1;
  c.last_seen = today();
  c.spoken_ok = !!spoke;
  if (knew && spoke) {
    c.correct_count = (c.correct_count || 0) + 1;
    c.box = Math.min(5, (c.box || 1) + 1);
  } else if (knew && !spoke) {
    c.correct_count = (c.correct_count || 0) + 1;
    c.box = Math.max(1, (c.box || 1) - 1);
  } else {
    c.miss_count = (c.miss_count || 0) + 1;
    c.box = 1;
  }
  c.due_date = addDays(today(), LEITNER_DAYS[c.box] || 1);
  return c;
}

export async function deckMastery() {
  const all = (await db.all('words')).filter(w => w.active !== false);
  if (!all.length) return { total: 0, mastered: 0, pct: 0 };
  const mastered = all.filter(w => (w.box || 1) >= MASTERY_BOX).length;
  return { total: all.length, mastered, pct: Math.round(mastered * 100 / all.length) };
}

// ---------- streak ----------
// Never miss twice: one missed day does not break the streak, two do.

export function streakFromDates(dates, t = today()) {
  const set = new Set(dates);
  if (!set.size) return { streak: 0, missedYesterday: false, doneToday: false };
  const doneToday = set.has(t);
  const yesterday = addDays(t, -1);
  // "Missed yesterday" only means anything once there is a history to miss.
  // On the very first ever morning there is no miss and no floor session.
  const hasHistory = dates.some(d => d < t);
  const missedYesterday = hasHistory && !set.has(yesterday);
  let streak = 0;
  let cursor = doneToday ? t : yesterday;
  let misses = 0;
  while (true) {
    if (set.has(cursor)) { streak++; misses = 0; }
    else { misses++; if (misses >= 2) break; if (streak === 0) break; }
    cursor = addDays(cursor, -1);
    if (streak > 3650) break;
  }
  return { streak, missedYesterday, doneToday };
}

export async function streakInfo() {
  const sessions = await db.all('sessions');
  const dates = sessions.filter(s => s.completed).map(s => s.date);
  return streakFromDates(dates);
}

// ---------- weekday drill rotation (mornings) ----------
// 0 Sun ... 6 Sat. Weekends get an open pick with a default.
export const ROTATION = {
  0: { mode: 'shadow', open: true },
  1: { mode: 'frame',  open: false },
  2: { mode: 'clear',  open: false },
  3: { mode: 'shadow', open: false },
  4: { mode: 'frame',  open: false },
  5: { mode: 'clear',  open: false },
  6: { mode: 'shadow', open: true }
};

export function todaysDrill(d = new Date()) {
  return ROTATION[d.getDay()];
}

// ---------- people ----------

export async function coldestPerson() {
  const people = await db.all('people');
  if (!people.length) return null;
  const t = today();
  people.sort((a, b) => {
    const da = a.last_touch_date ? daysBetween(a.last_touch_date, t) : 9999;
    const dbb = b.last_touch_date ? daysBetween(b.last_touch_date, t) : 9999;
    return dbb - da;
  });
  return people[0];
}

export function daysSince(dateStr) {
  if (!dateStr) return null;
  return daysBetween(dateStr, today());
}

export async function connectStats() {
  const touches = await db.all('touches');
  if (!touches.length) return { touches: 0, askRate: null, factRate: null };
  const asks = touches.filter(t => t.made_an_ask).length;
  const facts = touches.filter(t => (t.what_they_said || '').trim() || (t.what_they_are_working_on || '').trim()).length;
  return {
    touches: touches.length,
    askRate: Math.round(asks * 100 / touches.length),
    factRate: Math.round(facts * 100 / touches.length)
  };
}

// ---------- storage ----------

export async function storageInfo() {
  let quota = null, usage = null;
  if (navigator.storage && navigator.storage.estimate) {
    try { const e = await navigator.storage.estimate(); quota = e.quota; usage = e.usage; } catch (e) { /* ignore */ }
  }
  const clips = await db.count('clips');
  return { quota, usage, clips, pct: (quota && usage) ? Math.min(100, Math.round(usage * 100 / quota)) : null };
}

export async function pruneClips() {
  const cutoff = addDays(today(), -CLIP_RETENTION_DAYS);
  const all = await db.all('clips');
  let removed = 0;
  for (const c of all) {
    if (c.keep) continue;
    const d = (c.created_at || '').slice(0, 10);
    if (d && d < cutoff) { await db.del('clips', c.id); removed++; }
  }
  return removed;
}

export { uuid, today, addDays, daysBetween };
