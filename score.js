// score.js - pure scoring. No DOM, no network, no storage.
// Every function here works on plain strings and numbers so it can be tested
// on its own, and every one of them degrades to null rather than throwing.

// Hard fillers are never anything else. Counting them is safe.
export const HARD_FILLERS = ['um', 'uh', 'erm', 'er', 'ah', 'uhh', 'umm', 'hmm', 'mm'];

// Soft fillers are real words doing filler work. A machine cannot tell the
// difference reliably, so they are counted separately and reported separately.
// The manual tally is the honest number, and hearing yourself say them is the
// better training anyway.
export const SOFT_FILLERS = [
  'like', 'you know', 'so', 'basically', 'actually', 'i mean',
  'kind of', 'sort of', 'right', 'literally', 'obviously', 'just'
];

const WORD = /[a-z0-9']+/gi;

export function words(text) {
  if (!text) return [];
  return String(text).toLowerCase().match(WORD) || [];
}

function countPhrase(lowerText, phrase) {
  // whole word or whole phrase only, never inside another word
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(^|[^a-z0-9\'])' + esc + '($|[^a-z0-9\'])', 'g');
  let n = 0, m;
  while ((m = re.exec(lowerText)) !== null) { n++; re.lastIndex = m.index + 1; }
  return n;
}

export function fillerCounts(transcript) {
  const t = ' ' + String(transcript || '').toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const hard = {}, soft = {};
  let hardTotal = 0, softTotal = 0;
  for (const f of HARD_FILLERS) { const n = countPhrase(t, f); if (n) { hard[f] = n; hardTotal += n; } }
  for (const f of SOFT_FILLERS) { const n = countPhrase(t, f); if (n) { soft[f] = n; softTotal += n; } }
  return { hard, soft, hardTotal, softTotal, total: hardTotal + softTotal };
}

export function wpm(transcript, durationSec) {
  if (!durationSec || durationSec <= 0) return null;
  const n = words(transcript).length;
  if (!n) return null;
  return Math.round(n / (durationSec / 60));
}

export function fillerRate(count, durationSec) {
  if (count == null || !durationSec || durationSec <= 0) return null;
  return Math.round((count / (durationSec / 60)) * 10) / 10;
}

// Longest common subsequence ratio between the target words and what he said.
// Capped so a very long passage cannot blow up: above the cap we fall back to a
// bag of words overlap, which is a fair approximation and always finishes.
export function coverage(target, said, { cap = 400 } = {}) {
  const a = words(target), b = words(said);
  if (!a.length) return null;
  if (!b.length) return 0;
  if (a.length > cap || b.length > cap) {
    const bag = new Map();
    for (const w of b) bag.set(w, (bag.get(w) || 0) + 1);
    let hit = 0;
    for (const w of a) { const n = bag.get(w) || 0; if (n > 0) { hit++; bag.set(w, n - 1); } }
    return Math.round(hit * 100 / a.length);
  }
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return Math.round(prev[b.length] * 100 / a.length);
}

// Longest run of words with no sentence end. If the transcript has no punctuation
// at all, which is what iOS dictation usually gives, this returns null rather
// than a made up number, and the caller uses the pause based figure instead.
export function longestRun(transcript) {
  const t = String(transcript || '');
  if (!/[.!?]/.test(t)) return null;
  let best = 0;
  for (const part of t.split(/[.!?]+/)) {
    const n = words(part).length;
    if (n > best) best = n;
  }
  return best;
}

// Pace verdict against his target band.
export function paceVerdict(w, low = 130, high = 160) {
  if (w == null) return null;
  if (w < low - 25) return 'very slow';
  if (w < low) return 'slow';
  if (w <= high) return 'in the band';
  if (w <= high + 25) return 'fast';
  return 'too fast';
}

// The one line of feedback. A visible rules table, in order, first match wins.
// Never a network call, never a model. M4 keeps growing this list.
export const FEEDBACK_RULES = [
  { id: 'floor', when: (r) => r.floor === true, say: 'Short session, streak intact. Tomorrow is the full one.' },
  { id: 'filler_spike', when: (r) => r.filler_rate != null && r.prev_filler_rate != null && r.filler_rate > r.prev_filler_rate + 2,
    say: (r) => 'Filler rate up from ' + r.prev_filler_rate + ' to ' + r.filler_rate + '. Slow down and pause instead.' },
  { id: 'filler_drop', when: (r) => r.filler_rate != null && r.prev_filler_rate != null && r.filler_rate < r.prev_filler_rate - 2,
    say: (r) => 'Filler rate down from ' + r.prev_filler_rate + ' to ' + r.filler_rate + '. That is the whole drill working.' },
  { id: 'filler_high', when: (r) => r.filler_rate != null && r.filler_rate > 8,
    say: (r) => r.filler_rate + ' fillers a minute. Pause instead of filling. Silence sounds like thinking.' },
  { id: 'too_fast', when: (r) => r.wpm != null && r.wpm > 185,
    say: (r) => r.wpm + ' words a minute. That is racing. One idea per sentence, full stop, breathe.' },
  { id: 'too_slow', when: (r) => r.wpm != null && r.wpm < 105,
    say: (r) => r.wpm + ' words a minute. That is dragging. Pick the pace up, you sound unsure.' },
  { id: 'beats_missed', when: (r) => r.beats_total && r.beats_hit != null && r.beats_hit < r.beats_total,
    say: (r) => 'You hit ' + r.beats_hit + ' of ' + r.beats_total + ' beats. The structure is the point, not the words.' },
  { id: 'slow_start', when: (r) => r.time_to_first_word_ms != null && r.time_to_first_word_ms > 4000,
    say: 'You took over four seconds to start. Fill the three beats first, then talk.' },
  { id: 'cards_bad', when: (r) => r.cards_total && r.cards_correct / r.cards_total < 0.5,
    say: 'You missed more than half. Those cards come back tomorrow, that is the point.' },
  { id: 'spoken_missed', when: (r) => r.spoken_missed > 0,
    say: (r) => 'You knew ' + r.spoken_missed + ' of them but could not build a sentence. Those went back a box. Knowing is not owning.' },
  { id: 'no_ask', when: (r) => r.ask_made === false,
    say: 'You logged a touch with no ask. Asking is what makes someone part of your life, giving is not.' },
  { id: 'coverage_low', when: (r) => r.coverage_pct != null && r.coverage_pct < 55,
    say: (r) => 'You caught ' + r.coverage_pct + ' percent of the words. Listen to the whole sentence before you start repeating it.' },
  { id: 'improved', when: (r) => r.take_delta != null && r.take_delta > 1,
    say: (r) => 'Take three had ' + r.take_delta + ' fewer fillers a minute than take one. The rules work, use them live.' },
  { id: 'mastery', when: (r) => r.mastery_pct != null && r.mastery_pct >= 50,
    say: 'Half the deck is yours now. Keep going.' },
  { id: 'default', when: () => true, say: 'Done. Same time tomorrow.' }
];

export function feedbackFor(r) {
  for (const rule of FEEDBACK_RULES) {
    try {
      if (rule.when(r)) return typeof rule.say === 'function' ? rule.say(r) : rule.say;
    } catch (e) { /* a broken rule never ends the session */ }
  }
  return 'Done. Same time tomorrow.';
}

export function scoreTake({ transcript, durationSec, target }) {
  const f = transcript != null ? fillerCounts(transcript) : null;
  const w = transcript != null ? wpm(transcript, durationSec) : null;
  return {
    transcript: transcript || null,
    duration_sec: durationSec || null,
    word_count: transcript != null ? words(transcript).length : null,
    filler_count: f ? f.total : null,
    filler_hard: f ? f.hardTotal : null,
    filler_soft: f ? f.softTotal : null,
    filler_breakdown: f ? { ...f.hard, ...f.soft } : null,
    filler_rate: f ? fillerRate(f.total, durationSec) : null,
    wpm: w,
    pace: paceVerdict(w),
    longest_run: transcript != null ? longestRun(transcript) : null,
    coverage_pct: target ? coverage(target, transcript) : null
  };
}
