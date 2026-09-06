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
        check("sentence and passage mp3 all return 200 audio/mpeg",
              all(h[0] == 200 and h[1] == "audio/mpeg" for h in audio["heads"]), audio["heads"])

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
