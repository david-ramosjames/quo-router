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

// Extract the last 10 digits of a phone number for flexible matching
function lastTenDigits(phone) {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function searchChannelHistoryForPhone(messages, phoneNumber) {
  const last10 = lastTenDigits(phoneNumber);
  const normalized = normalizePhone(phoneNumber);
  if (!last10) return null;

  for (const msg of messages) {
    const msgText = msg.text || "";
    // Extract all digit sequences from the message and check for match
    const msgDigits = msgText.match(/\d{7,}/g) || [];
    for (const seq of msgDigits) {
      const seqLast10 = seq.length >= 10 ? seq.slice(-10) : seq;
      if (seqLast10 === last10) {
        console.log(`[lead-thread] Found phone match in message (ts: ${msg.thread_ts || msg.ts})`);
        return msg.thread_ts || msg.ts;
      }
    }
    // Also check raw string includes
    if (msgText.includes(phoneNumber) || msgText.includes(normalized) || msgText.includes(last10)) {
      console.log(`[lead-thread] Found string match in message (ts: ${msg.thread_ts || msg.ts})`);
      return msg.thread_ts || msg.ts;
    }
  }
  return null;
}

async function fetchLeadChannelHistory() {
  if (!SLACK_BOT_TOKEN || !SLACK_LEAD_CALLS_CHANNEL_ID) return [];

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
      return [];
    }
    return json.messages || [];
  } catch (err) {
    console.error("[lead-thread] Error fetching history:", err.message);
    return [];
  }
}

async function findThreadByPhone(phoneNumber) {
  if (!SLACK_BOT_TOKEN || !SLACK_LEAD_CALLS_CHANNEL_ID || !phoneNumber) return null;

  // First attempt
  let messages = await fetchLeadChannelHistory();
  let threadTs = searchChannelHistoryForPhone(messages, phoneNumber);
  if (threadTs) return threadTs;

  // Race condition: CallRail/Meta/Website may post at nearly the same time
  // Wait 5 seconds and try again
  console.log(`[lead-thread] No thread found for ${phoneNumber}, retrying in 5s...`);
  await new Promise((r) => setTimeout(r, 5000));

  messages = await fetchLeadChannelHistory();
  threadTs = searchChannelHistoryForPhone(messages, phoneNumber);
  if (threadTs) return threadTs;

  console.log(`[lead-thread] No thread found for ${phoneNumber} after retry`);
  return null;
}

async function postLeadToSlack(text, phoneFrom, phoneTo) {
  if (SLACK_BOT_TOKEN && SLACK_LEAD_CALLS_CHANNEL_ID) {
    try {
      // Search for thread matching either the from or to number
      const phones = [phoneFrom, phoneTo].filter(Boolean);
      let threadTs = null;

      for (const phone of phones) {
        // Skip our own phone lines — only search for the external party
        if (PHONE_LINES[phone]) continue;
        threadTs = await findThreadByPhone(phone);
        if (threadTs) break;
      }

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

function extractCaseNumber(contactName) {
  if (!contactName) return null;
  // Match "Name 1234" pattern — case number at end
  const match = contactName.match(/^(.+?)\s+(\d{3,})$/);
  if (!match) return null;
  return match[2];
}

function findChannelByCaseNumber(caseNumber) {
  // Search all cached channels for one ending with the case number
  for (const [name, info] of slackChannels) {
    if (name.endsWith("-" + caseNumber) || name.endsWith(caseNumber)) {
      return { name, ...info };
    }
  }
  return null;
}

async function joinChannel(channelId) {
  try {
    const res = await fetch("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: channelId }),
    });
    const json = await res.json();
    if (!json.ok && json.error !== "already_in_channel") {
      console.error(`[case-channel] Failed to join channel: ${json.error}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[case-channel] Error joining channel:`, err.message);
    return false;
  }
}

function extractMentionsFromTopic(topic) {
  if (!topic) return "";

  // Slack stores mentions as <@U12345> in the topic via API
  const userIdMatches = topic.match(/<@(U[A-Z0-9]+)>/g);
  if (userIdMatches && userIdMatches.length > 0) {
    console.log(`[mentions] Found ${userIdMatches.length} user mentions in topic`);
    return userIdMatches.join(" ") + "\n";
  }

  // Fallback: try @Name patterns and resolve via users cache
  const atMatches = topic.match(/@(\w+)/g);
  if (!atMatches) {
    console.log(`[mentions] No mentions found in topic: "${topic}"`);
    return "";
  }

  const mentions = [];
  for (const atName of atMatches) {
    const name = atName.slice(1).toLowerCase();
    const userId = slackUsers.get(name);
    if (userId) {
      mentions.push(`<@${userId}>`);
    } else {
      console.log(`[mentions] Could not resolve "${name}" to a Slack user`);
    }
  }

  if (mentions.length > 0) {
    console.log(`[mentions] Resolved ${mentions.length}/${atMatches.length} mentions`);
  }
  return mentions.length > 0 ? mentions.join(" ") + "\n" : "";
}

async function postToCaseChannel(text, phoneFrom, phoneTo) {
  if (!SLACK_BOT_TOKEN) return;

  const phones = [phoneFrom, phoneTo].filter(Boolean);

  for (const phone of phones) {
    const contactName = getContactName(phone);
    const caseNumber = extractCaseNumber(contactName);
    if (!caseNumber) continue;

    // Try to find channel by case number
    let channel = findChannelByCaseNumber(caseNumber);

    // If not found, refresh cache and try again
    if (!channel) {
      console.log(`[case-channel] No cached channel for case ${caseNumber}, refreshing...`);
      await loadSlackChannels();
      channel = findChannelByCaseNumber(caseNumber);
    }

    if (!channel) {
      console.log(`[case-channel] No channel found for case ${caseNumber}`);
      continue;
    }

    // Auto-join the channel
    const joined = await joinChannel(channel.id);
    if (!joined) continue;

    // Get mentions from channel topic
    const mentions = extractMentionsFromTopic(channel.topic);
    const caseText = mentions + text;

    const ok = await postViaBot(channel.id, caseText);
    if (ok) {
      console.log(`[case-channel] Posted to #${channel.name}${mentions ? " with mentions" : ""}`);
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

// Check if a phone number belongs to an existing client (has a case number)
function isExistingClient(phoneNumber) {
  const contactName = getContactName(phoneNumber);
  return !!extractCaseNumber(contactName);
}

// Lead = anyone seeking ANY type of legal help
// Qualified Lead = situation the firm may be able to help with (PI, auto, workplace, etc.)
// Existing clients (contact with case number) are NOT leads
function classifyLead(payload, phoneFrom, phoneTo) {
  // If either party is an existing client, not a lead
  const phones = [phoneFrom, phoneTo].filter(Boolean);
  for (const phone of phones) {
    if (PHONE_LINES[phone]) continue; // skip our own lines
    if (isExistingClient(phone)) {
      console.log(`[lead] Skipping — existing client: ${getContactName(phone)}`);
      return { isLead: false, isQualified: false, label: "No (Existing Client)" };
    }
  }

  const text = extractText(payload);
  if (!text) return { isLead: false, isQualified: false, label: "No" };

  const negativeSignals = [
    "wrong number", "spam", "sales", "job", "employment",
    "recruiting", "vendor", "marketing", "existing client",
    "soliciting", "cold call",
  ];

  const hasNegative = negativeSignals.some((s) => text.includes(s));
  if (hasNegative) return { isLead: false, isQualified: false, label: "No" };

  // Broad lead signals — anyone looking for legal help
  const leadSignals = [
    "lawyer", "attorney", "legal", "law firm", "lawsuit", "sue",
    "case", "claim", "represent", "representation", "consultation",
    "consult", "help me", "need help", "looking for help",
    "advice", "rights", "compensation", "damages", "settlement",
    "negligence", "liability", "fault", "incident", "police report",
    "medical", "doctor", "treatment", "surgery",
    "new client", "potential client", "intake",
    "referral", "referred",
  ];

  // Qualified lead signals — PI / auto / workplace situations
  const qualifiedSignals = [
    "accident", "injury", "injured", "hurt", "truck", "18-wheeler",
    "crash", "collision", "rear-ended", "hit", "insurance", "hospital",
    "ambulance", "pain", "wreck", "car accident", "auto accident",
    "motorcycle", "pedestrian", "slip", "fall", "fell",
    "workplace", "work injury", "on the job", "workers comp",
    "wrongful death", "death", "killed", "fatality",
    "drunk driver", "dui", "hit and run",
    "broken", "fracture", "spinal", "brain", "concussion",
    "disability", "disabled", "paralyz",
  ];

  const hasQualified = qualifiedSignals.some((s) => text.includes(s));
  if (hasQualified) return { isLead: true, isQualified: true, label: "🔥 Qualified Lead" };

  const hasLead = leadSignals.some((s) => text.includes(s));
  if (hasLead) return { isLead: true, isQualified: false, label: "Lead" };

  return { isLead: false, isQualified: false, label: "No" };
}

// --- Routes ---

app.get("/", (_req, res) => {
  res.send("Quo Slack Router Running");
});

app.post("/webhooks/quo/messages", async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const payload = req.body || {};
    const obj = payload.data?.object || {};
    const from = safe(extractField(payload, "data.object.from", "data.from", "from"));
    const to = safe(extractField(payload, "data.object.to", "data.to", "to"));
    const body = safe(extractField(payload, "data.object.body", "data.body", "body", "data.object.message", "data.message"));
    const direction = obj.direction || "";
    const eventType = (payload.type || "").toLowerCase();

    const isOutbound = direction === "outgoing" || eventType === "message.delivered";
    const emoji = isOutbound ? "📤" : "💬";
    const label = isOutbound ? "Outbound Text Message" : "New Text Message";

    const fromDisplay = formatFrom(from);
    const toDisplay = formatPhone(to);

    // Extract media/attachments (photos, files)
    const media = obj.media || [];
    const mediaLines = media
      .map((m) => {
        const url = m.url || m;
        const type = m.type || "attachment";
        return typeof url === "string" ? `📎 <${url}|${type}>` : null;
      })
      .filter(Boolean);
    const mediaSection = mediaLines.length > 0 ? "\n" + mediaLines.join("\n") : "";

    // Translate if Spanish
    const translation = await appendTranslation(body);

    const text = `${emoji} ${label}\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nMessage: ${body}${mediaSection}${translation}`;

    console.log(`[messages] From: ${fromDisplay} → To: ${toDisplay} (media: ${media.length})`);
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
    const { isLead, isQualified, label: leadLabel } = classifyLead(payload, from, to);

    const fromDisplay = formatFrom(from);
    const toDisplay = formatPhone(to);

    // Translate summary if Spanish
    const summaryText = Array.isArray(rawSummary) ? rawSummary.join(" ") : (rawSummary || "");
    const translation = await appendTranslation(summaryText);

    console.log(`[call-summary] From: ${fromDisplay} | To: ${toDisplay} | Sona: ${sona} | Lead: ${leadLabel}`);

    const linkLine = deepLink ? `\n<${deepLink}|View in Quo>` : "";
    let text;
    if (sona) {
      text = `🤖 Sona Call Completed\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}\nLead: ${leadLabel}${linkLine}`;
      await postToSlack(SLACK_SONA_CALLS_WEBHOOK_URL, text);
      console.log("[call-summary] Sent to #sona-calls");
    } else {
      text = `🧑 Human Call Completed\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}\nLead: ${leadLabel}${linkLine}`;
      await postToSlack(SLACK_HUMAN_CALLS_WEBHOOK_URL, text);
      console.log("[call-summary] Sent to #human-calls");
    }

    // Send ALL leads (qualified or not) to #lead-calls
    if (isLead) {
      const handledBy = sona ? "Sona" : "Human";
      const qualTag = isQualified ? "🔥 Qualified Lead Call" : "📋 Lead Call";
      const leadText = `${qualTag}\nHandled By: ${handledBy}\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}${linkLine}`;
      await postLeadToSlack(leadText, from, to);
      console.log(`[call-summary] ALSO sent to #lead-calls (${leadLabel})`);
    }

    // Post to case channel if applicable
    await postToCaseChannel(text, from, to);
  } catch (err) {
    console.error("[call-summary] Error:", err.message);
  }
});

// --- Start ---
// Start server immediately so we don't miss webhooks during cache loading
app.listen(PORT, () => {
  console.log(`Quo Slack Router listening on port ${PORT}`);
});

// Load caches in background — routes work without them (just no contact names/case channels)
Promise.all([loadQuoContacts(), loadSlackChannels(), loadSlackUsers()]).then(() => {
  console.log("[startup] All caches loaded");
});

// Refresh caches periodically (staggered to avoid API bursts)
setInterval(loadQuoContacts, 10 * 60 * 1000);
setInterval(loadSlackChannels, 15 * 60 * 1000);
setInterval(loadSlackUsers, 30 * 60 * 1000);
