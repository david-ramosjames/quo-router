import assert from "node:assert/strict";
import {
  normalizeCallbackEscalation,
  isBusinessHours,
  nextLeadCallsAssignees,
  nextLegalAssistantAssignees,
  formatCallbackRequest,
  formatManagerEscalation,
  replyMeansStop,
  reactionMeansStop,
} from "./callback-escalation.js";

const cfg = normalizeCallbackEscalation({
  managers: ["UJON1", "UJAY2"],
  intervalSeconds: 50,
});
assert.equal(cfg.intervalSeconds, 50);
assert.deepEqual(cfg.managers, ["UJON1", "UJAY2"]);
assert.equal(cfg.businessStartMin, 7 * 60);
assert.equal(cfg.businessEndMin, 18 * 60);

const friMorning = new Date("2026-11-06T14:30:00Z"); // Fri 08:30 CT
const friNight = new Date("2026-11-06T23:30:00Z"); // Fri 17:30 CT — still before 6pm
const friLate = new Date("2026-11-07T00:30:00Z"); // Fri 18:30 CT
const saturday = new Date("2026-11-07T16:00:00Z");
assert.equal(isBusinessHours(cfg, friMorning), true);
assert.equal(isBusinessHours(cfg, friNight), true);
assert.equal(isBusinessHours(cfg, friLate), false);
assert.equal(isBusinessHours(cfg, saturday), false);

const firm = {
  phoneStaff: [
    { name: "Stephany", slackUserId: "USTEPH", role: "la", tier: "primary" },
    { name: "Liz", slackUserId: "ULIZ", role: "la", tier: "primary" },
    { name: "Jissela", slackUserId: "UJIS", role: "la", tier: "primary" },
    { name: "Valeria", slackUserId: "UVAL", role: "la", tier: "secondary" },
    { name: "Claudia", slackUserId: "UCLAUD", role: "la", tier: "secondary" },
    { name: "Roman", slackUserId: "UROM", role: "intake" },
    { name: "Andrea", slackUserId: "UAND", role: "intake" },
  ],
  callbackEscalation: cfg,
};

const allFree = firm.phoneStaff.map((p) => ({ ...p, state: "available", tag: true }));

const lead0 = nextLeadCallsAssignees(firm, allFree, { step: 0, rotation: 0 });
assert.equal(lead0.kind, "request");
assert.equal(lead0.people.length, 2);
assert.equal(lead0.people.filter((p) => p.role === "la").length, 1);
assert.equal(lead0.people.filter((p) => p.role === "intake").length, 1);

const noIntakeSnap = allFree.filter((p) => p.role !== "intake");
const leadNoIntake = nextLeadCallsAssignees(firm, noIntakeSnap, { step: 0, rotation: 0 });
assert.equal(leadNoIntake.people.length, 2);
assert.equal(leadNoIntake.people.every((p) => p.role === "la"), true);

let used = new Set(lead0.usedIds);
const lead1 = nextLeadCallsAssignees(firm, allFree, { usedIds: used, step: 1, rotation: 1 });
assert.equal(lead1.kind, "request");
assert.equal(lead1.people.length, 2);
used = new Set(lead1.usedIds);

const lead2 = nextLeadCallsAssignees(firm, allFree, { usedIds: used, step: 2, rotation: 2 });
assert.equal(lead2.kind, "request");
assert.equal(lead2.people.length, 1);
assert.equal(lead2.people[0].role, "la");
used = new Set(lead2.usedIds);

// Exhaust LAs then managers
while (true) {
  const next = nextLeadCallsAssignees(firm, allFree, { usedIds: used, step: 10, rotation: 0 });
  if (next.kind !== "request") {
    assert.equal(next.kind, "managers");
    assert.ok(next.people.some((p) => p.slackUserId === "UJON1"));
    assert.match(next.message, /paralegal or attorney/);
    break;
  }
  used = new Set(next.usedIds);
}

const la0 = nextLegalAssistantAssignees(firm, allFree, { step: 0, rotation: 0 });
assert.equal(la0.kind, "request");
assert.equal(la0.people.length, 2);
assert.equal(la0.people.every((p) => p.role === "la"), true);
assert.equal(la0.people.every((p) => p.tier !== "secondary"), true);

const onlySecondary = allFree.map((p) => (
  p.tier === "primary" ? { ...p, state: "status", statusText: "Lunch", tag: false } : p
));
const laFallback = nextLegalAssistantAssignees(firm, onlySecondary, { step: 0, rotation: 0 });
assert.equal(laFallback.people.length, 2);
assert.equal(laFallback.people.every((p) => p.tier === "secondary"), true);

assert.match(formatCallbackRequest(la0.people), /:rotating_light: <@.+> Please call back now/);
assert.match(formatCallbackRequest(la0.people), /handling/);
assert.match(formatCallbackRequest(la0.people), /calling/);
assert.match(formatCallbackRequest(la0.people), /white_check_mark/);
assert.match(formatManagerEscalation(cfg.managers.map((id) => ({ slackUserId: id })), "No response has been received."), /No response/);
assert.equal(replyMeansStop("handling this one"), true);
assert.equal(replyMeansStop("not needed"), true);
assert.equal(replyMeansStop("calling now"), true);
assert.equal(replyMeansStop("looking into it"), false);
assert.equal(reactionMeansStop("white_check_mark"), true);
assert.equal(reactionMeansStop("thumbsup"), false);

// Inactive people are asked only after active options in that role are used.
const mixedSnap = allFree.map((p) => (
  p.slackUserId === "USTEPH" || p.slackUserId === "ULIZ" || p.slackUserId === "UJIS"
    ? { ...p, state: "inactive", tag: false }
    : p
));
const laActiveFirst = nextLegalAssistantAssignees(firm, mixedSnap, { step: 0, rotation: 0 });
assert.equal(laActiveFirst.people.length, 2);
assert.equal(laActiveFirst.people.every((p) => p.state !== "inactive"), true);
assert.equal(laActiveFirst.people.every((p) => p.tier === "secondary"), true);

const afterSecondaries = nextLegalAssistantAssignees(firm, mixedSnap, {
  usedIds: new Set(laActiveFirst.usedIds),
  step: 1,
  rotation: 1,
});
assert.ok(afterSecondaries.people.some((p) => p.state === "inactive"));

console.log("test-callback-escalation: ok");
