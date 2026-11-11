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
  parsePhoneDutyTopic,
  resolvePhoneDutyRoster,
  applyDutyTopicFilter,
  dutySlackUserIdsFromSnapshot,
  summarizeAvailabilityMisses,
  noticeGroups,
  personRingsOnLine,
  FAST_HANGUP_SECONDS,
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
assert.match(block, /:warning: Jackie/);
assert.doesNotMatch(block, /<@U123ABC>/);
assert.doesNotMatch(block, /U456DEF/);
assert.doesNotMatch(block, /U789GHI/);
assert.equal(availableFromSnapshot(snapshot).length, 1);

const roster = parsePhoneStaffText(`timezone=America/Chicago
Andrea=UAAA111=US111 | Mon-Fri 08:00-17:00 intake
Jackie=UBBB222=US222 | after-hours
`);
assert.equal(roster.length, 2);
assert.equal(roster[0].windows[0].startMin, 8 * 60);
assert.equal(roster[0].windows[0].endMin, 17 * 60);
assert.deepEqual(roster[0].windows[0].days, [1, 2, 3, 4, 5]);
assert.equal(roster[1].afterHours, true);
assert.equal(roster[1].windows.length, 0);
assert.equal(roster[0].role, "intake");
assert.equal(roster[1].role, "after_hours");
const again = parsePhoneStaffText(formatPhoneStaffText(roster));
assert.equal(again[0].windows[0].startMin, 480);
assert.equal(again[1].afterHours, true);
assert.equal(again[0].role, "intake");

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
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "away" }).tag, false);
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "active", onCall: true }).tag, false);
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "active", statusText: "Lunch" }).state, "status");
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "active", statusText: "Lunch" }).tag, false);
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "active", statusText: "Translating" }).state, "status");
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "active", statusText: "Translating" }).tag, false);
assert.equal(classifyPhoneStaffMember(andrea, { ...dayOpts, presence: "active", statusText: "In a huddle" }).state, "status");
assert.equal(classifyPhoneStaffMember(andrea, {
  ...dayOpts,
  presence: "active",
  statusText: "",
  statusEmoji: ":speech_balloon:",
}).state, "status");
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
assert.match(longRing, /Rang for 20s/);
assert.match(longRing, /:warning: Stephany/);
assert.match(longRing, /:warning: Valeria/);
assert.match(longRing, /:no_entry_sign: Andrea Alvarado \(Break\)/);
assert.doesNotMatch(longRing, /<@/);
assert.doesNotMatch(longRing, /Jackie/);
assert.doesNotMatch(longRing, /Please call back/);

const midRing = formatAvailabilitySlackBlock(rosterNow, { ringSeconds: 7 });
const midLines = midRing.split("\n");
const availableAt = midLines.findIndex((line) => line.includes("Available to answer"));
assert.match(midLines[availableAt + 1], /:warning: Stephany/);
assert.doesNotMatch(midLines[availableAt + 1], /Valeria/);
const callbackAt = midLines.findIndex((line) => line.includes("Please call back"));
assert.match(midLines[callbackAt + 1], /:warning: Valeria/);
assert.match(midRing, /:no_entry_sign: Andrea Alvarado \(Break\)/);
assert.doesNotMatch(midRing, /<@/);

const hangup = formatAvailabilitySlackBlock(rosterNow, { ringSeconds: 3 });
assert.match(hangup, /Rang for 3s/);
assert.match(hangup, /Caller hung up, please call back:/);
assert.match(hangup, /:warning: Stephany/);
assert.match(hangup, /:warning: Valeria/);
assert.doesNotMatch(hangup, /<@/);
assert.equal(noticeGroups(rosterNow, 3).accountable.length, 0);
assert.equal(noticeGroups(rosterNow, FAST_HANGUP_SECONDS).accountable.length, 0);
assert.ok(noticeGroups(rosterNow, FAST_HANGUP_SECONDS + 1).accountable.some((r) => r.slackUserId === "UIMM111"));

// On-topic inactive → :warning: (counts for metrics; tagged last). Off-topic → :no_entry_sign:.
const roman = {
  name: "Roman",
  slackUserId: "UROM555",
  state: "inactive",
  ringAfterSeconds: 10,
  ringLineLabels: ["Leads", "RGV", "Intake"],
  tag: false,
};
const inactiveBlock = formatAvailabilitySlackBlock(
  [immediate, roman, onBreak],
  { ringSeconds: 9 },
);
assert.match(inactiveBlock, /Available to answer \(active, not on a call\):/);
assert.match(inactiveBlock, /:warning: Stephany/);
// Rang 9s < Roman's 10s delay → Please call back with warning (still counts later).
assert.match(inactiveBlock, /Please call back:/);
assert.match(inactiveBlock, /:warning: Roman \(inactive\)/);
assert.match(inactiveBlock, /:no_entry_sign: Andrea Alvarado \(Break\)/);
assert.doesNotMatch(inactiveBlock, /<@/);

const inactiveLong = formatAvailabilitySlackBlock(
  [immediate, roman],
  { ringSeconds: 20 },
);
assert.match(inactiveLong, /:warning: Roman \(inactive\)/);
assert.doesNotMatch(inactiveLong, /:no_entry_sign: Roman/);
assert.doesNotMatch(inactiveLong, /Please call back/);
const inactiveMiss = noticeGroups([immediate, roman], 20);
assert.ok(inactiveMiss.accountable.some((r) => r.slackUserId === "UROM555"));
assert.equal(inactiveMiss.couldAnswer.some((r) => r.slackUserId === "UROM555"), false);

const roleParsed = parsePhoneStaffText(`timezone=America/Chicago
Liz=ULIZ111=US111 | Mon-Fri 08:00-17:00 la primary
Claudia Chang=UVAL222=US222 | Mon-Fri 08:00-17:00 rings after 10s la secondary aliases=Claudia,Valeria Chang
Roman=UROM333=US333 | Mon-Fri 08:00-17:00 rings after 10s intake lines=Leads,RGV,Intake
`);
assert.equal(roleParsed[0].role, "la");
assert.equal(roleParsed[0].tier, "primary");
assert.equal(roleParsed[1].role, "la");
assert.equal(roleParsed[1].tier, "secondary");
assert.equal(roleParsed[1].ringAfterSeconds, 10);
assert.equal(roleParsed[1].name, "Claudia Chang");
assert.deepEqual(roleParsed[1].aliases, ["Claudia", "Valeria Chang"]);
assert.equal(roleParsed[2].role, "intake");
assert.deepEqual(roleParsed[2].ringLineLabels, ["Leads", "RGV", "Intake"]);
assert.doesNotMatch(hangup, /Available to answer/);
assert.match(hangup, /:no_entry_sign: Andrea Alvarado \(Break\)/);
assert.doesNotMatch(hangup, /<@UBRK333>/);
assert.doesNotMatch(hangup, /Jackie/);

const delayedParsed = parsePhoneStaffText("Valeria=UDEL222=US222 | Mon-Fri 08:00-17:00 rings after 10s");
assert.equal(delayedParsed[0].ringAfterSeconds, 10);
assert.equal(delayedParsed[0].windows[0].startMin, 480);
assert.match(formatPhoneStaffText(delayedParsed), /rings after 10s/);
assert.match(formatPhoneStaffText(roleParsed), /lines=Leads,RGV,Intake/);
assert.match(formatPhoneStaffText(roleParsed), /aliases=Claudia,Valeria Chang/);

assert.equal(personRingsOnLine(roleParsed[2], "Leads"), true);
assert.equal(personRingsOnLine(roleParsed[2], "RGV Number"), true);
assert.equal(personRingsOnLine(roleParsed[2], "RJL Main Line"), false);
assert.equal(personRingsOnLine(roleParsed[0], "RJL Main Line"), true);

const mainLineMiss = noticeGroups(
  [
    { ...immediate, ringLineLabels: [] },
    { name: "Roman", slackUserId: "UROM333", state: "available", ringAfterSeconds: 10, ringLineLabels: ["Leads", "RGV", "Intake"] },
  ],
  20,
  "RJL Main Line",
);
assert.ok(mainLineMiss.accountable.some((r) => r.slackUserId === "UIMM111"));
assert.equal(mainLineMiss.accountable.some((r) => r.slackUserId === "UROM333"), false);
assert.ok(mainLineMiss.context.some((r) => r.slackUserId === "UROM333" && /does not ring/i.test(r.statusText)));

const leadsMiss = noticeGroups(
  [
    { name: "Roman", slackUserId: "UROM333", state: "available", ringAfterSeconds: 10, ringLineLabels: ["Leads", "RGV", "Intake"] },
  ],
  20,
  "Leads",
);
assert.ok(leadsMiss.accountable.some((r) => r.slackUserId === "UROM333"));

const topic = parsePhoneDutyTopic(
  "Inbound @Andrea Alvarado | Outbound @Roman | Attorney @Michael Tucker | LAs @Liz Abad-Cruz @Stephany Guerra @Claudia Chang @Valeria Flores",
);
assert.deepEqual(topic.inbound, ["Andrea Alvarado"]);
assert.deepEqual(topic.outbound, ["Roman"]);
assert.deepEqual(topic.attorney, ["Michael Tucker"]);
assert.deepEqual(topic.las, ["Liz Abad-Cruz", "Stephany Guerra", "Claudia Chang", "Valeria Flores"]);

const claudiaAliasRoster = resolvePhoneDutyRoster(topic, {}, roleParsed.concat([
  { name: "Andrea Alvarado", slackUserId: "UAND111", ringLineLabels: ["Leads", "RGV", "Intake"] },
  { name: "Liz Abad-Cruz", slackUserId: "ULIZ111" },
  { name: "Stephany Guerra", slackUserId: "USTE111" },
  { name: "Valeria Flores", slackUserId: "UFLO111" },
]));
assert.ok(claudiaAliasRoster.las.includes("UVAL222"));
assert.ok(claudiaAliasRoster.las.includes("UFLO111"));
assert.equal(claudiaAliasRoster.las.filter((id) => id === "UVAL222").length, 1);
const claudiaOnlyTopic = parsePhoneDutyTopic("LAs @Claudia @Valeria Chang");
const claudiaOnlyRoster = resolvePhoneDutyRoster(claudiaOnlyTopic, {}, roleParsed);
assert.deepEqual(claudiaOnlyRoster.las, ["UVAL222"]);

const idTopic = parsePhoneDutyTopic(
  "Inbound <@UAND111> | Outbound <@UROM222> | Attorney <@UATT333> | LAs <@ULIZ444> <@USTE555>",
);
assert.deepEqual(idTopic.inbound, ["UAND111"]);
assert.deepEqual(idTopic.las, ["ULIZ444", "USTE555"]);

// Slack topics often include the display-name alias after the user id.
const aliasTopic = parsePhoneDutyTopic(
  "Inbound <@UAND111|Andrea Alvarado> | Outbound <@UROM222|Roman> | LAs <@ULIZ444|Liz Abad-Cruz> <@USTE555|Stephany Guerra>",
);
assert.deepEqual(aliasTopic.inbound, ["UAND111"]);
assert.deepEqual(aliasTopic.outbound, ["UROM222"]);
assert.deepEqual(aliasTopic.las, ["ULIZ444", "USTE555"]);
const aliasRoster = resolvePhoneDutyRoster(aliasTopic, new Map());
assert.ok(aliasRoster.answerIds.has("UAND111"));
assert.ok(aliasRoster.answerIds.has("ULIZ444"));
assert.ok(aliasRoster.answerIds.has("UROM222")); // outbound still tags

const users = new Map([
  ["andrea alvarado", "UAND111"],
  ["andrea", "UAND111"],
  ["roman", "UROM222"],
  ["liz abad-cruz", "ULIZ444"],
  ["stephany guerra", "USTE555"],
  ["claudia chang", "U08PUFTF7HA"],
  ["claudia", "U08PUFTF7HA"],
  ["valeria flores", "UFLO666"],
  ["jissela", "UJIS888"],
]);
const dutyRoster = resolvePhoneDutyRoster(topic, users);
assert.equal(dutyRoster.hasRoster, true);
assert.ok(dutyRoster.answerIds.has("UAND111"));
assert.ok(dutyRoster.answerIds.has("ULIZ444"));
assert.ok(dutyRoster.answerIds.has("U08PUFTF7HA"));
assert.ok(dutyRoster.answerIds.has("UFLO666"));
assert.ok(dutyRoster.answerIds.has("UROM222")); // outbound still available/tags
assert.equal(dutyRoster.answerIds.has("UJIS888"), false); // not on topic

const jisselaActive = { name: "Jissela", slackUserId: "UJIS888", state: "available", tag: true };
const lizActive = { name: "Liz", slackUserId: "ULIZ444", state: "available", tag: true };
const romanActive = { name: "Roman", slackUserId: "UROM222", state: "available", tag: true };
const filtered = applyDutyTopicFilter([jisselaActive, lizActive, romanActive], dutyRoster, { enforce: true });
assert.equal(filtered.find((r) => r.slackUserId === "UJIS888").state, "off_topic");
assert.equal(filtered.find((r) => r.slackUserId === "UJIS888").statusText, "not on today's topic");
assert.equal(filtered.find((r) => r.slackUserId === "UJIS888").tag, false);
assert.equal(filtered.find((r) => r.slackUserId === "UROM222").state, "available");
assert.equal(filtered.find((r) => r.slackUserId === "UROM222").dutySection, "outbound");
assert.equal(filtered.find((r) => r.slackUserId === "ULIZ444").state, "available");
assert.equal(filtered.find((r) => r.slackUserId === "ULIZ444").tag, true);

const topicBlock = formatAvailabilitySlackBlock(filtered, { ringSeconds: 20 });
assert.match(topicBlock, /:warning: Liz/);
assert.match(topicBlock, /:warning: Roman \(outbound\)/);
assert.match(topicBlock, /:no_entry_sign: Jissela \(not on today's topic\)/);
const offTopicMiss = noticeGroups(filtered, 20);
assert.equal(offTopicMiss.accountable.some((r) => r.slackUserId === "UJIS888"), false);
assert.ok(offTopicMiss.accountable.some((r) => r.slackUserId === "UROM222"));

assert.deepEqual(
  dutySlackUserIdsFromSnapshot(filtered, dutyRoster, { enforce: true }).sort(),
  [...dutyRoster.answerIds].sort(),
);

const missSummary = summarizeAvailabilityMisses([
  {
    available_slack_user_ids: ["ULIZ444", "UJIS888"],
    duty_slack_user_ids: ["UAND111", "ULIZ444", "USTE555", "U08PUFTF7HA", "UFLO666"],
    staff_snapshot: [
      { slackUserId: "UAND111", name: "Andrea" },
      { slackUserId: "ULIZ444", name: "Liz" },
      { slackUserId: "USTE555", name: "Stephany" },
      { slackUserId: "U08PUFTF7HA", name: "Claudia Chang" },
      { slackUserId: "UFLO666", name: "Valeria Flores" },
      { slackUserId: "UJIS888", name: "Jissela" },
    ],
  },
]);
assert.equal(missSummary.availableButDidNotAnswerCount, 1); // Jissela off topic → ignored
assert.equal(missSummary.byUser.find((u) => u.slackUserId === "ULIZ444").count, 1);
assert.equal(missSummary.byUser.find((u) => u.slackUserId === "USTE555").count, 0);
assert.equal(missSummary.byUser.find((u) => u.slackUserId === "USTE555").onDuty, true);
assert.equal(missSummary.byUser.some((u) => u.slackUserId === "UJIS888"), false);

console.log("test-phone-staff: ok");
