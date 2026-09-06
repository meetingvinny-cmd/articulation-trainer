# Articulation Trainer

A short morning speaking drill that lives on the phone. Plain HTML, CSS and vanilla
JavaScript. No framework, no build step, no npm, no server, no account.

Live: https://meetingvinny-cmd.github.io/articulation-trainer/

## What it is

Five training modes, one 10 minute morning loop, everything scored and stored on the
device. Nothing is uploaded. There is no API key in this repo and none in the browser.

| Mode | What it trains | Where it runs |
|---|---|---|
| Shadow | repeat after a speaker, coverage and pace | in the car, hands free |
| Words | vocabulary, with a mandatory spoken sentence | in the car, hands free |
| Frame | organise the thought before you talk | at the desk |
| Clear | filler, pace, one idea per sentence | at the desk |
| Connect | make people feel useful and involved | before or after a real conversation |

## The morning slot

He leaves home at 6:10 AM, drives 40 to 45 minutes, is alone at his desk 7:00 to 9:00,
and walks the trail 7:45 to 8:30. So:

- **Shadow and Words are the car modes.** Audio driven, big single tap targets,
  auto advance, no reading required.
- **Frame, Clear and Connect are the desk modes**, 7:00 to 7:45 or 8:30 to 9:00.
- Weekday rotation applies to mornings: Sun Shadow, Mon Frame, Tue Clear, Wed Shadow,
  Thu Frame, Fri Clear, Sat Shadow. Saturday and Sunday are an open pick with a default.
- Session cap 10 minutes. After a missed day the next morning drops to a 2 minute floor
  and the streak does not break on one miss, only on two.

## Running it locally

    cd app
    python3 -m http.server 8000
    open http://localhost:8000

`localhost` is a secure context, so the microphone works there. A plain LAN IP is not,
which is why the phone needs the HTTPS host.

## Hosting

GitHub Pages, public repo, deployed from `main` at the repository root. The repo is
public on purpose: the app is generic training software and every personal thing (his
recordings, his people, his scores, his streak) lives in IndexedDB on his phone and
never touches this repo. Nothing personal is ever committed here.

## Repo layout

    index.html              one page, every screen is a <section>
    styles.css              tokens, light and dark, thumb sized tap targets
    app.js                  screens, the session runner, the modes
    db.js                   the only file that touches IndexedDB
    logic.js                pure logic: seeding, Leitner, streak, storage
    audio.js                speech synthesis, recording, playback   (M2)
    score.js                transcript scoring: filler, wpm, coverage (M3)
    sw.js                   offline cache
    manifest.webmanifest    Home Screen install
    data/words.json         the authored Core 300 deck
    data/words_va.json      the Verbal Advantage deck (headwords only, our own text)
    data/prompts.json       150 speaking prompts
    data/texts.json         20 shadowing passages
    data/structures.json    the 6 thought structures
    audio/                  pre rendered mp3 of each passage (M2)
    scripts/                Mac side build tools, never shipped to the browser

## Data model

IndexedDB database `artic`, version 1, nine stores: `settings`, `sessions`, `reps`,
`clips`, `words`, `texts`, `prompts`, `people`, `touches`.

One deliberate change from the design document: `words` is keyed by
`id` = `deckId::word`, not by the bare word. The Core 300 deck and the Verbal
Advantage deck share five headwords and a bare key would silently merge them.

`localStorage` is not used for anything that matters.

## Session log export

Settings, then **Export a backup**, writes `articulation-backup-YYYY-MM-DD.json`.
Audio clips are excluded on purpose: they are the only thing that makes the file big
and they are practice takes, not history. A future `/redevelop` skill reads this file.

    {
      "format": "articulation-trainer-export",
      "schema": 1,
      "exported_at": "2026-09-06T12:00:00.000Z",
      "stores": {
        "sessions": [
          { "id": "2026-09-06T11:31:02.000Z", "date": "2026-09-06",
            "started_at": "...", "ended_at": "...", "duration_sec": 412,
            "modes_run": ["frame","words","connect"], "modes_skipped": [],
            "completed": true, "floor_session": false, "streak_after": 9 }
        ],
        "reps": [
          { "id": "uuid", "session_id": "2026-09-06T11:31:02.000Z", "mode": "clear",
            "created_at": "...", "prompt_id": "p044", "target_text": null,
            "transcript": "...", "transcript_source": "asr|manual|none",
            "duration_sec": 60, "wpm": 148, "filler_count": 7, "filler_rate": 7.0,
            "coverage_pct": null, "beats_hit": null, "beats_total": null,
            "time_to_first_word_ms": null, "silence_pct": 12, "self_rating": null,
            "clip_id": "uuid", "notes": null }
        ],
        "words":   [ { "id": "seed300::mitigate", "box": 3, "due_date": "2026-09-10",
                       "seen_count": 4, "correct_count": 3, "miss_count": 1 } ],
        "people":  [ { "id": "uuid", "name": "Kevin", "last_touch_date": "2026-09-06",
                       "touch_count": 6, "ask_count": 4 } ],
        "touches": [ { "id": "uuid", "person_id": "uuid", "date": "2026-09-06",
                       "channel": "call", "made_an_ask": true } ],
        "settings": [], "texts": [], "prompts": [], "clips": []
      }
    }

Read `sessions` for adherence and streak, `reps` for the trend in filler rate and
words per minute, `words` for deck mastery, `touches` for ask rate.

## Vocabulary decks

**Core 300.** Authored for this app: 6 tiers of 50, every definition and every example
sentence written from scratch. On by default.

**Verbal Advantage.** Headwords only, taken from a public study list at
https://www.learnthat.org/word_lists/view/3927 (retrieved 2026-09-06), associated with
Charles Harrington Elster's *Verbal Advantage*. Every definition and example sentence in
the file is ours. No text from the book is reproduced. Off by default, switch it on in
Settings.

**Known gap, stated plainly.** The book teaches 500 keywords across ten levels. Only 40
headwords were retrievable from a citable public list on 2026-09-06. The other 460 are
not in the file and are not guessed. To fill them, drop the book in File Dump and run
`scripts/import_verbal_advantage.py`, which extracts headwords only and then prints the
words still needing our own definition and example.

## Not in this repo, ever

- The ElevenLabs API key. It lives in the workspace `.env`, is used only by
  `scripts/render_passages.py` on the Mac, and never reaches the browser.
- Any optional Claude API key. That is pasted by him into localStorage on the device.
- Any recording, transcript, person, score or streak.

## Note for the workspace

The working copy at
`Projects/AI Operations/Builds/articulation_trainer/app/` is its own git repository with
its own `.git`. The workspace `.gitignore` excludes that folder so the nested repo is
never committed into the workspace repo as a submodule. Edit here, commit here, push
here. That is the whole deploy.
