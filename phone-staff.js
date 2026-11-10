// Phone-staff availability: Quo → Slack "On a call" status, and tagging who
// should have answered a missed / Sona call.
//
// Configured per firm via `phoneStaff`:
//   [{ name, slackUserId, quoUserId?, windows?, afterHours?, timezone? }]
// Only this subset is tracked — attorneys / others are ignored.
//
// Tag someone only when all of these are true:
//   - Slack presence is active (inactive/away is noted but not tagged)
//   - not already on a call
//   - no Slack status that takes them off the phones (lunch, break, meeting, …)
//   - the miss happened during their scheduled hours, or they are the
//     after-hours person and nobody's shift covers that moment
//   - during business hours, listed under Inbound or LAs in the daily
//     #legalassistant-phone (or #lead-calls) channel topic
// People are not tagged outside their own hours. Until any hours are saved,
// only Slack-active staff are tagged, same as before.

const ON_CALL_STATUS_TEXT = "On a call";
const ON_CALL_STATUS_EMOJI = ":phone:";
const ANSWER_POLL_MS = 5_000;
const ANSWER_POLL_MAX_MS = 3 * 60_000; // stop watching after 3 minutes of ringing
export const DEFAULT_PHONE_STAFF_TZ = "America/Chicago";

const DAY_INDEX = {
  su: 0, sun: 0, sunday: 0,
  m: 1, mo: 1, mon: 1, monday: 1,
  tu: 2, tue: 2, tues: 2, tuesday: 2,
  w: 3, we: 3, wed: 3, wednesday: 3,
  th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  f: 5, fr: 5, fri: 5, friday: 5,
  sa: 6, sat: 6, saturday: 6,
};
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const BLOCKING_STATUS = [
  /\blunch\b/i,
  /\bbreak\b/i,
  /\bbrb\b/i,
  /\bbe right back\b/i,
  /\booo\b/i,
  /\bout of (the )?office\b/i,
  /\bpto\b/i,
  /\bvacation\b/i,
  /\bholiday\b/i,
  /\bsick\b/i,
  /\bdoctor\b/i,
  /\bdentist\b/i,
  /\bappointment\b/i,
  /\bmeeting\b/i,
  /\bfocus\b/i,
  /\bheads down\b/i,
  /\bdnd\b/i,
  /\bdo not disturb\b/i,
  /\bbusy\b/i,
  /\bon a call\b/i,
  /\bon-call\b/i,
  /\bcommute\b/i,
  /\bpersonal\b/i,
  /\berrand\b/i,
  /\bstepp(?:ing|ed) away\b/i,
  /\btranslat(?:e|ing|ion)\b/i,
  /\bhuddle\b/i,
  /\bin a huddle\b/i,
];

const BLOCKING_EMOJI = new Set([
  "palm_tree", "airplane", "zzz", "hamburger", "bento", "fork_and_knife",
  "beach_with_umbrella", "face_with_thermometer", "no_entry", "no_entry_sign", "sleeping",
  // Slack huddle / translating often use a speech bubble status emoji.
  "speech_balloon", "speaking_head", "speaking_head_in_silhouette",
]);

export function normalizePhoneStaff(config) {
  const raw = config?.phoneStaff;
  if (!Array.isArray(raw)) return [];
  const tzDefault = String(config?.phoneStaffTimezone || "").trim() || null;
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const slackUserId = String(entry.slackUserId || entry.slack_user_id || "").trim();
    if (entry.scheduleError && !/^U[A-Z0-9]+$/i.test(slackUserId)) {
      out.push({
        name: String(entry.name || "phone staff").trim(),
        slackUserId: "UINVALID",
        quoUserId: null,
        afterHours: false,
        windows: [],
        timezone: null,
        scheduleError: entry.scheduleError,
      });
      continue;
    }
    if (!/^U[A-Z0-9]+$/i.test(slackUserId)) continue;
    const name = String(entry.name || entry.displayName || slackUserId).trim();
    const quoUserId = String(entry.quoUserId || entry.quo_user_id || "").trim() || null;
    const schedule = entry.scheduleError
      ? { error: entry.scheduleError }
      : normalizeSchedule(entry);
    if (schedule.error) {
      out.push({
        name, slackUserId, quoUserId,
        afterHours: false,
        windows: [],
        timezone: null,
        role: null,
        tier: null,
        scheduleError: schedule.error,
      });
      continue;
    }
    const afterHours = !!schedule.afterHours;
    const role = entry.role || schedule.role || (afterHours ? "after_hours" : null);
    const tier = entry.tier || schedule.tier || null;
    out.push({
      name,
      slackUserId,
      quoUserId,
      afterHours,
      windows: schedule.windows,
      ringAfterSeconds: Math.max(0, Number(entry.ringAfterSeconds) || Number(schedule.ringAfterSeconds) || 0),
      role: normalizeStaffRole(role, afterHours),
      tier: normalizeStaffTier(tier),
      timezone: entry.timezone || tzDefault || (schedule.windows.length || afterHours ? DEFAULT_PHONE_STAFF_TZ : null),
    });
  }
  return out;
}

function normalizeStaffRole(role, afterHours) {
  const r = String(role || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (afterHours || r === "after_hours") return "after_hours";
  if (r === "la" || r === "legal_assistant") return "la";
  if (r === "intake") return "intake";
  return null;
}

function normalizeStaffTier(tier) {
  const t = String(tier || "").trim().toLowerCase();
  if (t === "primary" || t === "secondary") return t;
  return null;
}

function normalizeSchedule(entry) {
  const ringAfterSeconds = Math.max(0, Number(entry.ringAfterSeconds) || 0);
  if (entry.scheduleError) return { error: entry.scheduleError };
  if (Array.isArray(entry.windows) || entry.afterHours || ringAfterSeconds > 0 || entry.role || entry.tier) {
    const windows = [];
    for (const w of entry.windows || []) {
      const days = [...new Set((w.days || []).map((d) => Number(d)).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
      const startMin = Number(w.startMin);
      const endMin = Number(w.endMin);
      if (!days.length || !Number.isFinite(startMin) || !Number.isFinite(endMin) || startMin === endMin) {
        return { error: `Could not read hours for ${entry.name || entry.slackUserId}` };
      }
      windows.push({ days, startMin, endMin });
    }
    return {
      afterHours: !!entry.afterHours,
      windows,
      ringAfterSeconds,
      role: entry.role || null,
      tier: entry.tier || null,
    };
  }
  if (typeof entry.schedule === "string") return parseStaffSchedule(entry.schedule);
  return { afterHours: false, windows: [], ringAfterSeconds: 0, role: null, tier: null };
}

export function parsePhoneStaffText(text) {
  // One person per line:
  //   Name=SLACK_ID[=QUO_ID] [| Mon-Fri 08:00-17:00]
  //   Name=SLACK_ID=QUO_ID | after-hours
  // Optional first line: timezone=America/Chicago
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  let timezone = null;
  for (const line of lines) {
    const tz = line.match(/^timezone\s*=\s*(\S+)\s*$/i);
    if (tz) {
      timezone = tz[1];
      if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(timezone)) {
        out.push({
          name: "timezone",
          slackUserId: "",
          scheduleError: `Unknown timezone "${timezone}"`,
        });
      }
      continue;
    }
    let main = line;
    let scheduleText = "";
    const pipe = line.indexOf("|");
    if (pipe >= 0) {
      main = line.slice(0, pipe).trim();
      scheduleText = line.slice(pipe + 1).trim();
    }
    let name, slackUserId, quoUserId, extra;
    if (main.includes("=")) {
      const parts = main.split("=").map((p) => p.trim());
      [name, slackUserId, quoUserId, extra] = parts;
      if (!scheduleText && extra) scheduleText = parts.slice(3).join("=").trim();
    } else {
      const parts = main.split(/[,\t]/).map((p) => p.trim());
      [name, slackUserId, quoUserId] = parts;
    }
    if (!slackUserId) continue;
    const schedule = parseStaffSchedule(scheduleText);
    out.push({
      name: name || slackUserId,
      slackUserId,
      quoUserId: quoUserId || null,
      timezone,
      afterHours: schedule.afterHours,
      windows: schedule.windows,
      ringAfterSeconds: schedule.ringAfterSeconds || 0,
      role: schedule.role || null,
      tier: schedule.tier || null,
      scheduleError: schedule.error || null,
    });
  }
  return normalizePhoneStaff({ phoneStaff: out, phoneStaffTimezone: timezone });
}

export function formatPhoneStaffText(staff) {
  const people = staff || [];
  const tz = people.find((p) => p.timezone)?.timezone;
  const lines = [];
  if (tz) lines.push(`timezone=${tz}`);
  for (const p of people) {
    const id = p.quoUserId ? `${p.name}=${p.slackUserId}=${p.quoUserId}` : `${p.name}=${p.slackUserId}`;
    const schedule = formatStaffSchedule(p);
    lines.push(schedule ? `${id} | ${schedule}` : id);
  }
  return lines.join("\n");
}

const RING_DELAY_PATTERN = /\brings?\s+after\s+(\d+)\s*(?:s|sec|secs|seconds)?\b/i;

function extractRoleAndTier(text) {
  let role = null;
  let tier = null;
  const rest = String(text || "")
    .replace(/\b(?:role\s*=\s*)?(?:legal[\s-]?assistant|la)\b/ig, () => { role = "la"; return " "; })
    .replace(/\b(?:role\s*=\s*)?intake\b/ig, () => { role = "intake"; return " "; })
    .replace(/\b(?:tier\s*=\s*)?primary\b/ig, () => { tier = "primary"; return " "; })
    .replace(/\b(?:tier\s*=\s*)?secondary\b/ig, () => { tier = "secondary"; return " "; });
  return { role, tier, rest };
}

export function parseStaffSchedule(text) {
  const raw = String(text || "").trim();
  if (!raw) return { afterHours: false, windows: [], ringAfterSeconds: 0, role: null, tier: null };
  const delay = raw.match(RING_DELAY_PATTERN);
  const ringAfterSeconds = delay ? Number(delay[1]) : 0;
  let afterHours = false;
  const roleTier = extractRoleAndTier(
    raw
      .replace(new RegExp(RING_DELAY_PATTERN.source, "ig"), " ")
      .replace(/\bafter[-\s]?hours\b/ig, () => { afterHours = true; return " "; }),
  );
  const rest = roleTier.rest
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[|;\s]+|[|;\s]+$/g, "");
  if (!rest) {
    return {
      afterHours,
      windows: [],
      ringAfterSeconds,
      role: afterHours ? "after_hours" : roleTier.role,
      tier: roleTier.tier,
    };
  }
  const windows = [];
  for (const chunk of rest.split(/\s*;\s*/).filter(Boolean)) {
    const m = chunk.match(/^([a-z][a-z,\-\s]*?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i);
    if (!m) return { error: `Could not read hours "${chunk.trim()}"` };
    const days = parseDays(m[1]);
    const startMin = parseClock(m[2]);
    const endMin = parseClock(m[3]);
    if (!days?.length || startMin == null || endMin == null || startMin === endMin) {
      return { error: `Could not read hours "${chunk.trim()}"` };
    }
    windows.push({ days, startMin, endMin });
  }
  return {
    afterHours,
    windows,
    ringAfterSeconds,
    role: afterHours ? "after_hours" : roleTier.role,
    tier: roleTier.tier,
  };
}

function parseDays(spec) {
  const days = new Set();
  const cleaned = spec.replace(/\s+/g, "");
  for (const part of cleaned.split(",").filter(Boolean)) {
    const range = part.match(/^([a-z]+)-([a-z]+)$/i);
    const single = part.match(/^([a-z]+)$/i);
    if (!range && !single) return null;
    const start = DAY_INDEX[(range ? range[1] : single[1]).toLowerCase()];
    const end = range ? DAY_INDEX[range[2].toLowerCase()] : start;
    if (start == null || end == null) return null;
    let d = start;
    for (let i = 0; i < 7; i++) {
      days.add(d);
      if (d === end) break;
      d = (d + 1) % 7;
    }
  }
  return [...days].sort((a, b) => a - b);
}

function parseClock(raw) {
  const m = String(raw).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59 || h > 24) return null;
  const ap = m[3]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  } else if (h === 24 && min === 0) {
    h = 0;
  } else if (h > 23) return null;
  return h * 60 + min;
}

export function formatStaffSchedule(person) {
  const parts = (person?.windows || []).map((w) => `${formatDays(w.days)} ${formatClock(w.startMin)}-${formatClock(w.endMin)}`);
  if (person?.afterHours) parts.push("after-hours");
  if (person?.ringAfterSeconds > 0) parts.push(`rings after ${person.ringAfterSeconds}s`);
  if (person?.role === "la") parts.push(person.tier === "secondary" ? "la secondary" : person.tier === "primary" ? "la primary" : "la");
  else if (person?.role === "intake") parts.push("intake");
  return parts.join("; ");
}

function formatDays(days) {
  const set = [...new Set(days)].sort((a, b) => a - b);
  const ranges = [];
  let start = set[0];
  let prev = set[0];
  for (let i = 1; i <= set.length; i++) {
    if (i < set.length && set[i] === prev + 1) {
      prev = set[i];
      continue;
    }
    ranges.push(start === prev ? DAY_NAMES[start] : `${DAY_NAMES[start]}-${DAY_NAMES[prev]}`);
    start = set[i];
    prev = set[i];
  }
  return ranges.join(",");
}

function formatClock(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function zonedDayMinutes(date, timeZone = DEFAULT_PHONE_STAFF_TZ) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return { day, minutes: hour * 60 + Number(parts.minute) };
}

export function isOnShift(person, now) {
  if (!person?.windows?.length) return false;
  const { day, minutes } = zonedDayMinutes(now, person.timezone || DEFAULT_PHONE_STAFF_TZ);
  return person.windows.some((w) => inWindow(day, minutes, w));
}

function inWindow(day, minutes, w) {
  if (w.endMin > w.startMin) {
    return w.days.includes(day) && minutes >= w.startMin && minutes < w.endMin;
  }
  if (w.days.includes(day) && minutes >= w.startMin) return true;
  const prev = (day + 6) % 7;
  return w.days.includes(prev) && minutes < w.endMin;
}

export function hoursAreConfigured(staff) {
  return (staff || []).some((p) => p.afterHours || p.windows?.length);
}

export function isOfficeCovered(staff, now) {
  return (staff || []).some((p) => p.windows?.length && isOnShift(p, now));
}

export function blockingStatusReason(statusText, statusEmoji) {
  const text = String(statusText || "").trim();
  if (text && BLOCKING_STATUS.some((re) => re.test(text))) return text;
  const emoji = String(statusEmoji || "").replace(/:/g, "");
  if (emoji && BLOCKING_EMOJI.has(emoji)) return text || emoji;
  return "";
}

/**
 * Decide whether this person should be @-mentioned for a missed/Sona call.
 * `officeCovered` is true when any scheduled shift contains `now`.
 */
export function classifyPhoneStaffMember(person, {
  presence = "unknown",
  statusText = "",
  statusEmoji = "",
  onCall = false,
  now = new Date(),
  officeCovered = false,
  hoursConfigured = false,
} = {}) {
  const base = {
    name: person.name,
    slackUserId: person.slackUserId,
    quoUserId: person.quoUserId || null,
    presence,
    statusText: String(statusText || "").trim(),
    afterHoursDuty: false,
    ringAfterSeconds: Math.max(0, Number(person.ringAfterSeconds) || 0),
    tag: false,
  };
  const onCallStatus = base.statusText.toLowerCase() === ON_CALL_STATUS_TEXT.toLowerCase()
    || (statusEmoji === ON_CALL_STATUS_EMOJI && /call/i.test(base.statusText));
  if (onCall || onCallStatus) return { ...base, state: "on_call", tag: false };

  const blocked = blockingStatusReason(statusText, statusEmoji);
  if (blocked) return { ...base, state: "status", statusText: blocked, tag: false };

  const onScheduledShift = isOnShift(person, now);
  let duty = false;
  let afterHoursDuty = false;
  if (!hoursConfigured) {
    duty = true;
  } else if (onScheduledShift) {
    duty = true;
  } else if (person.afterHours && !officeCovered) {
    duty = true;
    afterHoursDuty = true;
  }
  if (!duty) {
    let why = "";
    if (hoursConfigured && !person.windows?.length && !person.afterHours) why = "no hours set";
    else if (person.afterHours && !onScheduledShift) why = "after hours only";
    return { ...base, state: "off_shift", statusText: why, tag: false };
  }

  if (afterHoursDuty) {
    // After-hours coverage still tags even if Slack shows away.
    return { ...base, state: "after_hours", afterHoursDuty: true, presence, tag: true };
  }
  if (presence === "active") return { ...base, state: "available", tag: true };
  // Inactive / away during shift: still counts as Available Missed, but shown as
  // inactive in the status list and asked last during callback escalation.
  if (presence === "away") return { ...base, state: "inactive", tag: false };
  return { ...base, state: "unknown", tag: false };
}

function isSonaAnsweredBy(answeredBy) {
  if (!answeredBy) return false;
  const s = String(answeredBy);
  return s.startsWith("SY") || /sona/i.test(s);
}

export function findPhoneStaffByQuoUser(firm, quoUserId) {
  if (!quoUserId) return null;
  const id = String(quoUserId);
  return (firm.phoneStaff || []).find((p) => p.quoUserId && p.quoUserId === id) || null;
}

export function findPhoneStaffBySlackUser(firm, slackUserId) {
  if (!slackUserId) return null;
  return (firm.phoneStaff || []).find((p) => p.slackUserId === slackUserId) || null;
}

/** Slack user IDs currently marked on a call by this router. */
export function onCallSlackUserIds(firm) {
  const ids = new Set();
  for (const entry of firm.onCallByCallId?.values() || []) {
    if (entry?.slackUserId) ids.add(entry.slackUserId);
  }
  return ids;
}

async function slackApi(token, method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function getSlackProfile(firm, slackUserId) {
  const token = firm.slackUserToken || firm.slackBotToken;
  if (!token || !slackUserId) return null;
  try {
    const json = await slackApi(token, "users.profile.get", { user: slackUserId });
    if (!json.ok) {
      console.warn(`[${firm.id}][phone-staff] users.profile.get failed for ${slackUserId}: ${json.error}`);
      return null;
    }
    return json.profile || null;
  } catch (err) {
    console.warn(`[${firm.id}][phone-staff] users.profile.get error:`, err.message);
    return null;
  }
}

function blankStatus() {
  return { status_text: "", status_emoji: "", status_expiration: 0 };
}

function otherOnCallEntry(firm, slackUserId, exceptCallId) {
  for (const [id, entry] of firm.onCallByCallId || []) {
    if (id !== exceptCallId && entry?.slackUserId === slackUserId) return entry;
  }
  return null;
}

export async function setSlackOnCallStatus(firm, slackUserId, { callId } = {}) {
  if (!slackUserId || !callId) return false;

  // Quo is the source of "on a call" for tagging. Mirroring that onto the
  // Slack profile is optional and needs an admin user token.
  let entry = firm.onCallByCallId?.get(callId);
  if (!(entry?.slackUserId === slackUserId)) {
    const carried = otherOnCallEntry(firm, slackUserId, callId);
    const profile = (!carried && firm.slackUserToken && !firm.slackStatusWriteBlocked)
      ? await getSlackProfile(firm, slackUserId)
      : null;
    const previous = carried?.previous || (profile
      ? {
          status_text: profile.status_text || "",
          status_emoji: profile.status_emoji || "",
          status_expiration: profile.status_expiration || 0,
        }
      : blankStatus());
    if (!firm.onCallByCallId) firm.onCallByCallId = new Map();
    entry = {
      slackUserId,
      previous,
      setAt: Date.now(),
      slackWritten: false,
      slackWriteAttempted: !!carried,
    };
    firm.onCallByCallId.set(callId, entry);
    const person = findPhoneStaffBySlackUser(firm, slackUserId);
    console.log(`[${firm.id}][phone-staff] On a call (from Quo): ${person?.name || slackUserId} (call ${callId})`);
  }

  if (entry.slackWritten || entry.slackWriteAttempted || firm.slackStatusWriteBlocked || !firm.slackUserToken) {
    return true;
  }

  const alreadyOurs =
    entry.previous.status_text === ON_CALL_STATUS_TEXT &&
    entry.previous.status_emoji === ON_CALL_STATUS_EMOJI;
  entry.slackWriteAttempted = true;
  if (alreadyOurs) return true;

  try {
    const json = await slackApi(firm.slackUserToken, "users.profile.set", {
      user: slackUserId,
      profile: {
        status_text: ON_CALL_STATUS_TEXT,
        status_emoji: ON_CALL_STATUS_EMOJI,
        status_expiration: 0,
      },
    });
    if (!json.ok) {
      if (json.error === "not_admin" && !firm.slackStatusWriteBlocked) {
        firm.slackStatusWriteBlocked = true;
        console.warn(
          `[${firm.id}][phone-staff] Slack user token cannot set other people's status (not_admin). ` +
            `On-call tagging will use Quo; Slack profiles will not change.`,
        );
      } else if (json.error !== "not_admin") {
        console.error(`[${firm.id}][phone-staff] users.profile.set failed for ${slackUserId}: ${json.error}`);
      }
      return true;
    }
    entry.slackWritten = true;
    const person = findPhoneStaffBySlackUser(firm, slackUserId);
    console.log(`[${firm.id}][phone-staff] Set on-call status for ${person?.name || slackUserId} (call ${callId})`);
    return true;
  } catch (err) {
    console.error(`[${firm.id}][phone-staff] set status error:`, err.message);
    return true;
  }
}

export async function clearSlackOnCallStatus(firm, callId) {
  if (!callId || !firm.onCallByCallId?.has(callId)) return false;
  const entry = firm.onCallByCallId.get(callId);
  firm.onCallByCallId.delete(callId);

  // Another live call still owns this user's status — leave it alone.
  for (const other of firm.onCallByCallId.values()) {
    if (other.slackUserId === entry.slackUserId) {
      if (entry.slackWritten && !other.slackWritten) {
        other.previous = entry.previous;
        other.slackWritten = true;
      }
      console.log(`[${firm.id}][phone-staff] ${entry.slackUserId} still on another call — keeping status`);
      return false;
    }
  }

  if (!entry.slackWritten || !firm.slackUserToken) {
    const person = findPhoneStaffBySlackUser(firm, entry.slackUserId);
    console.log(`[${firm.id}][phone-staff] Call ended for ${person?.name || entry.slackUserId} (call ${callId})`);
    return true;
  }
  const prev = entry.previous || { status_text: "", status_emoji: "", status_expiration: 0 };
  try {
    const json = await slackApi(firm.slackUserToken, "users.profile.set", {
      user: entry.slackUserId,
      profile: {
        status_text: prev.status_text || "",
        status_emoji: prev.status_emoji || "",
        status_expiration: prev.status_expiration || 0,
      },
    });
    if (!json.ok) {
      console.error(`[${firm.id}][phone-staff] clear status failed for ${entry.slackUserId}: ${json.error}`);
      return false;
    }
    const person = findPhoneStaffBySlackUser(firm, entry.slackUserId);
    console.log(`[${firm.id}][phone-staff] Cleared on-call status for ${person?.name || entry.slackUserId} (call ${callId})`);
    return true;
  } catch (err) {
    console.error(`[${firm.id}][phone-staff] clear status error:`, err.message);
    return false;
  }
}

export async function markPhoneStaffOnCall(firm, { callId, answeredBy, userId = null }) {
  if (!callId) return false;
  const candidate = answeredBy || userId;
  if (!candidate || isSonaAnsweredBy(candidate)) return false;
  if (!firm.phoneStaff?.length) {
    console.log(`[${firm.id}][phone-staff] No phoneStaff configured — ignoring answeredBy=${candidate}`);
    return false;
  }
  const person = findPhoneStaffByQuoUser(firm, candidate)
    || findPhoneStaffByQuoUser(firm, answeredBy)
    || findPhoneStaffByQuoUser(firm, userId);
  if (!person) {
    const mapped = (firm.phoneStaff || []).map((p) => `${p.name}:${p.quoUserId || "(no quo id)"}`).join(", ");
    console.log(
      `[${firm.id}][phone-staff] answeredBy/userId=${candidate} not in phoneStaff [${mapped}] — no Slack status change`,
    );
    return false;
  }
  return setSlackOnCallStatus(firm, person.slackUserId, { callId });
}

/** One-line readiness summary for logs / admin. */
export function phoneStaffStatusSummary(firm) {
  const staff = firm.phoneStaff || [];
  return {
    count: staff.length,
    hasUserToken: !!firm.slackUserToken,
    hasBotToken: !!firm.slackBotToken,
    staff: staff.map((p) => ({
      name: p.name,
      slackUserId: p.slackUserId,
      quoUserId: p.quoUserId || null,
      mapped: !!p.quoUserId,
    })),
  };
}

async function getPresence(firm, slackUserId) {
  if (!firm.slackBotToken || !slackUserId) return "unknown";
  try {
    const url = new URL("https://slack.com/api/users.getPresence");
    url.searchParams.set("user", slackUserId);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${firm.slackBotToken}` },
    });
    const json = await res.json();
    if (!json.ok) {
      console.warn(`[${firm.id}][phone-staff] users.getPresence failed for ${slackUserId}: ${json.error}`);
      return "unknown";
    }
    return json.presence === "active" ? "active" : "away";
  } catch (err) {
    console.warn(`[${firm.id}][phone-staff] getPresence error:`, err.message);
    return "unknown";
  }
}

async function getSlackStatus(firm, slackUserId) {
  if (!firm.slackBotToken || !slackUserId) return { statusText: "", statusEmoji: "" };
  try {
    const url = new URL("https://slack.com/api/users.info");
    url.searchParams.set("user", slackUserId);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${firm.slackBotToken}` },
    });
    const json = await res.json();
    if (!json.ok) {
      console.warn(`[${firm.id}][phone-staff] users.info failed for ${slackUserId}: ${json.error}`);
      return { statusText: "", statusEmoji: "" };
    }
    const profile = json.user?.profile || {};
    const expires = Number(profile.status_expiration || 0);
    if (expires && expires * 1000 <= Date.now()) return { statusText: "", statusEmoji: "" };
    return {
      statusText: profile.status_text || "",
      statusEmoji: profile.status_emoji || "",
    };
  } catch (err) {
    console.warn(`[${firm.id}][phone-staff] users.info error:`, err.message);
    return { statusText: "", statusEmoji: "" };
  }
}

/**
 * Parse the daily phone-duty channel topic:
 *   Inbound @Andrea | Outbound @Roman | Attorney @Michael | LAs @Liz @Stephany …
 * Mentions may be <@U…> ids or @Names (including multi-word).
 */
/** Split on | but ignore pipes inside Slack mentions (<@U123|Name>). */
function splitTopicSections(topic) {
  const parts = [];
  let buf = "";
  let inMention = false;
  for (const ch of String(topic || "")) {
    if (ch === "<") inMention = true;
    else if (ch === ">") inMention = false;
    if (ch === "|" && !inMention) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf) parts.push(buf);
  return parts;
}

export function parsePhoneDutyTopic(topic) {
  const empty = { inbound: [], outbound: [], attorney: [], las: [], raw: String(topic || "") };
  if (!topic || !String(topic).trim()) return empty;

  const sections = {};
  for (const part of splitTopicSections(topic)) {
    const m = part.trim().match(/^(inbound|outbound|attorney|las)\s*:?\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase() === "las" ? "las" : m[1].toLowerCase();
    sections[key] = extractTopicMentions(m[2] || "");
  }
  return {
    inbound: sections.inbound || [],
    outbound: sections.outbound || [],
    attorney: sections.attorney || [],
    las: sections.las || [],
    raw: String(topic),
  };
}

function extractTopicMentions(segment) {
  const out = [];
  const text = String(segment || "");
  // Slack topics usually store <@U123> or <@U123|Display Name>.
  const idRe = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/gi;
  let m;
  while ((m = idRe.exec(text)) !== null) out.push(m[1].toUpperCase());

  // Plain @Name tokens (Slack display form). Strip <@U…> first so ids aren't
  // re-parsed as names, then grab each @… until the next @ or end.
  const withoutIds = text.replace(/<@U[A-Z0-9]+(?:\|[^>]*)?>/gi, " ");
  const nameRe = /@([^@|]+)/g;
  while ((m = nameRe.exec(withoutIds)) !== null) {
    const name = m[1].replace(/\s+/g, " ").trim();
    if (name) out.push(name);
  }
  return out;
}

function normalizePersonNameKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Resolve topic mention tokens to Slack user IDs via firm.slackUsers and
 * configured phoneStaff names. Returns { inbound, outbound, attorney, las,
 * answerIds } where answerIds is Inbound ∪ Outbound ∪ LAs (Attorney excluded).
 */
export function resolvePhoneDutyRoster(parsed, slackUsers, phoneStaff = []) {
  const map = slackUsers instanceof Map ? slackUsers : new Map(Object.entries(slackUsers || {}));
  const staff = Array.isArray(phoneStaff) ? phoneStaff : [];
  const resolveOne = (token) => {
    const raw = String(token || "").trim();
    if (!raw) return null;
    if (/^U[A-Z0-9]+$/i.test(raw)) return raw.toUpperCase();
    const key = normalizePersonNameKey(raw);
    const first = key.split(/\s+/)[0];
    const fromMap = map.get(key) || (first ? map.get(first) : null) || map.get(raw.toLowerCase());
    if (fromMap) return String(fromMap).toUpperCase();
    const hit = staff.find((p) => {
      const n = normalizePersonNameKey(p.name);
      return n === key || (first && n.split(/\s+/)[0] === first);
    });
    return hit?.slackUserId ? String(hit.slackUserId).toUpperCase() : null;
  };
  const resolveList = (list) => [...new Set((list || []).map(resolveOne).filter(Boolean))];
  const inbound = resolveList(parsed?.inbound);
  const outbound = resolveList(parsed?.outbound);
  const attorney = resolveList(parsed?.attorney);
  const las = resolveList(parsed?.las);
  // Outbound staff (e.g. Roman) still answer/tag on inbound misses when free.
  const answerIds = new Set([...inbound, ...outbound, ...las]);
  return {
    inbound,
    outbound,
    attorney,
    las,
    answerIds,
    hasRoster: answerIds.size > 0,
  };
}

async function fetchChannelTopicValue(firm, channelId) {
  if (!firm.slackBotToken || !channelId) return null;
  try {
    const url = new URL("https://slack.com/api/conversations.info");
    url.searchParams.set("channel", channelId);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${firm.slackBotToken}` },
    });
    const json = await res.json();
    if (!json.ok) {
      console.warn(`[${firm.id}][phone-staff] duty topic fetch failed (${channelId}): ${json.error}`);
      return null;
    }
    return json.channel?.topic?.value || "";
  } catch (err) {
    console.warn(`[${firm.id}][phone-staff] duty topic fetch error:`, err.message);
    return null;
  }
}

/** Prefer a topic that has Inbound/LAs sections; check LA channel then lead-calls. */
export async function fetchPhoneDutyTopic(firm) {
  const channelIds = [
    firm.slackLegalAssistantChannelId,
    firm.slackLeadCallsChannelId,
  ].filter(Boolean);
  let fallback = null;
  for (const channelId of channelIds) {
    const topic = await fetchChannelTopicValue(firm, channelId);
    if (topic == null) continue;
    const parsed = parsePhoneDutyTopic(topic);
    if (parsed.inbound.length || parsed.las.length) return topic;
    if (fallback == null && topic) fallback = topic;
  }
  return fallback;
}

function dutyTopicExclusionReason(roster, slackUserId) {
  const id = String(slackUserId || "").toUpperCase();
  if (!id) return "not on today's topic";
  if ((roster?.attorney || []).some((x) => String(x).toUpperCase() === id)) {
    return "attorney today";
  }
  return "not on today's topic";
}

/**
 * During business hours, people listed under Inbound, Outbound, or LAs on today's
 * channel topic are eligible to be Available / escalated. Attorney is excluded.
 * After-hours coverage is unchanged. If the topic is missing or empty, keep
 * the existing phoneStaff schedule.
 */
function dutySectionForId(roster, slackUserId) {
  const id = String(slackUserId || "").toUpperCase();
  if ((roster?.inbound || []).some((x) => String(x).toUpperCase() === id)) return "inbound";
  if ((roster?.outbound || []).some((x) => String(x).toUpperCase() === id)) return "outbound";
  if ((roster?.las || []).some((x) => String(x).toUpperCase() === id)) return "las";
  if ((roster?.attorney || []).some((x) => String(x).toUpperCase() === id)) return "attorney";
  return null;
}

export function applyDutyTopicFilter(rows, roster, { enforce = true } = {}) {
  if (!enforce || !roster?.hasRoster) return rows || [];
  return (rows || []).map((row) => {
    if (row.afterHoursDuty || row.state === "after_hours") return row;
    if (row.state === "off_shift" || row.state === "unknown") return row;
    const id = String(row.slackUserId || "").toUpperCase();
    const dutySection = dutySectionForId(roster, id);
    if (roster.answerIds.has(id)) {
      return { ...row, dutySection: dutySection || row.dutySection || null };
    }
    return {
      ...row,
      state: "off_topic",
      tag: false,
      dutySection,
      statusText: dutyTopicExclusionReason(roster, id),
    };
  });
}

/**
 * Slack user IDs that count for Available-missed metrics / inbound tagging.
 * Prefer today's topic Inbound ∪ LAs; otherwise everyone on shift in the snapshot.
 */
export function dutySlackUserIdsFromSnapshot(rows, roster, { enforce = false } = {}) {
  if (enforce && roster?.hasRoster) return [...roster.answerIds];
  const ids = [];
  for (const r of rows || []) {
    if (!r?.slackUserId) continue;
    if (r.state === "off_shift" || r.state === "unknown" || r.state === "off_topic") continue;
    ids.push(r.slackUserId);
  }
  return [...new Set(ids)];
}

/**
 * Snapshot each configured phone-staff member at the moment of a missed/Sona call.
 * Tag people who were on shift (or the after-hours person), Slack-active, not on
 * a call, not behind a blocking status, and (by day) on the channel topic roster.
 * Returns { rows, dutyRoster, dutySlackUserIds }.
 */
export async function snapshotPhoneStaffAvailability(firm, { now = new Date() } = {}) {
  const staff = firm.phoneStaff || [];
  if (!staff.length) return { rows: [], dutyRoster: null, dutySlackUserIds: [] };

  const onCall = onCallSlackUserIds(firm);
  const hoursConfigured = hoursAreConfigured(staff);
  const officeCovered = isOfficeCovered(staff, now);
  const topicPromise = fetchPhoneDutyTopic(firm);
  const rows = [];
  for (const person of staff) {
    const [presence, status] = await Promise.all([
      getPresence(firm, person.slackUserId),
      getSlackStatus(firm, person.slackUserId),
    ]);
    rows.push(classifyPhoneStaffMember(person, {
      presence,
      statusText: status.statusText,
      statusEmoji: status.statusEmoji,
      onCall: onCall.has(person.slackUserId),
      now,
      officeCovered,
      hoursConfigured,
    }));
  }

  const topic = await topicPromise;
  const parsed = parsePhoneDutyTopic(topic);
  const roster = resolvePhoneDutyRoster(parsed, firm.slackUsers, staff);
  // Only enforce the daily topic while someone's scheduled shift covers now
  // (business-hours phone coverage). After-hours Jackie stays as-is.
  const enforce = officeCovered && roster.hasRoster;
  if (topic != null) {
    console.log(
      `[${firm.id}][phone-staff] duty topic roster inbound=${roster.inbound.length} ` +
      `las=${roster.las.length} answerIds=${roster.answerIds.size} enforce=${enforce}` +
      (topic ? ` raw="${String(topic).slice(0, 120)}"` : ""),
    );
  } else {
    console.warn(`[${firm.id}][phone-staff] duty topic unavailable — not filtering by roster`);
  }
  const filtered = applyDutyTopicFilter(rows, roster, { enforce });
  const dutySlackUserIds = dutySlackUserIdsFromSnapshot(filtered, roster, { enforce });
  return { rows: filtered, dutyRoster: roster, dutySlackUserIds };
}

const FAST_HANGUP_SECONDS = 5;

function warningName(row, { mention = false } = {}) {
  const base = mention ? `<@${row.slackUserId}>` : (row.name || row.slackUserId);
  const notes = [];
  if (row.state === "inactive") notes.push("inactive");
  if (row.dutySection === "outbound") notes.push("outbound");
  const who = notes.length ? `${base} (${notes.join(", ")})` : base;
  // :warning: (not a green check) — these people should have answered.
  return `:warning: ${who}`;
}

function checkedNames(rows, { mention = false } = {}) {
  return rows.map((r) => warningName(r, { mention })).join("\n");
}

function plainStatus(row) {
  if (row.state === "on_call") return "on a call";
  if (row.state === "off_topic") return row.statusText || "not on today's topic";
  if (row.state === "inactive" || row.state === "away") return "inactive";
  return row.statusText || "unavailable";
}

/**
 * Split a snapshot by how long the caller waited.
 * ringSeconds null means the ring time is unknown, so everyone on duty counts.
 * Under 5s nobody "should have answered". People with ringAfterSeconds only
 * count as available once the call rang at least that long.
 */
export function isFreeToAnswer(row) {
  // Slack-active (or after-hours coverage) — preferred for first-round tags.
  // Break / lunch / huddle / translating / off-topic stay unavailable.
  return row.state === "available" || row.state === "after_hours";
}

/**
 * Counts for Available Missed metrics: on-topic active + on-topic inactive.
 * Off-topic / status / on-call never count.
 */
export function countsTowardAvailableMissed(row) {
  return row.state === "available" || row.state === "after_hours" || row.state === "inactive";
}

export function noticeGroups(snapshot, ringSeconds = null) {
  const fast = ringSeconds != null && ringSeconds < FAST_HANGUP_SECONDS;
  // Show off-topic as unavailable; hide only true off-shift / unknown.
  const visible = (snapshot || []).filter(
    (r) => r.state !== "off_shift" && r.state !== "unknown",
  );
  const free = visible.filter(isFreeToAnswer);
  const inactiveDuty = visible.filter((r) => r.state === "inactive");
  const context = visible.filter((r) => !isFreeToAnswer(r) && r.state !== "inactive");
  const rang = (r) => ringSeconds == null || ringSeconds >= (Number(r.ringAfterSeconds) || 0);
  const couldAnswer = free.filter(rang);
  const callbackOnly = free.filter((r) => !rang(r));
  const inactiveAccountable = inactiveDuty.filter(rang);
  const inactiveCallback = inactiveDuty.filter((r) => !rang(r));
  // On-topic inactive still counts as Available Missed (tagged last).
  const accountable = fast ? [] : [...couldAnswer, ...inactiveAccountable];
  return {
    fast,
    couldAnswer,
    callbackOnly,
    inactiveAccountable,
    inactiveCallback,
    context,
    accountable,
  };
}

function formatRingDuration(ringSeconds) {
  if (ringSeconds == null || !Number.isFinite(ringSeconds) || ringSeconds < 0) return "";
  const secs = Math.round(ringSeconds);
  return secs === 1 ? "1s" : `${secs}s`;
}

export function formatAvailabilitySlackBlock(snapshot, { ringSeconds = null } = {}) {
  const {
    fast,
    couldAnswer,
    callbackOnly,
    inactiveAccountable,
    inactiveCallback,
    context,
  } = noticeGroups(snapshot, ringSeconds);
  const lines = [];
  const ringLabel = formatRingDuration(ringSeconds);
  if (ringLabel) lines.push(`_Rang for ${ringLabel}_`);
  const warnActive = [...couldAnswer, ...callbackOnly, ...inactiveAccountable, ...inactiveCallback];
  const afterHoursOnly = warnActive.length > 0
    && warnActive.every((r) => r.afterHoursDuty || r.state === "after_hours");
  if (fast) {
    const who = [...couldAnswer, ...callbackOnly, ...inactiveAccountable, ...inactiveCallback];
    if (who.length) {
      lines.push(`*Caller hung up, please call back:*\n${checkedNames(who, { mention: afterHoursOnly })}`);
    }
  } else {
    const availableLines = [...couldAnswer, ...inactiveAccountable];
    if (availableLines.length) {
      lines.push(`*Available to answer (active, not on a call):*\n${checkedNames(availableLines, { mention: afterHoursOnly })}`);
    }
    const callbackLines = [...callbackOnly, ...inactiveCallback];
    if (callbackLines.length) {
      lines.push(`*Please call back:*\n${checkedNames(callbackLines, { mention: false })}`);
    }
  }
  for (const row of context) {
    lines.push(`:no_entry_sign: ${row.name || row.slackUserId} (${plainStatus(row)})`);
  }
  if (!lines.length) return "";
  return `\n\n${lines.join("\n")}`;
}

export function availableFromSnapshot(snapshot) {
  return (snapshot || []).filter((r) => r.tag || isFreeToAnswer(r));
}

/**
 * Persist a missed/Sona availability snapshot for daily reports.
 * Uses the router's Postgres pool when available; no-ops otherwise.
 */
export async function recordAvailabilityEvent(pgPool, firm, {
  callId,
  eventType,
  snapshot,
  dutySlackUserIds = null,
  occurredAt = new Date(),
} = {}) {
  if (!pgPool || !firm || !snapshot?.length) return null;
  const available = snapshot
    .filter((r) => (r.accountable != null ? r.accountable : (r.tag || r.state === "available")))
    .map((r) => r.slackUserId);
  const onCall = snapshot.filter((r) => r.state === "on_call").map((r) => r.slackUserId);
  const away = snapshot.filter((r) => r.state === "away" || r.state === "inactive").map((r) => r.slackUserId);
  const duty = Array.isArray(dutySlackUserIds)
    ? [...new Set(dutySlackUserIds.filter(Boolean))]
    : dutySlackUserIdsFromSnapshot(snapshot, null, { enforce: false });
  try {
    // Deduplicate when both the call-check fallback and /call-summary fire for
    // the same Quo call (common for Sona). Null call_id always inserts.
    const { rows } = await pgPool.query(
      `INSERT INTO phone_availability_events
         (firm_id, call_id, event_type, occurred_at,
          available_slack_user_ids, on_call_slack_user_ids, away_slack_user_ids,
          duty_slack_user_ids, staff_snapshot)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
       ON CONFLICT (firm_id, call_id, event_type) WHERE call_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        firm.id,
        callId || null,
        eventType || "missed",
        occurredAt,
        JSON.stringify(available),
        JSON.stringify(onCall),
        JSON.stringify(away),
        JSON.stringify(duty),
        JSON.stringify(snapshot),
      ],
    );
    if (!rows.length) {
      console.log(`[${firm.id}][phone-staff] Availability event already recorded for ${callId} (${eventType})`);
      return null;
    }
    console.log(
      `[${firm.id}][phone-staff] Recorded ${eventType} availability event #${rows[0].id} ` +
        `(available=${available.length}, duty=${duty.length}, on_call=${onCall.length}, away=${away.length})`,
    );
    return rows[0].id;
  } catch (err) {
    console.error(`[${firm.id}][phone-staff] Failed to record availability event:`, err.message);
    return null;
  }
}

/** Aggregate stored availability events into report metrics (topic duty roster included). */
export function summarizeAvailabilityMisses(rows) {
  const byUser = new Map();
  const ensureUser = (uid, snapshot) => {
    const id = String(uid || "");
    if (!id) return null;
    const snap = (snapshot || []).find((s) => s.slackUserId === id);
    let cur = byUser.get(id);
    if (!cur) {
      cur = { slackUserId: id, name: snap?.name || id, count: 0, onDuty: false };
      byUser.set(id, cur);
    }
    if (snap?.name) cur.name = snap.name;
    return cur;
  };

  let availableButDidNotAnswerCount = 0;
  let eventsWithAvailableStaff = 0;
  for (const row of rows || []) {
    const snapshot = row.staff_snapshot || row.staffSnapshot || [];
    const duty = Array.isArray(row.duty_slack_user_ids)
      ? row.duty_slack_user_ids
      : (Array.isArray(row.dutySlackUserIds) ? row.dutySlackUserIds : null);
    const availableRaw = Array.isArray(row.available_slack_user_ids)
      ? row.available_slack_user_ids
      : (Array.isArray(row.availableSlackUserIds) ? row.availableSlackUserIds : []);
    // When a duty roster was stored (daily Slack topic), only those users count.
    const dutySet = duty?.length ? new Set(duty.map(String)) : null;
    const available = dutySet
      ? availableRaw.filter((uid) => dutySet.has(String(uid)))
      : availableRaw;

    if (duty?.length) {
      for (const uid of duty) {
        const cur = ensureUser(uid, snapshot);
        if (cur) cur.onDuty = true;
      }
    }
    if (available.length) {
      eventsWithAvailableStaff += 1;
      availableButDidNotAnswerCount += available.length;
    }
    for (const uid of available) {
      const cur = ensureUser(uid, snapshot);
      if (!cur) continue;
      cur.count += 1;
      if (dutySet) cur.onDuty = true;
    }
  }

  return {
    eventsWithAvailableStaff,
    availableButDidNotAnswerCount,
    byUser: [...byUser.values()].sort(
      (a, b) => b.count - a.count || Number(b.onDuty) - Number(a.onDuty) || String(a.name).localeCompare(String(b.name)),
    ),
  };
}

export async function queryAvailabilityMisses(pgPool, firmId, { createdAfter, createdBefore } = {}) {
  if (!pgPool) return null;
  const params = [firmId];
  let where = "firm_id = $1";
  if (createdAfter) {
    params.push(createdAfter);
    where += ` AND occurred_at >= $${params.length}`;
  }
  if (createdBefore) {
    params.push(createdBefore);
    where += ` AND occurred_at < $${params.length}`;
  }
  const { rows } = await pgPool.query(
    `SELECT id, call_id, event_type, occurred_at,
            available_slack_user_ids, on_call_slack_user_ids, away_slack_user_ids,
            duty_slack_user_ids, staff_snapshot
     FROM phone_availability_events
     WHERE ${where}
     ORDER BY occurred_at ASC`,
    params,
  );

  const summary = summarizeAvailabilityMisses(rows);
  return {
    firmId,
    createdAfter: createdAfter || null,
    createdBefore: createdBefore || null,
    eventCount: rows.length,
    eventsWithAvailableStaff: summary.eventsWithAvailableStaff,
    availableButDidNotAnswerCount: summary.availableButDidNotAnswerCount,
    byUser: summary.byUser,
    events: rows.map((r) => ({
      id: r.id,
      callId: r.call_id,
      eventType: r.event_type,
      occurredAt: r.occurred_at,
      availableSlackUserIds: r.available_slack_user_ids,
      onCallSlackUserIds: r.on_call_slack_user_ids,
      awaySlackUserIds: r.away_slack_user_ids,
      dutySlackUserIds: r.duty_slack_user_ids,
      staffSnapshot: r.staff_snapshot,
    })),
  };
}

/**
 * After an inbound call starts ringing, poll Quo until someone answers (or the
 * call ends / we time out). When a configured phone-staff member answers, set
 * their Slack status to "On a call".
 */
export function startAnswerWatch(firm, {
  callId,
  fetchCall,
  onAnswered,
  onEnded,
} = {}) {
  if (!firm || !callId || !fetchCall) return;
  if (!firm.answerWatchTimers) firm.answerWatchTimers = new Map();
  if (firm.answerWatchTimers.has(callId)) return; // already watching

  const started = Date.now();
  let stopped = false;
  let permanentFailLogged = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    const tid = firm.answerWatchTimers.get(callId);
    if (tid) clearTimeout(tid);
    firm.answerWatchTimers.delete(callId);
  };

  const tick = async () => {
    if (stopped) return;
    if (Date.now() - started > ANSWER_POLL_MAX_MS) {
      console.log(`[${firm.id}][phone-staff] Answer watch timed out for ${callId}`);
      stop();
      return;
    }
    try {
      const call = await fetchCall(firm, callId);
      // Quo returns null on 400 "too many participants" and similar — polling
      // will never recover. Fall back to webhook-driven status updates only.
      if (call?.__unsupported) {
        if (!permanentFailLogged) {
          permanentFailLogged = true;
          console.log(
            `[${firm.id}][phone-staff] Answer watch stopped for ${callId} — Quo API cannot fetch this call (${call.reason || "unsupported"}). Will rely on webhook answeredBy.`,
          );
        }
        stop();
        return;
      }
      if (!call) {
        schedule();
        return;
      }
      const status = String(call.status || "").toLowerCase();
      const answeredBy = call.answeredBy || null;

      if (answeredBy && !isSonaAnsweredBy(answeredBy)) {
        if (onAnswered) await onAnswered({ callId, answeredBy, call });
        // Keep watching until the call leaves in-progress so we clear status.
      }

      const terminal = ["completed", "no-answer", "busy", "canceled", "failed", "cancelled"].includes(status);
      if (terminal) {
        if (onEnded) await onEnded({ callId, answeredBy, call, status });
        stop();
        return;
      }
    } catch (err) {
      console.warn(`[${firm.id}][phone-staff] Answer watch error for ${callId}:`, err.message);
    }
    schedule();
  };

  const schedule = () => {
    if (stopped) return;
    const tid = setTimeout(tick, ANSWER_POLL_MS);
    firm.answerWatchTimers.set(callId, tid);
  };

  console.log(`[${firm.id}][phone-staff] Watching ${callId} for answer → Slack on-call status`);
  // First poll soon after ringing — people often answer within a few seconds.
  const tid = setTimeout(tick, 2_000);
  firm.answerWatchTimers.set(callId, tid);
}

export function stopAnswerWatch(firm, callId) {
  if (!firm?.answerWatchTimers?.has(callId)) return;
  clearTimeout(firm.answerWatchTimers.get(callId));
  firm.answerWatchTimers.delete(callId);
}

export async function ensureAvailabilityTable(pgPool) {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS phone_availability_events (
      id BIGSERIAL PRIMARY KEY,
      firm_id TEXT NOT NULL,
      call_id TEXT,
      event_type TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      available_slack_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      on_call_slack_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      away_slack_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      duty_slack_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      staff_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS phone_availability_events_firm_time_idx
      ON phone_availability_events (firm_id, occurred_at)
  `);
  await pgPool.query(`
    CREATE INDEX IF NOT EXISTS phone_availability_events_call_idx
      ON phone_availability_events (call_id)
  `);
  await pgPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS phone_availability_events_firm_call_type_uidx
      ON phone_availability_events (firm_id, call_id, event_type)
      WHERE call_id IS NOT NULL
  `);
  await pgPool.query(`
    ALTER TABLE phone_availability_events
      ADD COLUMN IF NOT EXISTS duty_slack_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb
  `);
}

/**
 * Append availability info to a missed/Sona Slack body, record the event, and
 * return { text, snapshot }.
 */
export async function attachAvailabilityToNotice(pgPool, firm, text, {
  callId,
  eventType,
  ringSeconds = null,
} = {}) {
  if (!firm.phoneStaff?.length) return { text, snapshot: [] };
  const { rows: raw, dutySlackUserIds } = await snapshotPhoneStaffAvailability(firm);
  const { accountable } = noticeGroups(raw, ringSeconds);
  const accountableIds = new Set(accountable.map((r) => r.slackUserId));
  const snapshot = raw.map((r) => ({ ...r, accountable: accountableIds.has(r.slackUserId) }));
  const block = formatAvailabilitySlackBlock(snapshot, { ringSeconds });
  await recordAvailabilityEvent(pgPool, firm, {
    callId,
    eventType,
    snapshot,
    dutySlackUserIds,
  });
  return { text: text + block, snapshot };
}
