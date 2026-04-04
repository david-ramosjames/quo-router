import express from "express";

const app = express();
app.use(express.json());

// --- Environment ---
const PORT = process.env.PORT || 3000;
const QUO_API_KEY = process.env.QUO_API_KEY;
const SLACK_TEXT_MESSAGES_WEBHOOK_URL = process.env.SLACK_TEXT_MESSAGES_WEBHOOK_URL;
const SLACK_MISSED_CALLS_WEBHOOK_URL = process.env.SLACK_MISSED_CALLS_WEBHOOK_URL;
const SLACK_HUMAN_CALLS_WEBHOOK_URL = process.env.SLACK_HUMAN_CALLS_WEBHOOK_URL;
const SLACK_SONA_CALLS_WEBHOOK_URL = process.env.SLACK_SONA_CALLS_WEBHOOK_URL;
const SLACK_LEAD_CALLS_WEBHOOK_URL = process.env.SLACK_LEAD_CALLS_WEBHOOK_URL;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_LEAD_CALLS_CHANNEL_ID = process.env.SLACK_LEAD_CALLS_CHANNEL_ID;

// --- Phone line mapping ---
const PHONE_LINES = {
  "+15125373369": "RJL Main Line",
  "+19563137771": "RGV Number",
  "+15126010647": "Intake",
  "+15125005266": "RJL Outbound",
  "+15126300907": "RJL Transfers",
};

// --- Quo Contacts Cache ---
const contactsCache = new Map();
const CONTACTS_REFRESH_INTERVAL = 10 * 60 * 1000;

async function loadQuoContacts() {
  if (!QUO_API_KEY) {
    console.warn("[contacts] QUO_API_KEY not set — skipping contact sync");
    return;
  }

  console.log("[contacts] Fetching contacts from Quo API...");
  let totalLoaded = 0;
  let pageToken = null;

  try {
    do {
      const url = new URL("https://api.openphone.com/v1/contacts");
      url.searchParams.set("maxResults", "50");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url.toString(), {
        headers: { Authorization: QUO_API_KEY },
      });

      if (!res.ok) {
        console.error(`[contacts] Quo API responded ${res.status}: ${await res.text()}`);
        break;
      }

      const json = await res.json();
      const contacts = json.data || [];

      for (const contact of contacts) {
        const firstName = contact.defaultFields?.firstName || "";
        const lastName = contact.defaultFields?.lastName || "";
        const name = `${firstName} ${lastName}`.trim();
        if (!name) continue;

        const phoneNumbers = contact.defaultFields?.phoneNumbers || [];
        for (const phone of phoneNumbers) {
          if (phone.value) {
            contactsCache.set(phone.value, name);
          }
        }
      }

      totalLoaded += contacts.length;
      pageToken = json.nextPageToken || null;
    } while (pageToken);

    console.log(`[contacts] Loaded ${totalLoaded} contacts, ${contactsCache.size} phone numbers mapped`);
  } catch (err) {
    console.error("[contacts] Error fetching contacts:", err.message);
  }
}

function getContactName(phoneNumber) {
  if (!phoneNumber) return null;
  return contactsCache.get(phoneNumber) || null;
}

// --- In-memory call cache ---
const callCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function cacheCall(callId, info) {
  callCache.set(callId, { ...info, cachedAt: Date.now() });
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

function formatPhone(number) {
  const num = safe(number);
  const lineName = PHONE_LINES[num];
  return lineName ? `${lineName} (${num})` : num;
}

function formatFrom(phoneNumber) {
  const num = safe(phoneNumber);
  const contactName = getContactName(num);
  if (contactName) return `${contactName} (${num})`;
  return formatPhone(num);
}

// Strip the "+" and any non-digit chars to get just digits for matching
function normalizePhone(phone) {
  if (!phone) return "";
  return phone.replace(/\D/g, "");
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

// --- Slack Bot API for #lead-calls threading ---

async function findThreadByPhone(phoneNumber) {
  if (!SLACK_BOT_TOKEN || !SLACK_LEAD_CALLS_CHANNEL_ID || !phoneNumber) return null;

  const normalized = normalizePhone(phoneNumber);
  if (!normalized) return null;

  try {
    // Search recent messages in #lead-calls (last 7 days worth, up to 200 messages)
    const url = new URL("https://slack.com/api/conversations.history");
    url.searchParams.set("channel", SLACK_LEAD_CALLS_CHANNEL_ID);
    url.searchParams.set("limit", "200");
    // Look back 7 days
    const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    url.searchParams.set("oldest", String(sevenDaysAgo));

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });

    if (!res.ok) {
      console.error(`[lead-thread] Slack API responded ${res.status}`);
      return null;
    }

    const json = await res.json();
    if (!json.ok) {
      console.error(`[lead-thread] Slack API error: ${json.error}`);
      return null;
    }

    // Search messages for the phone number (check both +1... and raw digits)
    for (const msg of json.messages || []) {
      const msgText = msg.text || "";
      if (msgText.includes(phoneNumber) || msgText.includes(normalized)) {
        // Return the thread_ts — use existing thread parent, or the message ts itself
        console.log(`[lead-thread] Found matching message for ${phoneNumber} (ts: ${msg.thread_ts || msg.ts})`);
        return msg.thread_ts || msg.ts;
      }
    }

    console.log(`[lead-thread] No existing thread found for ${phoneNumber}`);
    return null;
  } catch (err) {
    console.error("[lead-thread] Error searching for thread:", err.message);
    return null;
  }
}

async function postLeadToSlack(text, phoneNumber) {
  // If we have bot token + channel ID, use the Slack API with threading
  if (SLACK_BOT_TOKEN && SLACK_LEAD_CALLS_CHANNEL_ID) {
    try {
      const threadTs = await findThreadByPhone(phoneNumber);

      const body = {
        channel: SLACK_LEAD_CALLS_CHANNEL_ID,
        text,
      };
      if (threadTs) {
        body.thread_ts = threadTs;
        console.log(`[lead-calls] Replying in thread ${threadTs}`);
      }

      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const json = await res.json();
      if (!json.ok) {
        console.error(`[lead-calls] Slack API error: ${json.error}`);
        // Fall back to webhook
        await postToSlack(SLACK_LEAD_CALLS_WEBHOOK_URL, text);
      } else {
        console.log(`[lead-calls] Posted via Slack API (threaded: ${!!threadTs})`);
      }
    } catch (err) {
      console.error("[lead-calls] Slack API error:", err.message);
      await postToSlack(SLACK_LEAD_CALLS_WEBHOOK_URL, text);
    }
  } else {
    // Fall back to webhook if no bot token
    await postToSlack(SLACK_LEAD_CALLS_WEBHOOK_URL, text);
  }
}

// --- Detection ---

function isSonaCall(payload, cached) {
  const handledBy = extractField(payload, "data.object.handledBy", "data.handledBy");
  if (handledBy && String(handledBy).toLowerCase().includes("sona")) return true;

  const source = extractField(payload, "data.object.source", "data.source");
  if (source && String(source).toLowerCase().includes("sona")) return true;

  const agent = extractField(payload, "data.object.agent", "data.agent");
  if (agent && String(agent).toLowerCase().includes("sona")) return true;

  const sonaSummary = extractField(payload, "data.object.sona_summary", "data.object.sonaSummary", "data.sona_summary");
  if (sonaSummary) return true;

  const jobs = extractField(payload, "data.object.jobs");
  if (Array.isArray(jobs) && jobs.length > 0) return true;

  if (cached?.answeredBy) {
    const ab = String(cached.answeredBy);
    if (ab.toLowerCase().includes("sona")) return true;
    if (ab.startsWith("SY")) return true;
  }

  const combinedText = extractText(payload);
  const sonaPatterns = [
    "this is sona", "i'm sona", "hi, i'm sona", "i am sona",
    "ai assistant", "ai receptionist", "virtual assistant", "virtual receptionist",
    "automated assistant",
  ];
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
    const from = safe(extractField(payload, "data.object.from", "data.from", "from"));
    const to = safe(extractField(payload, "data.object.to", "data.to", "to"));
    const body = safe(extractField(payload, "data.object.body", "data.body", "body", "data.object.message", "data.message"));

    const fromDisplay = formatFrom(from);
    const toDisplay = formatPhone(to);
    const text = `💬 New Text Message\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nMessage: ${body}`;

    console.log(`[messages] From: ${fromDisplay} → To: ${toDisplay}`);
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
    const obj = payload.data?.object || {};
    const callId = obj.id || null;
    const from = safe(obj.from);
    const to = safe(obj.to);
    const status = (obj.status || "").toLowerCase();
    const voicemail = obj.voicemail || null;
    const direction = obj.direction || "";
    const answeredAt = obj.answeredAt || null;
    const eventType = (payload.type || "").toLowerCase();

    // Cache call info for call-summary lookup later
    if (callId) {
      cacheCall(callId, { from: obj.from, to: obj.to, direction, answeredBy: obj.answeredBy, userId: obj.userId });
      console.log(`[calls] Cached call ${callId}: ${from} → ${to} (status: ${status}, answeredAt: ${answeredAt || "none"}, answeredBy: ${obj.answeredBy || "none"})`);
    }

    // Skip ringing events
    if (eventType === "call.ringing" || status === "ringing") {
      console.log(`[calls] Ringing — waiting for completion`);
      return;
    }

    // Detect missed calls
    const isMissedStatus = ["no-answer", "busy", "canceled", "failed"].includes(status);
    const isUnanswered = status === "completed" && !answeredAt && direction === "incoming";
    const hasVoicemail = voicemail && (typeof voicemail === "string" ? voicemail : voicemail.url);

    if (!isMissedStatus && !isUnanswered && !hasVoicemail) {
      console.log(`[calls] Skipping answered call (status: ${status}) — not missed`);
      return;
    }

    const fromDisplay = formatFrom(from);
    const toDisplay = formatPhone(to);
    let text = `📞 Missed Call / Voicemail\nFrom: ${fromDisplay}\nTo: ${toDisplay}`;
    if (hasVoicemail) {
      const vmUrl = typeof voicemail === "string" ? voicemail : voicemail.url;
      text += `\nVoicemail: ${vmUrl}`;
    }

    console.log(`[calls] Missed call from: ${fromDisplay}`);
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
    const obj = payload.data?.object || {};
    const callId = obj.callId || null;
    const deepLink = payload.data?.deepLink || null;

    const cached = callId ? getCachedCall(callId) : null;
    const from = safe(cached?.from);
    const to = safe(cached?.to);

    const rawSummary = obj.summary;
    const summary = Array.isArray(rawSummary) ? rawSummary.join("\n") : safe(rawSummary);

    const sona = isSonaCall(payload, cached);
    const lead = isLeadCall(payload);

    const fromDisplay = formatFrom(from);
    const toDisplay = formatPhone(to);

    console.log(`[call-summary] From: ${fromDisplay} | To: ${toDisplay} | Sona: ${sona} | Lead: ${lead}`);

    const linkLine = deepLink ? `\nLink: ${deepLink}` : "";
    if (sona) {
      const text = `🤖 Sona Call Completed\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary: ${summary}\nLead: ${lead ? "Yes" : "No"}${linkLine}`;
      await postToSlack(SLACK_SONA_CALLS_WEBHOOK_URL, text);
      console.log("[call-summary] Sent to #sona-calls");
    } else {
      const text = `📞 Human Call Completed\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary: ${summary}\nLead: ${lead ? "Yes" : "No"}${linkLine}`;
      await postToSlack(SLACK_HUMAN_CALLS_WEBHOOK_URL, text);
      console.log("[call-summary] Sent to #human-calls");
    }

    if (lead) {
      const handledBy = sona ? "Sona" : "Human";
      const leadText = `🔥 Potential Lead Call\nHandled By: ${handledBy}\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary: ${summary}${linkLine}`;
      await postLeadToSlack(leadText, from);
      console.log("[call-summary] ALSO sent to #lead-calls");
    }
  } catch (err) {
    console.error("[call-summary] Error:", err.message);
  }
});

// --- Start ---
loadQuoContacts().then(() => {
  app.listen(PORT, () => {
    console.log(`Quo Slack Router listening on port ${PORT}`);
  });

  setInterval(loadQuoContacts, CONTACTS_REFRESH_INTERVAL);
});
