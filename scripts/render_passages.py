#!/usr/bin/env python3
"""Pre-render every shadowing passage to mp3 with ElevenLabs, on the Mac.

THE API KEY NEVER ENTERS THE REPO AND NEVER ENTERS THE BROWSER.
It is read from the workspace .env at run time and is never written to any file
this script produces. The mp3 files are committed, the key is not.

Cache: one mp3 per passage, named by the sha256 of the passage text (first 16 hex
chars), which is the same hash data/texts.json already carries. If the file exists
the passage is skipped, so a rerun after editing one passage costs one passage.

Cost control: refuses to run if the batch would exceed --budget characters
(default 15000) and prints exactly what it would spend before spending it.

Usage
    python3 scripts/render_passages.py --dry-run      # show the plan, spend nothing
    python3 scripts/render_passages.py                # render what is missing
    python3 scripts/render_passages.py --force t01    # re-render one passage
    python3 scripts/render_passages.py --data data/scenarios.json --level sentence \
        --budget 9500 --ids sc01 sc02 ...            # render the scenario pack
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXTS = os.path.join(APP_DIR, "data", "texts.json")
SCENARIOS = os.path.join(APP_DIR, "data", "scenarios.json")
AUDIO_DIR = os.path.join(APP_DIR, "audio")
ENV_PATHS = [
    os.path.expanduser("~/Documents/Claude/.env"),
    os.path.join(APP_DIR, "..", "..", "..", "..", "..", ".env"),
]

# eleven_turbo_v2_5 bills at half the character rate of eleven_multilingual_v2 on a
# pay as you go plan, and these are short plain English passages, so turbo is the
# cheaper correct choice. Checked 2026-09-06.
MODEL = "eleven_turbo_v2_5"
# Whole passages were rendered at 128k. Sentence clips are the ones that ship
# precached for the car, so they go out at 32k mono, which is plenty for a voice
# and a quarter of the bytes.
FMT_PASSAGE = "mp3_44100_128"
FMT_SENTENCE = "mp3_22050_32"
VOICE_NAME = "Jarvis"
FALLBACK_VOICE_NAME = "Edward"
API = "https://api.elevenlabs.io/v1"


def read_key():
    env = os.environ.get("ELEVENLABS_API_KEY")
    if env:
        return env.strip()
    for p in ENV_PATHS:
        p = os.path.abspath(p)
        if not os.path.exists(p):
            continue
        for line in open(p, encoding="utf-8", errors="replace"):
            if line.startswith("ELEVENLABS_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("ELEVENLABS_API_KEY not found. Set it in the environment or in the workspace .env.")


def api_get(key, path):
    req = urllib.request.Request(API + path, headers={"xi-api-key": key})
    return json.load(urllib.request.urlopen(req, timeout=30))


def pick_voice(key):
    voices = api_get(key, "/voices")["voices"]
    by_first = {}
    for v in voices:
        by_first.setdefault(v["name"].split(" - ")[0].strip().lower(), v)
    for want in (VOICE_NAME, FALLBACK_VOICE_NAME):
        v = by_first.get(want.lower())
        if v:
            return v["voice_id"], v["name"]
    sys.exit("Neither %s nor %s is on this account. Voices: %s"
             % (VOICE_NAME, FALLBACK_VOICE_NAME, sorted(by_first)))


def tts(key, voice_id, text, fmt=FMT_PASSAGE):
    body = json.dumps({
        "text": text,
        "model_id": MODEL,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.0, "use_speaker_boost": True},
    }).encode("utf-8")
    req = urllib.request.Request(
        API + "/text-to-speech/%s?output_format=%s" % (voice_id, fmt),
        data=body,
        headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=120).read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--budget", type=int, default=15000, help="hard character ceiling for one run")
    ap.add_argument("--force", nargs="*", default=[], help="passage ids to re-render even if the mp3 exists")
    ap.add_argument("--level", choices=["passage", "sentence", "both"], default="both",
                    help="passage = one mp3 per passage, sentence = one mp3 per sentence (what Shadow plays)")
    ap.add_argument("--data", default=TEXTS,
                    help="which data file to render. data/texts.json is the generic passage bank, "
                         "data/scenarios.json is the scenario and monologue pack.")
    ap.add_argument("--ids", nargs="*", default=None,
                    help="render only these ids, in this order. Everything else is left for the phone voice.")
    args = ap.parse_args()

    data_path = args.data
    if not os.path.isabs(data_path):
        cand = os.path.join(APP_DIR, data_path)
        data_path = cand if os.path.exists(cand) else os.path.abspath(data_path)
    data = json.load(open(data_path, encoding="utf-8"))
    os.makedirs(AUDIO_DIR, exist_ok=True)

    rows = data["texts"]
    if args.ids:
        by_id = {t["id"]: t for t in rows}
        missing = [i for i in args.ids if i not in by_id]
        if missing:
            sys.exit("Unknown ids in --ids: %s" % missing)
        rows = [by_id[i] for i in args.ids]

    plan, skipped = [], []
    for t in rows:
        h = hashlib.sha256(t["body"].encode("utf-8")).hexdigest()[:16]
        if h != t.get("hash"):
            print("  hash drift on %s, %s says %s, the text hashes to %s. Fixing in place."
                  % (t["id"], os.path.basename(data_path), t.get("hash"), h))
            t["hash"] = h
            if args.level in ("passage", "both"):
                t["audio"] = "audio/%s.mp3" % h

        if args.level in ("passage", "both"):
            out = os.path.join(AUDIO_DIR, h + ".mp3")
            if os.path.exists(out) and t["id"] not in args.force:
                skipped.append(t["id"])
            else:
                plan.append((t["id"], t["title"], t["body"], out, FMT_PASSAGE))

        if args.level in ("sentence", "both"):
            paths = []
            for n, sent in enumerate(t["sentences"], start=1):
                sh = hashlib.sha256(sent.encode("utf-8")).hexdigest()[:16]
                rel = "audio/s_%s.mp3" % sh
                paths.append(rel)
                out = os.path.join(APP_DIR, rel)
                if os.path.exists(out) and t["id"] not in args.force:
                    skipped.append("%s.s%d" % (t["id"], n))
                else:
                    plan.append(("%s.s%d" % (t["id"], n), t["title"], sent, out, FMT_SENTENCE))
            t["sentence_audio"] = paths

    chars = sum(len(b) for _, _, b, _, _ in plan)
    print("Passages in this run: %d of %d on file. Already rendered: %d. To render: %d."
          % (len(rows), len(data["texts"]), len(skipped), len(plan)))
    print("Characters this run: %d. Budget: %d. Model: %s." % (chars, args.budget, MODEL))
    if chars > args.budget:
        sys.exit("Refusing to run: %d characters is over the %d budget. Raise --budget deliberately or cut passages."
                 % (chars, args.budget))
    if not plan:
        print("Nothing to do.")
        return
    if args.dry_run:
        for pid, title, body, _, _ in plan:
            print("  %-5s %-28s %4d chars" % (pid, title[:28], len(body)))
        print("Dry run, nothing was sent and nothing was spent.")
        return

    key = read_key()
    voice_id, voice_name = pick_voice(key)
    sub = api_get(key, "/user/subscription")
    left = sub.get("character_limit", 0) - sub.get("character_count", 0)
    print("Voice: %s. Characters left on the account: %d." % (voice_name, left))
    if left < chars:
        sys.exit("Only %d characters left on the account, this run needs %d." % (left, chars))

    ok = 0
    for pid, title, body, out, fmt in plan:
        for attempt in (1, 2, 3):
            try:
                audio = tts(key, voice_id, body, fmt)
                if len(audio) < 400:
                    raise RuntimeError("response was %d bytes, too small to be audio" % len(audio))
                with open(out, "wb") as f:
                    f.write(audio)
                print("  ok  %-5s %-28s %4d chars -> %s (%d KB)"
                      % (pid, title[:28], len(body), os.path.basename(out), len(audio) // 1024))
                ok += 1
                break
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")[:200]
                print("  HTTP %s on %s attempt %d: %s" % (e.code, pid, attempt, detail))
                if e.code in (401, 402, 403):
                    sys.exit("Stopping. That is an auth or quota error, retrying will not help.")
                time.sleep(3 * attempt)
            except Exception as e:
                print("  error on %s attempt %d: %s" % (pid, attempt, e))
                time.sleep(3 * attempt)
        else:
            print("  FAILED %s after 3 attempts, leaving it for the phone voice fallback." % pid)

    json.dump(data, open(data_path, "w", encoding="utf-8"), indent=1, ensure_ascii=True)
    print("Rendered %d of %d. Every passage without an mp3 falls back to the phone voice at run time."
          % (ok, len(plan)))


if __name__ == "__main__":
    main()
