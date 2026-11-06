// Phone-staff availability: Quo → Slack "On a call" status, and tagging who
// should have answered a missed / Sona call.
//
// Configured per firm via `phoneStaff`:
//   [{ name, slackUserId, quoUserId?, windows?, afterHours?, timezone? }]
// Only this subset is tracked — attorneys / others are ignored.
//
// Tag someone only when all of these are true:
//   - not already on a call
//   - no Slack status that takes them off the phones (lunch, break, meeting, …)
//   - the miss happened during their scheduled hours, or they are the
//     after-hours person and nobody's shift covers that moment
//   - Slack presence is active, or (once hours are set) away/offline with no status
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
];

const BLOCKING_EMOJI = new Set([
  "palm_tree", "airplane", "zzz", "hamburger", "bento", "fork_and_knife",
  "beach_with_umbrella", "face_with_thermometer", "no_entry", "no_entry_sign", "sleeping",
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
        scheduleError: schedule.error,
      });
      continue;
    }
    out.push({
      name,
      slackUserId,
      quoUserId,
      afterHours: !!schedule.afterHours,
      windows: schedule.windows,
      timezone: entry.timezone || tzDefault || (schedule.windows.length || schedule.afterHours ? DEFAULT_PHONE_STAFF_TZ : null),
    });
  }
  return out;
}

function normalizeSchedule(entry) {
  if (entry.scheduleError) return { error: entry.scheduleError };
  if (Array.isArray(entry.windows) || entry.afterHours) {
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
    return { afterHours: !!entry.afterHours, windows };
  }
  if (typeof entry.schedule === "string") return parseStaffSchedule(entry.schedule);
  return { afterHours: false, windows: [] };
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

export function parseStaffSchedule(text) {
  const raw = String(text || "").trim();
  if (!raw) return { afterHours: false, windows: [] };
  let afterHours = false;
  const rest = raw
    .replace(/\bafter[-\s]?hours\b/ig, () => { afterHours = true; return " "; })
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[|;\s]+|[|;\s]+$/g, "");
  if (!rest) return { afterHours, windows: [] };
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
  return { afterHours, windows };
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
    return { ...base, state: "after_hours", afterHoursDuty: true, presence, tag: true };
  }
  if (presence === "active") return { ...base, state: "available", tag: true };
  if (presence === "away" && hoursConfigured) return { ...base, state: "inactive", tag: true };
  if (presence === "away") return { ...base, state: "away", tag: false };
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

export async function setSlackOnCallStatus(firm, slackUserId, { callId } = {}) {
  if (!firm.slackUserToken) {
    console.log(`[${firm.id}][phone-staff] No SLACK_USER_TOKEN — skipping on-call status for ${slackUserId}`);
    return false;
  }
  if (!slackUserId) return false;

  // Already tracking this user on this call — don't overwrite again.
  const existing = firm.onCallByCallId?.get(callId);
  if (existing?.slackUserId === slackUserId) return true;

  const profile = await getSlackProfile(firm, slackUserId);
  const previous = profile
    ? {
        status_text: profile.status_text || "",
        status_emoji: profile.status_emoji || "",
        status_expiration: profile.status_expiration || 0,
      }
    : { status_text: "", status_emoji: "", status_expiration: 0 };

  // Don't clobber if they're already showing our on-call status from another call.
  const alreadyOurs =
    previous.status_text === ON_CALL_STATUS_TEXT &&
    previous.status_emoji === ON_CALL_STATUS_EMOJI;

  try {
    if (!alreadyOurs) {
      const json = await slackApi(firm.slackUserToken, "users.profile.set", {
        user: slackUserId,
        profile: {
          status_text: ON_CALL_STATUS_TEXT,
          status_emoji: ON_CALL_STATUS_EMOJI,
          status_expiration: 0,
        },
      });
      if (!json.ok) {
        console.error(`[${firm.id}][phone-staff] users.profile.set failed for ${slackUserId}: ${json.error}`);
        return false;
      }
    }
    if (!firm.onCallByCallId) firm.onCallByCallId = new Map();
    firm.onCallByCallId.set(callId, {
      slackUserId,
      previous: alreadyOurs ? (firm.onCallByCallId.get(callId)?.previous || previous) : previous,
      setAt: Date.now(),
    });
    const person = findPhoneStaffBySlackUser(firm, slackUserId);
    console.log(`[${firm.id}][phone-staff] Set on-call status for ${person?.name || slackUserId} (call ${callId})`);
    return true;
  } catch (err) {
    console.error(`[${firm.id}][phone-staff] set status error:`, err.message);
    return false;
  }
}

export async function clearSlackOnCallStatus(firm, callId) {
  if (!callId || !firm.onCallByCallId?.has(callId)) return false;
  const entry = firm.onCallByCallId.get(callId);
  firm.onCallByCallId.delete(callId);

  // Another live call still owns this user's status — leave it alone.
  for (const other of firm.onCallByCallId.values()) {
    if (other.slackUserId === entry.slackUserId) {
      console.log(`[${firm.id}][phone-staff] ${entry.slackUserId} still on another call — keeping status`);
      return false;
    }
  }

  if (!firm.slackUserToken) return false;
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
 * Snapshot each configured phone-staff member at the moment of a missed/Sona call.
 * Tag people who were on shift (or the after-hours person), not on a call, and
 * not behind a blocking Slack status.
 */
export async function snapshotPhoneStaffAvailability(firm, { now = new Date() } = {}) {
  const staff = firm.phoneStaff || [];
  if (!staff.length) return [];

  const onCall = onCallSlackUserIds(firm);
  const hoursConfigured = hoursAreConfigured(staff);
  const officeCovered = isOfficeCovered(staff, now);
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
  return rows;
}

export function formatAvailabilitySlackBlock(snapshot, { header = "Phone staff at time of call" } = {}) {
  if (!snapshot?.length) return "";
  const lines = snapshot.map((row) => {
    const mention = `<@${row.slackUserId}>`;
    if (row.state === "available") return `✅ ${mention} (active)`;
    if (row.state === "inactive") return `💤 ${mention} (inactive during shift, no status)`;
    if (row.state === "on_call") return `📞 ${mention} (on a call)`;
    if (row.state === "status") return `🚫 ${mention} (status: ${row.statusText || "unavailable"})`;
    if (row.state === "off_shift") {
      const why = row.statusText === "no hours set" ? "no hours set"
        : row.statusText === "after hours only" ? "after hours only"
        : "outside scheduled hours";
      return `⏸️ ${mention} (${why})`;
    }
    if (row.state === "after_hours") {
      const extra = row.presence === "away" ? ", inactive" : row.presence === "active" ? ", active" : "";
      return `🌙 ${mention} (after hours${extra})`;
    }
    if (row.state === "away") return `💤 ${mention} (away)`;
    return `❓ ${mention} (presence unknown)`;
  });
  const tagged = snapshot.filter((r) => r.tag);
  let footer = "";
  if (tagged.length) {
    const tags = tagged.map((r) => `<@${r.slackUserId}>`).join(" ");
    footer = tagged.every((r) => r.afterHoursDuty)
      ? `\n🌙 After hours: ${tags}`
      : `\n⚠️ Should have answered: ${tags}`;
  }
  return `\n\n📊 *${header}:*\n${lines.join("\n")}${footer}`;
}

export function availableFromSnapshot(snapshot) {
  return (snapshot || []).filter((r) => r.tag || r.state === "available");
}

/**
 * Persist a missed/Sona availability snapshot for daily reports.
 * Uses the router's Postgres pool when available; no-ops otherwise.
 */
export async function recordAvailabilityEvent(pgPool, firm, {
  callId,
  eventType,
  snapshot,
  occurredAt = new Date(),
} = {}) {
  if (!pgPool || !firm || !snapshot?.length) return null;
  const available = snapshot.filter((r) => r.tag || r.state === "available").map((r) => r.slackUserId);
  const onCall = snapshot.filter((r) => r.state === "on_call").map((r) => r.slackUserId);
  const away = snapshot.filter((r) => r.state === "away").map((r) => r.slackUserId);
  try {
    // Deduplicate when both the call-check fallback and /call-summary fire for
    // the same Quo call (common for Sona). Null call_id always inserts.
    const { rows } = await pgPool.query(
      `INSERT INTO phone_availability_events
         (firm_id, call_id, event_type, occurred_at,
          available_slack_user_ids, on_call_slack_user_ids, away_slack_user_ids, staff_snapshot)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
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
        JSON.stringify(snapshot),
      ],
    );
    if (!rows.length) {
      console.log(`[${firm.id}][phone-staff] Availability event already recorded for ${callId} (${eventType})`);
      return null;
    }
    console.log(
      `[${firm.id}][phone-staff] Recorded ${eventType} availability event #${rows[0].id} ` +
        `(available=${available.length}, on_call=${onCall.length}, away=${away.length})`,
    );
    return rows[0].id;
  } catch (err) {
    console.error(`[${firm.id}][phone-staff] Failed to record availability event:`, err.message);
    return null;
  }
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
            available_slack_user_ids, on_call_slack_user_ids, away_slack_user_ids, staff_snapshot
     FROM phone_availability_events
     WHERE ${where}
     ORDER BY occurred_at ASC`,
    params,
  );

  const byUser = new Map();
  let availableButDidNotAnswerCount = 0;
  let eventsWithAvailableStaff = 0;
  for (const row of rows) {
    const available = Array.isArray(row.available_slack_user_ids) ? row.available_slack_user_ids : [];
    if (available.length) {
      eventsWithAvailableStaff += 1;
      availableButDidNotAnswerCount += available.length;
    }
    for (const uid of available) {
      const snap = (row.staff_snapshot || []).find((s) => s.slackUserId === uid);
      const cur = byUser.get(uid) || { slackUserId: uid, name: snap?.name || uid, count: 0 };
      cur.count += 1;
      if (snap?.name) cur.name = snap.name;
      byUser.set(uid, cur);
    }
  }

  return {
    firmId,
    createdAfter: createdAfter || null,
    createdBefore: createdBefore || null,
    eventCount: rows.length,
    eventsWithAvailableStaff,
    availableButDidNotAnswerCount,
    byUser: [...byUser.values()].sort((a, b) => b.count - a.count),
    events: rows.map((r) => ({
      id: r.id,
      callId: r.call_id,
      eventType: r.event_type,
      occurredAt: r.occurred_at,
      availableSlackUserIds: r.available_slack_user_ids,
      onCallSlackUserIds: r.on_call_slack_user_ids,
      awaySlackUserIds: r.away_slack_user_ids,
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
}

/**
 * Append availability info to a missed/Sona Slack body, record the event, and
 * return { text, snapshot }.
 */
export async function attachAvailabilityToNotice(pgPool, firm, text, {
  callId,
  eventType,
} = {}) {
  if (!firm.phoneStaff?.length) return { text, snapshot: [] };
  const snapshot = await snapshotPhoneStaffAvailability(firm);
  const block = formatAvailabilitySlackBlock(snapshot);
  await recordAvailabilityEvent(pgPool, firm, { callId, eventType, snapshot });
  return { text: text + block, snapshot };
}
