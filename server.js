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

// --- Slack Channels + Users Cache ---
const slackChannels = new Map(); // channelName → { id, topic }
const slackUsers = new Map(); // lowercaseDisplayName → userId

async function loadSlackChannels() {
  if (!SLACK_BOT_TOKEN) return;

  console.log("[slack] Loading channels...");
  let cursor = "";
  let total = 0;

  try {
    do {
      const url = new URL("https://slack.com/api/conversations.list");
      url.searchParams.set("types", "public_channel,private_channel");
      url.searchParams.set("limit", "200");
      url.searchParams.set("exclude_archived", "true");
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      });
      const json = await res.json();
      if (!json.ok) {
        console.error(`[slack] channels error: ${json.error}`);
        break;
      }

      for (const ch of json.channels || []) {
        slackChannels.set(ch.name, { id: ch.id, topic: ch.topic?.value || "" });
      }

      total += (json.channels || []).length;
      cursor = json.response_metadata?.next_cursor || "";
    } while (cursor);

    console.log(`[slack] Loaded ${total} channels`);
  } catch (err) {
    console.error("[slack] Error loading channels:", err.message);
  }
}

async function loadSlackUsers() {
  if (!SLACK_BOT_TOKEN) return;

  console.log("[slack] Loading users...");
  let cursor = "";
  let total = 0;

  try {
    do {
      const url = new URL("https://slack.com/api/users.list");
      url.searchParams.set("limit", "200");
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      });
      const json = await res.json();
      if (!json.ok) {
        console.error(`[slack] users error: ${json.error}`);
        break;
      }

      for (const user of json.members || []) {
        if (user.deleted || user.is_bot) continue;
        const displayName = (user.profile?.display_name || "").toLowerCase().trim();
        const realName = (user.real_name || "").toLowerCase().trim();
        const firstName = (user.profile?.first_name || "").toLowerCase().trim();

        if (displayName) slackUsers.set(displayName, user.id);
        if (realName) slackUsers.set(realName, user.id);
        if (firstName) slackUsers.set(firstName, user.id);
      }

      total += (json.members || []).length;
      cursor = json.response_metadata?.next_cursor || "";
    } while (cursor);

    console.log(`[slack] Loaded ${total} users, ${slackUsers.size} name mappings`);
  } catch (err) {
    console.error("[slack] Error loading users:", err.message);
  }
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
  if (lineName) return `${lineName} (${num})`;
  const contactName = getContactName(num);
  if (contactName) return `${contactName} (${num})`;
  return num;
}

function formatFrom(phoneNumber) {
  const num = safe(phoneNumber);
  const contactName = getContactName(num);
  if (contactName) return `${contactName} (${num})`;
  return formatPhone(num);
}

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

// --- Spanish Detection + Translation ---

const SPANISH_WORDS = [
  "hola", "gracias", "por favor", "buenos", "buenas", "días", "tardes", "noches",
  "cómo", "está", "estoy", "llamar", "llamando", "accidente", "abogado", "número",
  "necesito", "ayuda", "puede", "quiero", "tiene", "cuando", "donde", "porque",
  "también", "pero", "para", "como", "desde", "sobre", "entre", "después",
  "antes", "aquí", "ahora", "muy", "más", "menos", "mejor", "usted",
  "nosotros", "ellos", "mensaje", "teléfono", "oficina", "caso",
];

function isSpanish(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Check for Spanish-specific characters
  const hasSpecialChars = /[áéíóúñ¿¡ü]/.test(lower);
  // Count Spanish word matches
  const wordCount = SPANISH_WORDS.filter((w) => lower.includes(w)).length;
  return hasSpecialChars || wordCount >= 2;
}

async function translateToEnglish(text) {
  try {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "es");
    url.searchParams.set("tl", "en");
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", text);

    const res = await fetch(url.toString());
    if (!res.ok) return null;

    const json = await res.json();
    // Response format: [[["translated text","original text",...],...],...]
    const translated = (json[0] || []).map((part) => part[0]).join("");
    return translated || null;
  } catch (err) {
    console.error("[translate] Error:", err.message);
    return null;
  }
}

async function appendTranslation(text) {
  if (!isSpanish(text)) return "";
  const translated = await translateToEnglish(text);
  if (translated) {
    return `\n🌐 Translation: ${translated}`;
  }
  return "";
}

// --- Slack Posting ---

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

async function postViaBot(channelId, text) {
  if (!SLACK_BOT_TOKEN) return false;
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: channelId, text }),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`[slack-bot] Error posting to ${channelId}: ${json.error}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[slack-bot] Error:`, err.message);
    return false;
  }
}

// --- Lead-calls threading ---

async function findThreadByPhone(phoneNumber) {
  if (!SLACK_BOT_TOKEN || !SLACK_LEAD_CALLS_CHANNEL_ID || !phoneNumber) return null;

  const normalized = normalizePhone(phoneNumber);
  if (!normalized) return null;

  try {
    const url = new URL("https://slack.com/api/conversations.history");
    url.searchParams.set("channel", SLACK_LEAD_CALLS_CHANNEL_ID);
    url.searchParams.set("limit", "200");
    const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    url.searchParams.set("oldest", String(sevenDaysAgo));

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });

    const json = await res.json();
    if (!json.ok) {
      console.error(`[lead-thread] Slack API error: ${json.error}`);
      return null;
    }

    for (const msg of json.messages || []) {
      const msgText = msg.text || "";
      if (msgText.includes(phoneNumber) || msgText.includes(normalized)) {
        console.log(`[lead-thread] Found matching message for ${phoneNumber} (ts: ${msg.thread_ts || msg.ts})`);
        return msg.thread_ts || msg.ts;
      }
    }

    return null;
  } catch (err) {
    console.error("[lead-thread] Error:", err.message);
    return null;
  }
}

async function postLeadToSlack(text, phoneNumber) {
  if (SLACK_BOT_TOKEN && SLACK_LEAD_CALLS_CHANNEL_ID) {
    try {
      const threadTs = await findThreadByPhone(phoneNumber);
      const body = { channel: SLACK_LEAD_CALLS_CHANNEL_ID, text };
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
        await postToSlack(SLACK_LEAD_CALLS_WEBHOOK_URL, text);
      } else {
        console.log(`[lead-calls] Posted via Slack API (threaded: ${!!threadTs})`);
      }
    } catch (err) {
      console.error("[lead-calls] Slack API error:", err.message);
      await postToSlack(SLACK_LEAD_CALLS_WEBHOOK_URL, text);
    }
  } else {
    await postToSlack(SLACK_LEAD_CALLS_WEBHOOK_URL, text);
  }
}

// --- Case Channel Routing ---

function extractCaseInfo(contactName) {
  if (!contactName) return null;
  // Match "Name 1234" pattern — case number at end
  const match = contactName.match(/^(.+?)\s+(\d{3,})$/);
  if (!match) return null;
  const name = match[1].trim();
  const caseNumber = match[2];
  // Channel format: lowercase name, no spaces, hyphen, case number
  const channelName = name.toLowerCase().replace(/[^a-z0-9]/g, "") + "-" + caseNumber;
  return { name, caseNumber, channelName };
}

function extractMentionsFromTopic(topic) {
  if (!topic) return "";
  // Find @Name mentions in the topic
  const mentions = [];
  const atMatches = topic.match(/@(\w+)/g);
  if (!atMatches) return "";

  for (const atName of atMatches) {
    const name = atName.slice(1).toLowerCase(); // remove @
    const userId = slackUsers.get(name);
    if (userId) {
      mentions.push(`<@${userId}>`);
    }
  }
  return mentions.length > 0 ? mentions.join(" ") + "\n" : "";
}

async function postToCaseChannel(text, phoneFrom, phoneTo) {
  if (!SLACK_BOT_TOKEN) return;

  // Check both from and to numbers for a contact with a case number
  const phones = [phoneFrom, phoneTo].filter(Boolean);

  for (const phone of phones) {
    const contactName = getContactName(phone);
    const caseInfo = extractCaseInfo(contactName);
    if (!caseInfo) continue;

    const channel = slackChannels.get(caseInfo.channelName);
    if (!channel) {
      console.log(`[case-channel] No channel found for #${caseInfo.channelName}`);
      continue;
    }

    // Get mentions from channel topic
    const mentions = extractMentionsFromTopic(channel.topic);
    const caseText = mentions + text;

    const ok = await postViaBot(channel.id, caseText);
    if (ok) {
      console.log(`[case-channel] Posted to #${caseInfo.channelName}${mentions ? " with mentions" : ""}`);
    }
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

    // Translate if Spanish
    const translation = await appendTranslation(body);

    const text = `💬 New Text Message\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nMessage: ${body}${translation}`;

    console.log(`[messages] From: ${fromDisplay} → To: ${toDisplay}`);
    await postToSlack(SLACK_TEXT_MESSAGES_WEBHOOK_URL, text);
    console.log("[messages] Sent to #text-messages");

    // Post to case channel if applicable
    await postToCaseChannel(text, from, to);
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

    // Post to case channel if applicable
    await postToCaseChannel(text, from, to);
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
    const summary = Array.isArray(rawSummary) ? "• " + rawSummary.join("\n• ") : safe(rawSummary);

    const sona = isSonaCall(payload, cached);
    const lead = isLeadCall(payload);

    const fromDisplay = formatFrom(from);
    const toDisplay = formatPhone(to);

    // Translate summary if Spanish
    const summaryText = Array.isArray(rawSummary) ? rawSummary.join(" ") : (rawSummary || "");
    const translation = await appendTranslation(summaryText);

    console.log(`[call-summary] From: ${fromDisplay} | To: ${toDisplay} | Sona: ${sona} | Lead: ${lead}`);

    const linkLine = deepLink ? `\n<${deepLink}|View in Quo>` : "";
    let text;
    if (sona) {
      text = `🤖 Sona Call Completed\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}\nLead: ${lead ? "Yes" : "No"}${linkLine}`;
      await postToSlack(SLACK_SONA_CALLS_WEBHOOK_URL, text);
      console.log("[call-summary] Sent to #sona-calls");
    } else {
      text = `🧑 Human Call Completed\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}\nLead: ${lead ? "Yes" : "No"}${linkLine}`;
      await postToSlack(SLACK_HUMAN_CALLS_WEBHOOK_URL, text);
      console.log("[call-summary] Sent to #human-calls");
    }

    if (lead) {
      const handledBy = sona ? "Sona" : "Human";
      const leadText = `🔥 Potential Lead Call\nHandled By: ${handledBy}\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}${linkLine}`;
      await postLeadToSlack(leadText, from);
      console.log("[call-summary] ALSO sent to #lead-calls");
    }

    // Post to case channel if applicable
    await postToCaseChannel(text, from, to);
  } catch (err) {
    console.error("[call-summary] Error:", err.message);
  }
});

// --- Start ---
Promise.all([loadQuoContacts(), loadSlackChannels(), loadSlackUsers()]).then(() => {
  app.listen(PORT, () => {
    console.log(`Quo Slack Router listening on port ${PORT}`);
  });

  // Refresh caches periodically
  setInterval(loadQuoContacts, CONTACTS_REFRESH_INTERVAL);
  setInterval(loadSlackChannels, CONTACTS_REFRESH_INTERVAL);
  setInterval(loadSlackUsers, CONTACTS_REFRESH_INTERVAL);
});
