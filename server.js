import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import dns from "node:dns";
import { fileURLToPath } from "url";

// Prefer IPv4 when resolving hostnames. Some hosts (e.g. Railway) have no
// outbound IPv6 route, and Node 18+ returns DNS results verbatim — so a
// dual-stack host like Supabase's pooler can resolve to an unreachable IPv6
// address (ENETUNREACH). Preferring IPv4 avoids that; all our upstreams
// (Slack, Quo, Anthropic, Supabase pooler) are reachable over IPv4.
dns.setDefaultResultOrder("ipv4first");

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
const CASE_STATUS_REFRESH_INTERVAL = 30 * 60 * 1000;
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

// Per-firm secret/credential fields. `key` is BOTH the env-var suffix
// (FIRM_<ID>_<key>) and the key used in the stored-secrets object.
const SECRET_FIELDS = [
  { key: "QUO_API_KEY", label: "Quo API Key", secret: true },
  { key: "SLACK_BOT_TOKEN", label: "Slack Bot Token", secret: true },
  { key: "SLACK_TEXT_MESSAGES_WEBHOOK_URL", label: "#text-messages webhook", secret: true },
  { key: "SLACK_MISSED_CALLS_WEBHOOK_URL", label: "#missed-calls webhook", secret: true },
  { key: "SLACK_HUMAN_CALLS_WEBHOOK_URL", label: "#human-calls webhook", secret: true },
  { key: "SLACK_SONA_CALLS_WEBHOOK_URL", label: "#sona-calls webhook", secret: true },
  { key: "SLACK_LEAD_CALLS_WEBHOOK_URL", label: "#lead-calls webhook", secret: true },
  { key: "SLACK_LEGAL_ASSISTANT_WEBHOOK_URL", label: "#legalassistant-phone webhook", secret: true },
  { key: "SLACK_LEAD_CALLS_CHANNEL_ID", label: "#lead-calls channel ID", secret: false },
  { key: "SLACK_LEGAL_ASSISTANT_CHANNEL_ID", label: "#legalassistant-phone channel ID", secret: false },
  { key: "CASE_DB_URL", label: "Case DB connection string (Supabase Postgres, optional)", secret: true },
];

// Resolve a firm's credentials with precedence: FIRM_<ID>_<key> env var wins,
// then legacy un-prefixed env (default firm only), then UI-stored secrets.
// Env always wins so an existing env-based deployment can never be overridden
// by a value saved through the admin UI.
function resolveFirmSecrets(firmId, storedSecrets) {
  const upper = firmId.toUpperCase();
  const perFirm = (key) => process.env[`FIRM_${upper}_${key}`];
  const legacyOk = firmId === DEFAULT_FIRM_ID && !perFirm("QUO_API_KEY") && !perFirm("SLACK_BOT_TOKEN");
  const legacy = (key) => (legacyOk ? process.env[key] : undefined);
  const stored = storedSecrets || {};
  const pick = (key) => perFirm(key) || legacy(key) || stored[key] || null;
  return {
    slackLeadCallsChannelId: pick("SLACK_LEAD_CALLS_CHANNEL_ID"),
    slackLegalAssistantChannelId: pick("SLACK_LEGAL_ASSISTANT_CHANNEL_ID"),
    quoApiKey: pick("QUO_API_KEY"),
    slackBotToken: pick("SLACK_BOT_TOKEN"),
    caseDbUrl: pick("CASE_DB_URL"),
    slackWebhooks: {
      textMessages: pick("SLACK_TEXT_MESSAGES_WEBHOOK_URL"),
      missedCalls: pick("SLACK_MISSED_CALLS_WEBHOOK_URL"),
      humanCalls: pick("SLACK_HUMAN_CALLS_WEBHOOK_URL"),
      sonaCalls: pick("SLACK_SONA_CALLS_WEBHOOK_URL"),
      leadCalls: pick("SLACK_LEAD_CALLS_WEBHOOK_URL"),
      legalAssistant: pick("SLACK_LEGAL_ASSISTANT_WEBHOOK_URL"),
    },
  };
}

// For the admin UI: report where each credential comes from without leaking it.
// Returns { <key>: "env" | "stored" | null }.
function secretSources(firmId, storedSecrets) {
  const upper = firmId.toUpperCase();
  const legacyOk = firmId === DEFAULT_FIRM_ID
    && !process.env[`FIRM_${upper}_QUO_API_KEY`]
    && !process.env[`FIRM_${upper}_SLACK_BOT_TOKEN`];
  const out = {};
  for (const { key } of SECRET_FIELDS) {
    if (process.env[`FIRM_${upper}_${key}`]) out[key] = "env";
    else if (legacyOk && process.env[key]) out[key] = "env";
    else if (storedSecrets && storedSecrets[key]) out[key] = "stored";
    else out[key] = null;
  }
  return out;
}

// Normalize the case-status config from a firm's config object.
// caseStatusQuery: SQL returning columns aliased (case_number, status).
// caseClosedValues: lowercased status strings that mean "closed/archived".
function normalizeCaseStatusConfig(config) {
  const raw = config.caseStatusConfig || {};
  const query = typeof raw.query === "string" ? raw.query.trim() : "";
  let closed = raw.closedValues;
  if (!Array.isArray(closed)) closed = ["archived"];
  closed = closed.map((v) => String(v).toLowerCase().trim()).filter(Boolean);
  return { query, closedValues: closed.length ? closed : ["archived"] };
}

// Intake extraction config. When enabled, qualified-lead call summaries are
// parsed into structured intake data and written to `table` in the case DB
// (CASE_DB_URL), with a Slack confirmation to notifyChannelId.
function normalizeIntakeConfig(config) {
  const raw = config.intakeConfig || {};
  const table = typeof raw.table === "string" && raw.table.trim() ? raw.table.trim() : "public.intakes";
  const notifyChannelId = typeof raw.notifyChannelId === "string" ? raw.notifyChannelId.trim() : "";
  return { enabled: !!raw.enabled, table, notifyChannelId };
}

function makeFirm(firmId, config, storedSecrets = {}) {
  return {
    id: firmId,
    name: config.name || firmId,
    practiceArea: config.practiceArea || "personal injury",
    phoneLines: config.phoneLines || {},
    leadThreadTagUsers: config.leadThreadTagUsers || [],
    // When true, only route events where `from` or `to` matches one of the
    // firm's phone lines (allowlist). Off by default so firms route everything.
    restrictToPhoneLines: !!config.restrictToPhoneLines,
    caseStatusConfig: normalizeCaseStatusConfig(config),
    intakeConfig: normalizeIntakeConfig(config),
    storedSecrets: storedSecrets || {},
    ...resolveFirmSecrets(firmId, storedSecrets),
    // Per-firm state
    contactsCache: new Map(),
    quoUsersCache: new Map(),
    slackChannels: new Map(),
    slackUsers: new Map(),
    callCache: new Map(),
    pendingCallChecks: new Map(),
    resolvedCalls: new Set(),
    caseStatusCache: new Map(), // caseNumber(string) -> status(string, lowercased)
  };
}

// Recompute a firm's derived credential fields in place (after its stored
// secrets change) without discarding caches or pending timers.
function applyFirmSecrets(firm) {
  Object.assign(firm, resolveFirmSecrets(firm.id, firm.storedSecrets));
}

function registerFirms() {
  const config = loadFirmConfigFile();
  if (config && typeof config === "object") {
    for (const [firmId, firmConfig] of Object.entries(config)) {
      if (firmId.startsWith("_")) continue; // skip _docs, _comment, etc.
      const firm = makeFirm(firmId, firmConfig || {});
      firm.source = "file";
      firms.set(firmId, firm);
    }
  }
  // Legacy fallback: if no firms.json/FIRMS_CONFIG, synthesize a default firm from legacy env vars
  if (firms.size === 0 && process.env.QUO_API_KEY) {
    console.warn(`[firms] No firms.json found — synthesizing "${DEFAULT_FIRM_ID}" from legacy env vars`);
    const legacyFirm = makeFirm(DEFAULT_FIRM_ID, {
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
    });
    legacyFirm.source = "file";
    firms.set(DEFAULT_FIRM_ID, legacyFirm);
  }
  const summary = Array.from(firms.entries()).map(([id, f]) => `${id} (${f.name})`).join(", ");
  console.log(`[firms] Registered ${firms.size} firm(s): ${summary || "(none)"}`);
}

function getFirm(firmId) {
  return firms.get(firmId) || null;
}

// === Firm Persistence (Postgres) ===
// New firms added via the admin UI are stored in Postgres so they survive
// redeploys. The default firm (ramosjames) is NOT stored here — it comes from
// the committed firms.json and its config path is unchanged. If DATABASE_URL is
// not set, the router falls back to writing firms.json on disk (ephemeral on
// most hosts), so the existing single-firm setup keeps working with no DB.

const DATABASE_URL = process.env.DATABASE_URL;
let pgPool = null;

// Optional encryption at rest for UI-stored credentials. If SECRET_ENCRYPTION_KEY
// is set, stored secrets are AES-256-GCM encrypted before they touch the DB, so a
// database dump alone can't reveal them. Without it, secrets are stored as
// plaintext JSON (still behind the DB's own access controls).
const SECRET_KEY = process.env.SECRET_ENCRYPTION_KEY
  ? crypto.scryptSync(process.env.SECRET_ENCRYPTION_KEY, "quo-router-secret-salt", 32)
  : null;

function encryptSecrets(obj) {
  const json = JSON.stringify(obj || {});
  if (!SECRET_KEY) return json; // plaintext fallback
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SECRET_KEY, iv);
  const ct = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

function decryptSecrets(str) {
  if (!str) return {};
  if (!str.startsWith("enc:")) {
    try { return JSON.parse(str); } catch { return {}; }
  }
  if (!SECRET_KEY) {
    console.error("[secrets] A firm's secrets are encrypted but SECRET_ENCRYPTION_KEY is not set — cannot decrypt");
    return {};
  }
  try {
    const [, , ivB, tagB, ctB] = str.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", SECRET_KEY, Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]);
    return JSON.parse(pt.toString("utf8"));
  } catch (err) {
    console.error("[secrets] Failed to decrypt stored secrets:", err.message);
    return {};
  }
}

async function initFirmStore() {
  if (!DATABASE_URL) {
    console.warn("[db] DATABASE_URL not set — new firms persist to firms.json only (ephemeral on most hosts)");
    return;
  }
  try {
    const pg = await import("pg");
    const { Pool } = pg.default || pg;
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
    });
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS firms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        practice_area TEXT NOT NULL DEFAULT 'personal injury',
        phone_lines JSONB NOT NULL DEFAULT '{}'::jsonb,
        lead_thread_tag_users JSONB NOT NULL DEFAULT '[]'::jsonb,
        secrets TEXT,
        restrict_to_phone_lines BOOLEAN NOT NULL DEFAULT false,
        case_status_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        intake_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Migrate older tables that predate newer columns.
    await pgPool.query(`ALTER TABLE firms ADD COLUMN IF NOT EXISTS secrets TEXT`);
    await pgPool.query(`ALTER TABLE firms ADD COLUMN IF NOT EXISTS restrict_to_phone_lines BOOLEAN NOT NULL DEFAULT false`);
    await pgPool.query(`ALTER TABLE firms ADD COLUMN IF NOT EXISTS case_status_config JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await pgPool.query(`ALTER TABLE firms ADD COLUMN IF NOT EXISTS intake_config JSONB NOT NULL DEFAULT '{}'::jsonb`);
    console.log(`[db] Connected to Postgres and ensured firms table exists${SECRET_KEY ? " (secret encryption ON)" : " (secrets stored as plaintext — set SECRET_ENCRYPTION_KEY to encrypt)"}`);
  } catch (err) {
    console.error("[db] Failed to initialize Postgres — falling back to firms.json:", err.message);
    pgPool = null;
  }
}

function rowToConfig(row) {
  return {
    name: row.name,
    practiceArea: row.practice_area,
    phoneLines: row.phone_lines || {},
    leadThreadTagUsers: row.lead_thread_tag_users || [],
    restrictToPhoneLines: !!row.restrict_to_phone_lines,
    caseStatusConfig: row.case_status_config || {},
    intakeConfig: row.intake_config || {},
  };
}

async function loadFirmsFromDb() {
  if (!pgPool) return 0;
  try {
    const { rows } = await pgPool.query("SELECT * FROM firms ORDER BY id");
    let count = 0;
    for (const row of rows) {
      if (row.id.startsWith("_")) continue;
      const secrets = decryptSecrets(row.secrets);
      // The default firm's base comes from firms.json (so it always exists, even
      // with an empty DB). If a DB row also exists — written when it's edited in
      // the admin UI — overlay it so UI config (incl. case-status + CASE_DB_URL)
      // persists across redeploys. firms.json phone lines are kept if the DB row
      // has none, so a partial row can't wipe the default firm.
      if (row.id === DEFAULT_FIRM_ID) {
        const existing = firms.get(row.id);
        const dbConfig = rowToConfig(row);
        const base = existing ? {
          name: existing.name,
          practiceArea: existing.practiceArea,
          phoneLines: existing.phoneLines,
          leadThreadTagUsers: existing.leadThreadTagUsers,
          restrictToPhoneLines: existing.restrictToPhoneLines,
          caseStatusConfig: existing.caseStatusConfig,
          intakeConfig: existing.intakeConfig,
        } : {};
        const merged = { ...base, ...dbConfig };
        if (!dbConfig.phoneLines || Object.keys(dbConfig.phoneLines).length === 0) {
          merged.phoneLines = base.phoneLines || {};
        }
        const f = makeFirm(row.id, merged, { ...(existing?.storedSecrets || {}), ...secrets });
        f.source = "db";
        firms.set(row.id, f);
        continue;
      }
      const firm = makeFirm(row.id, rowToConfig(row), secrets);
      firm.source = "db";
      firms.set(row.id, firm);
      count++;
    }
    console.log(`[db] Loaded ${count} firm(s) from Postgres`);
    return count;
  } catch (err) {
    console.error("[db] Error loading firms from Postgres:", err.message);
    return 0;
  }
}

async function saveFirmToDb(id, config, storedSecrets) {
  if (!pgPool) return false;
  await pgPool.query(
    `INSERT INTO firms (id, name, practice_area, phone_lines, lead_thread_tag_users, secrets, restrict_to_phone_lines, case_status_config, intake_config, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       practice_area = EXCLUDED.practice_area,
       phone_lines = EXCLUDED.phone_lines,
       lead_thread_tag_users = EXCLUDED.lead_thread_tag_users,
       secrets = EXCLUDED.secrets,
       restrict_to_phone_lines = EXCLUDED.restrict_to_phone_lines,
       case_status_config = EXCLUDED.case_status_config,
       intake_config = EXCLUDED.intake_config,
       updated_at = now()`,
    [
      id,
      config.name,
      config.practiceArea,
      JSON.stringify(config.phoneLines || {}),
      JSON.stringify(config.leadThreadTagUsers || []),
      encryptSecrets(storedSecrets || {}),
      !!config.restrictToPhoneLines,
      JSON.stringify(normalizeCaseStatusConfig(config)),
      JSON.stringify(normalizeIntakeConfig(config)),
    ],
  );
  return true;
}

async function deleteFirmFromDb(id) {
  if (!pgPool) return false;
  await pgPool.query("DELETE FROM firms WHERE id = $1", [id]);
  return true;
}

// Persist a new firm to firms.json on disk (fallback when no DATABASE_URL).
function saveFirmToDisk(id, config) {
  const configPath = path.join(__dirname, "firms.json");
  let onDisk = {};
  if (fs.existsSync(configPath)) {
    onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  onDisk[id] = config;
  fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2) + "\n");
}

function deleteFirmFromDisk(id) {
  const configPath = path.join(__dirname, "firms.json");
  if (!fs.existsSync(configPath)) return;
  const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!(id in onDisk)) return;
  delete onDisk[id];
  fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2) + "\n");
}

// Cancel all pending fallback timers for a firm (used when a firm is removed,
// so a scheduled call-check can't fire against a detached firm object).
function teardownFirm(firm) {
  for (const tid of firm.pendingCallChecks.values()) clearTimeout(tid);
  firm.pendingCallChecks.clear();
  firm.resolvedCalls.clear();
}

// === Firm-agnostic Utilities ===

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fetch with retry on transient failures: network errors (fetch throws), HTTP
// 429, and 5xx (e.g. OpenPhone's Cloudflare 522 origin timeouts). Respects
// Retry-After; otherwise exponential backoff. Returns the final Response, or
// throws if the network error persists past all attempts.
async function fetchWithRetry(url, options = {}, { attempts = 4, label = "fetch" } = {}) {
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      if (i >= attempts - 1) throw err;
      const backoff = (2 ** i) * 2000;
      console.warn(`[${label}] ${err.message} — retrying in ${backoff / 1000}s (attempt ${i + 1}/${attempts})`);
      await sleep(backoff);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      const backoff = retryAfter > 0 ? retryAfter * 1000 : (2 ** i) * 2000;
      console.warn(`[${label}] HTTP ${res.status} — retrying in ${backoff / 1000}s (attempt ${i + 1}/${attempts})`);
      await sleep(backoff);
      continue;
    }
    return res;
  }
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

// Does this number match one of the firm's configured phone lines? Compares on
// last-10-digits so small formatting differences (missing country code) still match.
function isOwnLine(firm, number) {
  if (!number) return false;
  if (firm.phoneLines[number]) return true; // exact
  const target = lastTenDigits(number);
  if (!target) return false;
  for (const line of Object.keys(firm.phoneLines)) {
    if (lastTenDigits(line) === target) return true;
  }
  return false;
}

// When a firm has restrictToPhoneLines on, an event is only routed if one of its
// parties is a configured line. Returns true if the event should be SKIPPED.
function blockedByPhoneLineFilter(firm, from, to) {
  if (!firm.restrictToPhoneLines) return false;
  return !isOwnLine(firm, from) && !isOwnLine(firm, to);
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
      const res = await fetchWithRetry(url.toString(), { headers: { Authorization: firm.quoApiKey } }, { label: `${firm.id}][contacts` });
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

// --- Case status (optional per-firm Supabase/Postgres sync) ---
// Syncs {case_number, status} rows into firm.caseStatusCache so routing can tell
// whether a case is open (active) or closed (archived). Only runs when the firm
// has both a CASE_DB_URL secret and a caseStatusConfig.query configured.
async function loadCaseStatuses(firm) {
  const query = firm.caseStatusConfig?.query;
  if (!firm.caseDbUrl || !query) return;

  // Read-only guard: single SELECT, no statement chaining.
  const q = query.trim().replace(/;+\s*$/, "");
  if (!/^select\b/i.test(q) || q.includes(";")) {
    console.error(`[${firm.id}][case-status] Query must be a single SELECT — skipping`);
    return;
  }

  let client;
  try {
    const pg = await import("pg");
    const { Client } = pg.default || pg;
    // Supabase (and most managed Postgres) require SSL; allow sslmode=disable in
    // the connection string to turn it off for local/self-hosted databases.
    const disableSsl = /sslmode=disable/i.test(firm.caseDbUrl);
    client = new Client({
      connectionString: firm.caseDbUrl,
      ssl: disableSsl ? false : { rejectUnauthorized: false },
      statement_timeout: 20000,
    });
    await client.connect();
    const { rows } = await client.query(q);
    const next = new Map();
    for (const row of rows) {
      const num = row.case_number ?? row.caseNumber ?? row.number ?? row.id;
      const status = row.status ?? row.state;
      if (num == null || status == null) continue;
      next.set(String(num).trim(), String(status).toLowerCase().trim());
    }
    firm.caseStatusCache = next;
    console.log(`[${firm.id}][case-status] Loaded ${next.size} case statuses`);
  } catch (err) {
    console.error(`[${firm.id}][case-status] Error loading case statuses:`, err.message);
  } finally {
    if (client) { try { await client.end(); } catch { /* ignore */ } }
  }
}

// Look up a case number's status; null if unknown / not synced.
function getCaseStatus(firm, caseNumber) {
  if (!caseNumber || !firm.caseStatusCache) return null;
  return firm.caseStatusCache.get(String(caseNumber).trim()) || null;
}

function isClosedStatus(firm, status) {
  if (!status) return false;
  const closed = firm.caseStatusConfig?.closedValues || ["archived"];
  return closed.includes(String(status).toLowerCase().trim());
}

// Is any phone party tied to a closed (archived) case?
function anyCaseClosed(firm, phones) {
  for (const phone of phones.filter(Boolean)) {
    const caseNumber = extractCaseNumber(getContactName(firm, phone));
    if (caseNumber && isClosedStatus(firm, getCaseStatus(firm, caseNumber))) return true;
  }
  return false;
}

// Short-lived Postgres client to the firm's case DB (Supabase). Shared by the
// case-status sync and the intake writer. SSL on by default; sslmode=disable in
// the URL turns it off for local/self-hosted databases.
async function connectCaseDb(firm) {
  const pg = await import("pg");
  const { Client } = pg.default || pg;
  const disableSsl = /sslmode=disable/i.test(firm.caseDbUrl);
  const client = new Client({
    connectionString: firm.caseDbUrl,
    ssl: disableSsl ? false : { rejectUnauthorized: false },
    statement_timeout: 20000,
  });
  await client.connect();
  return client;
}

// --- Intake extraction (qualified-lead calls → structured intake row) ---

// Form-shaped extraction schema (Ramos James new-client MVA intake). All fields
// optional; the model fills what the call actually contains and leaves the rest null.
const INTAKE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    referral: { type: "object", properties: {
      how_found: { type: ["string", "null"] },
      map_location: { type: ["string", "null"] },
    } },
    accident: { type: "object", properties: {
      date: { type: ["string", "null"], description: "date of accident" },
      time: { type: ["string", "null"] },
      representation_date: { type: ["string", "null"] },
      location: { type: ["string", "null"] },
      city: { type: ["string", "null"] },
      county: { type: ["string", "null"] },
      description: { type: ["string", "null"], description: "brief description of how the accident happened" },
      police_department: { type: ["string", "null"] },
      police_report_no: { type: ["string", "null"] },
      ticket_issued: { type: ["boolean", "null"] },
      ticket_who: { type: ["string", "null"] },
      ticket_reason: { type: ["string", "null"] },
    } },
    client: { type: "object", properties: {
      name: { type: ["string", "null"] },
      phone: { type: ["string", "null"] },
      email: { type: ["string", "null"] },
      address: { type: ["string", "null"] },
      dob: { type: ["string", "null"] },
      sex: { type: ["string", "null"] },
      dl_number: { type: ["string", "null"] },
      spouse_name: { type: ["string", "null"] },
      emergency_contact: { type: ["string", "null"] },
      passengers: { type: "array", items: { type: "string" } },
    } },
    property_damage: { type: "object", properties: {
      vehicle: { type: ["string", "null"], description: "client's car year make model" },
      owner: { type: ["string", "null"] },
      drivable: { type: ["boolean", "null"] },
      towed: { type: ["boolean", "null"] },
      towed_by: { type: ["string", "null"] },
      vehicle_location: { type: ["string", "null"] },
      has_loan: { type: ["boolean", "null"] },
      lienholder: { type: ["string", "null"] },
      rental_needed: { type: ["boolean", "null"] },
      body_shop: { type: ["string", "null"] },
    } },
    employment: { type: "object", properties: {
      employer: { type: ["string", "null"] },
      job_description: { type: ["string", "null"] },
      missed_work: { type: ["boolean", "null"] },
      salary_rate: { type: ["string", "null"] },
    } },
    other_driver: { type: "object", properties: {
      name: { type: ["string", "null"] },
      sex: { type: ["string", "null"] },
      dob: { type: ["string", "null"] },
      address: { type: ["string", "null"] },
      phone: { type: ["string", "null"] },
      dl_number: { type: ["string", "null"] },
      car_owner: { type: ["string", "null"] },
    } },
    insurance: { type: "object", properties: {
      client_company: { type: ["string", "null"] },
      client_policy_number: { type: ["string", "null"] },
      client_claim_number: { type: ["string", "null"] },
      third_party_company: { type: ["string", "null"] },
      third_party_policy_number: { type: ["string", "null"] },
      third_party_claim_number: { type: ["string", "null"] },
      pip: { type: ["boolean", "null"] },
      med_pay: { type: ["boolean", "null"] },
      um_uim: { type: ["boolean", "null"] },
    } },
    injury: { type: "object", properties: {
      ems: { type: ["boolean", "null"] },
      hospital_bill: { type: ["boolean", "null"] },
      hospital: { type: ["string", "null"] },
      treating_doctor: { type: ["string", "null"] },
      injury_types: { type: "array", items: { type: "string" } },
      medicaid: { type: ["boolean", "null"] },
      medicare: { type: ["boolean", "null"] },
      health_insurance: { type: ["string", "null"] },
    } },
    notes: { type: ["string", "null"] },
  },
  required: [],
};

async function extractIntake(firm, text) {
  if (!ANTHROPIC_API_KEY) {
    console.warn(`[${firm.id}][intake] ANTHROPIC_API_KEY not set — cannot extract`);
    return null;
  }
  try {
    const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        tools: [{
          name: "save_intake",
          description: "Save the client intake details extracted from the call.",
          input_schema: INTAKE_TOOL_SCHEMA,
        }],
        tool_choice: { type: "tool", name: "save_intake" },
        system: `You extract new-client intake details for a personal-injury (motor vehicle accident) law firm from a phone call summary/transcript. Only include facts EXPLICITLY stated in the call. Use null for anything not mentioned — never guess, infer, or fabricate names, numbers, dates, or places. If the call is not an accident intake, return mostly nulls.`,
        messages: [{ role: "user", content: `Call summary / transcript:\n${text}` }],
      }),
    }, { label: `${firm.id}][intake` });
    if (!res.ok) {
      console.error(`[${firm.id}][intake] Anthropic API error ${res.status}: ${await res.text()}`);
      return null;
    }
    const json = await res.json();
    const toolUse = (json.content || []).find((c) => c.type === "tool_use");
    return toolUse?.input || null;
  } catch (err) {
    console.error(`[${firm.id}][intake] Extraction error:`, err.message);
    return null;
  }
}

async function insertIntake(firm, record) {
  const table = firm.intakeConfig?.table || "public.intakes";
  // Table name is interpolated (identifiers can't be parameterized) — validate strictly.
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(table)) {
    console.error(`[${firm.id}][intake] Invalid intake table name "${table}"`);
    return { inserted: false, error: "invalid table name" };
  }
  let client;
  try {
    client = await connectCaseDb(firm);
    const res = await client.query(
      `INSERT INTO ${table} (call_id, name, phone, accident_date, quo_link, transcript, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (call_id) DO NOTHING`,
      [record.callId, record.name, record.phone, record.accidentDate, record.quoLink, record.transcript || null, JSON.stringify(record.data || {})],
    );
    return { inserted: res.rowCount > 0 };
  } catch (err) {
    console.error(`[${firm.id}][intake] Insert error:`, err.message);
    return { inserted: false, error: err.message };
  } finally {
    if (client) { try { await client.end(); } catch { /* ignore */ } }
  }
}

// Extract → insert → notify. Best-effort: any failure is logged and swallowed so
// it never affects normal call routing. Only runs for qualified leads.
async function runIntake(firm, { callId, deepLink, text, transcript, isQualified }) {
  if (!firm.intakeConfig?.enabled || !isQualified) return;
  if (!callId || !text) return;
  if (!firm.caseDbUrl) {
    console.warn(`[${firm.id}][intake] enabled but no case DB connection (CASE_DB_URL) — skipping`);
    return;
  }
  const extracted = await extractIntake(firm, text);
  if (!extracted) {
    console.warn(`[${firm.id}][intake] Nothing extracted for ${callId}`);
    return;
  }
  const name = extracted.client?.name || null;
  const phone = extracted.client?.phone || null;
  const accidentDate = extracted.accident?.date || null;

  const { inserted, error } = await insertIntake(firm, {
    callId, name, phone, accidentDate, quoLink: deepLink || null,
    transcript: transcript || text, data: extracted,
  });
  if (error) return;
  if (!inserted) {
    console.log(`[${firm.id}][intake] ${callId} already recorded — skipping`);
    return;
  }
  console.log(`[${firm.id}][intake] Loaded intake for ${name || "unknown"} (${callId})`);

  // Slack confirmation to the configured channel (default: #lead-calls).
  const detail = extracted.accident?.description
    ? `— ${extracted.accident.description}`
    : (accidentDate ? `— accident ${accidentDate}` : "");
  const line = `${name || "Unknown caller"}${phone ? ` (${phone})` : ""} ${detail}`.trim();
  const link = deepLink ? `\n<${deepLink}|View call in Quo>` : "";
  const msg = `📝 *Intake loaded* for ${line}${link}`;
  const channelId = firm.intakeConfig.notifyChannelId || firm.slackLeadCallsChannelId;
  if (channelId && firm.slackBotToken) {
    await postViaBot(firm, channelId, msg);
  } else if (firm.slackWebhooks.leadCalls) {
    await postToSlack(firm.slackWebhooks.leadCalls, msg);
  }
}

async function loadQuoUsers(firm) {
  if (!firm.quoApiKey) return;
  console.log(`[${firm.id}][quo-users] Fetching users from Quo API...`);
  try {
    const res = await fetchWithRetry("https://api.openphone.com/v1/users", {
      headers: { Authorization: firm.quoApiKey },
    }, { label: `${firm.id}][quo-users` });
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
    const res = await fetchWithRetry(`https://api.openphone.com/v1/calls/${callId}`, {
      headers: { Authorization: firm.quoApiKey },
    }, { label: `${firm.id}][call-check` });
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
      const res = await fetchWithRetry(url.toString(), {
        headers: { Authorization: `Bearer ${firm.slackBotToken}` },
      }, { label: `${firm.id}][slack` });
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
      const res = await fetchWithRetry(url.toString(), {
        headers: { Authorization: `Bearer ${firm.slackBotToken}` },
      }, { label: `${firm.id}][slack` });
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
    const res = await fetchWithRetry("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firm.slackBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: channelId }),
    }, { label: `${firm.id}][case-channel` });
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

// Auto-join the two "hub" channels the router reads history from and threads
// into (#lead-calls, #legalassistant-phone). Unlike case channels these aren't
// joined on demand, so without this the bot hits not_in_channel. Public channels
// join automatically; private ones can't be self-joined and must be invited.
async function ensureHubChannelsJoined(firm) {
  if (!firm.slackBotToken) return;
  const hubs = [
    ["lead-calls", firm.slackLeadCallsChannelId],
    ["legalassistant-phone", firm.slackLegalAssistantChannelId],
  ];
  for (const [label, id] of hubs) {
    if (!id) continue;
    const ok = await joinChannel(firm, id);
    if (ok) {
      console.log(`[${firm.id}][startup] In ${label} channel (${id})`);
    } else {
      console.warn(`[${firm.id}][startup] Could NOT auto-join ${label} (${id}) — if it's a private channel, invite the bot manually with /invite`);
    }
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
    // Flag closed/archived cases so the team knows it's a former client.
    const closed = isClosedStatus(firm, getCaseStatus(firm, caseNumber));
    const closedFlag = closed ? "⚠️ *CLOSED CASE — former client*\n" : "";
    const caseText = mentions + closedFlag + text;
    const ok = await postViaBot(firm, channel.id, caseText);
    if (ok) {
      console.log(`[${firm.id}][case-channel] Posted to #${channel.name}${mentions ? " with mentions" : ""}${closed ? " [CLOSED CASE]" : ""}`);
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
  const forwardedTo = call.forwardedTo || null;

  if (blockedByPhoneLineFilter(firm, from, to)) {
    console.log(`[${firm.id}][call-check] Skipped ${callId} — neither ${from} nor ${to} is a configured phone line`);
    return;
  }

  cacheCall(firm, callId, { from: call.from || cachedFrom, to: call.to || cachedTo, direction, answeredBy, userId: call.userId });
  console.log(`[${firm.id}][call-check] Call ${callId}: status=${status}, answeredBy=${answeredBy || "none"}, direction=${direction}, forwardedTo=${forwardedTo || "none"}`);

  if (status === "in-progress" || status === "ringing" || status === "queued" || status === "initiated") {
    console.log(`[${firm.id}][call-check] Call ${callId} still ${status} — rescheduling`);
    scheduleCallCheck(firm, callId, cachedFrom, cachedTo, cachedDirection);
    return;
  }

  // Forwarded leg — routed to another number/line that reports it separately.
  if (forwardedTo && !answeredAt && !hasVoicemail) {
    console.log(`[${firm.id}][call-check] Call ${callId} forwarded to ${forwardedTo} — not a missed call, skipping`);
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
    if (!isActiveClient(firm, externalPhone)) {
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

// An ACTIVE client has a case number whose status isn't closed/archived.
// When case-status sync isn't configured, every case counts as active (status
// is unknown → not closed), so behavior is unchanged for firms without it.
// Former clients (closed case) are treated like non-clients for intake routing
// and lead classification, since they may be calling about a new matter.
function isActiveClient(firm, phoneNumber) {
  const caseNumber = extractCaseNumber(getContactName(firm, phoneNumber));
  if (!caseNumber) return false;
  return !isClosedStatus(firm, getCaseStatus(firm, caseNumber));
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
    // Active clients aren't leads. A former client (closed case) is allowed
    // through to classification — they may be calling about a new matter.
    if (isActiveClient(firm, phone)) {
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
    // Only active clients skip intake — former clients (closed case) route here
    // as a potential new matter (Option C).
    if (isActiveClient(firm, phone)) return false;
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

    if (blockedByPhoneLineFilter(firm, from, to)) {
      console.log(`[${firm.id}][messages] Skipped — neither ${from} nor ${to} is a configured phone line`);
      return;
    }

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

    if (blockedByPhoneLineFilter(firm, from, to)) {
      console.log(`[${firm.id}][calls] Skipped — neither ${from} nor ${to} is a configured phone line`);
      return;
    }

    const forwardedTo = obj.forwardedTo || null;

    if (callId) {
      cacheCall(firm, callId, { from: obj.from, to: obj.to, direction, answeredBy: obj.answeredBy, userId: obj.userId });
      console.log(`[${firm.id}][calls] Cached call ${callId}: ${from} → ${to} (status: ${status}, answeredAt: ${answeredAt || "none"}, answeredBy: ${obj.answeredBy || "none"}, forwardedTo: ${forwardedTo || "none"})`);
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

    const hasVoicemail = voicemail && (typeof voicemail === "string" ? voicemail : voicemail.url);

    // A forwarded leg completes on this line without being answered here — the
    // call was routed to another number/line, which handles and reports it
    // separately. Don't flag it as missed.
    if (forwardedTo && !answeredAt && !hasVoicemail) {
      console.log(`[${firm.id}][calls] Call ${callId} forwarded to ${forwardedTo} — not a missed call, skipping`);
      markCallResolved(firm, callId);
      return;
    }

    const isMissedStatus = ["no-answer", "busy", "canceled", "failed"].includes(status);
    const isUnanswered = status === "completed" && !answeredAt && direction === "incoming";
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
    if (!isActiveClient(firm, externalPhone)) {
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

    if (blockedByPhoneLineFilter(firm, from, to)) {
      console.log(`[${firm.id}][call-summary] Skipped — neither ${from} nor ${to} is a configured phone line`);
      return;
    }

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

    // Intake extraction (opt-in, qualified leads only). Best-effort — after
    // routing so it can't affect the Slack posts above. Uses the fullest text
    // available (summary + transcript if present).
    const transcript = extractField(payload, "data.object.transcript", "data.transcript", "transcript");
    const transcriptText = Array.isArray(transcript) ? transcript.join(" ") : (transcript || "");
    const intakeText = [summaryText, transcriptText].filter(Boolean).join("\n\n");
    await runIntake(firm, {
      callId, deepLink, text: intakeText, transcript: transcriptText || summaryText, isQualified,
    }).catch((err) => console.error(`[${firm.id}][intake] Error:`, err.message));
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
    restrictToPhoneLines: !!f.restrictToPhoneLines,
    caseStatusConfig: {
      query: f.caseStatusConfig?.query || "",
      closedValues: f.caseStatusConfig?.closedValues || ["archived"],
    },
    caseStatusCount: f.caseStatusCache ? f.caseStatusCache.size : 0,
    intakeConfig: {
      enabled: !!f.intakeConfig?.enabled,
      table: f.intakeConfig?.table || "public.intakes",
      notifyChannelId: f.intakeConfig?.notifyChannelId || "",
    },
    source: f.source || "file",
    isDefault: f.id === DEFAULT_FIRM_ID,
    hasQuoApiKey: !!f.quoApiKey,
    hasSlackBotToken: !!f.slackBotToken,
    hasLeadCallsChannel: !!f.slackLeadCallsChannelId,
    hasLegalAssistantChannel: !!f.slackLegalAssistantChannelId,
    // Per-credential source without leaking values: "env" | "stored" | null
    secretSources: secretSources(f.id, f.storedSecrets),
  }));
  res.json(list);
});

// Which credential fields are editable in the UI (metadata only, no values).
app.get("/admin/api/secret-fields", requireAuth, (_req, res) => {
  res.json({
    fields: SECRET_FIELDS.map(({ key, label, secret }) => ({ key, label, secret })),
    encryptionEnabled: !!SECRET_KEY,
    dbConfigured: !!pgPool,
  });
});

// Validate the editable config fields common to create + update. Returns
// { config } on success or { error } on failure.
function validateFirmBody(body) {
  const { name, practiceArea, phoneLines, leadThreadTagUsers } = body || {};
  if (!name || typeof name !== "string") {
    return { error: "name is required" };
  }
  if (phoneLines && (typeof phoneLines !== "object" || Array.isArray(phoneLines))) {
    return { error: "phoneLines must be an object mapping phone → line name" };
  }
  if (leadThreadTagUsers && !Array.isArray(leadThreadTagUsers)) {
    return { error: "leadThreadTagUsers must be an array of Slack user IDs" };
  }
  const csc = (body && body.caseStatusConfig) || {};
  if (csc.query && typeof csc.query === "string") {
    const q = csc.query.trim();
    if (q && (!/^select\b/i.test(q) || q.replace(/;+\s*$/, "").includes(";"))) {
      return { error: "caseStatusConfig.query must be a single read-only SELECT" };
    }
  }
  const ic = (body && body.intakeConfig) || {};
  if (ic.table && typeof ic.table === "string" && ic.table.trim()
      && !/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(ic.table.trim())) {
    return { error: "intakeConfig.table must be a valid table name like public.intakes" };
  }
  return {
    config: {
      name: String(name).trim(),
      practiceArea: String(practiceArea || "personal injury").trim(),
      phoneLines: phoneLines || {},
      leadThreadTagUsers: leadThreadTagUsers || [],
      restrictToPhoneLines: !!(body && body.restrictToPhoneLines),
      caseStatusConfig: {
        query: typeof csc.query === "string" ? csc.query.trim() : "",
        closedValues: Array.isArray(csc.closedValues) ? csc.closedValues : undefined,
      },
      intakeConfig: {
        enabled: !!ic.enabled,
        table: typeof ic.table === "string" ? ic.table.trim() : "",
        notifyChannelId: typeof ic.notifyChannelId === "string" ? ic.notifyChannelId.trim() : "",
      },
    },
  };
}

// Pull the known secret fields out of a request body's `secrets` object,
// keeping only non-empty string values. Unknown keys are ignored.
function extractSecretsFromBody(body) {
  const out = {};
  const provided = (body && body.secrets) || {};
  for (const { key } of SECRET_FIELDS) {
    const v = provided[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return out;
}

// Persist a firm to the appropriate store. `source` decides where: db-backed
// firms go to Postgres (with secrets); file-backed firms go to firms.json on
// disk (config ONLY — secrets are never written to the git-tracked file).
// Returns the label used in the response ("postgres" or "disk").
// Persist a firm to Postgres when a database is configured (survives redeploys),
// otherwise to firms.json on disk. This applies to the default firm too, so its
// UI-entered config and secrets persist rather than being lost on redeploy.
// Secrets are NEVER written to the git-tracked firms.json — only to the DB.
async function persistFirm(id, config, storedSecrets) {
  if (pgPool) {
    await saveFirmToDb(id, config, storedSecrets);
    return "postgres";
  }
  saveFirmToDisk(id, config);
  return "disk";
}

app.post("/admin/api/firms", requireAuth, async (req, res) => {
  const { id } = req.body || {};
  if (!id || !FIRM_ID_PATTERN.test(id)) {
    return res.status(400).json({ error: "id must be lowercase alphanumeric with hyphens" });
  }
  if (firms.has(id)) {
    return res.status(409).json({ error: `Firm "${id}" already exists` });
  }
  const { config, error } = validateFirmBody(req.body);
  if (error) return res.status(400).json({ error });

  const storedSecrets = extractSecretsFromBody(req.body);

  // New firms go to Postgres when configured, else firms.json on disk.
  let persistedTo;
  try {
    persistedTo = await persistFirm(id, config, storedSecrets);
  } catch (err) {
    console.error(`[admin] Failed to persist firm "${id}":`, err.message);
    return res.status(500).json({ error: `Failed to persist firm: ${err.message}` });
  }

  // Register in-memory so it's live immediately
  const firm = makeFirm(id, config, storedSecrets);
  firm.source = persistedTo === "postgres" ? "db" : "file";
  firms.set(id, firm);
  const secretsNote = !pgPool && Object.keys(storedSecrets).length
    ? " (secrets held in memory only — no DATABASE_URL, they won't survive restart)"
    : "";
  console.log(`[admin] Registered new firm "${id}" (${config.name}), persisted to ${persistedTo}${secretsNote}`);

  loadFirmCaches(firm).catch((err) =>
    console.error(`[${id}][startup] Cache load error:`, err.message)
  );

  res.json({ ok: true, firmId: id, config, persistedTo, secretsPersisted: pgPool ? true : false });
});

app.put("/admin/api/firms/:id", requireAuth, async (req, res) => {
  const id = req.params.id;
  const firm = firms.get(id);
  if (!firm) {
    return res.status(404).json({ error: `Firm "${id}" not found` });
  }
  const { config, error } = validateFirmBody(req.body);
  if (error) return res.status(400).json({ error });

  // Merge provided secrets over the firm's existing stored secrets. Blank fields
  // are left untouched (extractSecretsFromBody drops them), so the UI can leave a
  // credential's box empty to keep the current value.
  const provided = extractSecretsFromBody(req.body);
  const mergedSecrets = { ...(firm.storedSecrets || {}), ...provided };
  // Explicit clears: a field listed in body.clearSecrets removes the stored value.
  const clears = Array.isArray(req.body?.clearSecrets) ? req.body.clearSecrets : [];
  for (const key of clears) delete mergedSecrets[key];

  let persistedTo;
  try {
    persistedTo = await persistFirm(id, config, mergedSecrets);
  } catch (err) {
    console.error(`[admin] Failed to persist edit for firm "${id}":`, err.message);
    return res.status(500).json({ error: `Failed to persist firm: ${err.message}` });
  }

  // Update the editable fields in place so caches and pending timers are preserved.
  firm.name = config.name;
  firm.practiceArea = config.practiceArea;
  firm.phoneLines = config.phoneLines;
  firm.leadThreadTagUsers = config.leadThreadTagUsers;
  firm.restrictToPhoneLines = config.restrictToPhoneLines;
  firm.caseStatusConfig = normalizeCaseStatusConfig(config);
  firm.intakeConfig = normalizeIntakeConfig(config);
  firm.storedSecrets = mergedSecrets;
  firm.source = persistedTo === "postgres" ? "db" : "file";
  applyFirmSecrets(firm); // recompute quoApiKey/slackBotToken/webhooks/channels
  console.log(`[admin] Updated firm "${id}" (${config.name}), persisted to ${persistedTo}`);

  // Re-sync case statuses in the background (connection string or query may have changed).
  loadCaseStatuses(firm).catch((err) =>
    console.error(`[${id}][case-status] Resync error:`, err.message)
  );

  res.json({ ok: true, firmId: id, config, persistedTo });
});

app.delete("/admin/api/firms/:id", requireAuth, async (req, res) => {
  const id = req.params.id;
  if (id === DEFAULT_FIRM_ID) {
    return res.status(403).json({
      error: `Cannot delete the default firm "${id}". Edit firms.json in the repo to change it.`,
    });
  }
  const firm = firms.get(id);
  if (!firm) {
    return res.status(404).json({ error: `Firm "${id}" not found` });
  }

  let removedFrom;
  try {
    if (firm.source === "db" && pgPool) {
      await deleteFirmFromDb(id);
      removedFrom = "postgres";
    } else {
      deleteFirmFromDisk(id);
      removedFrom = "disk";
    }
  } catch (err) {
    console.error(`[admin] Failed to delete firm "${id}":`, err.message);
    return res.status(500).json({ error: `Failed to delete firm: ${err.message}` });
  }

  teardownFirm(firm);
  firms.delete(id);
  console.log(`[admin] Deleted firm "${id}" (removed from ${removedFrom})`);

  res.json({ ok: true, firmId: id, removedFrom });
});

// === Startup ===

// Load caches for each firm in the background
async function loadFirmCaches(firm) {
  await Promise.all([loadSlackChannels(firm), loadSlackUsers(firm)]);
  await ensureHubChannelsJoined(firm);
  await loadQuoContacts(firm);
  await loadQuoUsers(firm);
  await loadCaseStatuses(firm);
  console.log(`[${firm.id}][startup] Caches loaded`);
}

(async () => {
  // 1. Register firms.json/env firms first (includes the default firm).
  registerFirms();
  // 2. Connect to Postgres and load any firms added via the admin UI.
  await initFirmStore();
  await loadFirmsFromDb();

  // 3. Start listening once all firms are known, so no webhook 404s at boot.
  app.listen(PORT, () => {
    console.log(`Quo Slack Router listening on port ${PORT}`);
  });

  // 4. Warm each firm's caches (Slack channels/users, Quo contacts/users) in the background.
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

setInterval(() => {
  for (const firm of firms.values()) loadCaseStatuses(firm);
}, CASE_STATUS_REFRESH_INTERVAL);
