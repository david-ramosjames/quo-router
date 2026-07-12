import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// === Globals (shared across firms) ===
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_FIRM_ID = process.env.DEFAULT_FIRM_ID || "ramosjames";

const CACHE_TTL = 10 * 60 * 1000;
const CONTACTS_REFRESH_INTERVAL = 60 * 60 * 1000;
const QUO_USERS_REFRESH_INTERVAL = 30 * 60 * 1000;
const SLACK_CHANNELS_REFRESH_INTERVAL = 15 * 60 * 1000;
const SLACK_USERS_REFRESH_INTERVAL = 30 * 60 * 1000;
const CALL_CHECK_DELAY_MS = 185 * 1000;

// === Firm Registry ===
const firms = new Map(); // firmId -> Firm object

function loadFirmConfigFile() {
  const inline = process.env.FIRMS_CONFIG;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (err) {
      console.error("[firms] FIRMS_CONFIG env var is not valid JSON:", err.message);
    }
  }
  const configPath = path.join(__dirname, "firms.json");
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      console.error("[firms] firms.json is not valid JSON:", err.message);
    }
  }
  return null;
}

function makeFirm(firmId, config) {
  const upper = firmId.toUpperCase();
  const perFirm = (key) => process.env[`FIRM_${upper}_${key}`];
  // Legacy fallback: if this is the default firm and no per-firm env vars are set,
  // fall back to the old un-prefixed env vars so existing deployments keep working.
  const legacyOk = firmId === DEFAULT_FIRM_ID && !perFirm("QUO_API_KEY") && !perFirm("SLACK_BOT_TOKEN");
  const legacy = (key) => (legacyOk ? process.env[key] : undefined);
  const pick = (key) => perFirm(key) || legacy(key) || null;

  return {
    id: firmId,
    name: config.name || firmId,
    practiceArea: config.practiceArea || "personal injury",
    phoneLines: config.phoneLines || {},
    leadThreadTagUsers: config.leadThreadTagUsers || [],
    slackLeadCallsChannelId: pick("SLACK_LEAD_CALLS_CHANNEL_ID"),
    slackLegalAssistantChannelId: pick("SLACK_LEGAL_ASSISTANT_CHANNEL_ID"),
    quoApiKey: pick("QUO_API_KEY"),
    slackBotToken: pick("SLACK_BOT_TOKEN"),
    slackWebhooks: {
      textMessages: pick("SLACK_TEXT_MESSAGES_WEBHOOK_URL"),
      missedCalls: pick("SLACK_MISSED_CALLS_WEBHOOK_URL"),
      humanCalls: pick("SLACK_HUMAN_CALLS_WEBHOOK_URL"),
      sonaCalls: pick("SLACK_SONA_CALLS_WEBHOOK_URL"),
      leadCalls: pick("SLACK_LEAD_CALLS_WEBHOOK_URL"),
      legalAssistant: pick("SLACK_LEGAL_ASSISTANT_WEBHOOK_URL"),
    },
    // Per-firm state
    contactsCache: new Map(),
    quoUsersCache: new Map(),
    slackChannels: new Map(),
    slackUsers: new Map(),
    callCache: new Map(),
    pendingCallChecks: new Map(),
    resolvedCalls: new Set(),
  };
}

function registerFirms() {
  const config = loadFirmConfigFile();
  if (config && typeof config === "object") {
    for (const [firmId, firmConfig] of Object.entries(config)) {
      if (firmId.startsWith("_")) continue; // skip _docs, _comment, etc.
      firms.set(firmId, makeFirm(firmId, firmConfig || {}));
    }
  }
  // Legacy fallback: if no firms.json/FIRMS_CONFIG, synthesize a default firm from legacy env vars
  if (firms.size === 0 && process.env.QUO_API_KEY) {
    console.warn(`[firms] No firms.json found — synthesizing "${DEFAULT_FIRM_ID}" from legacy env vars`);
    firms.set(DEFAULT_FIRM_ID, makeFirm(DEFAULT_FIRM_ID, {
      name: "Ramos James Law",
      practiceArea: "personal injury",
      phoneLines: {
        "+15125373369": "RJL Main Line",
        "+19563137771": "RGV Number",
        "+15126010647": "Intake",
        "+15125005266": "RJL Outbound",
        "+15126300907": "RJL Transfers",
      },
      leadThreadTagUsers: ["U026P9FUKHC", "U0ANAJK56LD"],
    }));
  }
  const summary = Array.from(firms.entries()).map(([id, f]) => `${id} (${f.name})`).join(", ");
  console.log(`[firms] Registered ${firms.size} firm(s): ${summary || "(none)"}`);
}

function getFirm(firmId) {
  return firms.get(firmId) || null;
}

// === Firm-agnostic Utilities ===

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safe(val) {
  if (val === null || val === undefined) return "N/A";
  if (Array.isArray(val)) return val.join(" ") || "N/A";
  return String(val).trim() || "N/A";
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

function lastTenDigits(phone) {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function insertMentionsAfterTitle(text, userIds) {
  if (!userIds || userIds.length === 0) return text;
  const mentions = userIds.map((id) => `<@${id}>`).join(" ");
  const nlIdx = text.indexOf("\n");
  if (nlIdx === -1) return `${text}\n${mentions}`;
  return `${text.slice(0, nlIdx)}\n${mentions}${text.slice(nlIdx)}`;
}

function extractCaseNumber(contactName) {
  if (!contactName) return null;
  const matches = contactName.match(/\b\d{3,5}\b/g);
  if (!matches || matches.length === 0) return null;
  return matches.reduce((max, num) => (Number(num) > Number(max) ? num : max));
}

// --- Spanish detection + translation ---
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
  const hasSpecialChars = /[áéíóúñ¿¡ü]/.test(lower);
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
  if (translated) return `\n🌐 Translation: ${translated}`;
  return "";
}

// --- Slack webhook (URL + text) ---
async function postToSlack(webhookUrl, text) {
  if (!webhookUrl) {
    console.error("Slack webhook URL not configured");
    return;
  }
  try {
    const payload = {
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      text,
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

// --- Slack message searching (firm-agnostic; operates on message list) ---
function getFullMessageText(msg) {
  let parts = [msg.text || ""];
  if (msg.attachments) {
    for (const att of msg.attachments) {
      parts.push(att.text || "", att.fallback || "", att.pretext || "", att.title || "");
      if (att.fields) {
        for (const f of att.fields) parts.push(f.title || "", f.value || "");
      }
    }
  }
  if (msg.blocks) {
    for (const block of msg.blocks) {
      if (block.text?.text) parts.push(block.text.text);
      if (block.fields) {
        for (const f of block.fields) parts.push(f.text || "");
      }
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
  const matches = [];
  for (const msg of messages) {
    const fullText = getFullMessageText(msg);
    let found = false;
    const msgDigits = fullText.match(/\d{7,}/g) || [];
    for (const seq of msgDigits) {
      const seqLast10 = seq.length >= 10 ? seq.slice(-10) : seq;
      if (seqLast10 === last10) { found = true; break; }
    }
    if (!found && (fullText.includes(phoneNumber) || fullText.includes(normalized) || fullText.includes(last10))) {
      found = true;
    }
    if (!found) {
      const strippedDigits = fullText.replace(/\D/g, "");
      if (strippedDigits.includes(last10)) found = true;
    }
    if (found) {
      const ts = msg.thread_ts || msg.ts;
      matches.push(ts);
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => parseFloat(a) - parseFloat(b));
  console.log(`[lead-thread] Found ${matches.length} messages with phone match, using earliest (ts: ${matches[0]})`);
  return matches[0];
}

// --- Sona detection (firm-agnostic; operates on payload + cached call) ---
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

// === Quo API (per-firm) ===

async function loadQuoContacts(firm) {
  if (!firm.quoApiKey) {
    console.warn(`[${firm.id}][contacts] QUO_API_KEY not set — skipping contact sync`);
    return;
  }
  console.log(`[${firm.id}][contacts] Fetching contacts from Quo API...`);
  let totalLoaded = 0;
  let pageToken = null;
  try {
    do {
      const url = new URL("https://api.openphone.com/v1/contacts");
      url.searchParams.set("maxResults", "50");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      let res;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await fetch(url.toString(), { headers: { Authorization: firm.quoApiKey } });
        if (res.status !== 429) break;
        const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
        const backoff = retryAfter > 0 ? retryAfter * 1000 : (2 ** attempt) * 2000;
        console.warn(`[${firm.id}][contacts] Rate limited (429), retrying in ${backoff / 1000}s (attempt ${attempt + 1}/4)`);
        await sleep(backoff);
      }
      if (!res.ok) {
        console.error(`[${firm.id}][contacts] Quo API responded ${res.status}: ${await res.text()}`);
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
          if (phone.value) firm.contactsCache.set(phone.value, name);
        }
      }
      totalLoaded += contacts.length;
      pageToken = json.nextPageToken || null;
      if (pageToken) await sleep(500);
    } while (pageToken);
    console.log(`[${firm.id}][contacts] Loaded ${totalLoaded} contacts, ${firm.contactsCache.size} phone numbers mapped`);
  } catch (err) {
    console.error(`[${firm.id}][contacts] Error fetching contacts:`, err.message);
  }
}

function getContactName(firm, phoneNumber) {
  if (!phoneNumber) return null;
  return firm.contactsCache.get(phoneNumber) || null;
}

async function loadQuoUsers(firm) {
  if (!firm.quoApiKey) return;
  console.log(`[${firm.id}][quo-users] Fetching users from Quo API...`);
  try {
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch("https://api.openphone.com/v1/users", {
        headers: { Authorization: firm.quoApiKey },
      });
      if (res.status !== 429) break;
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      const backoff = retryAfter > 0 ? retryAfter * 1000 : (2 ** attempt) * 2000;
      console.warn(`[${firm.id}][quo-users] Rate limited (429), retrying in ${backoff / 1000}s (attempt ${attempt + 1}/4)`);
      await sleep(backoff);
    }
    if (!res.ok) {
      console.error(`[${firm.id}][quo-users] Quo API responded ${res.status}: ${await res.text()}`);
      return;
    }
    const json = await res.json();
    const users = json.data || [];
    firm.quoUsersCache.clear();
    for (const user of users) {
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
      if (user.id && name) firm.quoUsersCache.set(user.id, name);
    }
    console.log(`[${firm.id}][quo-users] Loaded ${firm.quoUsersCache.size} users`);
  } catch (err) {
    console.error(`[${firm.id}][quo-users] Error fetching users:`, err.message);
  }
}

function getQuoUserName(firm, userId) {
  if (!userId) return null;
  return firm.quoUsersCache.get(userId) || null;
}

async function fetchCallFromQuo(firm, callId) {
  if (!firm.quoApiKey || !callId) return null;
  try {
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(`https://api.openphone.com/v1/calls/${callId}`, {
        headers: { Authorization: firm.quoApiKey },
      });
      if (res.status !== 429) break;
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      const backoff = retryAfter > 0 ? retryAfter * 1000 : (2 ** attempt) * 2000;
      console.warn(`[${firm.id}][call-check] Rate limited (429), retrying in ${backoff / 1000}s (attempt ${attempt + 1}/4)`);
      await sleep(backoff);
    }
    if (!res.ok) {
      console.error(`[${firm.id}][call-check] Quo API responded ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json.data || json;
  } catch (err) {
    console.error(`[${firm.id}][call-check] Error fetching call:`, err.message);
    return null;
  }
}

// === Slack API (per-firm) ===

async function loadSlackChannels(firm) {
  if (!firm.slackBotToken) return;
  console.log(`[${firm.id}][slack] Loading channels...`);
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
        headers: { Authorization: `Bearer ${firm.slackBotToken}` },
      });
      const json = await res.json();
      if (!json.ok) {
        console.error(`[${firm.id}][slack] channels error: ${json.error}`);
        break;
      }
      for (const ch of json.channels || []) {
        firm.slackChannels.set(ch.name, { id: ch.id, topic: ch.topic?.value || "" });
      }
      total += (json.channels || []).length;
      cursor = json.response_metadata?.next_cursor || "";
    } while (cursor);
    console.log(`[${firm.id}][slack] Loaded ${total} channels`);
  } catch (err) {
    console.error(`[${firm.id}][slack] Error loading channels:`, err.message);
  }
}

async function loadSlackUsers(firm) {
  if (!firm.slackBotToken) return;
  console.log(`[${firm.id}][slack] Loading users...`);
  let cursor = "";
  let total = 0;
  try {
    do {
      const url = new URL("https://slack.com/api/users.list");
      url.searchParams.set("limit", "200");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${firm.slackBotToken}` },
      });
      const json = await res.json();
      if (!json.ok) {
        console.error(`[${firm.id}][slack] users error: ${json.error}`);
        break;
      }
      for (const user of json.members || []) {
        if (user.deleted || user.is_bot) continue;
        const displayName = (user.profile?.display_name || "").toLowerCase().trim();
        const realName = (user.real_name || "").toLowerCase().trim();
        const firstName = (user.profile?.first_name || "").toLowerCase().trim();
        if (displayName) firm.slackUsers.set(displayName, user.id);
        if (realName) firm.slackUsers.set(realName, user.id);
        if (firstName) firm.slackUsers.set(firstName, user.id);
      }
      total += (json.members || []).length;
      cursor = json.response_metadata?.next_cursor || "";
    } while (cursor);
    console.log(`[${firm.id}][slack] Loaded ${total} users, ${firm.slackUsers.size} name mappings`);
  } catch (err) {
    console.error(`[${firm.id}][slack] Error loading users:`, err.message);
  }
}

async function postViaBot(firm, channelId, text) {
  if (!firm.slackBotToken) return false;
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firm.slackBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: channelId, text }),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`[${firm.id}][slack-bot] Error posting to ${channelId}: ${json.error}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[${firm.id}][slack-bot] Error:`, err.message);
    return false;
  }
}

async function fetchLeadChannelHistory(firm) {
  if (!firm.slackBotToken || !firm.slackLeadCallsChannelId) return [];
  const allMessages = [];
  const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
  let cursor = "";
  try {
    do {
      const url = new URL("https://slack.com/api/conversations.history");
      url.searchParams.set("channel", firm.slackLeadCallsChannelId);
      url.searchParams.set("limit", "200");
      url.searchParams.set("oldest", String(sevenDaysAgo));
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${firm.slackBotToken}` },
      });
      const json = await res.json();
      if (!json.ok) {
        console.error(`[${firm.id}][lead-thread] Slack API error: ${json.error}`);
        break;
      }
      allMessages.push(...(json.messages || []));
      cursor = json.response_metadata?.next_cursor || "";
    } while (cursor);
    console.log(`[${firm.id}][lead-thread] Fetched ${allMessages.length} total messages from lead-calls (7 days)`);
    return allMessages;
  } catch (err) {
    console.error(`[${firm.id}][lead-thread] Error fetching history:`, err.message);
    return allMessages;
  }
}

async function findThreadByPhone(firm, phoneNumber) {
  if (!firm.slackBotToken || !firm.slackLeadCallsChannelId || !phoneNumber) return null;
  const last10 = lastTenDigits(phoneNumber);
  console.log(`[${firm.id}][lead-thread] Searching for phone ${phoneNumber} (last10: ${last10})`);
  let messages = await fetchLeadChannelHistory(firm);
  let threadTs = searchChannelHistoryForPhone(messages, phoneNumber);
  if (threadTs) return threadTs;
  console.log(`[${firm.id}][lead-thread] No thread found for ${phoneNumber}, retrying in 5s...`);
  await sleep(5000);
  messages = await fetchLeadChannelHistory(firm);
  threadTs = searchChannelHistoryForPhone(messages, phoneNumber);
  if (threadTs) return threadTs;
  console.log(`[${firm.id}][lead-thread] No thread found for ${phoneNumber} after retry`);
  return null;
}

async function getSlackPermalink(firm, channelId, messageTs) {
  if (!firm.slackBotToken || !channelId || !messageTs) return null;
  try {
    const url = new URL("https://slack.com/api/chat.getPermalink");
    url.searchParams.set("channel", channelId);
    url.searchParams.set("message_ts", messageTs);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${firm.slackBotToken}` },
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`[${firm.id}][permalink] Slack API error: ${json.error}`);
      return null;
    }
    return json.permalink || null;
  } catch (err) {
    console.error(`[${firm.id}][permalink] Error:`, err.message);
    return null;
  }
}

async function postLeadToSlack(firm, text, phoneFrom, phoneTo, { mentionUsersIfThreaded = [] } = {}) {
  if (firm.slackBotToken && firm.slackLeadCallsChannelId) {
    try {
      const phones = [phoneFrom, phoneTo].filter(Boolean);
      let threadTs = null;
      for (const phone of phones) {
        if (firm.phoneLines[phone]) continue;
        threadTs = await findThreadByPhone(firm, phone);
        if (threadTs) break;
      }
      const finalText = threadTs
        ? insertMentionsAfterTitle(text, mentionUsersIfThreaded)
        : text;
      const body = { channel: firm.slackLeadCallsChannelId, text: finalText };
      if (threadTs) {
        body.thread_ts = threadTs;
        console.log(`[${firm.id}][lead-calls] Replying in thread ${threadTs}`);
      }
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firm.slackBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.ok) {
        console.error(`[${firm.id}][lead-calls] Slack API error: ${json.error}`);
        await postToSlack(firm.slackWebhooks.leadCalls, text);
        return null;
      }
      console.log(`[${firm.id}][lead-calls] Posted via Slack API (threaded: ${!!threadTs})`);
      const msgTs = json.ts;
      if (msgTs) {
        const permalink = await getSlackPermalink(firm, firm.slackLeadCallsChannelId, msgTs);
        console.log(`[${firm.id}][lead-calls] Permalink: ${permalink || "null"}`);
        return permalink;
      }
      console.warn(`[${firm.id}][lead-calls] No ts in Slack response — cannot build permalink`);
      return null;
    } catch (err) {
      console.error(`[${firm.id}][lead-calls] Slack API error:`, err.message);
      await postToSlack(firm.slackWebhooks.leadCalls, text);
    }
  } else {
    await postToSlack(firm.slackWebhooks.leadCalls, text);
  }
  return null;
}

async function threadInLeadChannelIfMatch(firm, text, phoneFrom, phoneTo, { mentionUsers = [] } = {}) {
  if (!firm.slackBotToken || !firm.slackLeadCallsChannelId) return false;
  const phones = [phoneFrom, phoneTo].filter(Boolean);
  let threadTs = null;
  for (const phone of phones) {
    if (firm.phoneLines[phone]) continue;
    const messages = await fetchLeadChannelHistory(firm);
    threadTs = searchChannelHistoryForPhone(messages, phone);
    if (threadTs) break;
  }
  if (!threadTs) return false;
  const finalText = insertMentionsAfterTitle(text, mentionUsers);
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firm.slackBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: firm.slackLeadCallsChannelId,
        text: finalText,
        thread_ts: threadTs,
      }),
    });
    const json = await res.json();
    if (json.ok) {
      console.log(`[${firm.id}][lead-thread] Threaded event in lead-calls (ts: ${threadTs})`);
      return true;
    }
    console.error(`[${firm.id}][lead-thread] Slack API error: ${json.error}`);
  } catch (err) {
    console.error(`[${firm.id}][lead-thread] Error:`, err.message);
  }
  return false;
}

async function fetchLegalAssistantHistory(firm) {
  if (!firm.slackBotToken || !firm.slackLegalAssistantChannelId) return [];
  const allMessages = [];
  const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  let cursor = "";
  try {
    do {
      const url = new URL("https://slack.com/api/conversations.history");
      url.searchParams.set("channel", firm.slackLegalAssistantChannelId);
      url.searchParams.set("limit", "200");
      url.searchParams.set("oldest", String(oneDayAgo));
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${firm.slackBotToken}` },
      });
      const json = await res.json();
      if (!json.ok) {
        console.error(`[${firm.id}][la-thread] Slack API error: ${json.error}`);
        break;
      }
      allMessages.push(...(json.messages || []));
      cursor = json.response_metadata?.next_cursor || "";
    } while (cursor);
    return allMessages;
  } catch (err) {
    console.error(`[${firm.id}][la-thread] Error fetching history:`, err.message);
    return allMessages;
  }
}

async function postToLegalAssistant(firm, text, phoneFrom, phoneTo) {
  if (firm.slackBotToken && firm.slackLegalAssistantChannelId) {
    try {
      const phones = [phoneFrom, phoneTo].filter(Boolean);
      let threadTs = null;
      const messages = await fetchLegalAssistantHistory(firm);
      for (const phone of phones) {
        if (firm.phoneLines[phone]) continue;
        threadTs = searchChannelHistoryForPhone(messages, phone);
        if (threadTs) break;
      }
      const body = { channel: firm.slackLegalAssistantChannelId, text };
      if (threadTs) {
        body.thread_ts = threadTs;
        console.log(`[${firm.id}][la-thread] Replying in thread ${threadTs}`);
      }
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firm.slackBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.ok) {
        console.error(`[${firm.id}][la-thread] Slack API error: ${json.error}`);
        await postToSlack(firm.slackWebhooks.legalAssistant, text);
      } else {
        console.log(`[${firm.id}][la-thread] Posted via Slack API (threaded: ${!!threadTs})`);
      }
      return;
    } catch (err) {
      console.error(`[${firm.id}][la-thread] Error:`, err.message);
    }
  }
  await postToSlack(firm.slackWebhooks.legalAssistant, text);
}

async function joinChannel(firm, channelId) {
  try {
    const res = await fetch("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firm.slackBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: channelId }),
    });
    const json = await res.json();
    if (!json.ok && json.error !== "already_in_channel") {
      console.error(`[${firm.id}][case-channel] Failed to join channel: ${json.error}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[${firm.id}][case-channel] Error joining channel:`, err.message);
    return false;
  }
}

async function fetchChannelTopic(firm, channelId) {
  try {
    const url = new URL("https://slack.com/api/conversations.info");
    url.searchParams.set("channel", channelId);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${firm.slackBotToken}` },
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`[${firm.id}][case-channel] conversations.info error: ${json.error}`);
      return null;
    }
    return json.channel?.topic?.value || "";
  } catch (err) {
    console.error(`[${firm.id}][case-channel] Error fetching channel topic:`, err.message);
    return null;
  }
}

function extractMentionsFromTopic(firm, topic) {
  if (!topic) return "";
  const userIdMatches = topic.match(/<@(U[A-Z0-9]+)>/g);
  if (userIdMatches && userIdMatches.length > 0) {
    console.log(`[${firm.id}][mentions] Found ${userIdMatches.length} user mentions in topic`);
    return userIdMatches.join(" ") + "\n";
  }
  const atMatches = topic.match(/@(\w+)/g);
  if (!atMatches) {
    console.log(`[${firm.id}][mentions] No mentions found in topic: "${topic}"`);
    return "";
  }
  const mentions = [];
  for (const atName of atMatches) {
    const name = atName.slice(1).toLowerCase();
    const userId = firm.slackUsers.get(name);
    if (userId) mentions.push(`<@${userId}>`);
    else console.log(`[${firm.id}][mentions] Could not resolve "${name}" to a Slack user`);
  }
  if (mentions.length > 0) {
    console.log(`[${firm.id}][mentions] Resolved ${mentions.length}/${atMatches.length} mentions`);
  }
  return mentions.length > 0 ? mentions.join(" ") + "\n" : "";
}

function findChannelByCaseNumber(firm, caseNumber) {
  for (const [name, info] of firm.slackChannels) {
    if (name.endsWith("-" + caseNumber) || name.endsWith(caseNumber)) {
      return { name, ...info };
    }
  }
  return null;
}

async function postToCaseChannel(firm, text, phoneFrom, phoneTo, { skipMentions = false } = {}) {
  if (!firm.slackBotToken) return;
  const phones = [phoneFrom, phoneTo].filter(Boolean);
  for (const phone of phones) {
    const contactName = getContactName(firm, phone);
    const caseNumber = extractCaseNumber(contactName);
    console.log(`[${firm.id}][case-channel] Phone: ${phone}, Contact: ${contactName || "none"}, Case#: ${caseNumber || "none"}`);
    if (!caseNumber) continue;
    let channel = findChannelByCaseNumber(firm, caseNumber);
    if (!channel) {
      console.log(`[${firm.id}][case-channel] No cached channel for case ${caseNumber}, refreshing...`);
      await loadSlackChannels(firm);
      channel = findChannelByCaseNumber(firm, caseNumber);
    }
    if (!channel) {
      console.log(`[${firm.id}][case-channel] No channel found for case ${caseNumber}`);
      continue;
    }
    const joined = await joinChannel(firm, channel.id);
    if (!joined) continue;
    const liveTopic = skipMentions ? null : await fetchChannelTopic(firm, channel.id);
    const mentions = skipMentions ? "" : extractMentionsFromTopic(firm, liveTopic ?? channel.topic);
    const caseText = mentions + text;
    const ok = await postViaBot(firm, channel.id, caseText);
    if (ok) {
      console.log(`[${firm.id}][case-channel] Posted to #${channel.name}${mentions ? " with mentions" : ""}`);
    }
  }
}

// === Call Cache + Fallback (per-firm) ===

function cacheCall(firm, callId, info) {
  firm.callCache.set(callId, { ...info, cachedAt: Date.now() });
  for (const [key, val] of firm.callCache) {
    if (Date.now() - val.cachedAt > CACHE_TTL) firm.callCache.delete(key);
  }
}

function getCachedCall(firm, callId) {
  const entry = firm.callCache.get(callId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL) {
    firm.callCache.delete(callId);
    return null;
  }
  return entry;
}

function scheduleCallCheck(firm, callId, cachedFrom, cachedTo, cachedDirection) {
  if (!callId || firm.resolvedCalls.has(callId)) return;
  clearScheduledCallCheck(firm, callId);
  const timeoutId = setTimeout(() => {
    firm.pendingCallChecks.delete(callId);
    if (firm.resolvedCalls.has(callId)) return;
    handleUnresolvedCall(firm, callId, cachedFrom, cachedTo, cachedDirection).catch((err) =>
      console.error(`[${firm.id}][call-check] Error:`, err.message),
    );
  }, CALL_CHECK_DELAY_MS);
  firm.pendingCallChecks.set(callId, timeoutId);
}

function clearScheduledCallCheck(firm, callId) {
  if (!callId) return;
  const tid = firm.pendingCallChecks.get(callId);
  if (tid) {
    clearTimeout(tid);
    firm.pendingCallChecks.delete(callId);
  }
}

function markCallResolved(firm, callId) {
  if (!callId) return;
  firm.resolvedCalls.add(callId);
  clearScheduledCallCheck(firm, callId);
  setTimeout(() => firm.resolvedCalls.delete(callId), CACHE_TTL);
}

async function handleUnresolvedCall(firm, callId, cachedFrom, cachedTo, cachedDirection) {
  const call = await fetchCallFromQuo(firm, callId);
  if (!call) {
    console.log(`[${firm.id}][call-check] Could not verify call ${callId} via API — skipping`);
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

  cacheCall(firm, callId, { from: call.from || cachedFrom, to: call.to || cachedTo, direction, answeredBy, userId: call.userId });
  console.log(`[${firm.id}][call-check] Call ${callId}: status=${status}, answeredBy=${answeredBy || "none"}, direction=${direction}`);

  if (status === "in-progress" || status === "ringing" || status === "queued" || status === "initiated") {
    console.log(`[${firm.id}][call-check] Call ${callId} still ${status} — rescheduling`);
    scheduleCallCheck(firm, callId, cachedFrom, cachedTo, cachedDirection);
    return;
  }

  if (direction !== "incoming") {
    console.log(`[${firm.id}][call-check] Outbound call ${callId} — skipping fallback`);
    return;
  }

  const fromDisplay = formatFrom(firm, from);
  const toDisplay = formatPhone(firm, to);
  const externalNumber = firm.phoneLines[from] ? to : from;
  const isSavedContact = !!getContactName(firm, externalNumber);

  const isMissedStatus = ["no-answer", "busy", "canceled", "failed"].includes(status);
  const isMenuHangup = status === "completed" && !!answeredAt && !answeredBy && !hasVoicemail;
  const isAnswered = status === "completed" && !!answeredBy;

  if (isMissedStatus || isMenuHangup || (status === "completed" && !answeredAt && !hasVoicemail)) {
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
    console.log(`[${firm.id}][call-check] Fallback: ${isMenuHangup ? "menu hangup" : "missed"} for ${callId}`);
    await postToSlack(firm.slackWebhooks.missedCalls, text);
    await threadInLeadChannelIfMatch(firm, text, from, to, { mentionUsers: firm.leadThreadTagUsers });
    const externalPhone = firm.phoneLines[from] ? to : from;
    if (!isExistingClient(firm, externalPhone)) {
      await postToLegalAssistant(firm, text, from, to);
    }
    await postToCaseChannel(firm, text, from, to);
  } else if (isAnswered) {
    const isSona = answeredBy && (String(answeredBy).startsWith("SY") || String(answeredBy).toLowerCase().includes("sona"));
    const handlerName = getQuoUserName(firm, answeredBy);
    console.log(`[${firm.id}][call-check] Fallback: answered call for ${callId} (answeredBy: ${answeredBy}, sona: ${isSona})`);
    let text;
    if (isSona) {
      text = `🤖 *Sona Call Completed*\nFrom: ${fromDisplay}\nTo: ${toDisplay}\n_(No transcript received from Quo)_`;
      await postToSlack(firm.slackWebhooks.sonaCalls, text);
    } else {
      const handlerLine = handlerName ? `\nHandled By: *${handlerName}*` : "";
      text = `🧑 *Human Call Completed*${handlerLine}\nFrom: ${fromDisplay}\nTo: ${toDisplay}\n_(No transcript received from Quo)_`;
      await postToSlack(firm.slackWebhooks.humanCalls, text);
    }
    if (shouldRouteToLegalAssistant(firm, from, to)) {
      await postToLegalAssistant(firm, text, from, to);
    }
    await threadInLeadChannelIfMatch(firm, text, from, to, isSona ? { mentionUsers: firm.leadThreadTagUsers } : {});
    await postToCaseChannel(firm, text, from, to);
  } else {
    console.log(`[${firm.id}][call-check] Call ${callId} has unexpected status "${status}" — skipping`);
  }
}

// === Formatters (per-firm) ===

function formatPhone(firm, number) {
  const num = safe(number);
  const lineName = firm.phoneLines[num];
  if (lineName) return `${lineName} (${num})`;
  const contactName = getContactName(firm, num);
  if (contactName) return `${contactName} (${num})`;
  return num;
}

function formatFrom(firm, phoneNumber) {
  const num = safe(phoneNumber);
  const contactName = getContactName(firm, num);
  if (contactName) return `${contactName} (${num})`;
  return formatPhone(firm, num);
}

// === Detection (per-firm) ===

function isExistingClient(firm, phoneNumber) {
  const contactName = getContactName(firm, phoneNumber);
  return !!extractCaseNumber(contactName);
}

function isKnownBusiness(firm, phoneNumber) {
  const contactName = getContactName(firm, phoneNumber);
  if (!contactName) return false;
  if (extractCaseNumber(contactName)) return false;
  return true;
}

async function classifyLead(firm, payload, phoneFrom, phoneTo, cached) {
  const phones = [phoneFrom, phoneTo].filter(Boolean);
  for (const phone of phones) {
    if (firm.phoneLines[phone]) continue;
    if (isExistingClient(firm, phone)) {
      console.log(`[${firm.id}][lead] Skipping — existing client: ${getContactName(firm, phone)}`);
      return { isLead: false, isQualified: false, label: "No (Existing Client)" };
    }
    if (isKnownBusiness(firm, phone)) {
      console.log(`[${firm.id}][lead] Skipping — known business: ${getContactName(firm, phone)}`);
      return { isLead: false, isQualified: false, label: "No (Known Business)" };
    }
  }

  const text = extractText(payload);
  if (!text) return { isLead: false, isQualified: false, label: "No" };

  if (!ANTHROPIC_API_KEY) {
    console.warn(`[${firm.id}][lead] ANTHROPIC_API_KEY not set — cannot classify`);
    return { isLead: false, isQualified: false, label: "No (Unclassified)" };
  }

  try {
    const systemPrompt = `You classify call summaries for a ${firm.practiceArea} law firm (${firm.name}).

Classify each call into ONE of these categories:
- "qualified_lead": A NEW potential client seeking legal help for a situation the firm handles: car accidents, truck accidents, motorcycle accidents, pedestrian accidents, slip and fall, workplace injuries, workers comp, wrongful death, drunk driver, hit and run, or any personal injury case.
- "lead": A NEW potential client seeking legal help, but for something OUTSIDE ${firm.practiceArea} (family law, divorce, child support, criminal, immigration, etc.) OR a vague legal inquiry.
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
- If a caller's situation is explicitly outside ${firm.practiceArea} (e.g., "child support", "divorce") and the intake explicitly declined them, it's still a "lead" (just not qualified)

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
      console.error(`[${firm.id}][lead] Anthropic API error ${res.status}: ${await res.text()}`);
      return { isLead: false, isQualified: false, label: "No (API Error)" };
    }
    const json = await res.json();
    const reply = (json.content?.[0]?.text || "").toLowerCase().trim();
    console.log(`[${firm.id}][lead] LLM classification: "${reply}"`);
    if (reply.includes("qualified_lead")) return { isLead: true, isQualified: true, label: "🔥 Qualified Lead" };
    if (reply.includes("not_lead")) return { isLead: false, isQualified: false, label: "No" };
    if (reply.includes("lead")) return { isLead: true, isQualified: false, label: "Lead" };
    console.warn(`[${firm.id}][lead] Unexpected LLM response: "${reply}"`);
    return { isLead: false, isQualified: false, label: "No (Unparseable)" };
  } catch (err) {
    console.error(`[${firm.id}][lead] Classification error:`, err.message);
    return { isLead: false, isQualified: false, label: "No (Error)" };
  }
}

function shouldRouteToLegalAssistant(firm, phoneFrom, phoneTo) {
  const phones = [phoneFrom, phoneTo].filter(Boolean);
  for (const phone of phones) {
    if (firm.phoneLines[phone]) continue;
    if (isExistingClient(firm, phone)) return false;
  }
  return true;
}

// === Webhook Handlers ===

async function handleMessages(firm, req, res) {
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

    const fromDisplay = formatFrom(firm, from);
    const toDisplay = formatPhone(firm, to);

    const media = obj.media || [];
    const mediaLines = media
      .map((m) => {
        const url = m.url || m;
        const type = m.type || "attachment";
        return typeof url === "string" ? `📎 <${url}|${type}>` : null;
      })
      .filter(Boolean);
    const mediaSection = mediaLines.length > 0 ? "\n" + mediaLines.join("\n") : "";

    const translation = await appendTranslation(body);

    const text = `${emoji} *${label}*\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nMessage: ${body}${mediaSection}${translation}`;

    console.log(`[${firm.id}][messages] From: ${fromDisplay} → To: ${toDisplay} (media: ${media.length})`);
    await postToSlack(firm.slackWebhooks.textMessages, text);
    console.log(`[${firm.id}][messages] Sent to text-messages`);

    const threadedInLeads = await threadInLeadChannelIfMatch(firm, text, from, to);

    if (!isOutbound && !threadedInLeads && shouldRouteToLegalAssistant(firm, from, to)) {
      await postToLegalAssistant(firm, text, from, to);
      console.log(`[${firm.id}][messages] ALSO sent to legalassistant-phone`);
    }

    await postToCaseChannel(firm, text, from, to, { skipMentions: isOutbound });
  } catch (err) {
    console.error(`[${firm.id}][messages] Error:`, err.message);
  }
}

async function handleCalls(firm, req, res) {
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

    if (callId) {
      cacheCall(firm, callId, { from: obj.from, to: obj.to, direction, answeredBy: obj.answeredBy, userId: obj.userId });
      console.log(`[${firm.id}][calls] Cached call ${callId}: ${from} → ${to} (status: ${status}, answeredAt: ${answeredAt || "none"}, answeredBy: ${obj.answeredBy || "none"})`);
    }

    if (eventType === "call.ringing" || status === "ringing") {
      if (direction === "incoming") {
        scheduleCallCheck(firm, callId, obj.from, obj.to, direction);
        console.log(`[${firm.id}][calls] Ringing — scheduled API check in ${CALL_CHECK_DELAY_MS / 1000}s for ${callId}`);
      } else {
        console.log(`[${firm.id}][calls] Ringing — waiting for completion`);
      }
      return;
    }

    const isMissedStatus = ["no-answer", "busy", "canceled", "failed"].includes(status);
    const isUnanswered = status === "completed" && !answeredAt && direction === "incoming";
    const hasVoicemail = voicemail && (typeof voicemail === "string" ? voicemail : voicemail.url);
    const isMenuHangup =
      status === "completed" &&
      direction === "incoming" &&
      !!answeredAt &&
      !obj.answeredBy &&
      !hasVoicemail;

    if (!isMissedStatus && !isUnanswered && !hasVoicemail && !isMenuHangup) {
      console.log(`[${firm.id}][calls] Skipping answered call (status: ${status}) — waiting for /call-summary or fallback`);
      return;
    }

    markCallResolved(firm, callId);

    const fromDisplay = formatFrom(firm, from);
    const toDisplay = formatPhone(firm, to);

    if (direction === "outgoing") {
      const outHeader = hasVoicemail
        ? `📨 *Outbound Voicemail Left*`
        : `📞 *Outbound Call Not Answered*`;
      let outText = `${outHeader}\nFrom: ${fromDisplay}\nTo: ${toDisplay}`;
      if (hasVoicemail) {
        const vmUrl = typeof voicemail === "string" ? voicemail : voicemail.url;
        outText += `\nVoicemail: ${vmUrl}`;
      }
      console.log(`[${firm.id}][calls] Outbound ${hasVoicemail ? "voicemail left" : "no-answer"}: ${fromDisplay} → ${toDisplay}`);
      await postToCaseChannel(firm, outText, from, to, { skipMentions: true });
      return;
    }

    const externalNumber = firm.phoneLines[from] ? to : from;
    const isSavedContact = !!getContactName(firm, externalNumber);
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

    console.log(`[${firm.id}][calls] ${isMenuHangup ? "Menu hangup" : "Missed call"} from: ${fromDisplay}`);
    await postToSlack(firm.slackWebhooks.missedCalls, text);
    console.log(`[${firm.id}][calls] Sent to missed-calls-voicemail`);

    await threadInLeadChannelIfMatch(firm, text, from, to, { mentionUsers: firm.leadThreadTagUsers });

    const externalPhone = firm.phoneLines[from] ? to : from;
    if (!isExistingClient(firm, externalPhone)) {
      await postToLegalAssistant(firm, text, from, to);
      console.log(`[${firm.id}][calls] ALSO sent to legalassistant-phone`);
    } else {
      console.log(`[${firm.id}][calls] Skipping legalassistant-phone — existing client`);
    }

    await postToCaseChannel(firm, text, from, to);
  } catch (err) {
    console.error(`[${firm.id}][calls] Error:`, err.message);
  }
}

async function handleCallSummary(firm, req, res) {
  res.status(200).json({ received: true });
  try {
    const payload = req.body || {};
    const obj = payload.data?.object || {};
    const callId = obj.callId || null;
    const deepLink = payload.data?.deepLink || null;

    markCallResolved(firm, callId);

    const cached = callId ? getCachedCall(firm, callId) : null;
    const from = safe(cached?.from);
    const to = safe(cached?.to);

    const rawSummary = obj.summary;
    const summary = Array.isArray(rawSummary) ? "• " + rawSummary.join("\n• ") : safe(rawSummary);

    const sona = isSonaCall(payload, cached);
    const { isLead, isQualified, label: leadLabel } = await classifyLead(firm, payload, from, to, cached);

    const fromDisplay = formatFrom(firm, from);
    const toDisplay = formatPhone(firm, to);

    const summaryText = Array.isArray(rawSummary) ? rawSummary.join(" ") : (rawSummary || "");
    const translation = await appendTranslation(summaryText);

    console.log(`[${firm.id}][call-summary] From: ${fromDisplay} | To: ${toDisplay} | Sona: ${sona} | Lead: ${leadLabel}`);

    const linkLine = deepLink ? `\n<${deepLink}|View in Quo>` : "";

    let leadPermalink = null;
    if (isLead) {
      const handlerDisplay = sona ? "Sona" : (getQuoUserName(firm, cached?.answeredBy) || getQuoUserName(firm, cached?.userId) || "Human");
      const qualTag = isQualified ? "🔥 *Qualified Lead Call*" : "📋 *Lead Call*";
      const leadText = `${qualTag}\nHandled By: ${handlerDisplay}\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}${linkLine}`;
      const leadPostOpts = sona ? { mentionUsersIfThreaded: firm.leadThreadTagUsers } : {};
      leadPermalink = await postLeadToSlack(firm, leadText, from, to, leadPostOpts);
      console.log(`[${firm.id}][call-summary] Sent to lead-calls (${leadLabel})`);
    }

    let text;
    if (sona) {
      const leadLink = leadPermalink ? `\n<${leadPermalink}|View in #lead-calls>` : "";
      console.log(`[${firm.id}][call-summary] Sona post — isLead=${isLead}, leadPermalink=${leadPermalink || "null"}`);
      text = `🤖 *Sona Call Completed*\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}\nLead: ${leadLabel}${leadLink}${linkLine}`;
      await postToSlack(firm.slackWebhooks.sonaCalls, text);
      console.log(`[${firm.id}][call-summary] Sent to sona-calls`);
    } else {
      const answeredById = cached?.answeredBy;
      const handlerName = getQuoUserName(firm, answeredById) || getQuoUserName(firm, cached?.userId);
      console.log(`[${firm.id}][call-summary] Handler lookup: answeredBy=${answeredById}, userId=${cached?.userId}, resolved=${handlerName || "not found"}, cache size=${firm.quoUsersCache.size}`);
      const handlerLine = handlerName ? `\nHandled By: *${handlerName}*` : "";
      text = `🧑 *Human Call Completed*${handlerLine}\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}\nLead: ${leadLabel}${linkLine}`;
      await postToSlack(firm.slackWebhooks.humanCalls, text);
      console.log(`[${firm.id}][call-summary] Sent to human-calls`);
    }

    let threadedInLeads = false;
    if (!isLead) {
      const threadOpts = sona ? { mentionUsers: firm.leadThreadTagUsers } : {};
      threadedInLeads = await threadInLeadChannelIfMatch(firm, text, from, to, threadOpts);
    }

    const isInbound = !!firm.phoneLines[to] || cached?.direction === "incoming";
    const sonaLeadOverride = sona && isLead;
    if (isInbound && shouldRouteToLegalAssistant(firm, from, to) && (sonaLeadOverride || (!isLead && !threadedInLeads))) {
      await postToLegalAssistant(firm, text, from, to);
      console.log(`[${firm.id}][call-summary] ALSO sent to legalassistant-phone`);
    } else if (!isLead && !threadedInLeads && !isInbound) {
      console.log(`[${firm.id}][call-summary] Skipping legalassistant-phone — outbound (to=${to})`);
    }

    await postToCaseChannel(firm, text, from, to);
  } catch (err) {
    console.error(`[${firm.id}][call-summary] Error:`, err.message);
  }
}

// === Routes ===

app.get("/", (_req, res) => {
  const firmList = Array.from(firms.values()).map((f) => `${f.id} (${f.name})`).join(", ");
  res.send(`Quo Slack Router Running — firms: ${firmList || "(none)"}`);
});

// Multi-tenant routes — firmId in URL path
function withFirm(handler) {
  return async (req, res) => {
    const firmId = req.params.firmId;
    const firm = getFirm(firmId);
    if (!firm) {
      console.warn(`[router] Unknown firmId: ${firmId}`);
      return res.status(404).json({ error: `Unknown firm: ${firmId}` });
    }
    return handler(firm, req, res);
  };
}

app.post("/webhooks/quo/:firmId/messages", withFirm(handleMessages));
app.post("/webhooks/quo/:firmId/calls", withFirm(handleCalls));
app.post("/webhooks/quo/:firmId/call-summary", withFirm(handleCallSummary));

// Legacy routes — route to default firm so existing Quo webhook URLs keep working
function withDefaultFirm(handler) {
  return async (req, res) => {
    const firm = getFirm(DEFAULT_FIRM_ID);
    if (!firm) {
      console.warn(`[router] DEFAULT_FIRM_ID "${DEFAULT_FIRM_ID}" not registered`);
      return res.status(404).json({ error: `Default firm not configured` });
    }
    return handler(firm, req, res);
  };
}

app.post("/webhooks/quo/messages", withDefaultFirm(handleMessages));
app.post("/webhooks/quo/calls", withDefaultFirm(handleCalls));
app.post("/webhooks/quo/call-summary", withDefaultFirm(handleCallSummary));

// === Admin UI (Google OAuth) ===

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const ADMIN_ALLOWED_DOMAINS = (process.env.ADMIN_ALLOWED_DOMAINS || "ramosjames.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// SESSION_SECRET signs the session cookie. If unset, we generate a random one at
// startup and warn — sessions won't survive a process restart in that case.
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  const gen = crypto.randomBytes(32).toString("base64url");
  console.warn("[auth] SESSION_SECRET not set — generated an ephemeral one; sessions will not survive restart");
  return gen;
})();

const SESSION_COOKIE = "quo_admin_session";
const OAUTH_STATE_COOKIE = "quo_admin_oauth_state";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
const FIRM_ID_PATTERN = /^[a-z0-9-]+$/;

const oauthConfigured = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((c) => {
    const eq = c.indexOf("=");
    if (eq === -1) return;
    const k = c.slice(0, eq).trim();
    if (k) out[k] = decodeURIComponent(c.slice(eq + 1).trim());
  });
  return out;
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySession(cookie) {
  if (!cookie || typeof cookie !== "string") return null;
  const dot = cookie.indexOf(".");
  if (dot === -1) return null;
  const body = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function getSession(req) {
  const cookies = parseCookies(req.get("cookie"));
  return verifySession(cookies[SESSION_COOKIE]);
}

function computeRedirectUri(req) {
  const base = PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/admin/auth/callback`;
}

function requireAuth(req, res, next) {
  if (!oauthConfigured) {
    return res.status(503).json({ error: "OAuth not configured on the server" });
  }
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  req.session = session;
  next();
}

function isAllowedEmail(email) {
  if (!email) return false;
  const domain = String(email).toLowerCase().split("@")[1] || "";
  return ADMIN_ALLOWED_DOMAINS.includes(domain);
}

// --- OAuth routes ---

app.get("/admin/auth/login", (req, res) => {
  if (!oauthConfigured) {
    return res
      .status(503)
      .send("OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.");
  }
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(OAUTH_STATE_COOKIE, state, {
    maxAge: 5 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", computeRedirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  // Optional UX hint — Google may still show account picker
  if (ADMIN_ALLOWED_DOMAINS.length === 1) {
    url.searchParams.set("hd", ADMIN_ALLOWED_DOMAINS[0]);
  }
  res.redirect(url.toString());
});

app.get("/admin/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(`OAuth error: ${String(error).replace(/[<>]/g, "")}`);
  }
  if (!code) return res.status(400).send("Missing authorization code");
  const cookies = parseCookies(req.get("cookie"));
  const expectedState = cookies[OAUTH_STATE_COOKIE];
  if (!state || state !== expectedState) {
    return res.status(400).send("Invalid state — please try logging in again.");
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: computeRedirectUri(req),
        grant_type: "authorization_code",
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("[auth] Token exchange failed:", tokenJson);
      return res.status(500).send(`Token exchange failed: ${tokenJson.error_description || tokenJson.error || "unknown"}`);
    }
    if (!tokenJson.id_token) {
      console.error("[auth] No id_token in response:", tokenJson);
      return res.status(500).send("No id_token returned by Google");
    }

    // Verify id_token via Google's tokeninfo endpoint
    const infoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenJson.id_token)}`,
    );
    const info = await infoRes.json();
    if (!infoRes.ok) {
      console.error("[auth] tokeninfo failed:", info);
      return res.status(401).send("ID token verification failed");
    }
    if (info.aud !== GOOGLE_CLIENT_ID) {
      console.error("[auth] aud mismatch:", info.aud, "vs", GOOGLE_CLIENT_ID);
      return res.status(401).send("ID token audience mismatch");
    }
    const emailVerified = info.email_verified === true || info.email_verified === "true";
    if (!emailVerified) {
      return res.status(403).send("Email not verified by Google");
    }
    const email = String(info.email || "").toLowerCase();
    if (!isAllowedEmail(email)) {
      console.warn(`[auth] Denied ${email} — domain not in allow list`);
      const domains = ADMIN_ALLOWED_DOMAINS.join(", ");
      return res
        .status(403)
        .send(`Access denied for ${email}. Only accounts from: ${domains}`);
    }

    const exp = Date.now() + SESSION_MAX_AGE_MS;
    res.cookie(SESSION_COOKIE, signSession({ email, exp }), {
      maxAge: SESSION_MAX_AGE_MS,
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
    });
    res.clearCookie(OAUTH_STATE_COOKIE);
    console.log(`[auth] Logged in ${email}`);
    res.redirect("/admin");
  } catch (err) {
    console.error("[auth] Callback error:", err.message);
    res.status(500).send("Login error");
  }
});

app.post("/admin/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

// --- Admin API + page ---

app.get("/admin", (req, res) => {
  // Always serve the HTML so the client can render an "OAuth not configured" message
  // or a "Log in with Google" button if unauthenticated. The API endpoints below still
  // require a valid session.
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/admin/api/session", (req, res) => {
  if (!oauthConfigured) {
    return res.status(503).json({
      error: "OAuth not configured",
      allowedDomains: ADMIN_ALLOWED_DOMAINS,
    });
  }
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({
      error: "Not authenticated",
      allowedDomains: ADMIN_ALLOWED_DOMAINS,
    });
  }
  res.json({ email: session.email, allowedDomains: ADMIN_ALLOWED_DOMAINS });
});

app.get("/admin/api/firms", requireAuth, (_req, res) => {
  const list = Array.from(firms.values()).map((f) => ({
    id: f.id,
    name: f.name,
    practiceArea: f.practiceArea,
    phoneLines: f.phoneLines,
    leadThreadTagUsers: f.leadThreadTagUsers,
    hasQuoApiKey: !!f.quoApiKey,
    hasSlackBotToken: !!f.slackBotToken,
    hasLeadCallsChannel: !!f.slackLeadCallsChannelId,
    hasLegalAssistantChannel: !!f.slackLegalAssistantChannelId,
  }));
  res.json(list);
});

app.post("/admin/api/firms", requireAuth, (req, res) => {
  const { id, name, practiceArea, phoneLines, leadThreadTagUsers } = req.body || {};

  if (!id || !FIRM_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: "id must be lowercase alphanumeric with hyphens" });
  }
  if (firms.has(id)) {
    return res.status(409).json({ error: `Firm "${id}" already exists` });
  }
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }
  if (phoneLines && typeof phoneLines !== "object") {
    return res.status(400).json({ error: "phoneLines must be an object mapping phone → line name" });
  }
  if (leadThreadTagUsers && !Array.isArray(leadThreadTagUsers)) {
    return res.status(400).json({ error: "leadThreadTagUsers must be an array of Slack user IDs" });
  }

  const firmConfig = {
    name: String(name).trim(),
    practiceArea: String(practiceArea || "personal injury").trim(),
    phoneLines: phoneLines || {},
    leadThreadTagUsers: leadThreadTagUsers || [],
  };

  // Persist to firms.json on disk (may be ephemeral depending on host)
  const configPath = path.join(__dirname, "firms.json");
  let onDisk = {};
  if (fs.existsSync(configPath)) {
    try {
      onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      return res.status(500).json({ error: `firms.json is corrupt: ${err.message}` });
    }
  }
  onDisk[id] = firmConfig;
  try {
    fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2) + "\n");
  } catch (err) {
    console.error(`[admin] Failed to write firms.json:`, err.message);
    return res.status(500).json({ error: `Failed to write firms.json: ${err.message}` });
  }

  // Register in-memory so it's live immediately
  const firm = makeFirm(id, firmConfig);
  firms.set(id, firm);
  console.log(`[admin] Registered new firm "${id}" (${firmConfig.name})`);

  // Kick off cache load in the background
  loadFirmCaches(firm).catch((err) =>
    console.error(`[${id}][startup] Cache load error:`, err.message)
  );

  res.json({ ok: true, firmId: id, config: firmConfig });
});

// === Startup ===

registerFirms();

app.listen(PORT, () => {
  console.log(`Quo Slack Router listening on port ${PORT}`);
});

// Load caches for each firm in the background
async function loadFirmCaches(firm) {
  await Promise.all([loadSlackChannels(firm), loadSlackUsers(firm)]);
  await loadQuoContacts(firm);
  await loadQuoUsers(firm);
  console.log(`[${firm.id}][startup] Caches loaded`);
}

(async () => {
  for (const firm of firms.values()) {
    await loadFirmCaches(firm);
  }
  console.log(`[startup] All firms initialized`);
})();

// Periodic refresh
setInterval(() => {
  for (const firm of firms.values()) loadQuoContacts(firm);
}, CONTACTS_REFRESH_INTERVAL);

setInterval(() => {
  for (const firm of firms.values()) loadQuoUsers(firm);
}, QUO_USERS_REFRESH_INTERVAL);

setInterval(() => {
  for (const firm of firms.values()) loadSlackChannels(firm);
}, SLACK_CHANNELS_REFRESH_INTERVAL);

setInterval(() => {
  for (const firm of firms.values()) loadSlackUsers(firm);
}, SLACK_USERS_REFRESH_INTERVAL);
