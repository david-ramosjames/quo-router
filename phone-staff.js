// Phone-staff availability: Quo → Slack "On a call" status, and tagging who
// was available (but did not answer) on missed / Sona calls.
//
// Configured per firm via `phoneStaff`:
//   [{ name, slackUserId, quoUserId? }]
// Only this subset is tracked — attorneys / others are ignored.

const ON_CALL_STATUS_TEXT = "On a call";
const ON_CALL_STATUS_EMOJI = ":phone:";
const ANSWER_POLL_MS = 5_000;
const ANSWER_POLL_MAX_MS = 3 * 60_000; // stop watching after 3 minutes of ringing

export function normalizePhoneStaff(config) {
  const raw = config?.phoneStaff;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const slackUserId = String(entry.slackUserId || entry.slack_user_id || "").trim();
    if (!/^U[A-Z0-9]+$/i.test(slackUserId)) continue;
    const name = String(entry.name || entry.displayName || slackUserId).trim();
    const quoUserId = String(entry.quoUserId || entry.quo_user_id || "").trim() || null;
    out.push({ name, slackUserId, quoUserId });
  }
  return out;
}

export function parsePhoneStaffText(text) {
  // One person per line: Name=SLACK_ID[=QUO_ID]  or  Name,SLACK_ID[,QUO_ID]
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    let name, slackUserId, quoUserId;
    if (line.includes("=")) {
      const parts = line.split("=").map((p) => p.trim());
      [name, slackUserId, quoUserId] = parts;
    } else {
      const parts = line.split(/[,\t]/).map((p) => p.trim());
      [name, slackUserId, quoUserId] = parts;
    }
    if (!slackUserId) continue;
    out.push({
      name: name || slackUserId,
      slackUserId,
      quoUserId: quoUserId || null,
    });
  }
  return normalizePhoneStaff({ phoneStaff: out });
}

export function formatPhoneStaffText(staff) {
  return (staff || [])
    .map((p) => (p.quoUserId ? `${p.name}=${p.slackUserId}=${p.quoUserId}` : `${p.name}=${p.slackUserId}`))
    .join("\n");
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

/**
 * Snapshot each configured phone-staff member at the moment of a missed/Sona call.
 * A person is "available" when Slack presence is active AND they are not on a call
 * (tracked by this router).
 */
export async function snapshotPhoneStaffAvailability(firm) {
  const staff = firm.phoneStaff || [];
  if (!staff.length) return [];

  const onCall = onCallSlackUserIds(firm);
  const rows = [];
  for (const person of staff) {
    let state;
    if (onCall.has(person.slackUserId)) {
      state = "on_call";
    } else {
      const presence = await getPresence(firm, person.slackUserId);
      if (presence === "active") state = "available";
      else if (presence === "away") state = "away";
      else state = "unknown";
    }
    rows.push({
      name: person.name,
      slackUserId: person.slackUserId,
      quoUserId: person.quoUserId,
      state,
    });
  }
  return rows;
}

export function formatAvailabilitySlackBlock(snapshot, { header = "Phone staff at time of call" } = {}) {
  if (!snapshot?.length) return "";
  const lines = snapshot.map((row) => {
    const mention = `<@${row.slackUserId}>`;
    if (row.state === "available") return `✅ ${mention} (active, available)`;
    if (row.state === "on_call") return `📞 ${mention} (on a call)`;
    if (row.state === "away") return `💤 ${mention} (away)`;
    return `❓ ${mention} (presence unknown)`;
  });
  const available = snapshot.filter((r) => r.state === "available");
  let footer = "";
  if (available.length) {
    const tags = available.map((r) => `<@${r.slackUserId}>`).join(" ");
    footer = `\n⚠️ ${available.length} available but did not answer: ${tags}`;
  }
  return `\n\n📊 *${header}:*\n${lines.join("\n")}${footer}`;
}

export function availableFromSnapshot(snapshot) {
  return (snapshot || []).filter((r) => r.state === "available");
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
  const available = snapshot.filter((r) => r.state === "available").map((r) => r.slackUserId);
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
