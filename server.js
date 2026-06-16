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
const SLACK_LEGAL_ASSISTANT_WEBHOOK_URL = process.env.SLACK_LEGAL_ASSISTANT_WEBHOOK_URL;
const SLACK_LEGAL_ASSISTANT_CHANNEL_ID = process.env.SLACK_LEGAL_ASSISTANT_CHANNEL_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// --- Phone line mapping ---
const PHONE_LINES = {
  "+15125373369": "RJL Main Line",
  "+19563137771": "RGV Number",
  "+15126010647": "Intake",
  "+15125005266": "RJL Outbound",
  "+15126300907": "RJL Transfers",
};

// Slack user IDs to tag on missed/Sona calls threaded into #lead-calls
const LEAD_THREAD_TAG_USERS = ["U026P9FUKHC", "U0ANAJK56LD"]; // @jon, @Jaymie

// Insert @-mentions as a second line so the event title stays on line 1
function insertMentionsAfterTitle(text, userIds) {
  if (!userIds || userIds.length === 0) return text;
  const mentions = userIds.map((id) => `<@${id}>`).join(" ");
  const nlIdx = text.indexOf("\n");
  if (nlIdx === -1) return `${text}\n${mentions}`;
  return `${text.slice(0, nlIdx)}\n${mentions}${text.slice(nlIdx)}`;
}

// --- Quo Contacts Cache ---
const contactsCache = new Map();
const CONTACTS_REFRESH_INTERVAL = 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

      let res;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await fetch(url.toString(), {
          headers: { Authorization: QUO_API_KEY },
        });

        if (res.status !== 429) break;

        const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
        const backoff = retryAfter > 0 ? retryAfter * 1000 : (2 ** attempt) * 2000;
        console.warn(`[contacts] Rate limited (429), retrying in ${backoff / 1000}s (attempt ${attempt + 1}/4)`);
        await sleep(backoff);
      }

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

      if (pageToken) await sleep(500);
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

// --- Quo Users Cache ---
const quoUsersCache = new Map(); // quoUserId → name
const QUO_USERS_REFRESH_INTERVAL = 30 * 60 * 1000;

async function loadQuoUsers() {
  if (!QUO_API_KEY) return;

  console.log("[quo-users] Fetching users from Quo API...");
  try {
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch("https://api.openphone.com/v1/users", {
        headers: { Authorization: QUO_API_KEY },
      });
      if (res.status !== 429) break;
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      const backoff = retryAfter > 0 ? retryAfter * 1000 : (2 ** attempt) * 2000;
      console.warn(`[quo-users] Rate limited (429), retrying in ${backoff / 1000}s (attempt ${attempt + 1}/4)`);
      await sleep(backoff);
    }

    if (!res.ok) {
      console.error(`[quo-users] Quo API responded ${res.status}: ${await res.text()}`);
      return;
    }

    const json = await res.json();
    const users = json.data || [];
    quoUsersCache.clear();

    for (const user of users) {
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
      console.log(`[quo-users] User: id=${user.id}, name="${name}", email=${user.email || "N/A"}`);
      if (user.id && name) {
        quoUsersCache.set(user.id, name);
      }
    }

    console.log(`[quo-users] Loaded ${quoUsersCache.size} users`);
  } catch (err) {
    console.error("[quo-users] Error fetching users:", err.message);
  }
}

function getQuoUserName(userId) {
  if (!userId) return null;
  return quoUsersCache.get(userId) || null;
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

// --- Unresolved call fallback ---
// Quo sometimes does not fire call.completed or call-summary events.
// On ringing, we schedule a delayed check. Before acting, we query the Quo API
// for the call's real status so we never post false positives.
const CALL_CHECK_DELAY_MS = 185 * 1000; // 185s
const pendingCallChecks = new Map(); // callId -> timeoutId
const resolvedCalls = new Set(); // callIds that received a non-ringing event

async function fetchCallFromQuo(callId) {
  if (!QUO_API_KEY || !callId) return null;
  try {
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(`https://api.openphone.com/v1/calls/${callId}`, {
        headers: { Authorization: QUO_API_KEY },
      });
      if (res.status !== 429) break;
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      const backoff = retryAfter > 0 ? retryAfter * 1000 : (2 ** attempt) * 2000;
      console.warn(`[call-check] Rate limited (429), retrying in ${backoff / 1000}s (attempt ${attempt + 1}/4)`);
      await sleep(backoff);
    }
    if (!res.ok) {
      console.error(`[call-check] Quo API responded ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json.data || json;
  } catch (err) {
    console.error("[call-check] Error fetching call:", err.message);
    return null;
  }
}

function scheduleCallCheck(callId, cachedFrom, cachedTo, cachedDirection) {
  if (!callId || resolvedCalls.has(callId)) return;
  clearScheduledCallCheck(callId);
  const timeoutId = setTimeout(() => {
    pendingCallChecks.delete(callId);
    if (resolvedCalls.has(callId)) return;
    handleUnresolvedCall(callId, cachedFrom, cachedTo, cachedDirection).catch((err) =>
      console.error("[call-check] Error:", err.message),
    );
  }, CALL_CHECK_DELAY_MS);
  pendingCallChecks.set(callId, timeoutId);
}

function clearScheduledCallCheck(callId) {
  if (!callId) return;
  const tid = pendingCallChecks.get(callId);
  if (tid) {
    clearTimeout(tid);
    pendingCallChecks.delete(callId);
  }
}

function markCallResolved(callId) {
  if (!callId) return;
  resolvedCalls.add(callId);
  clearScheduledCallCheck(callId);
  setTimeout(() => resolvedCalls.delete(callId), CACHE_TTL);
}

async function handleUnresolvedCall(callId, cachedFrom, cachedTo, cachedDirection) {
  const call = await fetchCallFromQuo(callId);
  if (!call) {
    console.log(`[call-check] Could not verify call ${callId} via API — skipping`);
    return;
  }

  const status = (call.status || "").toLowerCase();
  const direction = call.direction || cachedDirection;
  const from = safe(call.from || cachedFrom);
  const to = safe(call.to || cachedTo);
  const answeredBy = call.answeredBy || null;
  const answeredAt = call.answeredAt || null;
  const voicemail = call.voicemail || null;
  const hasVoicemail = voicemail && (typeof voicemail === "string" ? voicemail : voicemail.url);

  // Update cache with full data from API
  cacheCall(callId, { from: call.from || cachedFrom, to: call.to || cachedTo, direction, answeredBy, userId: call.userId });

  console.log(`[call-check] Call ${callId}: status=${status}, answeredBy=${answeredBy || "none"}, direction=${direction}`);

  // Still in progress — reschedule one more check
  if (status === "in-progress" || status === "ringing" || status === "queued" || status === "initiated") {
    console.log(`[call-check] Call ${callId} still ${status} — rescheduling`);
    scheduleCallCheck(callId, cachedFrom, cachedTo, cachedDirection);
    return;
  }

  if (direction !== "incoming") {
    console.log(`[call-check] Outbound call ${callId} — skipping fallback`);
    return;
  }

  const fromDisplay = formatFrom(from);
  const toDisplay = formatPhone(to);
  const externalNumber = PHONE_LINES[from] ? to : from;
  const isSavedContact = !!getContactName(externalNumber);

  const isMissedStatus = ["no-answer", "busy", "canceled", "failed"].includes(status);
  const isMenuHangup = status === "completed" && !!answeredAt && !answeredBy && !hasVoicemail;
  const isAnswered = status === "completed" && !!answeredBy;

  if (isMissedStatus || isMenuHangup || (status === "completed" && !answeredAt && !hasVoicemail)) {
    // Missed call, unanswered, or menu hangup
    let header;
    if (isMenuHangup) {
      header = isSavedContact ? `📞 *Hung Up at Phone Menu*` : `☎️ *HUNG UP AT PHONE MENU URGENT* ☎️`;
    } else {
      header = isSavedContact ? `📞 *Missed Call*` : `🚨 *MISSED CALL URGENT* 🚨`;
    }
    let text = `${header}\nFrom: ${fromDisplay}\nTo: ${toDisplay}`;
    if (hasVoicemail) {
      const vmUrl = typeof voicemail === "string" ? voicemail : voicemail.url;
      text += `\nVoicemail: ${vmUrl}`;
    }

    console.log(`[call-check] Fallback: ${isMenuHangup ? "menu hangup" : "missed"} for ${callId}`);
    await postToSlack(SLACK_MISSED_CALLS_WEBHOOK_URL, text);
    await threadInLeadChannelIfMatch(text, from, to, { mentionUsers: LEAD_THREAD_TAG_USERS });

    const externalPhone = PHONE_LINES[from] ? to : from;
    if (!isExistingClient(externalPhone)) {
      await postToLegalAssistant(text, from, to);
    }
    await postToCaseChannel(text, from, to);
  } else if (isAnswered) {
    // Call was answered but no webhook events came through — post basic notification
    const isSona = answeredBy && (String(answeredBy).startsWith("SY") || String(answeredBy).toLowerCase().includes("sona"));
    const handlerName = getQuoUserName(answeredBy);

    console.log(`[call-check] Fallback: answered call for ${callId} (answeredBy: ${answeredBy}, sona: ${isSona})`);

    let text;
    if (isSona) {
      text = `🤖 *Sona Call Completed*\nFrom: ${fromDisplay}\nTo: ${toDisplay}\n_(No transcript received from Quo)_`;
      await postToSlack(SLACK_SONA_CALLS_WEBHOOK_URL, text);
    } else {
      const handlerLine = handlerName ? `\nHandled By: *${handlerName}*` : "";
      text = `🧑 *Human Call Completed*${handlerLine}\nFrom: ${fromDisplay}\nTo: ${toDisplay}\n_(No transcript received from Quo)_`;
      await postToSlack(SLACK_HUMAN_CALLS_WEBHOOK_URL, text);
    }

    // Route to legalassistant / lead-calls / case channel as usual
    if (shouldRouteToLegalAssistant(from, to)) {
      await postToLegalAssistant(text, from, to);
    }
    await threadInLeadChannelIfMatch(text, from, to, isSona ? { mentionUsers: LEAD_THREAD_TAG_USERS } : {});
    await postToCaseChannel(text, from, to);
  } else {
    console.log(`[call-check] Call ${callId} has unexpected status "${status}" — skipping`);
  }
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
    // Use blocks with mrkdwn so bold/formatting works via webhooks
    const payload = {
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
      ],
      text, // fallback for notifications
    };
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

// Build a single searchable string from a Slack message (text + attachments + blocks)
function getFullMessageText(msg) {
  let parts = [msg.text || ""];

  // Attachments (used by Zapier, CallRail, etc.)
  if (msg.attachments) {
    for (const att of msg.attachments) {
      parts.push(att.text || "", att.fallback || "", att.pretext || "", att.title || "");
      if (att.fields) {
        for (const f of att.fields) {
          parts.push(f.title || "", f.value || "");
        }
      }
    }
  }

  // Blocks (Slack Block Kit)
  if (msg.blocks) {
    for (const block of msg.blocks) {
      if (block.text?.text) parts.push(block.text.text);
      if (block.fields) {
        for (const f of block.fields) {
          parts.push(f.text || "");
        }
      }
      // Section accessories, context elements
      if (block.elements) {
        for (const el of block.elements) {
          parts.push(el.text || el.value || "");
          if (el.text?.text) parts.push(el.text.text);
        }
      }
    }
  }

  return parts.join(" ");
}

function searchChannelHistoryForPhone(messages, phoneNumber) {
  const last10 = lastTenDigits(phoneNumber);
  const normalized = normalizePhone(phoneNumber);
  if (!last10) return null;

  // Find ALL matching messages, then return the earliest (oldest) one
  const matches = [];

  for (const msg of messages) {
    const fullText = getFullMessageText(msg);
    let found = false;
    // Extract all digit sequences from the message and check for match
    const msgDigits = fullText.match(/\d{7,}/g) || [];
    for (const seq of msgDigits) {
      const seqLast10 = seq.length >= 10 ? seq.slice(-10) : seq;
      if (seqLast10 === last10) {
        found = true;
        break;
      }
    }
    // Also check raw string includes
    if (!found && (fullText.includes(phoneNumber) || fullText.includes(normalized) || fullText.includes(last10))) {
      found = true;
    }
    // Also strip ALL non-digits from the text and search for last10
    // Catches formatted numbers like "+1 956-252-6478" where digits are split by dashes/spaces
    if (!found) {
      const strippedDigits = fullText.replace(/\D/g, "");
      if (strippedDigits.includes(last10)) {
        found = true;
      }
    }
    if (found) {
      const ts = msg.thread_ts || msg.ts;
      matches.push(ts);
    }
  }

  if (matches.length === 0) return null;

  // Return the earliest (smallest timestamp) — first mention of this phone number
  matches.sort((a, b) => parseFloat(a) - parseFloat(b));
  console.log(`[lead-thread] Found ${matches.length} messages with phone match, using earliest (ts: ${matches[0]})`);
  return matches[0];
}

async function fetchLeadChannelHistory() {
  if (!SLACK_BOT_TOKEN || !SLACK_LEAD_CALLS_CHANNEL_ID) return [];

  const allMessages = [];
  const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  let cursor = "";

  try {
    do {
      const url = new URL("https://slack.com/api/conversations.history");
      url.searchParams.set("channel", SLACK_LEAD_CALLS_CHANNEL_ID);
      url.searchParams.set("limit", "200");
      url.searchParams.set("oldest", String(sevenDaysAgo));
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      });

      const json = await res.json();
      if (!json.ok) {
        console.error(`[lead-thread] Slack API error: ${json.error}`);
        break;
      }

      allMessages.push(...(json.messages || []));
      cursor = json.response_metadata?.next_cursor || "";
    } while (cursor);

    console.log(`[lead-thread] Fetched ${allMessages.length} total messages from #lead-calls (7 days)`);
    return allMessages;
  } catch (err) {
    console.error("[lead-thread] Error fetching history:", err.message);
    return allMessages;
  }
}

async function findThreadByPhone(phoneNumber) {
  if (!SLACK_BOT_TOKEN || !SLACK_LEAD_CALLS_CHANNEL_ID || !phoneNumber) return null;

  const last10 = lastTenDigits(phoneNumber);
  console.log(`[lead-thread] Searching for phone ${phoneNumber} (last10: ${last10})`);

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

// Get a Slack permalink for a posted message — handles thread replies correctly
async function getSlackPermalink(channelId, messageTs) {
  if (!SLACK_BOT_TOKEN || !channelId || !messageTs) return null;
  try {
    const url = new URL("https://slack.com/api/chat.getPermalink");
    url.searchParams.set("channel", channelId);
    url.searchParams.set("message_ts", messageTs);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`[permalink] Slack API error: ${json.error}`);
      return null;
    }
    return json.permalink || null;
  } catch (err) {
    console.error("[permalink] Error:", err.message);
    return null;
  }
}

async function postLeadToSlack(text, phoneFrom, phoneTo, { mentionUsersIfThreaded = [] } = {}) {
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

      // Insert @-mentions as a second line only when posting as a thread reply
      const finalText = threadTs
        ? insertMentionsAfterTitle(text, mentionUsersIfThreaded)
        : text;

      const body = { channel: SLACK_LEAD_CALLS_CHANNEL_ID, text: finalText };
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
        return null;
      }

      console.log(`[lead-calls] Posted via Slack API (threaded: ${!!threadTs})`);
      // Fetch permalink via Slack API — handles thread replies correctly
      const msgTs = json.ts;
      if (msgTs) {
        const permalink = await getSlackPermalink(SLACK_LEAD_CALLS_CHANNEL_ID, msgTs);
        console.log(`[lead-calls] Permalink: ${permalink || "null"}`);
        return permalink;
      }
      console.warn("[lead-calls] No ts in Slack response — cannot build permalink");
      return null;
    } catch (err) {
      console.error("[lead-calls] Slack API error:", err.message);
      await postToSlack(SLACK_LEAD_CALLS_WEBHOOK_URL, text);
    }
  } else {
    await postToSlack(SLACK_LEAD_CALLS_WEBHOOK_URL, text);
  }
  return null;
}

// Thread any event into #lead-calls if the phone number matches an existing post
async function threadInLeadChannelIfMatch(text, phoneFrom, phoneTo, { mentionUsers = [] } = {}) {
  if (!SLACK_BOT_TOKEN || !SLACK_LEAD_CALLS_CHANNEL_ID) return false;

  const phones = [phoneFrom, phoneTo].filter(Boolean);
  let threadTs = null;

  for (const phone of phones) {
    if (PHONE_LINES[phone]) continue;
    // Quick search — no retry since this is supplementary routing
    const messages = await fetchLeadChannelHistory();
    threadTs = searchChannelHistoryForPhone(messages, phone);
    if (threadTs) break;
  }

  if (!threadTs) return false;

  // Insert @-mentions as a second line so the event title stays on line 1
  const finalText = insertMentionsAfterTitle(text, mentionUsers);

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: SLACK_LEAD_CALLS_CHANNEL_ID,
        text: finalText,
        thread_ts: threadTs,
      }),
    });

    const json = await res.json();
    if (json.ok) {
      console.log(`[lead-thread] Threaded event in #lead-calls (ts: ${threadTs})`);
      return true;
    } else {
      console.error(`[lead-thread] Slack API error: ${json.error}`);
    }
  } catch (err) {
    console.error("[lead-thread] Error:", err.message);
  }
  return false;
}

// Fetch recent #legalassistant-phone history (24 hours, paginated)
async function fetchLegalAssistantHistory() {
  if (!SLACK_BOT_TOKEN || !SLACK_LEGAL_ASSISTANT_CHANNEL_ID) return [];

  const allMessages = [];
  const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  let cursor = "";

  try {
    do {
      const url = new URL("https://slack.com/api/conversations.history");
      url.searchParams.set("channel", SLACK_LEGAL_ASSISTANT_CHANNEL_ID);
      url.searchParams.set("limit", "200");
      url.searchParams.set("oldest", String(oneDayAgo));
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      });

      const json = await res.json();
      if (!json.ok) {
        console.error(`[la-thread] Slack API error: ${json.error}`);
        break;
      }

      allMessages.push(...(json.messages || []));
      cursor = json.response_metadata?.next_cursor || "";
    } while (cursor);

    return allMessages;
  } catch (err) {
    console.error("[la-thread] Error fetching history:", err.message);
    return allMessages;
  }
}

// Post to #legalassistant-phone, threading under a prior post if phone number matches
async function postToLegalAssistant(text, phoneFrom, phoneTo) {
  // Try to thread via Slack API if bot token + channel ID are configured
  if (SLACK_BOT_TOKEN && SLACK_LEGAL_ASSISTANT_CHANNEL_ID) {
    try {
      const phones = [phoneFrom, phoneTo].filter(Boolean);
      let threadTs = null;

      const messages = await fetchLegalAssistantHistory();
      for (const phone of phones) {
        if (PHONE_LINES[phone]) continue;
        threadTs = searchChannelHistoryForPhone(messages, phone);
        if (threadTs) break;
      }

      const body = { channel: SLACK_LEGAL_ASSISTANT_CHANNEL_ID, text };
      if (threadTs) {
        body.thread_ts = threadTs;
        console.log(`[la-thread] Replying in thread ${threadTs}`);
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
        console.error(`[la-thread] Slack API error: ${json.error}`);
        await postToSlack(SLACK_LEGAL_ASSISTANT_WEBHOOK_URL, text);
      } else {
        console.log(`[la-thread] Posted via Slack API (threaded: ${!!threadTs})`);
      }
      return;
    } catch (err) {
      console.error("[la-thread] Error:", err.message);
    }
  }
  // Fallback to webhook
  await postToSlack(SLACK_LEGAL_ASSISTANT_WEBHOOK_URL, text);
}

// --- Case Channel Routing ---

function extractCaseNumber(contactName) {
  if (!contactName) return null;
  // Find all 3-5 digit case numbers in the contact name
  // e.g. "Barbara Glass 1281", "Wendy Veal 946 New Phone", "Cynthia Hierrezuelo 1313 & 1476"
  // For contacts with multiple cases, use the largest number (the most recent/active case)
  const matches = contactName.match(/\b\d{3,5}\b/g);
  if (!matches || matches.length === 0) return null;
  // Return the largest case number
  return matches.reduce((max, num) => (Number(num) > Number(max) ? num : max));
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

async function fetchChannelTopic(channelId) {
  try {
    const url = new URL("https://slack.com/api/conversations.info");
    url.searchParams.set("channel", channelId);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`[case-channel] conversations.info error: ${json.error}`);
      return null;
    }
    return json.channel?.topic?.value || "";
  } catch (err) {
    console.error(`[case-channel] Error fetching channel topic:`, err.message);
    return null;
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

async function postToCaseChannel(text, phoneFrom, phoneTo, { skipMentions = false } = {}) {
  if (!SLACK_BOT_TOKEN) return;

  const phones = [phoneFrom, phoneTo].filter(Boolean);

  for (const phone of phones) {
    const contactName = getContactName(phone);
    const caseNumber = extractCaseNumber(contactName);
    console.log(`[case-channel] Phone: ${phone}, Contact: ${contactName || "none"}, Case#: ${caseNumber || "none"}`);
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

    // Fetch live topic from Slack (cache may be stale if topic was recently changed)
    const liveTopic = skipMentions ? null : await fetchChannelTopic(channel.id);
    const mentions = skipMentions ? "" : extractMentionsFromTopic(liveTopic ?? channel.topic);
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

// Check if a phone number belongs to a known business/vendor contact
// (has a contact name but no case number — e.g. "USAA", "State Farm", "Dr. Smith")
function isKnownBusiness(phoneNumber) {
  const contactName = getContactName(phoneNumber);
  if (!contactName) return false;
  // If it has a case number, it's a client not a business
  if (extractCaseNumber(contactName)) return false;
  // Contact exists without a case number = known business/vendor
  return true;
}

// Lead = anyone seeking ANY type of legal help that the firm could potentially handle
// Qualified Lead = situation the firm specializes in (PI, auto, workplace, wrongful death, etc.)
// Existing clients (contact with case number) are NOT leads
// Known businesses/vendors in contacts are NOT leads
// Uses Claude Haiku to classify based on call summary text
async function classifyLead(payload, phoneFrom, phoneTo, cached) {
  // If either party is an existing client or known business, not a lead
  const phones = [phoneFrom, phoneTo].filter(Boolean);
  for (const phone of phones) {
    if (PHONE_LINES[phone]) continue; // skip our own lines
    if (isExistingClient(phone)) {
      console.log(`[lead] Skipping — existing client: ${getContactName(phone)}`);
      return { isLead: false, isQualified: false, label: "No (Existing Client)" };
    }
    if (isKnownBusiness(phone)) {
      console.log(`[lead] Skipping — known business: ${getContactName(phone)}`);
      return { isLead: false, isQualified: false, label: "No (Known Business)" };
    }
  }

  const text = extractText(payload);
  if (!text) return { isLead: false, isQualified: false, label: "No" };

  // No API key — fall back to "not a lead" rather than mis-classify
  if (!ANTHROPIC_API_KEY) {
    console.warn("[lead] ANTHROPIC_API_KEY not set — cannot classify");
    return { isLead: false, isQualified: false, label: "No (Unclassified)" };
  }

  try {
    const systemPrompt = `You classify call summaries for a personal injury law firm (Ramos James Law).

Classify each call into ONE of these categories:
- "qualified_lead": A NEW potential client seeking legal help for a situation the firm handles: car accidents, truck accidents, motorcycle accidents, pedestrian accidents, slip and fall, workplace injuries, workers comp, wrongful death, drunk driver, hit and run, or any personal injury case.
- "lead": A NEW potential client seeking legal help, but for something OUTSIDE personal injury (family law, divorce, child support, criminal, immigration, etc.) OR a vague legal inquiry.
- "not_lead": Anything else, including:
  * Calls about an EXISTING case or existing client (even if the caller mentions injuries, accidents, etc.)
  * Calls from insurance adjusters / insurance companies (Progressive, USAA, GEICO, State Farm, etc.) about claims, demands, subrogation
  * Calls from other law firms about case management, mediation, opposing counsel, co-counsel
  * Calls from medical providers (doctors, clinics, physiotherapy) about appointments, records, payments
  * Sales calls, marketing, recruiting, vendors
  * Press / media inquiries
  * Wrong numbers, spam
  * Automated phone systems

CRITICAL RULES:
- If the summary mentions "existing case", "their case", "the case", "client [name]", or references an ongoing matter — it's NOT a new lead
- If the caller is calling FROM an insurance company or law firm (not as a victim) — it's NOT a lead
- A new lead is someone calling for the FIRST TIME because they need legal help with their own situation
- If a caller's situation is explicitly outside personal injury (e.g., "child support", "divorce") and the intake explicitly declined them, it's still a "lead" (just not qualified)

Respond with ONLY a single word: "qualified_lead", "lead", or "not_lead". No explanation.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        system: systemPrompt,
        messages: [{ role: "user", content: `Call summary:\n${text}` }],
      }),
    });

    if (!res.ok) {
      console.error(`[lead] Anthropic API error ${res.status}: ${await res.text()}`);
      return { isLead: false, isQualified: false, label: "No (API Error)" };
    }

    const json = await res.json();
    const reply = (json.content?.[0]?.text || "").toLowerCase().trim();
    console.log(`[lead] LLM classification: "${reply}"`);

    if (reply.includes("qualified_lead")) {
      return { isLead: true, isQualified: true, label: "🔥 Qualified Lead" };
    }
    if (reply.includes("not_lead")) {
      return { isLead: false, isQualified: false, label: "No" };
    }
    if (reply.includes("lead")) {
      return { isLead: true, isQualified: false, label: "Lead" };
    }

    console.warn(`[lead] Unexpected LLM response: "${reply}"`);
    return { isLead: false, isQualified: false, label: "No (Unparseable)" };
  } catch (err) {
    console.error("[lead] Classification error:", err.message);
    return { isLead: false, isQualified: false, label: "No (Error)" };
  }
}

// Check if inbound event should go to #legalassistant-phone
// Routes inbound items that are NOT leads, NOT existing clients
function shouldRouteToLegalAssistant(phoneFrom, phoneTo) {
  const phones = [phoneFrom, phoneTo].filter(Boolean);
  for (const phone of phones) {
    if (PHONE_LINES[phone]) continue; // skip our own lines
    if (isExistingClient(phone)) return false; // already routes to case channel
  }
  return true;
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

    const text = `${emoji} *${label}*\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nMessage: ${body}${mediaSection}${translation}`;

    console.log(`[messages] From: ${fromDisplay} → To: ${toDisplay} (media: ${media.length})`);
    await postToSlack(SLACK_TEXT_MESSAGES_WEBHOOK_URL, text);
    console.log("[messages] Sent to #text-messages");

    // Thread in #lead-calls if phone matches an existing lead post
    const threadedInLeads = await threadInLeadChannelIfMatch(text, from, to);

    // Route inbound texts to #legalassistant-phone (not outbound, not clients, not threaded into leads)
    if (!isOutbound && !threadedInLeads && shouldRouteToLegalAssistant(from, to)) {
      await postToLegalAssistant(text, from, to);
      console.log("[messages] ALSO sent to #legalassistant-phone");
    }

    // Post to case channel if applicable (skip topic mentions for outbound — no need to alert)
    await postToCaseChannel(text, from, to, { skipMentions: isOutbound });
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

    // Skip ringing events — schedule a fallback check in case Quo never sends completion
    if (eventType === "call.ringing" || status === "ringing") {
      if (direction === "incoming") {
        scheduleCallCheck(callId, obj.from, obj.to, direction);
        console.log(`[calls] Ringing — scheduled API check in ${CALL_CHECK_DELAY_MS / 1000}s for ${callId}`);
      } else {
        console.log(`[calls] Ringing — waiting for completion`);
      }
      return;
    }

    // Detect missed calls
    const isMissedStatus = ["no-answer", "busy", "canceled", "failed"].includes(status);
    const isUnanswered = status === "completed" && !answeredAt && direction === "incoming";
    const hasVoicemail = voicemail && (typeof voicemail === "string" ? voicemail : voicemail.url);
    // Menu hangup: caller reached IVR (answeredAt set) but no agent/Sona picked up and no VM
    const isMenuHangup =
      status === "completed" &&
      direction === "incoming" &&
      !!answeredAt &&
      !obj.answeredBy &&
      !hasVoicemail;

    if (!isMissedStatus && !isUnanswered && !hasVoicemail && !isMenuHangup) {
      // Answered call — /call-summary should handle. Keep fallback check active in case it doesn't.
      console.log(`[calls] Skipping answered call (status: ${status}) — waiting for /call-summary or fallback`);
      return;
    }

    // We are handling the call here — cancel any pending fallback check to avoid duplicate post
    markCallResolved(callId);

    const fromDisplay = formatFrom(from);
    const toDisplay = formatPhone(to);

    // Outbound events (no-answer, voicemail left by us) → case channel only, no tags, no transcript
    if (direction === "outgoing") {
      const outHeader = hasVoicemail
        ? `📨 *Outbound Voicemail Left*`
        : `📞 *Outbound Call Not Answered*`;
      let outText = `${outHeader}\nFrom: ${fromDisplay}\nTo: ${toDisplay}`;
      if (hasVoicemail) {
        const vmUrl = typeof voicemail === "string" ? voicemail : voicemail.url;
        outText += `\nVoicemail: ${vmUrl}`;
      }
      console.log(`[calls] Outbound ${hasVoicemail ? "voicemail left" : "no-answer"}: ${fromDisplay} → ${toDisplay}`);
      await postToCaseChannel(outText, from, to, { skipMentions: true });
      return;
    }

    // Use urgent header for unknown numbers, normal alert for saved contacts
    const externalNumber = PHONE_LINES[from] ? to : from;
    const isSavedContact = !!getContactName(externalNumber);
    let header;
    if (isMenuHangup) {
      header = isSavedContact
        ? `📞 *Hung Up at Phone Menu*`
        : `☎️ *HUNG UP AT PHONE MENU URGENT* ☎️`;
    } else {
      header = isSavedContact
        ? `📞 *Missed Call*`
        : `🚨 *MISSED CALL URGENT* 🚨`;
    }
    let text = `${header}\nFrom: ${fromDisplay}\nTo: ${toDisplay}`;
    if (hasVoicemail) {
      const vmUrl = typeof voicemail === "string" ? voicemail : voicemail.url;
      text += `\nVoicemail: ${vmUrl}`;
    }

    console.log(`[calls] ${isMenuHangup ? "Menu hangup" : "Missed call"} from: ${fromDisplay}`);
    await postToSlack(SLACK_MISSED_CALLS_WEBHOOK_URL, text);
    console.log("[calls] Sent to #missed-calls-voicemail");

    // Thread in #lead-calls if phone matches an existing lead post — tag @jon/@jaymie
    await threadInLeadChannelIfMatch(text, from, to, { mentionUsers: LEAD_THREAD_TAG_USERS });

    // Post missed calls/voicemails to #legalassistant-phone — but not for existing clients
    // (those go to case channels). Always post even if also in #lead-calls — these are urgent.
    const externalPhone = PHONE_LINES[from] ? to : from;
    if (!isExistingClient(externalPhone)) {
      await postToLegalAssistant(text, from, to);
      console.log("[calls] ALSO sent to #legalassistant-phone");
    } else {
      console.log("[calls] Skipping #legalassistant-phone — existing client");
    }

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

    // Summary received — cancel any pending fallback check
    markCallResolved(callId);

    const cached = callId ? getCachedCall(callId) : null;
    const from = safe(cached?.from);
    const to = safe(cached?.to);

    const rawSummary = obj.summary;
    const summary = Array.isArray(rawSummary) ? "• " + rawSummary.join("\n• ") : safe(rawSummary);

    const sona = isSonaCall(payload, cached);
    const { isLead, isQualified, label: leadLabel } = await classifyLead(payload, from, to, cached);

    const fromDisplay = formatFrom(from);
    const toDisplay = formatPhone(to);

    // Translate summary if Spanish
    const summaryText = Array.isArray(rawSummary) ? rawSummary.join(" ") : (rawSummary || "");
    const translation = await appendTranslation(summaryText);

    console.log(`[call-summary] From: ${fromDisplay} | To: ${toDisplay} | Sona: ${sona} | Lead: ${leadLabel}`);

    const linkLine = deepLink ? `\n<${deepLink}|View in Quo>` : "";

    // For Sona leads, post to #lead-calls FIRST so we can link it from #sona-calls
    let leadPermalink = null;
    if (isLead) {
      const handlerDisplay = sona ? "Sona" : (getQuoUserName(cached?.answeredBy) || getQuoUserName(cached?.userId) || "Human");
      const handledBy = handlerDisplay;
      const qualTag = isQualified ? "🔥 *Qualified Lead Call*" : "📋 *Lead Call*";
      const leadText = `${qualTag}\nHandled By: ${handledBy}\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}${linkLine}`;
      // Tag @jon/@jaymie only on Sona calls that end up threaded
      const leadPostOpts = sona ? { mentionUsersIfThreaded: LEAD_THREAD_TAG_USERS } : {};
      leadPermalink = await postLeadToSlack(leadText, from, to, leadPostOpts);
      console.log(`[call-summary] Sent to #lead-calls (${leadLabel})`);
    }

    let text;
    if (sona) {
      const leadLink = leadPermalink ? `\n<${leadPermalink}|View in #lead-calls>` : "";
      console.log(`[call-summary] Sona post — isLead=${isLead}, leadPermalink=${leadPermalink || "null"}`);
      text = `🤖 *Sona Call Completed*\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}\nLead: ${leadLabel}${leadLink}${linkLine}`;
      await postToSlack(SLACK_SONA_CALLS_WEBHOOK_URL, text);
      console.log("[call-summary] Sent to #sona-calls");
    } else {
      // answeredBy = actual person who picked up; userId = phone number owner
      const answeredById = cached?.answeredBy;
      const handlerName = getQuoUserName(answeredById) || getQuoUserName(cached?.userId);
      console.log(`[call-summary] Handler lookup: answeredBy=${answeredById}, userId=${cached?.userId}, resolved=${handlerName || "not found"}, cache size=${quoUsersCache.size}`);
      const handlerLine = handlerName ? `\nHandled By: *${handlerName}*` : "";
      text = `🧑 *Human Call Completed*${handlerLine}\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}\nLead: ${leadLabel}${linkLine}`;
      await postToSlack(SLACK_HUMAN_CALLS_WEBHOOK_URL, text);
      console.log("[call-summary] Sent to #human-calls");
    }

    // Thread non-lead calls in #lead-calls if phone matches an existing post.
    // Sona calls get @jon/@jaymie tagged; Human calls don't.
    let threadedInLeads = false;
    if (!isLead) {
      const threadOpts = sona ? { mentionUsers: LEAD_THREAD_TAG_USERS } : {};
      threadedInLeads = await threadInLeadChannelIfMatch(text, from, to, threadOpts);
    }

    // Route inbound non-lead calls to #legalassistant-phone (Human or Sona)
    // Skip if already in #lead-calls (as a lead or threaded), if existing client (case channel), or if outbound
    // EXCEPTION: Sona leads always post to #legalassistant-phone (like missed calls, they need follow-up)
    // Determine inbound by checking if `to` is one of our phone lines (more reliable than cached direction)
    const isInbound = !!PHONE_LINES[to] || cached?.direction === "incoming";
    const sonaLeadOverride = sona && isLead;
    if (isInbound && shouldRouteToLegalAssistant(from, to) && (sonaLeadOverride || (!isLead && !threadedInLeads))) {
      await postToLegalAssistant(text, from, to);
      console.log("[call-summary] ALSO sent to #legalassistant-phone");
    } else if (!isLead && !threadedInLeads && !isInbound) {
      console.log(`[call-summary] Skipping #legalassistant-phone — outbound (to=${to})`);
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
// Stagger Quo API calls to avoid rate limits (contacts pages through many results)
(async () => {
  await Promise.all([loadSlackChannels(), loadSlackUsers()]);
  await loadQuoContacts();
  await loadQuoUsers();
  console.log("[startup] All caches loaded");
})();

// Refresh caches periodically (staggered to avoid API bursts)
setInterval(loadQuoContacts, CONTACTS_REFRESH_INTERVAL);
setInterval(loadQuoUsers, QUO_USERS_REFRESH_INTERVAL);
setInterval(loadSlackChannels, 15 * 60 * 1000);
setInterval(loadSlackUsers, 30 * 60 * 1000);
