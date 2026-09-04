// Exercises the real detectCallbackRequest() prompt out of server.js against
// labeled calls, so tuning the "does this client need a call back" bar can be
// checked before it ships.
//
//   ANTHROPIC_API_KEY=sk-ant-... node test-callback-detector.mjs
//
// Only "callback_owed" tags the app. Everything else must not.

import fs from "node:fs";

const src = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");

function grab(name) {
  const re = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${name} from server.js`);
  return m[0];
}

const harness = [
  `const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;`,
  // Retry behavior isn't under test; go straight to fetch.
  `const fetchWithRetry = (url, opts) => fetch(url, opts);`,
  grab("detectCallbackRequest"),
  `export { detectCallbackRequest };`,
].join("\n\n");

const mod = await import("data:text/javascript," + encodeURIComponent(harness));
const FIRM = { id: "test" };

// tag: true  → must be treated as a call back owed by the firm
// tag: false → must NOT tag
//
// handleCallSummary no longer runs the detector on outbound calls at all, so
// the outbound cases below are defense in depth: the prompt should reject them
// on its own even though the call site already does.
const CASES = [
  // --- reported false positives ----------------------------------------
  { tag: false, name: "the firm asked the CLIENT to call back (the inverse)",
    text: `Roman from Ramos James Law called and requested a return call.` },
  { tag: false, name: "attorney's own outbound call, leftover work in hand",
    text: `Ryan at Ramos James confirmed that the check from the defense attorney should arrive next week, definitely by Friday. Ryan will prepare a document for Andre to sign once the check is deposited. Andre mentioned he found Ramos James on Google after being turned down by other firms. Ryan emphasized the importance of maintaining good relationships with referring attorneys. Andre agreed to sign the document regarding the referral fee. Andre expressed concerns about the referral fee and indicated he wants to negotiate for a better amount.` },
  { tag: false, name: "left a message for the client to call the office",
    text: `Legal assistant left a message for the client asking her to call the office back about scheduling her IME.` },
  { tag: false, name: "outbound intake gathering info, client owes their ID",
    text: `Roman from Ramos James Law reached out regarding a case for Ruben and his wife, Gallegos. The caller provided their home address as 683 Billowing Way, Kyle, Texas, 78640. The caller confirmed they have Blue Cross Blue Shield insurance, with no Medicare or Medicaid. The caller mentioned they have car insurance and previously sent that information. The caller confirmed their wife will be the emergency contact for the case. The caller initially thought they sent a copy of their driver's license but later realized they had not. The Intake Specialist requested the front and back of the caller's driver's license to be sent. The caller agreed to send their driver's license and also needs to find and send their wife's ID.` },
  { tag: false, name: "client asked for a document, firm sending it by text and email",
    text: `Liz Abad-Cruz from Ramos James Law spoke with client Stephanie Castro regarding her contract and medical care. Stephanie requested a copy of her contract to be sent via both text and email.` },

  // --- other things that must not tag ----------------------------------
  { tag: false, name: "client will send accident photos",
    text: `Client called to confirm he received the intake packet. He will send photos of the accident scene and the other driver's insurance card later today.` },
  { tag: false, name: "appointment confirmation",
    text: `Paralegal confirmed the client's appointment for Thursday at 2pm and reminded him to bring his medical records.` },
  { tag: false, name: "status update given, client satisfied",
    text: `Paralegal called the client to let her know the demand package was sent to the adjuster. Client said thank you and had no other questions.` },
  { tag: false, name: "client needs to sign and return a form",
    text: `Client was sent a HIPAA authorization. She said she will print it, sign it, and mail it back this week.` },
  { tag: false, name: "new lead intake completed",
    text: `Intake specialist collected the details of a rear-end collision from a new caller, including date of loss and treating hospital, and scheduled a consultation for Monday.` },
  { tag: false, name: "insurance adjuster",
    text: `Adjuster from GEICO called about claim 88-2201 to confirm receipt of the demand and request the updated medical bills.` },
  { tag: false, name: "medical provider billing",
    text: `Billing office from Austin Ortho called to ask where to send the outstanding statement for the client's treatment.` },
  { tag: false, name: "frustrated client whose issue was resolved on the call",
    text: `Client was upset about how long the case is taking. The paralegal walked her through the current status, explained the remaining steps and the expected timeline, and she said that answered her concern.` },

  // --- genuine call backs ----------------------------------------------
  { tag: true, name: "client asked for their attorney, who was unavailable",
    text: `Client called asking to speak with his attorney about the settlement offer he received. The attorney was in a deposition. Reception took a message.` },
  { tag: true, name: "client has called repeatedly with no return call",
    text: `Client says this is the third time she has called this week and no one has called her back about her case. She is asking someone to please call her.` },
  { tag: true, name: "message taken for the paralegal to call",
    text: `Caller asked that her paralegal Jessica call her back this afternoon regarding her medical treatment authorization.` },
  { tag: true, name: "substantive question intake could not answer",
    text: `Client asked whether the firm will cover the cost of her upcoming MRI and who pays the lien if the case settles for less than the bills. The intake specialist did not know and said a paralegal would call her back.` },
  { tag: true, name: "client asks the attorney to call about accepting an offer",
    text: `Client called in to give his employer information. Before hanging up he said he needs to talk to the attorney directly about whether to accept the offer, and asked the attorney to call him.` },
  { tag: true, name: "unresolved complaint needing an attorney decision",
    text: `Client expressed frustration about her treatment and the lack of support from the firm regarding her cast and care. She was told last week to handle her care independently due to the firm's reluctance to cover costs, which she found unfair. She wants someone to explain the firm's position on covering her cast removal.` },
];

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set — this test calls the real model. Aborting.");
  process.exit(2);
}

let pass = 0;
const falsePositives = [];
const falseNegatives = [];

for (const c of CASES) {
  const got = await mod.detectCallbackRequest(FIRM, c.text);
  const ok = got === c.tag;
  if (ok) pass++;
  else (got ? falsePositives : falseNegatives).push(c.name);
  console.log(`${ok ? "PASS" : "FAIL"}  [${c.tag ? "should tag" : "should NOT tag"}] ${c.name}`);
}

console.log(`\n${pass}/${CASES.length} passed`);
if (falsePositives.length) {
  console.log(`\nFalse positives (tagged when it should not have) — these are the ones that create junk tasks:`);
  for (const n of falsePositives) console.log(`  - ${n}`);
}
if (falseNegatives.length) {
  console.log(`\nFalse negatives (missed a real call back):`);
  for (const n of falseNegatives) console.log(`  - ${n}`);
}
process.exit(pass === CASES.length ? 0 : 1);
