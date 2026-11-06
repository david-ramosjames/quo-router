import assert from "node:assert/strict";
import {
  normalizePhoneStaff,
  parsePhoneStaffText,
  formatPhoneStaffText,
  formatAvailabilitySlackBlock,
  availableFromSnapshot,
  classifyPhoneStaffMember,
  isOfficeCovered,
  hoursAreConfigured,
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
  { name: "Jackie", slackUserId: "U123ABC", state: "available", tag: true },
  { name: "LA", slackUserId: "U456DEF", state: "on_call", tag: false },
  { name: "Away", slackUserId: "U789GHI", state: "away", tag: false },
];
const block = formatAvailabilitySlackBlock(snapshot);
assert.match(block, /Available to answer \(active, not on a call\)/);
assert.match(block, /<@U123ABC>/);
assert.doesNotMatch(block, /U456DEF/);
assert.doesNotMatch(block, /U789GHI/);
assert.equal(availableFromSnapshot(snapshot).length, 1);

const roster = parsePhoneStaffText(`timezone=America/Chicago
Andrea=UAAA111=US111 | Mon-Fri 08:00-17:00
Jackie=UBBB222=US222 | after-hours
`);
assert.equal(roster.length, 2);
assert.equal(roster[0].windows[0].startMin, 8 * 60);
assert.equal(roster[0].windows[0].endMin, 17 * 60);
assert.deepEqual(roster[0].windows[0].days, [1, 2, 3, 4, 5]);
assert.equal(roster[1].afterHours, true);
assert.equal(roster[1].windows.length, 0);
const again = parsePhoneStaffText(formatPhoneStaffText(roster));
assert.equal(again[0].windows[0].startMin, 480);
assert.equal(again[1].afterHours, true);

const bad = parsePhoneStaffText("Andrea=UAAA111=US111 | everyday 8-5");
assert.match(bad[0].scheduleError, /Could not read hours/);

const duringShift = new Date("2026-11-06T14:30:00Z"); // Fri 08:30 CT
const afterClose = new Date("2026-11-06T23:30:00Z"); // Fri 17:30 CT
const saturday = new Date("2026-11-07T16:00:00Z"); // Sat 10:00 CT
assert.equal(hoursAreConfigured(roster), true);
assert.equal(isOfficeCovered(roster, duringShift), true);
assert.equal(isOfficeCovered(roster, afterClose), false);

const andrea = roster[0];
const jackie = roster[1];
const dayOpts = { now: duringShift, officeCovered: true, hoursConfigured: true };
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "active" }).tag, true);
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "away" }).state, "inactive");
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "away" }).tag, true);
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "active", onCall: true }).tag, false);
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "active", statusText: "Lunch" }).state, "status");
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "active", statusText: "Lunch" }).tag, false);
assert.equal(classifyPhoneStaffMember(jackie, { ...dayOpts, presence: "active" }).tag, false);
assert.equal(classifyPhoneStaffMember(jackie, { ...dayOpts, presence: "active" }).statusText, "after hours only");

const nightOpts = { now: afterClose, officeCovered: false, hoursConfigured: true };
assert.equal(classifyPhoneStaffMember(andrea, { ...nightOpts, presence: "active" }).tag, false);
assert.equal(classifyPhoneStaffMember(andrea, { ...nightOpts, presence: "active" }).state, "off_shift");
assert.equal(classifyPhoneStaffMember(jackie, { ...nightOpts, presence: "away" }).tag, true);
assert.equal(classifyPhoneStaffMember(jackie, { ...nightOpts, presence: "away" }).afterHoursDuty, true);
assert.equal(classifyPhoneStaffMember(jackie, { ...nightOpts, presence: "active", statusText: "Out of office" }).tag, false);
assert.equal(classifyPhoneStaffMember(andrea, { now: saturday, officeCovered: false, hoursConfigured: true, presence: "active" }).tag, false);

const nightBlock = formatAvailabilitySlackBlock([
  classifyPhoneStaffMember(andrea, { ...nightOpts, presence: "active" }),
  classifyPhoneStaffMember(jackie, { ...nightOpts, presence: "away" }),
]);
assert.match(nightBlock, /Available to answer \(active, not on a call\)/);
assert.match(nightBlock, /<@UBBB222>/);
assert.doesNotMatch(nightBlock, /UAAA111/);

const immediate = { name: "Stephany", slackUserId: "UIMM111", state: "available", ringAfterSeconds: 0 };
const delayed = { name: "Valeria", slackUserId: "UDEL222", state: "available", ringAfterSeconds: 10 };
const onBreak = { name: "Andrea Alvarado", slackUserId: "UBRK333", state: "status", statusText: "Break", ringAfterSeconds: 10 };
const jackieDay = { name: "Jackie", slackUserId: "UJAC444", state: "off_shift", statusText: "after hours only", ringAfterSeconds: 0 };
const rosterNow = [immediate, delayed, onBreak, jackieDay];

const longRing = formatAvailabilitySlackBlock(rosterNow, { ringSeconds: 20 });
assert.match(longRing, /Available to answer \(active, not on a call\):.*<@UIMM111>.*<@UDEL222>/);
assert.match(longRing, /Andrea Alvarado \(Break\)/);
assert.doesNotMatch(longRing, /<@UBRK333>/);
assert.doesNotMatch(longRing, /Jackie/);
assert.doesNotMatch(longRing, /Please call back/);

const midRing = formatAvailabilitySlackBlock(rosterNow, { ringSeconds: 7 });
const availableLine = midRing.split("\n").find((line) => line.includes("Available to answer"));
assert.match(availableLine, /<@UIMM111>/);
assert.doesNotMatch(availableLine, /UDEL222/);
assert.match(midRing, /Please call back:.*<@UDEL222>/);
assert.match(midRing, /Andrea Alvarado \(Break\)/);
assert.doesNotMatch(midRing, /<@UBRK333>/);

const hangup = formatAvailabilitySlackBlock(rosterNow, { ringSeconds: 3 });
assert.match(hangup, /Caller hung up, please call back:.*<@UIMM111>.*<@UDEL222>/);
assert.doesNotMatch(hangup, /Available to answer/);
assert.match(hangup, /Andrea Alvarado \(Break\)/);
assert.doesNotMatch(hangup, /<@UBRK333>/);
assert.doesNotMatch(hangup, /Jackie/);

const delayedParsed = parsePhoneStaffText("Valeria=UDEL222=US222 | Mon-Fri 08:00-17:00 rings after 10s");
assert.equal(delayedParsed[0].ringAfterSeconds, 10);
assert.equal(delayedParsed[0].windows[0].startMin, 480);
assert.match(formatPhoneStaffText(delayedParsed), /rings after 10s/);

console.log("test-phone-staff: ok");
