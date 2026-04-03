import express from "express";

const app = express();
app.use(express.json());

// --- Environment ---
const PORT = process.env.PORT || 3000;
const SLACK_TEXT_MESSAGES_WEBHOOK_URL = process.env.SLACK_TEXT_MESSAGES_WEBHOOK_URL;
const SLACK_MISSED_CALLS_WEBHOOK_URL = process.env.SLACK_MISSED_CALLS_WEBHOOK_URL;
const SLACK_HUMAN_CALLS_WEBHOOK_URL = process.env.SLACK_HUMAN_CALLS_WEBHOOK_URL;
const SLACK_SONA_CALLS_WEBHOOK_URL = process.env.SLACK_SONA_CALLS_WEBHOOK_URL;
const SLACK_LEAD_CALLS_WEBHOOK_URL = process.env.SLACK_LEAD_CALLS_WEBHOOK_URL;

// --- In-memory call cache ---
// call.completed fires before call.summary.completed, so we cache from/to/line info
// keyed by callId, auto-expires after 10 minutes
const callCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function cacheCall(callId, info) {
  callCache.set(callId, { ...info, cachedAt: Date.now() });
  // Clean up old entries
  for (const [key, val] of callCache) {
    if (Date.now() - val.cachedAt > CACHE_TTL) callCache.delete(key);
  }
}

function getCachedCall(callId) {
  const entry = callCache.get(callId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL) {
    callCache.delete(callId);
    return null;
  }
  return entry;
}

// --- Helpers ---

function safe(val) {
  if (val === null || val === undefined) return "N/A";
  if (Array.isArray(val)) return val.join(" ") || "N/A";
  return String(val).trim() || "N/A";
}

function extractField(payload, ...paths) {
  for (const path of paths) {
    const parts = path.split(".");
    let current = payload;
    for (const part of parts) {
      if (current == null) break;
      current = current[part];
    }
    if (current !== null && current !== undefined && current !== "") {
      return current;
    }
  }
  return null;
}

function extractText(payload) {
  const summary = extractField(payload, "data.object.summary", "data.summary", "summary") || "";
  const transcript = extractField(payload, "data.object.transcript", "data.transcript", "transcript") || "";
  const body = extractField(payload, "data.object.body", "data.body", "body") || "";

  // Handle arrays (Quo sends summary as an array of strings)
  const parts = [summary, transcript, body].map((v) =>
    Array.isArray(v) ? v.join(" ") : String(v)
  );
  return parts.join(" ").toLowerCase();
}

async function postToSlack(webhookUrl, text) {
  if (!webhookUrl) {
    console.error("Slack webhook URL not configured");
    return;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`Slack responded ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error("Error posting to Slack:", err.message);
  }
}

// --- Detection ---

function isSonaCall(payload) {
  const handledBy = extractField(payload, "data.object.handledBy", "data.handledBy");
  if (handledBy && String(handledBy).toLowerCase().includes("sona")) return true;

  const source = extractField(payload, "data.object.source", "data.source");
  if (source && String(source).toLowerCase().includes("sona")) return true;

  const agent = extractField(payload, "data.object.agent", "data.agent");
  if (agent && String(agent).toLowerCase().includes("sona")) return true;

  const answeredBy = extractField(payload, "data.object.answeredBy");
  if (answeredBy && String(answeredBy).toLowerCase().includes("sona")) return true;

  const combinedText = extractText(payload);
  const sonaPatterns = ["this is sona", "i'm sona", "hi, i'm sona", "i am sona"];
  for (const pattern of sonaPatterns) {
    if (combinedText.includes(pattern)) return true;
  }

  return false;
}

function isLeadCall(payload) {
  const text = extractText(payload);
  if (!text) return false;

  const positiveSignals = [
    "accident", "injury", "injured", "hurt", "truck", "18-wheeler",
    "crash", "collision", "rear-ended", "hit", "insurance", "hospital",
    "ambulance", "pain",
  ];

  const negativeSignals = [
    "wrong number", "spam", "sales", "job", "employment",
    "recruiting", "vendor", "marketing", "existing client",
  ];

  const hasNegative = negativeSignals.some((s) => text.includes(s));
  if (hasNegative) return false;

  const hasPositive = positiveSignals.some((s) => text.includes(s));
  return hasPositive;
}

// --- Routes ---

app.get("/", (_req, res) => {
  res.send("Quo Slack Router Running");
});

app.post("/webhooks/quo/messages", async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const payload = req.body || {};
    console.log("[messages] RAW PAYLOAD:", JSON.stringify(payload, null, 2));

    const from = safe(extractField(payload, "data.object.from", "data.from", "from"));
    const to = safe(extractField(payload, "data.object.to", "data.to", "to"));
    const body = safe(extractField(payload, "data.object.body", "data.body", "body", "data.object.message", "data.message"));

    const text = `💬 New Text Message\nFrom: ${from}\nTo: ${to}\nMessage: ${body}`;

    console.log(`[messages] From: ${from} → To: ${to}`);
    await postToSlack(SLACK_TEXT_MESSAGES_WEBHOOK_URL, text);
    console.log("[messages] Sent to #text-messages");
  } catch (err) {
    console.error("[messages] Error:", err.message);
  }
});

app.post("/webhooks/quo/calls", async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const payload = req.body || {};
    console.log("[calls] RAW PAYLOAD:", JSON.stringify(payload, null, 2));

    const obj = payload.data?.object || {};
    const callId = obj.id || null;
    const from = safe(obj.from);
    const to = safe(obj.to);
    const status = (obj.status || "").toLowerCase();
    const voicemail = obj.voicemail || null;
    const direction = obj.direction || "";

    // Cache call info for call-summary lookup later
    if (callId) {
      cacheCall(callId, { from: obj.from, to: obj.to, direction });
      console.log(`[calls] Cached call ${callId}: ${from} → ${to}`);
    }

    // Only send to #missed-calls if it was actually missed or has a voicemail
    const isMissed = ["no-answer", "busy", "canceled", "failed"].includes(status);
    const hasVoicemail = voicemail && (typeof voicemail === "string" ? voicemail : voicemail.url);

    if (!isMissed && !hasVoicemail) {
      console.log(`[calls] Skipping completed call (status: ${status}) — not missed`);
      return;
    }

    let text = `📞 Missed Call / Voicemail\nFrom: ${from}\nTo: ${to}`;
    if (hasVoicemail) {
      const vmUrl = typeof voicemail === "string" ? voicemail : voicemail.url;
      text += `\nVoicemail: ${vmUrl}`;
    }

    console.log(`[calls] Missed call from: ${from}`);
    await postToSlack(SLACK_MISSED_CALLS_WEBHOOK_URL, text);
    console.log("[calls] Sent to #missed-calls-voicemail");
  } catch (err) {
    console.error("[calls] Error:", err.message);
  }
});

app.post("/webhooks/quo/call-summary", async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const payload = req.body || {};
    console.log("[call-summary] RAW PAYLOAD:", JSON.stringify(payload, null, 2));

    const obj = payload.data?.object || {};
    const callId = obj.callId || null;
    const deepLink = payload.data?.deepLink || null;

    // Get from/to from cached call.completed event
    const cached = callId ? getCachedCall(callId) : null;
    const from = safe(cached?.from);
    const to = safe(cached?.to);

    // Summary is an array of strings in Quo
    const rawSummary = obj.summary;
    const summary = Array.isArray(rawSummary) ? rawSummary.join("\n") : safe(rawSummary);

    const sona = isSonaCall(payload);
    const lead = isLeadCall(payload);

    console.log(`[call-summary] From: ${from} | To: ${to} | Sona: ${sona} | Lead: ${lead}`);

    // 1. Always post to base channel
    const linkLine = deepLink ? `\nLink: ${deepLink}` : "";
    if (sona) {
      const text = `🤖 Sona Call Completed\nFrom: ${from}\nTo: ${to}\nSummary: ${summary}\nLead: ${lead ? "Yes" : "No"}${linkLine}`;
      await postToSlack(SLACK_SONA_CALLS_WEBHOOK_URL, text);
      console.log("[call-summary] Sent to #sona-calls");
    } else {
      const text = `📞 Human Call Completed\nFrom: ${from}\nTo: ${to}\nSummary: ${summary}\nLead: ${lead ? "Yes" : "No"}${linkLine}`;
      await postToSlack(SLACK_HUMAN_CALLS_WEBHOOK_URL, text);
      console.log("[call-summary] Sent to #human-calls");
    }

    // 2. If lead, ALSO send to #lead-calls
    if (lead) {
      const handledBy = sona ? "Sona" : "Human";
      const leadText = `🔥 Potential Lead Call\nHandled By: ${handledBy}\nFrom: ${from}\nTo: ${to}\nSummary: ${summary}${linkLine}`;
      await postToSlack(SLACK_LEAD_CALLS_WEBHOOK_URL, leadText);
      console.log("[call-summary] ALSO sent to #lead-calls");
    }
  } catch (err) {
    console.error("[call-summary] Error:", err.message);
  }
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Quo Slack Router listening on port ${PORT}`);
});
