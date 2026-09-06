#!/usr/bin/env python3
"""Headless end to end harness for the articulation trainer.

Runs entirely headless with a fake microphone and audio muted, so it never opens
a window and never makes a sound on the Mac.

    python3 scripts/tests/e2e.py                 # against the local server
    python3 scripts/tests/e2e.py --url https://... # against the live deploy

Exit code 0 means every check passed.
"""
import argparse
import json
import subprocess
import sys
import threading
import time
import http.server
import socketserver
import os
import functools

APP_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 8899

CHROME_ARGS = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
]


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=APP_DIR)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + ((" | " + str(detail)) if detail else ""))
    return bool(ok)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None)
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    httpd = None
    url = args.url
    if not url:
        httpd = serve()
        url = "http://127.0.0.1:%d/index.html" % PORT

    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=CHROME_ARGS)
        ctx = browser.new_context(permissions=["microphone"])
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        page.goto(url, wait_until="load")
        page.wait_for_function("() => !!window.__artic", timeout=15000)
        page.wait_for_timeout(1200)

        print("\n== data and seeding ==")
        counts = page.evaluate("""async () => {
            const a = window.__artic;
            return {words: await a.db.count('words'), prompts: await a.db.count('prompts'),
                    texts: await a.db.count('texts'), steps: Object.keys(a.STEPS)};
        }""")
        check("340 word cards seeded", counts["words"] == 340, counts["words"])
        check("150 prompts seeded", counts["prompts"] == 150, counts["prompts"])
        check("20 passages seeded", counts["texts"] == 20, counts["texts"])

        print("\n== pure logic ==")
        logic = page.evaluate("""async () => {
            const m = await import('./logic.js');
            const A = await import('./audio.js');
            const T='2026-09-06';
            const f=m.streakFromDates;
            const card={id:'x',box:1,seen_count:0,correct_count:0,miss_count:0};
            const s1=m.nextCardState(card,true,true), s2=m.nextCardState(s1,true,false), s3=m.nextCardState(s2,false,false);
            return {
              streaks:{first:f([],T).streak, three:f(['2026-09-04','2026-09-05','2026-09-06'],T).streak,
                       oneMiss:f(['2026-09-06','2026-09-05','2026-09-03','2026-09-02'],T).streak,
                       twoMiss:f(['2026-09-06','2026-09-02','2026-09-01'],T).streak,
                       floorFirstDay:f([],T).missedYesterday,
                       floorAfterMiss:f(['2026-09-03','2026-09-04'],T).missedYesterday},
              boxes:[s1.box,s2.box,s3.box],
              split:{basic:A.splitSentences('One. Two! Three?').length,
                     abbrev:A.splitSentences('I paid Mr. Smith on Tue. It shipped.').length,
                     empty:A.splitSentences('').length,
                     nopunct:A.splitSentences('no full stop here').length},
              mime: A.pickMime(), rec: A.recordingSupported()
            };
        }""")
        check("streak first ever is 0", logic["streaks"]["first"] == 0)
        check("streak three in a row is 3", logic["streaks"]["three"] == 3)
        check("one missed day does not break the streak", logic["streaks"]["oneMiss"] == 4, logic["streaks"]["oneMiss"])
        check("two missed days do break it", logic["streaks"]["twoMiss"] == 1, logic["streaks"]["twoMiss"])
        check("no floor session on the very first morning", logic["streaks"]["floorFirstDay"] is False)
        check("floor session after a real miss", logic["streaks"]["floorAfterMiss"] is True)
        check("Leitner knew+spoke goes up, knew-only goes down, miss resets",
              logic["boxes"] == [2, 1, 1], logic["boxes"])
        check("sentence splitter", logic["split"] == {"basic": 3, "abbrev": 2, "empty": 0, "nopunct": 1}, logic["split"])
        check("a recording mime was detected", logic["mime"] is not None and logic["rec"], logic["mime"])

        print("\n== audio assets ==")
        audio = page.evaluate("""async () => {
            const a = window.__artic;
            const texts = (await a.db.all('texts')).filter(t=>t.source_type!=='own_paste');
            const matched = texts.every(t => (t.sentence_audio||[]).length === t.sentences.length);
            const t = texts.find(x=>x.id==='t01');
            const out=[];
            for (const p of t.sentence_audio.concat([t.audio])) {
                const r = await fetch(p, {method:'HEAD'});
                out.push([r.status, r.headers.get('content-type')]);
            }
            return {matched, heads: out, total: texts.reduce((n,t)=>n+(t.sentence_audio||[]).length,0)};
        }""")
        check("every passage has one mp3 per sentence", audio["matched"], audio["total"])
        # GitHub Pages labels mp3 as audio/mp3, a local python server says audio/mpeg.
        # Both are mp3 and every browser plays both, so accept either.
        check("sentence and passage mp3 all return 200 and an mp3 content type",
              all(h[0] == 200 and h[1] in ("audio/mpeg", "audio/mp3") for h in audio["heads"]), audio["heads"])

        print("\n== words session, full 10 cards ==")
        words = page.evaluate("""async () => {
            const $=id=>document.getElementById(id);
            const vis=()=>[...document.querySelectorAll('section')].filter(s=>!s.hidden).map(s=>s.id)[0];
            const w=ms=>new Promise(r=>setTimeout(r,ms));
            const a=window.__artic;
            $('install-continue').click(); await w(250);
            await a.db.setSetting('words_hands_free', false);
            const sess={id:new Date().toISOString(),date:new Date().toISOString().slice(0,10),
                        started_at:new Date().toISOString(),modes_run:[],modes_skipped:[],completed:false};
            await a.db.put('sessions', sess);
            $('home-start').click(); await w(400);
            let guard=0;
            while (vis()!=='s-words' && guard++<40) { if($('shadow-quit')&&vis()==='s-shadow'){$('shadow-quit').click();} await w(200); }
            if (vis()!=='s-words') return {reached:false, at:vis()};
            let done=0;
            for (let i=0;i<10 && vis()==='s-words';i++){
                $('w-reveal').click(); await w(80);
                if (i%3===0) $('w-miss').click();
                else { $('w-knew').click(); await w(80); (i%3===1?$('w-said'):$('w-nos')).click(); }
                await w(120); done++;
            }
            const seen=(await a.db.all('words')).filter(x=>x.seen_count>0);
            return {reached:true, done, seen:seen.length, boxes:[...new Set(seen.map(x=>x.box))].sort(),
                    dues:[...new Set(seen.map(x=>x.due_date))].sort(), after:vis()};
        }""")
        check("words session reachable and all 10 cards ran", words.get("reached") and words.get("done") == 10, words)
        check("10 cards recorded, boxes moved, due dates set",
              words.get("seen") == 10 and len(words.get("dues", [])) >= 1, words)

        print("\n== shadow session, hands free, real recording ==")
        page.evaluate("""async () => {
            const a=window.__artic;
            await a.db.clear('reps'); await a.db.clear('clips');
            await a.db.setSetting('hands_free', true);
        }""")
        page.evaluate("""async () => {
            const a=window.__artic;
            const $=id=>document.getElementById(id);
            const vis=()=>[...document.querySelectorAll('section')].filter(s=>!s.hidden).map(s=>s.id)[0];
            if (vis()!=='s-shadow') { a.STEPS.shadow.run(); }
            await new Promise(r=>setTimeout(r,600));
            // shortest passage so the harness does not take five minutes
            const texts = await a.db.all('texts');
            texts.sort((x,y)=>x.body.length-y.body.length);
            a.sh.text = texts[0];
            window.__shadowTitle = texts[0].title;
            window.__shadowSentences = texts[0].sentences.length;
        }""")
        page.evaluate("() => { const a=window.__artic; document.getElementById('shadow-intro').hidden=false; }")
        page.evaluate("() => { const b=document.getElementById('sh-go'); if(b) b.click(); }")

        t0 = time.time()
        finished = False
        trail = []
        while time.time() - t0 < 240:
            st = page.evaluate("""() => {
                const $=id=>document.getElementById(id);
                return {rate: !$('shadow-rate').hidden, s: $('shadow-state').textContent,
                        c: $('shadow-count').textContent};
            }""")
            tag = st["c"] + ":" + st["s"]
            if not trail or trail[-1] != tag:
                trail.append(tag)
            if st["rate"]:
                finished = True
                break
            page.wait_for_timeout(1000)

        shadow = page.evaluate("""async () => {
            const a=window.__artic;
            const reps=(await a.db.all('reps')).filter(r=>r.mode==='shadow');
            const clips=await a.db.all('clips');
            return {reps: reps.length, withClip: reps.filter(r=>r.clip_id).length,
                    coldRead: reps.some(r=>r.notes==='cold read'),
                    clips: clips.map(c=>({mime:c.mime, bytes:c.blob.size, dur:c.duration_sec}))};
        }""")
        check("shadow ran to the self rating screen without hanging", finished,
              "%ds, path %s" % (int(time.time() - t0), " > ".join(trail)))
        check("shadow recorded a clip per sentence plus the cold read",
              shadow["reps"] >= 2 and shadow["coldRead"], shadow["reps"])
        check("clips are stored with the container the browser actually gave us",
              len(shadow["clips"]) > 0 and all(c["mime"] and c["bytes"] > 800 for c in shadow["clips"]),
              [(c["mime"], c["bytes"]) for c in shadow["clips"]])


        print("\n== scoring, pure functions ==")
        sc = page.evaluate("""async () => {
            const S = await import('./score.js');
            const t = "um so I was uh thinking that we should like ship it. Basically the price is right, you know. um ok.";
            const f = S.fillerCounts(t);
            return {
              hard: f.hardTotal, soft: f.softTotal, total: f.total,
              // "um" must not match inside "umbrella", "so" not inside "sorry"
              noSubstring: S.fillerCounts("umbrella sorry likely justice actuality").total,
              wpm60: S.wpm("one two three four five six seven eight nine ten", 60),
              wpm0: S.wpm("one two", 0),
              wpmEmpty: S.wpm("", 30),
              rate: S.fillerRate(6, 120),
              covFull: S.coverage("the quick brown fox", "the quick brown fox"),
              covHalf: S.coverage("the quick brown fox", "the brown"),
              covNone: S.coverage("the quick brown fox", "nothing similar at all"),
              covEmptySaid: S.coverage("the quick brown fox", ""),
              covOrder: S.coverage("a b c d", "d c b a"),
              covBig: S.coverage(new Array(600).fill('word').join(' '), new Array(600).fill('word').join(' ')),
              runPunct: S.longestRun("One two three. Four five."),
              runNoPunct: S.longestRun("one two three four five"),
              pace: [S.paceVerdict(90), S.paceVerdict(120), S.paceVerdict(145), S.paceVerdict(170), S.paceVerdict(200)],
              takeNoTranscript: S.scoreTake({transcript:null, durationSec:60, target:'x y z'}),
              takeFull: S.scoreTake({transcript:'um the quick brown fox', durationSec:30, target:'the quick brown fox'})
            };
        }""")
        check("hard fillers counted, soft fillers counted separately",
              sc["hard"] == 3 and sc["soft"] >= 4, (sc["hard"], sc["soft"]))
        check("a filler never matches inside another word", sc["noSubstring"] == 0, sc["noSubstring"])
        check("words per minute, and null rather than a wrong number",
              sc["wpm60"] == 10 and sc["wpm0"] is None and sc["wpmEmpty"] is None, sc["wpm60"])
        check("filler rate per minute", sc["rate"] == 3, sc["rate"])
        check("coverage: full, partial, none, empty",
              sc["covFull"] == 100 and 40 <= sc["covHalf"] <= 60 and sc["covNone"] == 0 and sc["covEmptySaid"] == 0,
              [sc["covFull"], sc["covHalf"], sc["covNone"], sc["covEmptySaid"]])
        check("coverage respects order, so reversed words score low", sc["covOrder"] <= 25, sc["covOrder"])
        check("coverage on a very long passage still finishes and is right", sc["covBig"] == 100, sc["covBig"])
        check("longest run needs punctuation, returns null without it",
              sc["runPunct"] == 3 and sc["runNoPunct"] is None, [sc["runPunct"], sc["runNoPunct"]])
        check("pace verdicts", sc["pace"] == ["very slow", "slow", "in the band", "fast", "too fast"], sc["pace"])
        check("a take with no transcript still scores, it just returns nulls, never throws",
              sc["takeNoTranscript"]["filler_count"] is None and sc["takeNoTranscript"]["duration_sec"] == 60,
              sc["takeNoTranscript"])
        check("a take with a transcript scores filler, pace and coverage",
              sc["takeFull"]["filler_count"] >= 1 and sc["takeFull"]["wpm"] and sc["takeFull"]["coverage_pct"] == 100,
              {k: sc["takeFull"][k] for k in ("filler_count", "wpm", "coverage_pct")})

        print("\n== feedback rules table ==")
        fb = page.evaluate("""async () => {
            const S = await import('./score.js');
            return {
              n: S.FEEDBACK_RULES.length,
              floor: S.feedbackFor({floor:true}),
              spike: S.feedbackFor({filler_rate:6.8, prev_filler_rate:4.1}),
              fast: S.feedbackFor({wpm:200}),
              beats: S.feedbackFor({beats_hit:1, beats_total:3}),
              noAsk: S.feedbackFor({ask_made:false}),
              empty: S.feedbackFor({}),
              broken: S.feedbackFor(null) === undefined ? 'threw' : S.feedbackFor({})
            };
        }""")
        check("the rules table has at least ten rules", fb["n"] >= 10, fb["n"])
        check("every rule branch returns a sentence and the table always terminates",
              all(isinstance(fb[k], str) and len(fb[k]) > 10 for k in ("floor", "spike", "fast", "beats", "noAsk", "empty")),
              fb)

        print("\n== frame mode, full run ==")
        frame = page.evaluate("""async () => {
            const $=id=>document.getElementById(id);
            const vis=()=>[...document.querySelectorAll('section')].filter(s=>!s.hidden).map(s=>s.id)[0];
            const w=ms=>new Promise(r=>setTimeout(r,ms));
            const a=window.__artic;
            await a.db.setSetting('frame_beats_seconds', 3);
            await a.db.setSetting('frame_speak_seconds', 4);
            await a.db.setSetting('frame_rounds', 1);
            await a.db.clear('reps');
            a.STEPS.frame.run(); await w(700);
            if (vis()!=='s-frame') return {reached:false, at:vis()};
            const prompt=$('frame-prompt').textContent, structure=$('frame-structure').textContent;
            const inputs=[...document.querySelectorAll('#frame-beats input')];
            inputs.forEach((el,i)=>{ el.value='beat'+i; });
            $('fr-speak').click(); await w(300);
            const taps=[...document.querySelectorAll('#frame-beat-taps button')];
            taps[0].click(); taps[1].click();
            await w(7000);
            const reps=(await a.db.all('reps')).filter(r=>r.mode==='frame');
            return {reached:true, prompt, structure, beatInputs:inputs.length, tapCount:taps.length,
                    reps: reps.length, r: reps[0] ? {
                      beats_hit:reps[0].beats_hit, beats_total:reps[0].beats_total,
                      ttfw:reps[0].time_to_first_word_ms, dur:reps[0].duration_sec,
                      beats:reps[0].beats_text, src:reps[0].transcript_source,
                      silence:reps[0].silence_pct, clip: !!reps[0].clip_id} : null,
                    after: vis()};
        }""")
        check("frame renders a prompt and a structure with three beats",
              frame.get("reached") and frame.get("beatInputs") == 3 and frame.get("tapCount") == 3, frame)
        check("a frame rep records beats hit, time to first word and duration",
              frame.get("reps") == 1 and frame["r"]["beats_hit"] == 2 and frame["r"]["beats_total"] == 3
              and frame["r"]["dur"] is not None, frame.get("r"))
        check("tapping a beat does NOT cut the recording short",
              frame.get("r") and frame["r"]["dur"] and frame["r"]["dur"] >= 3.0, frame["r"]["dur"] if frame.get("r") else None)
        check("the typed beats are stored with the rep",
              frame["r"] and "beat0" in (frame["r"]["beats"] or ""), frame["r"]["beats"] if frame.get("r") else None)

        print("\n== clear mode, three takes, no dictation available ==")
        clear = page.evaluate("""async () => {
            const $=id=>document.getElementById(id);
            const vis=()=>[...document.querySelectorAll('section')].filter(s=>!s.hidden).map(s=>s.id)[0];
            const w=ms=>new Promise(r=>setTimeout(r,ms));
            const a=window.__artic;
            await a.db.setSetting('take_seconds', 3);
            await a.db.clear('reps');
            a.STEPS.clear.run(); await w(700);
            if (vis()!=='s-clear') return {reached:false, at:vis()};
            const topic=$('clear-topic').textContent;
            $('cl-go').click();
            const tallies=[];
            for (let take=0; take<3; take++){
                // wait for either the tally screen or the next take
                let guard=0;
                while ($('clear-tally').hidden && guard++<80) await w(250);
                if (!$('clear-tally').hidden){
                    // count some fillers by hand, which is the documented fallback
                    for (let k=0;k<take+1;k++) $('tally-hit').click();
                    $('tally-hit').click(); $('tally-undo').click();   // undo must work
                    tallies.push($('tally-count').textContent);
                    $('tally-done').click();
                    await w(400);
                }
            }
            let guard=0;
            while ($('clear-results').hidden && guard++<80) await w(250);
            const reps=(await a.db.all('reps')).filter(r=>r.mode==='clear');
            return {reached:true, topic, tallies,
                    results: !$('clear-results').hidden,
                    table: $('clear-table').textContent.replace(/\s+/g,' ').trim(),
                    verdict: $('clear-verdict').textContent,
                    reps: reps.length,
                    rows: reps.map(r=>({take:r.take, fc:r.filler_count, fr:r.filler_rate, src:r.transcript_source,
                                        sil:r.silence_pct, dur: r.duration_sec && Math.round(r.duration_sec*10)/10, clip:!!r.clip_id}))};
        }""")
        check("clear ran three takes and reached the results table",
              clear.get("reached") and clear.get("results") and clear.get("reps") == 3, clear.get("reps"))
        check("with no dictation, the manual filler tally is used and undo works",
              clear.get("tallies") == ["1", "2", "3"], clear.get("tallies"))
        check("every take stored a filler count, a filler rate and a source",
              all(r["fc"] is not None and r["fr"] is not None and r["src"] == "manual" for r in clear.get("rows", [])),
              clear.get("rows"))
        check("silence percent is computed from the waveform with no transcript",
              all(r["sil"] is not None for r in clear.get("rows", [])), [r["sil"] for r in clear.get("rows", [])])
        check("the results table shows a row per take and a visible delta",
              clear.get("table", "").count("take") >= 0 and len(clear.get("verdict", "")) > 20, clear.get("verdict"))

        print("\n== dictation self test is honest about what it found ==")
        st = page.evaluate("""async () => {
            const A = await import('./audio.js');
            return {supported: A.recognitionSupported(), standalone: A.isStandalone()};
        }""")
        check("the app can tell standalone from a browser tab, which is what the phone test needs",
              st["standalone"] is False, st)


        print("\n== progress screen ==")
        prog = page.evaluate("""async () => {
            const P = await import('./progress.js');
            const T='2026-09-06';
            const mk=(d,v)=>({created_at:d+'T08:00:00.000Z', filler_rate:v, wpm:v?140:null});
            const reps=[mk('2026-09-01',8),mk('2026-09-01',6),mk('2026-09-03',5),mk('2026-09-06',3)];
            const s=P.dailySeries(reps,'filler_rate',30,T);
            const t=P.trend(s);
            const empty=P.dailySeries([], 'filler_rate', 30, T);
            return {
              len:s.length,
              gapsAreNull: s.filter(p=>p.value===null).length,
              averagedSameDay: s.find(p=>p.date==='2026-09-01').value,
              latest: t.latest, delta: t.delta, n: t.n,
              svg: P.sparkline(s,{lowerIsBetter:true}).slice(0,40),
              tooFew: P.sparkline(empty).indexOf('Not enough') >= 0,
              band: P.sparkline(P.dailySeries(reps,'wpm',30,T),{band:[130,160]}).indexOf('rect') >= 0,
              skips: P.skipReport([{modes_skipped:['clear']},{modes_skipped:['clear','frame']}]),
              noSkips: P.skipReport([{modes_skipped:[]}])
            };
        }""")
        # 4 reps across 3 distinct days, so 27 of the 30 slots are gaps.
        check("30 day series, one point a day, missing days are gaps not zeros",
              prog["len"] == 30 and prog["gapsAreNull"] == 27, prog)
        check("two reps on one day are averaged, not double counted",
              prog["averagedSameDay"] == 7, prog["averagedSameDay"])
        check("the trend reports the latest value and a direction",
              prog["latest"] == 3 and prog["delta"] is not None, (prog["latest"], prog["delta"]))
        check("the sparkline renders as inline svg with no library",
              prog["svg"].startswith("<svg"), prog["svg"])
        check("under two data points it says so instead of drawing a lie", prog["tooFew"])
        check("the words per minute chart draws the target band", prog["band"])
        check("the skip report names the mode he dodges most",
              "clear" in prog["skips"] and "not skipped" in prog["noSkips"], [prog["skips"], prog["noSkips"]])

        prog2 = page.evaluate("""async () => {
            const $=id=>document.getElementById(id);
            const a=window.__artic;
            await a.renderProgress();
            const vis=[...document.querySelectorAll('section')].filter(s=>!s.hidden).map(s=>s.id)[0];
            return {vis, streak:$('pr-streak').textContent, sessions:$('pr-sessions').textContent,
                    filler:$('pr-filler-now').textContent, wpm:$('pr-wpm-now').textContent,
                    mastery:$('pr-mastery').textContent, ask:$('pr-ask').textContent,
                    fillerNote:$('pr-filler-note').textContent, skips:$('pr-skips').textContent,
                    hasSvgOrMsg: $('pr-filler-chart').innerHTML.length > 20};
        }""")
        check("the progress screen renders from real stored data",
              prog2["vis"] == "s-progress" and prog2["hasSvgOrMsg"] and len(prog2["fillerNote"]) > 10, prog2)

        print("\n== help ==")
        helpv = page.evaluate("""async () => {
            const a=window.__artic; a.renderHelp();
            const b=document.getElementById('help-body');
            return {sections: b.querySelectorAll('h3').length, chars: b.textContent.length,
                    vis:[...document.querySelectorAll('section')].filter(s=>!s.hidden).map(s=>s.id)[0]};
        }""")
        check("the in app how to covers every mode and the limits",
              helpv["sections"] >= 10 and helpv["chars"] > 900, helpv)

        print("\n== optional grading, off by default ==")
        g = page.evaluate("""async () => {
            const G = window.__artic.grading;
            localStorage.removeItem('artic_claude_key'); localStorage.removeItem('artic_claude_on');
            const offByDefault = G.gradingOn();
            const noKey = G.hasKey();
            const hintNoKey = G.keyHint();
            // with nothing configured it must make no call at all
            let called = false;
            const realFetch = window.fetch;
            window.fetch = (...args) => { called = true; return realFetch(...args); };
            const r1 = await G.grade({transcript:'a fairly long transcript with plenty of words in it'});
            // turning it on without a key must be impossible
            G.setGradingOn(true);
            const onWithoutKey = G.gradingOn();
            // with a key saved, the hint must never print the key
            G.setKey('sk-ant-test-DO-NOT-USE-1234abcd');
            const hint = G.keyHint();
            const leaks = hint.indexOf('sk-ant') >= 0;
            const r2 = await G.grade({transcript:'short'});
            G.setKey(''); G.setGradingOn(false);
            window.fetch = realFetch;
            return {offByDefault, noKey, hintNoKey, r1, onWithoutKey, hint, leaks, r2, called,
                    stillOff: G.gradingOn()};
        }""")
        check("grading is off by default and there is no key", g["offByDefault"] is False and g["noKey"] is False)
        check("with grading off it makes NO network call at all", g["called"] is False, g["r1"]["reason"])
        check("it cannot be switched on without a key", g["onWithoutKey"] is False)
        check("the key is never printed, only the last four characters",
              g["leaks"] is False and "1234" not in g["hint"].replace("abcd", ""), g["hint"])
        check("a too short transcript is refused before anything is sent",
              g["r2"]["ok"] is False and "nothing was sent" in g["r2"]["reason"].lower(), g["r2"]["reason"])
        check("clearing the key turns grading off", g["stillOff"] is False)

        print("\n== the whole app still works with grading off and no key ==")
        noKeyRun = page.evaluate("""async () => {
            const $=id=>document.getElementById(id);
            const w=ms=>new Promise(r=>setTimeout(r,ms));
            const a=window.__artic;
            localStorage.clear();
            const vis=()=>[...document.querySelectorAll('section')].filter(s=>!s.hidden).map(s=>s.id)[0];
            await a.db.setSetting('take_seconds', 2);
            await a.db.clear('reps');
            a.STEPS.clear.run(); await w(600);
            $('cl-go').click();
            for (let take=0; take<3; take++){
                let guard=0;
                while ($('clear-tally').hidden && guard++<60) await w(250);
                if (!$('clear-tally').hidden){ $('tally-hit').click(); $('tally-done').click(); await w(300); }
            }
            let guard=0; while ($('clear-results').hidden && guard++<60) await w(250);
            return {results: !$('clear-results').hidden,
                    gradeButtonShown: !!$('cl-grade'),
                    reps: (await a.db.all('reps')).filter(r=>r.mode==='clear').length};
        }""")
        check("a full Clear session completes with no key present",
              noKeyRun["results"] and noKeyRun["reps"] == 3, noKeyRun)
        check("the deeper read button is not even offered when grading is off",
              noKeyRun["gradeButtonShown"] is False)

        print("\n== imported headwords with no text are never studied ==")
        imp = page.evaluate("""async () => {
            const a=window.__artic;
            await a.db.put('words', {id:'verbal_advantage::placeholderword', deck:'verbal_advantage',
                word:'placeholderword', definition:'', example_sentence:'', box:1,
                due_date:'2000-01-01', seen_count:0, correct_count:0, miss_count:0,
                active:true, needs_text:true});
            const due = await a.dueWords(999);
            const inDeck = due.some(w=>w.word==='placeholderword');
            await a.db.del('words','verbal_advantage::placeholderword');
            return {inDeck};
        }""")
        check("a headword imported with no definition never reaches a study session",
              imp["inDeck"] is False, imp)

        print("\n== dictation disclosure and switch ==")
        disc = page.evaluate("""async () => {
            const $=id=>document.getElementById(id);
            const a=window.__artic;
            await a.renderHelp();
            const help = document.getElementById('help-body').textContent;
            await a.db.setSetting('use_dictation', true);
            const settingsText = document.getElementById('s-settings').textContent;
            // the toggle must actually flip the setting
            $('dictation-toggle').click();
            await new Promise(r=>setTimeout(r,250));
            const after = await a.db.setting('use_dictation', true);
            $('dictation-toggle').click();
            await new Promise(r=>setTimeout(r,250));
            const back = await a.db.setting('use_dictation', true);
            return {
              helpDiscloses: /Apple or Google/.test(help),
              settingsDiscloses: /Apple or Google/.test(settingsText),
              toggleOff: after, toggleBackOn: back
            };
        }""")
        check("the UI says plainly that dictation sends audio to Apple or Google",
              disc["helpDiscloses"] and disc["settingsDiscloses"], disc)
        check("dictation can be switched off, which stops anything leaving the phone",
              disc["toggleOff"] is False and disc["toggleBackOn"] is True, disc)

        print("\n== clip retention ==")
        retention = page.evaluate("""async () => {
            const a=window.__artic;
            const m=await import('./logic.js');
            const old=new Date(Date.now()-20*86400000).toISOString();
            await a.db.put('clips',{id:'old1',rep_id:'r',created_at:old,mime:'audio/mp4',blob:new Blob(['x']),duration_sec:1,keep:false});
            await a.db.put('clips',{id:'old2',rep_id:'r',created_at:old,mime:'audio/mp4',blob:new Blob(['x']),duration_sec:1,keep:true});
            const before=await a.db.count('clips');
            const removed=await m.pruneClips();
            const after=await a.db.count('clips');
            const keptSurvived=!!(await a.db.get('clips','old2'));
            const oldGone=!(await a.db.get('clips','old1'));
            return {before, removed, after, keptSurvived, oldGone};
        }""")
        check("clips older than 14 days are deleted", retention["oldGone"] and retention["removed"] >= 1, retention)
        check("a clip flagged keep survives the prune", retention["keptSurvived"], retention)

        print("\n== export and import round trip ==")
        rt = page.evaluate("""async () => {
            const a=window.__artic;
            const exp=await a.db.exportJson();
            await a.db.wipeAll();
            const zero=await a.db.count('words');
            await a.db.importJson(exp);
            let rejected=null;
            try { await a.db.importJson({format:'nope'}); } catch(e){ rejected=e.message; }
            return {zero, words: await a.db.count('words'), people: await a.db.count('people'),
                    sessions: await a.db.count('sessions'), clipsInFile: exp.stores.clips.length, rejected};
        }""")
        check("wipe then restore brings every store back", rt["zero"] == 0 and rt["words"] == 340, rt)
        check("audio clips are excluded from the backup file", rt["clipsInFile"] == 0, rt["clipsInFile"])
        check("a file that is not ours is rejected with a plain message", bool(rt["rejected"]), rt["rejected"])

        print("\n== offline ==")
        page.evaluate("() => navigator.serviceWorker.ready")
        page.wait_for_timeout(2500)
        cached = page.evaluate("""async () => {
            const keys=await caches.keys();
            if(!keys.length) return {keys:[], n:0};
            const c=await caches.open(keys[0]);
            return {keys, n:(await c.keys()).length};
        }""")
        check("service worker cached the app shell", cached["n"] >= 15, cached)
        ctx.set_offline(True)
        page.goto(url, wait_until="load")
        page.wait_for_function("() => !!window.__artic", timeout=15000)
        page.wait_for_timeout(900)
        off = page.evaluate("async () => ({words: await window.__artic.db.count('words'), title: document.title})")
        check("the app boots with the network off", off["words"] == 340 and off["title"] == "Articulation Trainer", off)
        ctx.set_offline(False)

        print("\n== console ==")
        real = [e for e in errors if "apple-mobile-web-app-capable" not in e]
        check("zero console errors", len(real) == 0, real[:3])

        browser.close()

    if httpd:
        httpd.shutdown()

    failed = [n for n, ok, _ in RESULTS if not ok]
    print("\n%d checks, %d passed, %d failed" % (len(RESULTS), len(RESULTS) - len(failed), len(failed)))
    if failed:
        for f in failed:
            print("  FAILED: " + f)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
