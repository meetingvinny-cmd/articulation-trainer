#!/usr/bin/env python3
"""Extract HEADWORDS ONLY from a copy of Verbal Advantage, then say what is missing.

Why headwords only: copying the book's 500 words together with its definitions is a
reproduction of the book's substance. The book's sequencing judgment is the valuable
part and a bare ordered word list is not the book. So this script takes the words and
NOTHING else. Every definition and example sentence in the app is written by us.

    python3 scripts/import_verbal_advantage.py "~/Documents/Claude/File Dump/verbal_advantage.pdf"
    python3 scripts/import_verbal_advantage.py book.epub --write-stub missing.py

It reads .txt and .md directly, .pdf via pdftotext if it is installed, and .epub by
unzipping the XHTML. If none of those work it says so and stops, rather than guessing.

Output: the headwords it found, which of them the app already has, and the list that
still needs one plain definition and one example sentence in his register. It NEVER
writes a definition itself and it never edits data/words_va.json without --apply.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VA_JSON = os.path.join(APP_DIR, "data", "words_va.json")

# The book numbers its keywords. These are the shapes that actually appear.
PATTERNS = [
    re.compile(r"^\s*Word\s+(\d{1,3})\s*[:.\-]\s*([A-Za-z][A-Za-z\-']{2,24})\s*$", re.M),
    re.compile(r"^\s*(\d{1,3})\.\s+([A-Z][A-Za-z\-']{2,24})\s*$", re.M),
    re.compile(r"^\s*(\d{1,3})\s*[:.\-]\s*([A-Z][A-Z\-']{2,24})\s*$", re.M),
]


def read_text(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".txt", ".md", ".text"):
        return open(path, encoding="utf-8", errors="replace").read()
    if ext == ".pdf":
        if not shutil.which("pdftotext"):
            sys.exit("That is a PDF and pdftotext is not installed.\n"
                     "Install it with: brew install poppler\n"
                     "Or export the book to .txt and point this script at that.")
        out = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True)
        if out.returncode != 0:
            sys.exit("pdftotext failed: " + (out.stderr or "")[:300])
        return out.stdout
    if ext in (".epub", ".zip"):
        chunks = []
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.lower().endswith((".xhtml", ".html", ".htm"))]
            names.sort()
            for n in names:
                raw = z.read(n).decode("utf-8", "replace")
                raw = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw, flags=re.S | re.I)
                raw = re.sub(r"<[^>]+>", "\n", raw)
                chunks.append(raw)
        return "\n".join(chunks)
    sys.exit("Cannot read %s. Give me a .txt, .md, .pdf or .epub." % ext)


def extract(text):
    found = []
    seen = set()
    for pat in PATTERNS:
        for num, word in pat.findall(text):
            w = word.strip().lower()
            if w in seen:
                continue
            if len(w) < 3 or w in ("the", "and", "word", "level", "review", "test", "index"):
                continue
            seen.add(w)
            found.append((int(num), w))
    found.sort(key=lambda t: t[0])
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("book", help="path to the book: .txt, .md, .pdf or .epub")
    ap.add_argument("--write-stub", default=None,
                    help="write a python stub listing every missing word, ready for us to fill in")
    ap.add_argument("--apply", action="store_true",
                    help="add the found words to data/words_va.json as PLACEHOLDER cards, "
                         "marked needs_text so they are excluded from study until written")
    args = ap.parse_args()

    path = os.path.expanduser(args.book)
    if not os.path.exists(path):
        sys.exit("No such file: " + path)

    text = read_text(path)
    found = extract(text)
    if not found:
        sys.exit("Found no numbered headwords in that file.\n"
                 "The book numbers its keywords as 'Word 1: paraphrase' or '1. PARAPHRASE'.\n"
                 "If this copy is formatted differently, paste one page of it and I will add the pattern.")

    data = json.load(open(VA_JSON, encoding="utf-8"))
    have = {c["word"].lower() for c in data["cards"]}
    words = [w for _, w in found]
    missing = [w for w in words if w not in have]

    print("Headwords found in the book:      %d" % len(words))
    print("Already in the app with our text: %d" % len([w for w in words if w in have]))
    print("Still needing our own definition and example sentence: %d" % len(missing))
    print()
    print("These need one plain definition and one example sentence each, in his register:")
    for i, w in enumerate(missing, 1):
        print("  %3d. %s" % (i, w))

    if args.write_stub:
        with open(args.write_stub, "w", encoding="utf-8") as f:
            f.write("# Verbal Advantage headwords still needing OUR OWN text.\n")
            f.write("# Source of the headwords: %s\n" % os.path.basename(path))
            f.write("# Fill in (word, definition, example). Copy NOTHING from the book.\n")
            f.write("VA_MISSING = [\n")
            for w in missing:
                f.write('    ("%s", "", ""),\n' % w)
            f.write("]\n")
        print("\nStub written to %s" % args.write_stub)

    if args.apply:
        for w in missing:
            data["cards"].append({
                "word": w, "definition": "", "example": "",
                "tier": 1, "tier_label": "verbal advantage, text not written yet",
                "needs_text": True
            })
        data["coverage_gap"] = ("Headwords imported from a copy of the book on this machine. "
                               "%d cards carry needs_text and are excluded from study until a "
                               "definition and an example sentence are written for them." % len(missing))
        json.dump(data, open(VA_JSON, "w", encoding="utf-8"), indent=0, ensure_ascii=True)
        print("\nAdded %d placeholder cards to data/words_va.json, all marked needs_text." % len(missing))
        print("They will NOT appear in a study session until their text is written.")
    else:
        print("\nNothing was written. Add --apply to put placeholders in the deck, "
              "or --write-stub FILE to get a fill in list.")


if __name__ == "__main__":
    main()
