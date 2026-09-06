// progress.js - the numbers behind the Progress screen, plus a tiny inline SVG
// sparkline. Pure functions and one renderer. No network, no storage writes.

// A 30 day series of one value per day, from rep rows. Days with no rep are
// gaps, never zeros: a zero would say "he was perfect", a gap says "he did not
// train". Averaging a day's reps is deliberate, one bad take should not define
// the day.
export function dailySeries(reps, field, days = 30, todayStr) {
  const byDay = new Map();
  for (const r of reps) {
    const v = r[field];
    if (v == null || isNaN(v)) continue;
    const d = String(r.created_at || '').slice(0, 10);
    if (!d) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(Number(v));
  }
  const out = [];
  const end = todayStr ? new Date(todayStr + 'T12:00:00') : new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(end);
    dt.setDate(dt.getDate() - i);
    const key = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    const vals = byDay.get(key);
    out.push({ date: key, value: vals ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null });
  }
  return out;
}

export function trend(series) {
  const pts = series.filter(p => p.value != null);
  if (pts.length < 2) return { first: pts[0] ? pts[0].value : null, last: pts[0] ? pts[0].value : null, delta: null, n: pts.length };
  const half = Math.max(1, Math.floor(pts.length / 2));
  const avg = (arr) => Math.round((arr.reduce((a, b) => a + b.value, 0) / arr.length) * 10) / 10;
  const early = avg(pts.slice(0, half));
  const late = avg(pts.slice(-half));
  return { first: early, last: late, delta: Math.round((late - early) * 10) / 10, n: pts.length, latest: pts[pts.length - 1].value };
}

// A sparkline that reads on a phone: wide, short, gaps left as gaps, the most
// recent point marked. Inline SVG so there is no library and nothing to load.
export function sparkline(series, { w = 300, h = 64, band = null, lowerIsBetter = false } = {}) {
  const pts = series.map((p, i) => ({ i, v: p.value, d: p.date })).filter(p => p.v != null);
  if (pts.length < 2) {
    return '<div class="small muted" style="padding:14px 0">Not enough mornings yet. Two days of data and the line appears.</div>';
  }
  const vals = pts.map(p => p.v);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (band) { lo = Math.min(lo, band[0]); hi = Math.max(hi, band[1]); }
  if (hi === lo) { hi = lo + 1; }
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;
  const n = series.length - 1;
  const x = (i) => Math.round((i / n) * (w - 8) + 4);
  const y = (v) => Math.round(h - 8 - ((v - lo) / (hi - lo)) * (h - 16) + 4);

  let bandRect = '';
  if (band) {
    const yTop = y(band[1]), yBot = y(band[0]);
    bandRect = '<rect x="0" y="' + yTop + '" width="' + w + '" height="' + Math.max(1, yBot - yTop) +
      '" fill="currentColor" opacity="0.10"></rect>';
  }
  const path = pts.map((p, k) => (k ? 'L' : 'M') + x(p.i) + ' ' + y(p.v)).join(' ');
  const last = pts[pts.length - 1];
  const good = lowerIsBetter ? (last.v <= vals[0]) : true;
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" role="img" ' +
    'aria-label="trend over the last 30 mornings" style="display:block;color:var(--accent)">' +
    bandRect +
    '<path d="' + path + '" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></path>' +
    '<circle cx="' + x(last.i) + '" cy="' + y(last.v) + '" r="4.5" fill="currentColor"></circle>' +
    '</svg>';
}

export function skipReport(sessions) {
  const counts = {};
  let total = 0;
  for (const s of sessions) {
    for (const m of (s.modes_skipped || [])) { counts[m] = (counts[m] || 0) + 1; total++; }
  }
  if (!total) return 'You have not skipped anything. Good.';
  const worst = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const list = Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([m, n]) => m + ' ' + n).join(', ');
  return 'Skipped: ' + list + '. You dodge ' + worst[0] + ' most. That is usually the one worth doing.';
}
