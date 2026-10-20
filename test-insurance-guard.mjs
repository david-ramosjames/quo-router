// Deterministic checks for inbound insurance callers. These must never land
// in #lead-calls, including when Sona or voicemail took the call.
//
//   node test-insurance-guard.mjs

import { SRC } from "./test-harness.mjs";

function sliceFrom(startNeedle, endNeedle) {
  const start = SRC.indexOf(startNeedle);
  const end = SRC.indexOf(endNeedle, start);
  if (start < 0 || end < 0) throw new Error(`could not slice ${startNeedle}`);
  return SRC.slice(start, end);
}

const harness = [
  `const BUCKET_LABEL = { insurance: "Excluded · Insurance company" };`,
  sliceFrom("const MAJOR_INSURER", "const FILTERING_BUCKETS"),
  sliceFrom("const FILTERING_BUCKETS", "function classificationFromReply"),
  `export { looksLikeInsuranceCompanyCall, looksLikeInboundInsuranceCaller, mentionsOwnFirm, holdUnverifiedCall };`,
].join("\n\n");

const mod = await import("data:text/javascript," + encodeURIComponent(harness));

const AAA = `• Vanessa Hansken from AAA Insurance called to leave a message for Matt Ray regarding an existing client, Juanita Zuleika. The caller provided her contact information and claim number to follow up on the client's reported injuries and request an email address.`;
const COUNTY_MUTUAL = `• An insurance representative called on behalf of American County Mutual Fire Insurance to request confirmation regarding reaching out to a client about property damage.`;
const HAS_STATE_FARM = `Caller was rear-ended on the highway last Tuesday and has back pain. She has State Farm insurance and a police report was filed.`;
const ADJUSTER = `Adjuster from Progressive called regarding claim number 44-8812 to discuss the demand package and request updated medical records.`;
const OUTBOUND_STATE_FARM = `The Legal Assistant initiated a new claim with State Farm. The claim is located in Texas.`;
const PROVIDER = `Caller from Austin Physical Therapy asking where to send billing records and whether the firm received the last statement about insurance.`;
const OTHER_LAW_FIRM = `Claudia from Ronald James Law Firm called and left a message. The call was in response to a missed call from +16504223661. Claudia provided a callback number: (512) 537-3369.`;
const FIRM = { name: "Ramos James Law" };

const CASES = [
  { name: "AAA Insurance leaving a Sona message", fn: "looksLikeInsuranceCompanyCall", arg: AAA, want: true },
  { name: "insurance representative on behalf of a carrier", fn: "looksLikeInsuranceCompanyCall", arg: COUNTY_MUTUAL, want: true },
  { name: "Progressive adjuster on a claim", fn: "looksLikeInsuranceCompanyCall", arg: ADJUSTER, want: true },
  { name: "injured caller who has State Farm is still a lead", fn: "looksLikeInsuranceCompanyCall", arg: HAS_STATE_FARM, want: false },
  { name: "medical provider mentioning insurance is not a carrier", fn: "looksLikeInsuranceCompanyCall", arg: PROVIDER, want: false },
  { name: "outbound staff filing a State Farm claim", fn: "looksLikeInsuranceCompanyCall", args: [OUTBOUND_STATE_FARM, true], want: true },
  { name: "misheard Ramos James is not a carrier", fn: "looksLikeInsuranceCompanyCall", args: [OTHER_LAW_FIRM, true], want: false },
  { name: "Ronald James Law Firm is this firm", fn: "mentionsOwnFirm", args: [OTHER_LAW_FIRM, FIRM], want: true },
  { name: "exact firm name is this firm", fn: "mentionsOwnFirm", args: ["Liz from Ramos James Law left a message for the client.", FIRM], want: true },
];

let pass = 0;
const failures = [];

for (const c of CASES) {
  const args = c.args || [c.arg];
  const got = mod[c.fn](...args);
  const ok = got === c.want;
  ok ? pass++ : failures.push({ ...c, got });
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}\n      want=${c.want} got=${got}`);
}

const sona = { answeredBy: "SY123abc" };
const voicemail = { answeredBy: "" };
const human = { answeredBy: "U123", userId: "U123" };

const HOLD = [
  {
    name: "Sona insurance stays excluded, not a No Contact lead",
    decision: { isLead: false, isQualified: false, bucket: "insurance", label: "Excluded · Insurance company" },
    opts: { sona: true, cached: sona, summary: AAA },
    want: { isLead: false, bucket: "insurance" },
  },
  {
    name: "voicemail insurance stays excluded",
    decision: { isLead: false, isQualified: false, bucket: "insurance", label: "Excluded · Insurance company" },
    opts: { sona: false, cached: voicemail, summary: COUNTY_MUTUAL },
    want: { isLead: false, bucket: "insurance" },
  },
  {
    name: "Sona existing_client that is actually AAA Insurance is reclassified",
    decision: { isLead: false, isQualified: false, bucket: "existing_client", label: "Excluded · Existing client" },
    opts: { sona: true, cached: sona, summary: AAA },
    want: { isLead: false, bucket: "insurance" },
  },
  {
    name: "Sona spam is still held as No Contact",
    decision: { isLead: false, isQualified: false, bucket: "spam", label: "Excluded · Spam / robocall" },
    opts: { sona: true, cached: sona, summary: "This is a robocall about your car's extended warranty." },
    want: { isLead: true, bucket: null },
  },
  {
    name: "human-answered insurance stays excluded",
    decision: { isLead: false, isQualified: false, bucket: "insurance", label: "Excluded · Insurance company" },
    opts: { sona: false, cached: human, summary: ADJUSTER },
    want: { isLead: false, bucket: "insurance" },
  },
];

for (const c of HOLD) {
  const got = mod.holdUnverifiedCall(c.decision, c.opts);
  const ok = got.isLead === c.want.isLead && got.bucket === c.want.bucket;
  ok ? pass++ : failures.push({ ...c, got });
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}\n      want isLead=${c.want.isLead} bucket=${c.want.bucket} got isLead=${got.isLead} bucket=${got.bucket} label=${got.label}`);
}

const total = CASES.length + HOLD.length;
console.log(`\n${pass}/${total} passed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}`);
  process.exit(1);
}
