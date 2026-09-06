import json, re, hashlib

PD = [
("Gettysburg, the opening",
 "Four score and seven years ago our fathers brought forth on this continent a new nation, conceived in liberty, and dedicated to the proposition that all men are created equal. Now we are engaged in a great civil war, testing whether that nation, or any nation so conceived and so dedicated, can long endure. We are met on a great battlefield of that war.",
 "Abraham Lincoln, Gettysburg Address, 1863. Public domain, published before 1929 and a United States government work."),
("Gettysburg, the close",
 "It is for us the living, rather, to be dedicated here to the unfinished work which they who fought here have thus far so nobly advanced. That we here highly resolve that these dead shall not have died in vain, and that government of the people, by the people, for the people, shall not perish from the earth.",
 "Abraham Lincoln, Gettysburg Address, 1863. Public domain, published before 1929 and a United States government work."),
("The man in the arena",
 "It is not the critic who counts, not the man who points out how the strong man stumbles, or where the doer of deeds could have done them better. The credit belongs to the man who is actually in the arena, whose face is marred by dust and sweat and blood, who strives valiantly, who errs, who comes short again and again, because there is no effort without error and shortcoming.",
 "Theodore Roosevelt, Citizenship in a Republic, Paris, 1910. Public domain, published before 1929."),
("Ask not",
 "And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country. My fellow citizens of the world, ask not what America will do for you, but what together we can do for the freedom of man.",
 "John F. Kennedy, Inaugural Address, 1961. Public domain, a United States government work."),
("With malice toward none",
 "With malice toward none, with charity for all, with firmness in the right as God gives us to see the right, let us strive on to finish the work we are in, to bind up the nation's wounds, to care for him who shall have borne the battle and for his widow and his orphan.",
 "Abraham Lincoln, Second Inaugural Address, 1865. Public domain, published before 1929 and a United States government work."),
("We band of brothers",
 "We few, we happy few, we band of brothers. For he today that sheds his blood with me shall be my brother. Be he ne'er so vile, this day shall gentle his condition. And gentlemen in England now abed shall think themselves accursed they were not here.",
 "William Shakespeare, Henry the Fifth, Act four Scene three. Public domain."),
]

MINE = [
("The one number",
 "Here is the number that matters. Not revenue, not units, not how many people looked at the page. Cash in the account on the first of the month, after everything owed goes out. That is the number. Everything else is a story you tell yourself while the real number quietly moves. So I check it Monday morning, before email, before anything. If it went up, I keep doing what I did. If it went down, I find out why before lunch.",
 None),
("Saying no",
 "I used to say yes to everything. I thought that was generosity. It was not. It was avoidance. Saying yes cost me nothing in the moment and cost me everything by Friday. A real no takes two seconds and it is kind, because the other person can go find someone who actually means yes. So now I say it plainly. No, I cannot do that this week. No explanation after it. The explanation is where the apology hides.",
 None),
("The supplier call",
 "I want to be direct about the timeline, because last time we were both surprised and neither of us enjoyed it. The order ships on the fourteenth. If anything moves that date, I need to know the day you know, not the week after. In exchange, you have my payment the day the inspection clears, every time, no chasing. That is the deal I want. Tell me now if it does not work for you.",
 None),
("What I actually do",
 "I build small brands and sell them online. That is the short answer. The longer one is that I find a product people already buy, figure out why the current versions annoy them, make a better one, and then spend most of my time on the boring part, which is inventory and advertising. It is less glamorous than it sounds and more interesting than it sounds, both at once.",
 None),
("The morning window",
 "The best hour I have is the one before anyone needs me. Nobody has emailed yet. Nothing has gone wrong yet. My head is quiet. So I stopped spending it on email and started spending it on the thing I would otherwise never get to. It is not discipline exactly. It is just protecting the only clean hour on the board.",
 None),
("Ask, do not give",
 "People do not feel close to you because you gave them something. They feel close because you needed them for something and they came through. That is backwards from what everyone thinks. Giving makes you the one with the surplus, which is a lonely place. Asking makes you a person with a gap, and people move toward gaps. So ask. Ask for the thing they are actually good at. Then tell them, out loud, that they were the reason it worked.",
 None),
("Holding a price",
 "The price is nineteen eighty eight. I know you have seen it lower elsewhere and I know what that seller is carrying in inventory. I am not going to match a number that puts me out of business in four months, because then you have a supplier who disappears. What I can do is guarantee stock through the season and get you a shorter lead time. That is worth more to you than a dollar.",
 None),
("Three beats",
 "Before I open my mouth I want three beats in my head. What happened. Why it matters. What happens next. That is it. Thirty seconds of thinking buys me a minute of talking that actually goes somewhere. Without it I start in the middle, circle back, apologize for circling back, and lose the room. With it I sound like someone who knew what he was going to say, because I did.",
 None),
("The gym at six",
 "It is dark, it is cold, and the whole thing takes ninety minutes door to door. There is no version of this where I feel like going. That is the point. The decision was made once, months ago, and today is not a new decision. Today is just execution. The moment I let it become a decision again, it becomes a negotiation, and I lose those.",
 None),
("Bad news first",
 "Here is the bad news up front, because you should not have to dig for it. We are going to be four days late and it is my fault, I placed the order too close to the cutoff. Here is what I have already done about it. Half the units go by air at my cost, so you have stock by the original date. The rest arrives the following week. Nothing about your side changes."
 , None),
("A real compliment",
 "You handled that call better than I would have. Not the polite part, the part where he pushed and you did not move and you also did not get sharp about it. I would have gotten sharp. I have been trying to learn that for a year and you did it without thinking about it. I wanted you to know I noticed.",
 None),
("The thing I am rebuilding",
 "I used to decide fast. I would make the call, tell people the plan, and move, and people liked being around that. Somewhere in the last few years I traded it for agreeableness, and agreeableness is not the same as kindness. It is just a slower way of disappearing. So I am rebuilding the part that decides. Not louder. Just decided.",
 None),
("Explaining a delay",
 "The pallet is sitting at the port and it will move on Thursday. I am not going to tell you it is out of my hands, because you hired me to have things in my hands. What I can tell you is the exact date, the reason, and the two things I changed so this specific problem does not repeat. If Thursday moves, you hear it from me the same hour.",
 None),
("One idea per sentence",
 "Short sentences are not simple. They are expensive. Every full stop is a decision to stop adding and let the last thing land. When I talk fast and never stop, it is not because I have more to say. It is because I have not decided which part matters. So I practice stopping. Say the thing. Stop. Let it sit. The pause is the part they remember.",
 None),
]

def sentences(t):
    parts = re.split(r'(?<=[.!?])\s+', t.strip())
    return [p.strip() for p in parts if p.strip()]

texts=[]; total=0
for i,(title,body,lic) in enumerate(PD+MINE, start=1):
    body=" ".join(body.split())
    total+=len(body)
    h=hashlib.sha256(body.encode()).hexdigest()[:16]
    texts.append({
      "id":"t%02d"%i,"title":title,"body":body,
      "source_type":"public_domain" if lic else "authored",
      "license_note": lic or "Written for this app by automation-builder, 2026-09-06. Original text, no third party rights.",
      "sentences":sentences(body),
      "audio":"audio/%s.mp3"%h,
      "hash":h
    })
json.dump({"version":1,"texts":texts},open("data/texts.json","w"),indent=0,ensure_ascii=True)
print("passages:",len(texts),"total chars:",total,"avg:",total//len(texts))
print("min/max:",min(len(t['body']) for t in texts), max(len(t['body']) for t in texts))
