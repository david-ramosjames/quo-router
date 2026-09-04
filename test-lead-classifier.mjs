// Exercises the real classifyLead() prompt out of server.js against a set of
// labeled calls, so a change to the classifier can be checked before it ships.
//
//   OPENAI_API_KEY=sk-... node test-lead-classifier.mjs
//
// The deterministic guards ahead of the LLM (existing client / known business)
// are stubbed per-case, so what this measures is the prompt itself.

import { grab, llmPrelude, requireKey, activeProvider } from "./test-harness.mjs";

// The real classifier + the real text extraction and provider layer, with the
// surrounding helpers stubbed so each case can state its own premises.
const harness = [
  llmPrelude(),
  `let STUB = {};`,
  `function isActiveClient() { return !!STUB.activeClient; }`,
  `function isKnownBusiness() { return !!STUB.knownBusiness; }`,
  `function getContactName() { return STUB.contactName || null; }`,
  grab("extractField"),
  grab("extractText"),
  grab("classifyLead"),
  `export { classifyLead, setStub };`,
  `function setStub(s) { STUB = s || {}; }`,
].join("\n\n");

const mod = await import("data:text/javascript," + encodeURIComponent(harness));

const FIRM = {
  id: "test",
  name: "Ramos James Law",
  practiceArea: "personal injury",
  phoneLines: { "+15127643037": "Leads", "+15125373369": "RJL Main Line" },
};

const LEADS_LINE = "+15127643037";

// The call from the screenshot that was wrongly classified "not_lead": a wife
// calling on behalf of her husband about a rear-end collision.
const CORIA = `• Caller María de Jesús Coria requested an appointment regarding her husband Abraham Barriga's accident.
• The accident occurred on 08/12.
• Abraham Barriga was rear-ended in a vehicle accident.
• Liz Abad-Cruz, the injured party, reported chest pain and neck pain, and mentioned she had been to the hospital but still feels unwell.
• Liz stated that she has been experiencing pain for about 15 days.
• A police report was filed following the accident.
• Liz was taken to the hospital by her employer after the accident.`;

const CASES = [
  { name: "third party calling about husband's crash (the reported miss)", want: "qualified_lead", summary: CORIA },
  { name: "first-time caller, own rear-end collision", want: "qualified_lead",
    summary: "Caller was rear-ended on the highway last Tuesday and has back pain. Asked whether the firm could represent her. Police report was filed." },
  { name: "slip and fall at a grocery store", want: "qualified_lead",
    summary: "Caller slipped on a wet floor at a grocery store, injured her shoulder, and wants to know if she has a case." },
  { name: "Spanish-language new accident", want: "qualified_lead",
    summary: "La persona que llama fue atropellada por un carro y tiene dolor de espalda. Pregunta si el abogado puede ayudarla con su caso. Se hizo un reporte de policía." },
  { name: "mother calling for injured son", want: "qualified_lead",
    summary: "Caller's son was hit by a drunk driver on Saturday and is still in the hospital. She wants to schedule a consultation with an attorney." },
  { name: "former client, closed matter, new crash", want: "qualified_lead",
    contactName: "Maria Lopez", summary: "Caller was in a new car accident yesterday, separate from the matter the firm handled for her in 2023. She wants someone to look at it." },
  { name: "divorce inquiry (outside practice area)", want: "lead",
    summary: "Caller asked whether the firm handles divorce and child custody. Intake explained the firm only handles personal injury." },
  { name: "insurance adjuster on a claim", want: "not_lead",
    summary: "Adjuster from Progressive called regarding claim number 44-8812 to discuss the demand package and request updated medical records." },
  // Deliberately does NOT set activeClient: the guard would short-circuit it.
  // This checks the prompt itself still recognizes an open matter from wording.
  { name: "open client asking about settlement", want: "not_lead",
    contactName: "Robert Diaz 1540",
    summary: "Client called asking when his settlement check will be disbursed and whether his paralegal Jessica received the lien reduction." },
  { name: "medical provider records request", want: "not_lead",
    summary: "Caller from Austin Physical Therapy asking where to send billing records and whether the firm received the last statement." },
  { name: "opposing counsel", want: "not_lead",
    summary: "Attorney from another firm called about scheduling mediation and confirming the deposition date for the opposing party." },
  { name: "software sales pitch", want: "not_lead",
    summary: "Sales representative calling to offer case management software and asking to speak with the office manager about a demo." },
  { name: "wrong number", want: "not_lead",
    summary: "Caller was trying to reach a dentist office and had the wrong number." },
];

requireKey();
console.log(`Provider: ${activeProvider()}\n`);

let pass = 0;
const failures = [];

for (const c of CASES) {
  mod.setStub({ contactName: c.contactName, activeClient: c.activeClientNote });
  const payload = { data: { object: { summary: c.summary } } };
  const got = await mod.classifyLead(FIRM, payload, "+15124508938", LEADS_LINE, null);
  // Map the returned label back to the model's own vocabulary.
  const actual = got.isQualified ? "qualified_lead" : got.isLead ? "lead" : "not_lead";
  const ok = actual === c.want;
  ok ? pass++ : failures.push({ ...c, actual });
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}\n      want=${c.want} got=${actual} (label: ${got.label})`);
}

console.log(`\n${pass}/${CASES.length} passed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}: wanted ${f.want}, got ${f.actual}`);
}
process.exit(failures.length ? 1 : 0);
