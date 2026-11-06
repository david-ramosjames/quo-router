// Listed phone lines are the allowlist. Traffic for other numbers — including
// leftover webhooks — must not post to this firm's Slack.
//
//   node test-phone-line-filter.mjs

import { SRC } from "./test-harness.mjs";

function sliceFrom(startNeedle, endNeedle) {
  const start = SRC.indexOf(startNeedle);
  const end = SRC.indexOf(endNeedle, start);
  if (start < 0 || end < 0) throw new Error(`could not slice ${startNeedle}`);
  return SRC.slice(start, end);
}

const harness = [
  sliceFrom("function lastTenDigits", "function insertMentionsAfterTitle"),
  `export { blockedByPhoneLineFilter };`,
].join("\n\n");

const mod = await import("data:text/javascript," + encodeURIComponent(harness));

const firm = {
  id: "ramosjames",
  phoneLines: {
    "+15125373369": "RJL Main Line",
    "+19563137771": "RGV Number",
    "+15126010647": "Intake",
    "+15125005266": "RJL Outbound",
    "+15126300907": "RJL Transfers",
  },
};

const CASES = [
  { name: "Jane Flores Sona line is not a registered line", from: "+19455459003", to: "+15128773244", want: true },
  { name: "old Leads / other-tenant number is skipped", from: "+15127643037", to: "+17374972096", want: true },
  { name: "RJL Main inbound is routed", from: "+15551234567", to: "+15125373369", want: false },
  { name: "RJL Outbound is routed", from: "+15125005266", to: "+18007325246", want: false },
  { name: "RJL Transfers inbound is routed", from: "+12016471566", to: "+15126300907", want: false },
  { name: "no configured lines means route everything", from: "+19455459003", to: "+15128773244", want: false, firm: { id: "x", phoneLines: {} } },
];

let failed = 0;
for (const c of CASES) {
  const got = mod.blockedByPhoneLineFilter(c.firm || firm, c.from, c.to);
  const ok = got === c.want;
  if (!ok) failed++;
  console.log(`${ok ? "ok" : "FAIL"}  ${c.name}  (got ${got}, want ${c.want})`);
}
if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log(`\n${CASES.length}/${CASES.length} phone-line filter tests passed`);
