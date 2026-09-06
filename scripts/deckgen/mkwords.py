import os
import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from t1 import T1
from t2 import T2
from t3 import T3
from t4 import T4
from t5 import T5
from t6 import T6
tiers = [(1,"precision verbs",T1),(2,"business and negotiation",T2),(3,"people and behavior",T3),
         (4,"words that land",T4),(5,"ideas and thinking",T5),(6,"social and warmth",T6)]
cards=[]; seen=set()
for n,label,rows in tiers:
    assert len(rows)==50, (n,len(rows))
    for w,d,e in rows:
        assert w not in seen, w
        seen.add(w)
        cards.append({"word":w,"definition":d,"example":e,"tier":n,"tier_label":label})
out={
 "deck_id":"seed300",
 "deck_name":"Core 300",
 "version":1,
 "authored_by":"automation-builder, 2026-09-06. All definitions and example sentences written for this app. No text copied from any book.",
 "tiers":{str(n):label for n,label,_ in tiers},
 "cards":cards
}
os.makedirs("data",exist_ok=True)
json.dump(out,open("data/words.json","w"),indent=0,ensure_ascii=True)
print("seed300 cards:",len(cards))
