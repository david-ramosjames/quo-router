import assert from "node:assert/strict";
import {
  normalizePhoneStaff,
  parsePhoneStaffText,
  formatPhoneStaffText,
  formatAvailabilitySlackBlock,
  availableFromSnapshot,
} from "./phone-staff.js";

const staff = normalizePhoneStaff({
  phoneStaff: [
    { name: "Jackie", slackUserId: "U123ABC", quoUserId: "US999" },
    { name: "Bad", slackUserId: "not-an-id" },
    { slackUserId: "U456DEF" },
  ],
});
assert.equal(staff.length, 2);
assert.equal(staff[0].name, "Jackie");
assert.equal(staff[1].name, "U456DEF");

const parsed = parsePhoneStaffText(`Jackie=U123ABC=US999
Legal Assistant,U456DEF,US888
`);
assert.equal(parsed.length, 2);
assert.equal(parsed[1].name, "Legal Assistant");
assert.equal(formatPhoneStaffText(parsed).split("\n").length, 2);

const snapshot = [
  { name: "Jackie", slackUserId: "U123ABC", state: "available" },
  { name: "LA", slackUserId: "U456DEF", state: "on_call" },
  { name: "Away", slackUserId: "U789GHI", state: "away" },
];
const block = formatAvailabilitySlackBlock(snapshot);
assert.match(block, /available but did not answer/);
assert.match(block, /<@U123ABC>/);
assert.doesNotMatch(block, /did not answer:.*U456DEF/);
assert.equal(availableFromSnapshot(snapshot).length, 1);

console.log("test-phone-staff: ok");
