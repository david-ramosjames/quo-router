// Callback escalation for missed / Sona notices in #lead-calls and
// #legalassistant-phone. Status lists stay untagged; these posts ask specific
// people to call back, then widen the ask every intervalSeconds until someone
// handles it or managers are tagged.

import {
  DEFAULT_PHONE_STAFF_TZ,
  zonedDayMinutes,
  countsTowardAvailableMissed,
} from "./phone-staff.js";

export const DEFAULT_ESCALATION_INTERVAL_SECONDS = 50;
/** Web form / chat callback ladder: one person at a time, slower than missed-call tags. */
export const WEBFORM_ESCALATION_INTERVAL_SECONDS = 120;

const STOP_REPLY = /\b(handling|not needed|calling)\b/i;
const CHECK_REACTIONS = new Set([
  "white_check_mark",
  "heavy_check_mark",
  "checked",
  "ballot_box_with_check",
]);

export const CALLBACK_STOP_HINT =
  `_React :white_check_mark: or reply *handling* / *on it* if you're taking this — that stops further tags._`;

/** True when a human reply means stop escalating (ignore our own hint text). */
export function replyMeansStop(text) {
  const raw = String(text || "");
  // Our own instruction line contains words like "handling" — never treat it as a stop.
  if (/stops further tags/i.test(raw)) return false;
  if (/please call back now/i.test(raw)) return false;
  return STOP_REPLY.test(raw);
}

export function normalizeCallbackEscalation(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const days = Array.isArray(src.businessDays)
    ? [...new Set(src.businessDays.map(Number).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b)
    : [1, 2, 3, 4, 5];
  let startMin = Number(src.businessStartMin);
  let endMin = Number(src.businessEndMin);
  if (!Number.isFinite(startMin)) startMin = 7 * 60;
  if (!Number.isFinite(endMin)) endMin = 18 * 60;
  let intervalSeconds = Number(src.intervalSeconds);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 10) {
    intervalSeconds = DEFAULT_ESCALATION_INTERVAL_SECONDS;
  }
  const managers = [...new Set(
    (Array.isArray(src.managers) ? src.managers : String(src.managersText || "").split(/[,\s]+/))
      .map((id) => String(id || "").trim())
      .filter((id) => /^U[A-Z0-9]+$/i.test(id)),
  )];
  return {
    enabled: src.enabled !== false,
    intervalSeconds,
    managers,
    timezone: String(src.timezone || DEFAULT_PHONE_STAFF_TZ).trim() || DEFAULT_PHONE_STAFF_TZ,
    businessDays: days.length ? days : [1, 2, 3, 4, 5],
    businessStartMin: startMin,
    businessEndMin: endMin,
  };
}

export function isBusinessHours(config, now = new Date()) {
  const cfg = normalizeCallbackEscalation(config);
  const { day, minutes } = zonedDayMinutes(now, cfg.timezone);
  if (!cfg.businessDays.includes(day)) return false;
  if (cfg.businessEndMin > cfg.businessStartMin) {
    return minutes >= cfg.businessStartMin && minutes < cfg.businessEndMin;
  }
  return minutes >= cfg.businessStartMin || minutes < cfg.businessEndMin;
}

function byRotation(pool, usedIds, count, rotation) {
  if (!pool.length || count <= 0) return [];
  const available = pool.filter((p) => !usedIds.has(p.slackUserId));
  if (!available.length) return [];
  const start = available.length ? (rotation % available.length) : 0;
  const ordered = available.slice(start).concat(available.slice(0, start));
  return ordered.slice(0, count);
}

/** Prefer Slack-active people; only pull inactive after that pool is exhausted. */
function byRotationPreferActive(pool, usedIds, count, rotation) {
  if (!pool.length || count <= 0) return [];
  const unused = pool.filter((p) => !usedIds.has(p.slackUserId));
  const active = unused.filter((p) => p.state !== "inactive");
  const inactive = unused.filter((p) => p.state === "inactive");
  const fromActive = byRotation(active, usedIds, count, rotation);
  if (fromActive.length >= count) return fromActive;
  const need = count - fromActive.length;
  const used = new Set([...usedIds, ...fromActive.map((p) => p.slackUserId)]);
  return [...fromActive, ...byRotation(inactive, used, need, rotation)];
}

/**
 * Across ordered pools (e.g. primary then secondary): take every active person
 * first, then inactive — so inactive are last overall, not just within a tier.
 */
function pickPreferActiveAcrossPools(pools, usedIds, count, rotation) {
  if (count <= 0) return [];
  const picked = [];
  const used = new Set(usedIds);
  for (const pool of pools) {
    if (picked.length >= count) break;
    const active = (pool || []).filter((p) => p.state !== "inactive");
    for (const p of byRotation(active, used, count - picked.length, rotation)) {
      picked.push(p);
      used.add(p.slackUserId);
    }
  }
  for (const pool of pools) {
    if (picked.length >= count) break;
    const inactive = (pool || []).filter((p) => p.state === "inactive");
    for (const p of byRotation(inactive, used, count - picked.length, rotation)) {
      picked.push(p);
      used.add(p.slackUserId);
    }
  }
  return picked;
}

function freeFromSnapshot(snapshot) {
  // Active + inactive on duty both escalate; inactive is asked last within each role.
  // Off-topic / lunch / on-call never enter the tag ladder.
  return (snapshot || []).filter(
    (row) => row.state !== "off_topic" && (countsTowardAvailableMissed(row) || row.tag),
  );
}

function staffByRole(firm, snapshot, role) {
  const free = freeFromSnapshot(snapshot);
  const freeById = new Map(free.map((r) => [String(r.slackUserId || "").toUpperCase(), r]));
  return (firm.phoneStaff || [])
    .filter((p) => p.role === role && freeById.has(String(p.slackUserId || "").toUpperCase()))
    .map((p) => {
      const snap = freeById.get(String(p.slackUserId || "").toUpperCase());
      return { ...p, state: snap?.state || "available" };
    });
}

/**
 * #lead-calls step:
 *   0 → 1 LA + 1 Intake (or 2nd LA if no intake)
 *   1 → 1 LA + 1 Intake (or 2nd LA)
 *   2+ → 1 LA each round
 *   exhausted → managers
 */
export function nextLeadCallsAssignees(firm, snapshot, { usedIds = new Set(), step = 0, rotation = 0 } = {}) {
  const used = new Set(usedIds);
  const las = staffByRole(firm, snapshot, "la");
  const intake = staffByRole(firm, snapshot, "intake");

  if (step <= 1) {
    const picked = [];
    const laPick = byRotationPreferActive(las, used, 1, rotation);
    for (const p of laPick) {
      picked.push(p);
      used.add(p.slackUserId);
    }
    // Intake (Andrea / Roman) rotates independently of LA so outbound-on-topic
    // intake staff still share missed-call tags fairly with inbound intake.
    const intakePick = byRotationPreferActive(intake, used, 1, rotation);
    if (intakePick.length) {
      picked.push(intakePick[0]);
      used.add(intakePick[0].slackUserId);
    } else {
      const secondLa = byRotationPreferActive(las, used, 1, rotation + 1);
      for (const p of secondLa) {
        picked.push(p);
        used.add(p.slackUserId);
      }
    }
    if (picked.length) {
      return { kind: "request", people: picked, usedIds: [...used] };
    }
  } else {
    const laPick = byRotationPreferActive(las, used, 1, rotation + step);
    if (laPick.length) {
      for (const p of laPick) used.add(p.slackUserId);
      return { kind: "request", people: laPick, usedIds: [...used] };
    }
  }

  const managers = (firm.callbackEscalation?.managers || [])
    .filter((id) => !used.has(id))
    .map((slackUserId) => ({ name: slackUserId, slackUserId, role: "manager" }));
  if (!managers.length) return { kind: "done", people: [], usedIds: [...used] };
  return {
    kind: "managers",
    people: managers,
    usedIds: [...used, ...managers.map((m) => m.slackUserId)],
    message: "No phone staff left to ask — please manually tag a paralegal or attorney.",
  };
}

/**
 * Web form / chat callback ladder (one person per step):
 *   outbound topic → inbound topic → LAs → managers
 * Interval is typically 120s (set on the job by the caller).
 */
export function nextWebformAssignees(firm, snapshot, { usedIds = new Set(), step = 0, rotation = 0 } = {}) {
  const used = new Set(usedIds);
  const free = freeFromSnapshot(snapshot);
  const staffById = new Map(
    (firm.phoneStaff || []).map((p) => [String(p.slackUserId || "").toUpperCase(), p]),
  );
  const asPeople = (rows) => rows.map((r) => {
    const configured = staffById.get(String(r.slackUserId || "").toUpperCase());
    return {
      name: r.name || configured?.name || r.slackUserId,
      slackUserId: r.slackUserId,
      state: r.state || "available",
      role: r.dutySection || configured?.role || "la",
      tier: configured?.tier || null,
      dutySection: r.dutySection || null,
    };
  });

  const outbound = asPeople(free.filter((r) => r.dutySection === "outbound"));
  const inbound = asPeople(free.filter((r) => r.dutySection === "inbound"));
  const las = asPeople(free.filter((r) => {
    if (r.dutySection === "las") return true;
    const configured = staffById.get(String(r.slackUserId || "").toUpperCase());
    return configured?.role === "la" && r.dutySection !== "outbound" && r.dutySection !== "inbound";
  }));

  // Walk sections in order; within a section prefer Slack-active, then inactive.
  for (const pool of [outbound, inbound, las]) {
    const pick = byRotationPreferActive(pool, used, 1, rotation + step);
    if (pick.length) {
      for (const p of pick) used.add(p.slackUserId);
      return { kind: "request", people: pick, usedIds: [...used] };
    }
  }

  const managers = (firm.callbackEscalation?.managers || [])
    .filter((id) => !used.has(id))
    .map((slackUserId) => ({ name: slackUserId, slackUserId, role: "manager" }));
  if (!managers.length) return { kind: "done", people: [], usedIds: [...used] };
  return {
    kind: "managers",
    people: managers,
    usedIds: [...used, ...managers.map((m) => m.slackUserId)],
    message: "No phone staff left to ask on this web lead — please manually tag someone.",
  };
}

/**
 * #legalassistant-phone step:
 *   0 → 2 from primary LAs, fill from secondary
 *   1 → up to 2 more from any LA
 *   2+ → 1 more LA
 *   exhausted → managers
 */
export function nextLegalAssistantAssignees(firm, snapshot, { usedIds = new Set(), step = 0, rotation = 0 } = {}) {
  const used = new Set(usedIds);
  const allLas = staffByRole(firm, snapshot, "la");
  const primary = allLas.filter((p) => p.tier !== "secondary");
  const secondary = allLas.filter((p) => p.tier === "secondary");

  let need = step === 0 ? 2 : step === 1 ? 2 : 1;
  const picked = [];

  if (step === 0) {
    // Active primary → active secondary → inactive primary → inactive secondary.
    for (const p of pickPreferActiveAcrossPools([primary, secondary], used, need, rotation)) {
      picked.push(p);
      used.add(p.slackUserId);
    }
  } else {
    for (const p of byRotationPreferActive(allLas, used, need, rotation + step)) {
      picked.push(p);
      used.add(p.slackUserId);
    }
  }

  if (picked.length) {
    return { kind: "request", people: picked, usedIds: [...used] };
  }

  const managers = (firm.callbackEscalation?.managers || [])
    .filter((id) => !used.has(id))
    .map((slackUserId) => ({ name: slackUserId, slackUserId, role: "manager" }));
  if (!managers.length) return { kind: "done", people: [], usedIds: [...used] };
  return {
    kind: "managers",
    people: managers,
    usedIds: [...used, ...managers.map((m) => m.slackUserId)],
    message: "No response has been received from phone staff.",
  };
}

export function formatCallbackRequest(people) {
  if (!people?.length) return "";
  const lines = people.map((p) => `:rotating_light: <@${p.slackUserId}> Please call back now`);
  lines.push(CALLBACK_STOP_HINT);
  return lines.join("\n");
}

/**
 * After-hours coverage (Jackie): one tag, no ladder. Used for webform/chat
 * leads that arrive outside Mon–Fri 7am–6pm when the daytime ladder is off.
 */
export function nextAfterHoursAssignees(firm, snapshot = []) {
  const fromSnap = (snapshot || []).filter(
    (r) => r.state === "after_hours" || r.afterHoursDuty,
  );
  if (fromSnap.length) {
    const people = fromSnap.map((r) => ({
      name: r.name || r.slackUserId,
      slackUserId: r.slackUserId,
      role: "after_hours",
      state: "after_hours",
    }));
    return {
      kind: "after_hours",
      people,
      usedIds: people.map((p) => p.slackUserId),
    };
  }
  const configured = (firm.phoneStaff || []).filter(
    (p) => p.afterHours || p.role === "after_hours",
  );
  if (!configured.length) return { kind: "done", people: [], usedIds: [] };
  const people = configured.map((p) => ({
    name: p.name || p.slackUserId,
    slackUserId: p.slackUserId,
    role: "after_hours",
    state: "after_hours",
  }));
  return {
    kind: "after_hours",
    people,
    usedIds: people.map((p) => p.slackUserId),
  };
}

export function formatAfterHoursCallbackRequest(people) {
  if (!people?.length) return "";
  const lines = people.map(
    (p) => `:moon: <@${p.slackUserId}> After-hours — please call this lead back`,
  );
  lines.push(CALLBACK_STOP_HINT);
  return lines.join("\n");
}

export function formatManagerEscalation(people, message) {
  if (!people?.length) return "";
  const tags = people.map((p) => `<@${p.slackUserId}>`).join(" ");
  return `:rotating_light: ${tags} ${message || "Please step in on this callback."}\n${CALLBACK_STOP_HINT}`;
}

export function reactionMeansStop(reaction) {
  const name = String(reaction || "").replace(/^:/, "").replace(/:$/, "");
  return CHECK_REACTIONS.has(name);
}

/** Advance a firm-level rotation counter so picks feel fair over time. */
export function bumpRotation(firm, by = 1) {
  if (!firm) return 0;
  firm.callbackRotation = (Number(firm.callbackRotation) || 0) + by;
  return firm.callbackRotation;
}
