// grade.js - the OPTIONAL deeper read. Off by default, built last, and the app
// is complete without it.
//
// Three hard rules, enforced here and nowhere else:
// 1. The key lives in localStorage on this device. It is never committed, never
//    logged, never put in a URL, and never sent anywhere except Anthropic.
// 2. Only the WORDS he said are ever sent. A recording never leaves the phone.
// 3. If the toggle is off or there is no key, this file makes NO network call
//    at all. Everything else in the app keeps working exactly the same.

const KEY_NAME = 'artic_claude_key';
const ON_NAME = 'artic_claude_on';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';

export function gradingOn() {
  try { return localStorage.getItem(ON_NAME) === '1' && !!getKey(); } catch (e) { return false; }
}

export function setGradingOn(on) {
  try { localStorage.setItem(ON_NAME, on ? '1' : '0'); } catch (e) { /* ignore */ }
}

export function getKey() {
  try { return localStorage.getItem(KEY_NAME) || ''; } catch (e) { return ''; }
}

export function setKey(k) {
  try {
    if (k) localStorage.setItem(KEY_NAME, k.trim());
    else localStorage.removeItem(KEY_NAME);
  } catch (e) { /* ignore */ }
}

export function hasKey() { return !!getKey(); }

// Never print the key. This is the only thing allowed on screen about it.
export function keyHint() {
  const k = getKey();
  if (!k) return 'No key saved. Nothing can be sent.';
  return 'A key is saved on this phone. It ends ' + k.slice(-4) + '.';
}

const PROMPT = [
  'You are a blunt speaking coach. Below is a transcript of one 60 second take.',
  'Give exactly three things, no preamble, no praise padding:',
  '1. The single biggest structural problem, in one sentence.',
  '2. One specific line he said and how to say it better, quoting his own words.',
  '3. One thing to do differently in the next take, in under 12 words.',
  'Plain words. No em dashes. Under 120 words total.'
].join(' ');

export async function grade({ transcript, prompt }) {
  if (!gradingOn()) return { ok: false, text: null, reason: 'Deeper read is off. Nothing was sent.' };
  const key = getKey();
  if (!key) return { ok: false, text: null, reason: 'No key saved. Nothing was sent.' };
  if (!transcript || transcript.trim().length < 20) {
    return { ok: false, text: null, reason: 'There is no transcript to read, so nothing was sent. Dictation did not catch anything.' };
  }
  if (!navigator.onLine) return { ok: false, text: null, reason: 'No signal. Nothing was sent.' };

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: PROMPT + '\n\nThe prompt he was answering: ' + String(prompt || 'not recorded') +
                   '\n\nWhat he said: ' + String(transcript)
        }]
      })
    });
    if (!res.ok) {
      // Never echo the response body raw, it can carry the key back in an error.
      return { ok: false, text: null, reason: 'Claude said no, status ' + res.status +
        (res.status === 401 ? '. That key is not valid.' : res.status === 429 ? '. Rate limited, try later.' : '.') };
    }
    const data = await res.json();
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    return { ok: !!text, text: text || null, reason: text ? null : 'Empty answer.' };
  } catch (e) {
    return { ok: false, text: null, reason: 'The request did not go through. Everything else still works.' };
  }
}
