import json
P = {
"party": [
"Explain what you do for work to someone at a party.","Someone asks why you sell on Amazon. Answer in three sentences.",
"Tell a stranger one true thing about your week that is actually interesting.","Someone asks what you do for fun. Do not say nothing.",
"Introduce yourself to a group already mid conversation.","Someone asks where you are from. Make it a story, not a city.",
"Explain your business to someone who has never bought anything online.","Tell someone about the last thing that made you laugh.",
"Someone asks how your year is going. Be honest without dumping.","Describe your ideal Saturday in under thirty seconds.",
"Someone compliments you. Respond without deflecting.","Tell a two sentence story about a trip you took.",
"Someone asks what you are into lately. Pick one thing and go deep.","Explain why you started your business, not what it is.",
"Someone mentions a topic you know nothing about. Ask three good questions.","Tell someone what you were like at twenty two.",
"Explain what a private label brand is without jargon.","Someone asks if you are seeing anyone. Answer in one line and move on.",
"Describe a person you admire and exactly why.","Tell the story of the worst thing that happened at work this month.",
"Someone asks what you would do with a free year.","Explain the difference between what you do and what everyone thinks you do.",
"Give a stranger a real compliment that is not about their appearance.","Someone asks about your family. Give one warm specific detail.",
"Tell someone why you go to the gym, without saying health.","Explain a hobby you dropped and why.",
"Someone asks what keeps you busy. Do not say work.","Tell a story where you were wrong about something.",
"Describe your neighborhood to someone who has never been.","Someone asks what you are proud of this year."
],
"work": [
"Give a one minute status update on your business to someone who invested in it.",
"Explain to your supplier why the ship date matters this time.","Tell your freight forwarder you need a decision by tomorrow.",
"Explain why you cut the ad budget on one product.","Give a thirty second update on cash position.",
"Explain to a partner why you are holding price instead of dropping it.","Tell someone what went wrong last week and what you changed.",
"Explain your inventory position and what happens if nothing changes.","Walk someone through how you pick a new product.",
"Explain why one channel is dangerous.","Tell your boss you need to leave early without apologizing three times.",
"Explain a delay to a customer without making excuses.","Give a one minute recap of the last quarter.",
"Explain why the cheapest quote is not the best quote.","Tell someone the one number you watch every week and why.",
"Explain what you would do with fifty thousand dollars in the business.","Describe your biggest operational bottleneck in one minute.",
"Explain why you fired or would fire a supplier.","Give the case for spending money you do not want to spend.",
"Explain what you learned from a product that failed.","Tell someone what your business looks like in three years.",
"Explain a technical part of your work to someone non technical.","Give the one minute version of a decision you have been avoiding.",
"Explain why a competitor is beating you on one thing.","Tell someone what you would stop doing if you could.",
"Explain how you decide what to work on today.","Give a status update that includes bad news first.",
"Explain the risk in your current plan out loud.","Tell someone what would have to be true for this to fail.",
"Explain the one thing you want someone else to own.","Give the one sentence version of what your business does."
],
"relationship": [
"Tell someone close to you why you were distant last week.","Explain what you need without listing what they did wrong.",
"Say no to a request from someone you care about.","Tell someone you were wrong, in three sentences, no excuses.",
"Explain what a good week looks like for you.","Ask for something you have been avoiding asking for.",
"Tell someone specifically what you appreciate about them.","Explain why you have been working so much, without defending it.",
"Set a boundary in one calm sentence.","Tell someone what you are working on about yourself.",
"Explain how you want to be treated when you are stressed.","Ask someone what they need from you this month.",
"Tell someone the truth about your money situation.","Explain why something they said landed badly, without attacking.",
"Say what you want to happen next, plainly.","Tell someone you missed them without being heavy about it.",
"Explain why you changed your mind about something.","Ask a question you actually want the answer to.",
"Tell someone what you love doing with them.","Explain what you were like before, and what you are rebuilding.",
"Say the thing you have been rehearsing in your head for a week.","Tell someone they are wrong without making them feel small.",
"Explain what you are not willing to do anymore.","Ask for help with something specific.",
"Tell someone what you noticed about them lately.","Explain a plan you have made and invite one opinion.",
"Say sorry once, properly, and then stop.","Tell someone what you need this weekend.",
"Explain why you said yes when you meant no.","Describe the relationship you actually want in one minute."
],
"pitch": [
"Pitch your product to a buyer in sixty seconds.","Ask a supplier for better terms.",
"Pitch a partnership to someone with a bigger audience.","Ask for a discount without apologizing for asking.",
"Pitch yourself for a job you are not obviously qualified for.","Ask someone for an introduction.",
"Pitch the reason someone should buy from you instead of the cheaper option.","Ask an expert for twenty minutes of their time.",
"Pitch a price increase to an existing customer.","Ask someone to invest in what you are building.",
"Pitch your brand story in thirty seconds.","Ask for a referral, specifically.",
"Pitch a service to a business owner who is busy.","Ask a landlord or lender for terms.",
"Pitch why now is the right time.","Ask someone to make a decision by a date.",
"Pitch the problem before you pitch the solution.","Ask for feedback on something you made.",
"Pitch to someone who already said no once.","Ask a friend for a favor that costs them real effort.",
"Pitch the smallest possible first step.","Ask someone what it would take to get a yes.",
"Pitch to someone who does not know your category.","Ask for a longer payment window.",
"Pitch your best product in one sentence.","Ask someone to hold you accountable.",
"Pitch a risky idea and name the risk first.","Ask a hard question early in a negotiation.",
"Pitch the value, not the features.","Ask for what you actually want, not the safe version."
],
"conflict": [
"Someone blames you for something that was not your fault. Respond.",
"Push back on a price you think is unfair.","Tell someone their work was not good enough.",
"Disagree with someone senior to you, respectfully.","Respond to an angry message without matching the anger.",
"Hold your position after someone pushes back twice.","Say no to a request for the third time.",
"Correct someone in front of other people, carefully.","Tell someone they crossed a line.",
"Respond to criticism that is partly true.","End a conversation that is going nowhere.",
"Ask for accountability without accusing.","Tell someone you are not going to do what they asked.",
"Handle being interrupted repeatedly.","Respond when someone questions your competence.",
"Deliver bad news to someone who will not take it well.","Refuse a request from someone who has helped you before.",
"Tell someone their excuse is not good enough.","Answer a hostile question calmly.",
"Say you need time before answering.","Call out a pattern, not just an incident.",
"Respond to a lowball offer.","Tell someone the deal is off.",
"Hold a deadline when someone asks for more time.","Address something you let slide three times.",
"Say the uncomfortable thing first, before they do.","Respond when someone takes credit for your work.",
"Refuse to be rushed into a decision.","Tell someone what will happen if this repeats."
]
}
hints={"party":"past_present_future","work":"what_so_what_now_what","relationship":"yes_because_therefore",
       "pitch":"problem_solution_benefit","conflict":"scqa"}
cards=[]; i=0
for cat, items in P.items():
    for t in items:
        i+=1
        cards.append({"id":"p%03d"%i,"text":t,"category":cat,"structure_hint":hints[cat]})
json.dump({"version":1,"authored_by":"automation-builder 2026-09-06, original prompts","prompts":cards},
          open("data/prompts.json","w"),indent=0,ensure_ascii=True)
print("prompts:",len(cards))
STRUCTS=[
 {"id":"point_reason_example","name":"Point, Reason, Example","use":"opinions","beats":["Point","Reason","Example"]},
 {"id":"what_so_what_now_what","name":"What, So What, Now What","use":"updates and status","beats":["What happened","Why it matters","What happens next"]},
 {"id":"problem_solution_benefit","name":"Problem, Solution, Benefit","use":"pitches and asks","beats":["Problem","Solution","Benefit"]},
 {"id":"past_present_future","name":"Past, Present, Future","use":"stories about yourself","beats":["Past","Present","Future"]},
 {"id":"scqa","name":"Situation, Complication, Question, Answer","use":"anything ending in a decision","beats":["Situation","Complication","Question and answer"]},
 {"id":"yes_because_therefore","name":"Yes, Because, Therefore","use":"answering a direct question without wandering","beats":["Yes or no","Because","Therefore"]}
]
json.dump({"version":1,"structures":STRUCTS},open("data/structures.json","w"),indent=0,ensure_ascii=True)
print("structures:",len(STRUCTS))
