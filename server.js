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
  { key: "EMAIL_WEBHOOK_TOKEN", label: "Inbound email webhook token (optional)", secret: true },
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
    emailWebhookToken: pick("EMAIL_WEBHOOK_TOKEN"),
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
  // How long after a case closes before a message from that former client is
  // treated as a possible NEW matter (and alerted into #lead-calls). Before
  // that, they're most likely still following up on the case just closed.
  let closedGraceDays = parseInt(raw.closedGraceDays, 10);
  if (!Number.isFinite(closedGraceDays) || closedGraceDays < 0) closedGraceDays = 21;
  return { query, closedValues: closed.length ? closed : ["archived"], closedGraceDays };
}

// Intake extraction config. When enabled, qualified-lead call summaries are
// parsed into structured intake data and written to `table` in the case DB
// (CASE_DB_URL), with a Slack confirmation to notifyChannelId.
function normalizeIntakeConfig(config) {
  const raw = config.intakeConfig || {};
  const table = typeof raw.table === "string" && raw.table.trim() ? raw.table.trim() : "public.intakes";
  const interactionsTable = typeof raw.interactionsTable === "string" && raw.interactionsTable.trim()
    ? raw.interactionsTable.trim() : "public.intake_interactions";
  const notifyChannelId = typeof raw.notifyChannelId === "string" ? raw.notifyChannelId.trim() : "";
  // Base URL of the intake app (e.g. https://rjl-docket-flow.vercel.app). Slack
  // notifications link to <appUrl>/intakes/<call_id> instead of the raw Quo call.
  const appUrl = typeof raw.appUrl === "string" ? raw.appUrl.trim().replace(/\/+$/, "") : "";
  let followUpHours = parseInt(raw.followUpHours, 10);
  if (!Number.isFinite(followUpHours) || followUpHours <= 0) followUpHours = 72;
  // What to do with an inbound email we can't tie to an existing intake:
  // "alert" (default) posts to Slack for a human; "create" opens a new intake.
  const emailUnmatched = raw.emailUnmatched === "create" ? "create" : "alert";
  // Slack noise control for email-sourced updates:
  //   all    — notify on every merge/creation (default)
  //   errors — only when an email can't be matched (needs a human)
  //   off    — never notify
  const emailNotify = ["errors", "off"].includes(raw.emailNotify) ? raw.emailNotify : "all";
  return { enabled: !!raw.enabled, table, interactionsTable, notifyChannelId, appUrl, followUpHours, emailUnmatched, emailNotify };
}

function makeFirm(firmId, config, storedSecrets = {}) {
  return {
    id: firmId,
    name: config.name || firmId,
    practiceArea: config.practiceArea || "personal injury",
    phoneLines: config.phoneLines || {},
    leadThreadTagUsers: config.leadThreadTagUsers || [],
    // Slack app/bot to tag when a client asks for a call back. Accepts an App ID
    // (A…, resolved to the bot's member id via users.list) or a member id directly.
    callbackBotId: (config.callbackBotId || "").trim(),
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
    slackBots: new Map(), // app id (A…) and bot name → bot member id (U…)
    callCache: new Map(),
    pendingCallChecks: new Map(),
    resolvedCalls: new Set(),
    caseStatusCache: new Map(), // caseNumber(string) -> status(string, lowercased)
    followUpWindows: new Map(), // phoneLast10 -> { intakeCallId, expiresAt }
    pendingCallbacks: new Map(), // phoneLast10 -> { callId, expiresAt }
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
        callback_bot_id TEXT,
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
    await pgPool.query(`ALTER TABLE firms ADD COLUMN IF NOT EXISTS callback_bot_id TEXT`);
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
    callbackBotId: row.callback_bot_id || "",
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
          callbackBotId: existing.callbackBotId,
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
    `INSERT INTO firms (id, name, practice_area, phone_lines, lead_thread_tag_users, secrets, restrict_to_phone_lines, case_status_config, intake_config, callback_bot_id, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, $10, now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       practice_area = EXCLUDED.practice_area,
       phone_lines = EXCLUDED.phone_lines,
       lead_thread_tag_users = EXCLUDED.lead_thread_tag_users,
       secrets = EXCLUDED.secrets,
       restrict_to_phone_lines = EXCLUDED.restrict_to_phone_lines,
       case_status_config = EXCLUDED.case_status_config,
       intake_config = EXCLUDED.intake_config,
       callback_bot_id = EXCLUDED.callback_bot_id,
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
      config.callbackBotId || null,
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
  // Trim: joining three empty fields yields "  ", which is truthy and would slip
  // past empty-checks and get sent to the LLM as an empty prompt.
  return parts.join(" ").toLowerCase().trim();
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
  const foreign = !isOwnLine(firm, from) && !isOwnLine(firm, to);
  if (firm.restrictToPhoneLines) return foreign;
  // Filter off: still flag events where neither party is one of this firm's
  // lines. With several firms on one Quo account (or webhooks pointed at more
  // than one firm endpoint), that means another firm's traffic is being routed
  // into this firm's Slack — turn on "Only route events for the phone lines
  // above" for this firm.
  if (foreign && Object.keys(firm.phoneLines || {}).length) {
    firm._warnedForeign = firm._warnedForeign || new Set();
    const key = `${from}|${to}`;
    if (!firm._warnedForeign.has(key)) {
      firm._warnedForeign.add(key);
      if (firm._warnedForeign.size > 500) firm._warnedForeign.clear();
      console.warn(`[${firm.id}] Routing ${from} → ${to}, but neither is a configured phone line for this firm — enable the phone-line filter if this is another firm's traffic`);
    }
  }
  return false;
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

// Google's translate_a/single is the undocumented endpoint the Translate widget
// uses — free, but rate-limited and frequently blocked from datacenter IPs, so
// it fails intermittently. Fall back to Claude, which we already have a key for.
async function translateViaGoogle(text) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "es");
  url.searchParams.set("tl", "en");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);
  const res = await fetch(url.toString());
  if (!res.ok) {
    console.warn(`[translate] Google responded ${res.status} — falling back to Claude`);
    return null;
  }
  const json = await res.json();
  const translated = (json[0] || []).map((part) => part[0]).join("");
  return translated || null;
}

async function translateViaClaude(text) {
  if (!ANTHROPIC_API_KEY) return null;
  const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: "Translate the user's Spanish text to English. Reply with ONLY the translation — no preamble, quotes, or notes. Keep phone numbers, names and formatting as-is.",
      messages: [{ role: "user", content: text }],
    }),
  }, { label: "translate" });
  if (!res.ok) {
    console.error(`[translate] Claude responded ${res.status}`);
    return null;
  }
  const json = await res.json();
  return (json.content?.[0]?.text || "").trim() || null;
}

async function translateToEnglish(text) {
  try {
    const viaGoogle = await translateViaGoogle(text);
    if (viaGoogle) return viaGoogle;
  } catch (err) {
    console.warn("[translate] Google error:", err.message, "— falling back to Claude");
  }
  try {
    return await translateViaClaude(text);
  } catch (err) {
    console.error("[translate] Claude error:", err.message);
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
      // closed_at is optional — include it in the query to enable the grace period.
      const rawClosed = row.closed_at ?? row.closedAt ?? null;
      const closedAt = rawClosed ? Date.parse(rawClosed instanceof Date ? rawClosed.toISOString() : rawClosed) : null;
      next.set(String(num).trim(), {
        status: String(status).toLowerCase().trim(),
        closedAt: Number.isFinite(closedAt) ? closedAt : null,
      });
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
function getCaseEntry(firm, caseNumber) {
  if (!caseNumber || !firm.caseStatusCache) return null;
  return firm.caseStatusCache.get(String(caseNumber).trim()) || null;
}

function getCaseStatus(firm, caseNumber) {
  return getCaseEntry(firm, caseNumber)?.status || null;
}

// When the case closed, in epoch ms — null if unknown or not supplied by the query.
function getCaseClosedAt(firm, caseNumber) {
  return getCaseEntry(firm, caseNumber)?.closedAt ?? null;
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
      address: { type: ["string", "null"], description: "full address exactly as stated" },
      street_address: { type: ["string", "null"], description: "street number and name, incl. apt/unit" },
      address_city: { type: ["string", "null"], description: "city of the client's home address" },
      address_state: { type: ["string", "null"], description: "state, 2-letter code if given" },
      address_zip: { type: ["string", "null"], description: "postal / ZIP code" },
      address_country: { type: ["string", "null"], description: "country, only if explicitly stated" },
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

// Maps the extraction schema onto flat table columns, so the intake row is a
// normal editable table (readable/writable by other apps) rather than a JSONB blob.
// `t`: text | bool | list (list is stored comma-joined for easy editing).
const INTAKE_COLUMNS = [
  ["how_found", ["referral", "how_found"], "text"],
  ["map_location", ["referral", "map_location"], "text"],

  ["accident_date", ["accident", "date"], "text"],
  ["accident_time", ["accident", "time"], "text"],
  ["representation_date", ["accident", "representation_date"], "text"],
  ["accident_location", ["accident", "location"], "text"],
  ["city", ["accident", "city"], "text"],
  ["county", ["accident", "county"], "text"],
  ["accident_description", ["accident", "description"], "text"],
  ["police_department", ["accident", "police_department"], "text"],
  ["police_report_no", ["accident", "police_report_no"], "text"],
  ["ticket_issued", ["accident", "ticket_issued"], "bool"],
  ["ticket_who", ["accident", "ticket_who"], "text"],
  ["ticket_reason", ["accident", "ticket_reason"], "text"],

  ["name", ["client", "name"], "text"],
  ["phone", ["client", "phone"], "text"],
  ["email", ["client", "email"], "text"],
  ["address", ["client", "address"], "text"],
  ["street_address", ["client", "street_address"], "text"],
  ["address_city", ["client", "address_city"], "text"],
  ["address_state", ["client", "address_state"], "text"],
  ["address_zip", ["client", "address_zip"], "text"],
  ["address_country", ["client", "address_country"], "text"],
  ["dob", ["client", "dob"], "text"],
  ["sex", ["client", "sex"], "text"],
  ["dl_number", ["client", "dl_number"], "text"],
  ["spouse_name", ["client", "spouse_name"], "text"],
  ["emergency_contact", ["client", "emergency_contact"], "text"],
  ["passengers", ["client", "passengers"], "list"],

  ["vehicle", ["property_damage", "vehicle"], "text"],
  ["vehicle_owner", ["property_damage", "owner"], "text"],
  ["drivable", ["property_damage", "drivable"], "bool"],
  ["towed", ["property_damage", "towed"], "bool"],
  ["towed_by", ["property_damage", "towed_by"], "text"],
  ["vehicle_location", ["property_damage", "vehicle_location"], "text"],
  ["has_loan", ["property_damage", "has_loan"], "bool"],
  ["lienholder", ["property_damage", "lienholder"], "text"],
  ["rental_needed", ["property_damage", "rental_needed"], "bool"],
  ["body_shop", ["property_damage", "body_shop"], "text"],

  ["employer", ["employment", "employer"], "text"],
  ["job_description", ["employment", "job_description"], "text"],
  ["missed_work", ["employment", "missed_work"], "bool"],
  ["salary_rate", ["employment", "salary_rate"], "text"],

  ["other_driver_name", ["other_driver", "name"], "text"],
  ["other_driver_sex", ["other_driver", "sex"], "text"],
  ["other_driver_dob", ["other_driver", "dob"], "text"],
  ["other_driver_address", ["other_driver", "address"], "text"],
  ["other_driver_phone", ["other_driver", "phone"], "text"],
  ["other_driver_dl", ["other_driver", "dl_number"], "text"],
  ["other_driver_car_owner", ["other_driver", "car_owner"], "text"],

  ["client_insurance", ["insurance", "client_company"], "text"],
  ["client_policy_no", ["insurance", "client_policy_number"], "text"],
  ["client_claim_no", ["insurance", "client_claim_number"], "text"],
  ["third_party_insurance", ["insurance", "third_party_company"], "text"],
  ["third_party_policy_no", ["insurance", "third_party_policy_number"], "text"],
  ["third_party_claim_no", ["insurance", "third_party_claim_number"], "text"],
  ["pip", ["insurance", "pip"], "bool"],
  ["med_pay", ["insurance", "med_pay"], "bool"],
  ["um_uim", ["insurance", "um_uim"], "bool"],

  ["ems", ["injury", "ems"], "bool"],
  ["hospital_bill", ["injury", "hospital_bill"], "bool"],
  ["hospital", ["injury", "hospital"], "text"],
  ["treating_doctor", ["injury", "treating_doctor"], "text"],
  ["injury_types", ["injury", "injury_types"], "list"],
  ["medicaid", ["injury", "medicaid"], "bool"],
  ["medicare", ["injury", "medicare"], "bool"],
  ["health_insurance", ["injury", "health_insurance"], "text"],

  ["notes", ["notes"], "text"],
];

function coerceColumnValue(raw, type) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (type === "bool") {
    if (typeof raw === "boolean") return raw;
    const s = String(raw).toLowerCase().trim();
    if (["true", "yes", "y", "1"].includes(s)) return true;
    if (["false", "no", "n", "0"].includes(s)) return false;
    return null;
  }
  if (type === "list") {
    const arr = Array.isArray(raw) ? raw : [raw];
    const joined = arr.map((v) => String(v).trim()).filter(Boolean).join(", ");
    return joined || null;
  }
  const s = String(raw).trim();
  return s || null;
}

// Turn a nested extraction into { column: value }, dropping nulls.
function flattenExtraction(extracted) {
  const out = {};
  for (const [col, path, type] of INTAKE_COLUMNS) {
    let cur = extracted;
    for (const key of path) {
      if (cur == null) break;
      cur = cur[key];
    }
    const val = coerceColumnValue(cur, type);
    if (val !== null) out[col] = val;
  }
  return out;
}

// Union two comma-joined lists without duplicates (case-insensitive).
function mergeListValue(existing, incoming) {
  const seen = new Map();
  for (const part of [existing, incoming]) {
    for (const v of String(part || "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const k = v.toLowerCase();
      if (!seen.has(k)) seen.set(k, v);
    }
  }
  return [...seen.values()].join(", ");
}

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
        system: `You extract new-client intake details for a personal-injury (motor vehicle accident) law firm from a phone call summary/transcript. Only include facts EXPLICITLY stated in the call. Use null for anything not mentioned — never guess, infer, or fabricate names, numbers, dates, or places. If the call is not an accident intake, return mostly nulls.

For the client's home address: put the full address as spoken in client.address, AND split what was actually given into street_address / address_city / address_state / address_zip / address_country. Only fill the parts that were stated — if they only said "Austin, Texas", set address_city and address_state and leave street_address, address_zip and address_country null. Do not infer a state from a city, a ZIP from a city, or a country from anything.`,
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

// Which columns actually exist on a table (cached per firm+table). Used so the
// router degrades gracefully when the shared intake table is missing a column.
async function tableColumns(firm, client, table) {
  firm._tableColumnCache = firm._tableColumnCache || new Map();
  const cached = firm._tableColumnCache.get(table);
  if (cached) return cached;
  const [schema, name] = table.includes(".") ? table.split(".") : ["public", table];
  try {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [schema, name],
    );
    const set = new Set(rows.map((r) => r.column_name));
    if (set.size) firm._tableColumnCache.set(table, set);
    return set;
  } catch (err) {
    console.error(`[${firm.id}][intake] Could not read columns for ${table}:`, err.message);
    return new Set(); // empty = "unknown", callers fall back to writing everything
  }
}

async function insertIntake(firm, record) {
  const table = firm.intakeConfig?.table || "public.intakes";
  // Table name is interpolated (identifiers can't be parameterized) — validate strictly.
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(table)) {
    console.error(`[${firm.id}][intake] Invalid intake table name "${table}"`);
    return { inserted: false, error: "invalid table name" };
  }
  // Flat columns from the extraction, plus the call metadata. `data` keeps the
  // raw extraction as an archive/debug trail; the columns are the editable truth.
  const cols = flattenExtraction(record.data || {});
  cols.call_id = record.callId;
  cols.quo_link = record.quoLink || null;
  cols.transcript = record.transcript || null;
  // The Quo caller number is more reliable than the model-extracted one.
  if (record.phone) cols.phone = record.phone;

  let client;
  try {
    client = await connectCaseDb(firm);

    // Only write columns that actually exist. The intake table is shared with
    // other apps, so a column we extract may not have been added yet — dropping
    // the field is far better than failing the whole insert and losing the intake.
    const existing = await tableColumns(firm, client, table);
    const dropped = [];
    for (const name of Object.keys(cols)) {
      if (existing.size && !existing.has(name)) { dropped.push(name); delete cols[name]; }
    }
    if (dropped.length) {
      console.warn(`[${firm.id}][intake] Table ${table} is missing column(s): ${dropped.join(", ")} — value(s) kept in data JSONB only`);
    }

    const names = Object.keys(cols);
    const params = names.map((_, i) => `$${i + 1}`);
    const values = names.map((n) => cols[n]);
    if (!existing.size || existing.has("data")) {
      names.push("data");
      params.push(`$${names.length}::jsonb`);
      values.push(JSON.stringify(record.data || {}));
    }

    const res = await client.query(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${params.join(", ")})
       ON CONFLICT (call_id) DO NOTHING`,
      values,
    );
    return { inserted: res.rowCount > 0 };
  } catch (err) {
    console.error(`[${firm.id}][intake] Insert error:`, err.message);
    return { inserted: false, error: err.message };
  } finally {
    if (client) { try { await client.end(); } catch { /* ignore */ } }
  }
}

// Slack link to the intake's page in the intake app, keyed by the Quo call id
// (that's the row's call_id). Falls back to empty when no app URL is configured.
function intakeLink(firm, callId, label = "View intake") {
  const base = firm.intakeConfig?.appUrl;
  if (!base || !callId) return "";
  return `\n<${base}/intakes/${encodeURIComponent(callId)}|${label}>`;
}

// Post an intake notice, threaded under the caller's lead-calls post so
// everything about one lead stays together.
//   threadTs — thread under this exact message (used right after we post the
//              lead, so there's no history search and no race)
//   phone    — otherwise, find the caller's existing thread by phone number
async function intakeNotify(firm, msg, { threadTs = null, phone = null } = {}) {
  const channelId = firm.intakeConfig.notifyChannelId || firm.slackLeadCallsChannelId;
  if (!channelId || !firm.slackBotToken) {
    if (firm.slackWebhooks.leadCalls) return postToSlack(firm.slackWebhooks.leadCalls, msg);
    return;
  }

  let parentTs = threadTs;
  if (!parentTs && phone && channelId === firm.slackLeadCallsChannelId) {
    // Only the lead-calls channel has a phone-indexed history helper.
    const messages = await fetchLeadChannelHistory(firm);
    parentTs = searchChannelHistoryForPhone(messages, phone);
  }

  try {
    const body = { channel: channelId, text: msg };
    if (parentTs) body.thread_ts = parentTs;
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${firm.slackBotToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`[${firm.id}][intake] Slack error posting notice: ${json.error}`);
      return;
    }
    console.log(`[${firm.id}][intake] Posted notice (threaded: ${!!parentTs})`);
  } catch (err) {
    console.error(`[${firm.id}][intake] Error posting notice:`, err.message);
  }
}

// Extract → insert → notify, then open a follow-up window on the caller's phone.
// Best-effort: any failure is logged and swallowed so it never affects routing.
async function runIntake(firm, { callId, deepLink, summaryText, externalPhone, isQualified, leadParentTs = null }) {
  if (!firm.intakeConfig?.enabled || !isQualified) return;
  if (!callId) return;
  if (!firm.caseDbUrl) {
    console.warn(`[${firm.id}][intake] enabled but no case DB connection (CASE_DB_URL) — skipping`);
    return;
  }

  // Extract from the full verbatim transcript (the summary drops detail). If the
  // transcript isn't available, fall back to the summary so we still capture the basics.
  const transcript = await fetchCallTranscript(firm, callId);
  const sourceText = [transcript, summaryText].filter(Boolean).join("\n\n").trim();
  if (!sourceText) {
    console.warn(`[${firm.id}][intake] No transcript or summary for ${callId} — skipping`);
    return;
  }
  console.log(`[${firm.id}][intake] Extracting from ${transcript ? "transcript" : "summary only"} for ${callId}`);

  const extracted = await extractIntake(firm, sourceText);
  if (!extracted) {
    console.warn(`[${firm.id}][intake] Nothing extracted for ${callId}`);
    return;
  }
  const name = extracted.client?.name || null;
  const accidentDate = extracted.accident?.date || null;
  // Store the actual Quo caller number (reliable for follow-up matching), not the
  // model-extracted one. The extracted client phone stays inside data.client.phone.
  const phone = externalPhone || extracted.client?.phone || null;

  const { inserted, error } = await insertIntake(firm, {
    callId, name, phone, accidentDate, quoLink: deepLink || null,
    transcript: transcript || summaryText, data: extracted,
  });
  if (error) return;
  if (!inserted) {
    console.log(`[${firm.id}][intake] ${callId} already recorded — skipping`);
    return;
  }
  console.log(`[${firm.id}][intake] Loaded intake for ${name || "unknown"} (${callId})`);

  // Open the 72h (configurable) follow-up window on this caller's number.
  openFollowUpWindow(firm, externalPhone, callId);

  const detail = extracted.accident?.description
    ? `— ${extracted.accident.description}`
    : (accidentDate ? `— accident ${accidentDate}` : "");
  const line = `${name || "Unknown caller"}${phone ? ` (${phone})` : ""} ${detail}`.trim();
  // Prefer the intake app's page; fall back to the raw Quo call when not configured.
  const link = intakeLink(firm, callId) || (deepLink ? `\n<${deepLink}|View call in Quo>` : "");
  await intakeNotify(firm, `📝 *Intake loaded* for ${line}${link}`,
    { threadTs: leadParentTs, phone: externalPhone });

  // Backfill anything from this caller BEFORE the qualifying call (e.g. a text
  // sent an hour earlier), then merge it in.
  await backfillFollowUps(firm, { externalPhone, intakeCallId: callId })
    .catch((err) => console.error(`[${firm.id}][backfill] Error:`, err.message));
}

// --- Follow-up window: capture calls/texts/voicemails for N hours after intake ---

function phoneKey(phone) {
  return lastTenDigits(phone || "");
}

function openFollowUpWindow(firm, phone, intakeCallId) {
  const key = phoneKey(phone);
  if (!key) return;
  const hours = firm.intakeConfig?.followUpHours || 72;
  firm.followUpWindows.set(key, { intakeCallId, expiresAt: Date.now() + hours * 3600 * 1000 });
}

function getFollowUpWindow(firm, phone) {
  const key = phoneKey(phone);
  if (!key) return null;
  const entry = firm.followUpWindows.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    firm.followUpWindows.delete(key);
    return null;
  }
  return entry;
}

// Deep "fill empty" merge: fills null/empty fields in base from incoming, keeps
// existing non-empty scalars, unions arrays. Returns { merged, added } where
// `added` counts newly-filled scalar fields.
function deepFillMerge(base, incoming) {
  let added = 0;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(incoming || {})) {
    if (v === null || v === undefined || v === "") continue;
    const cur = out[k];
    if (Array.isArray(v)) {
      const set = new Set([...(Array.isArray(cur) ? cur : []), ...v.filter(Boolean)]);
      const before = Array.isArray(cur) ? cur.length : 0;
      out[k] = [...set];
      if (out[k].length > before) added += out[k].length - before;
    } else if (typeof v === "object") {
      const r = deepFillMerge(cur && typeof cur === "object" ? cur : {}, v);
      out[k] = r.merged;
      added += r.added;
    } else if (cur === null || cur === undefined || cur === "") {
      out[k] = v;
      added += 1;
    }
  }
  return { merged: out, added };
}

// Merge a new extraction into an existing intake row, FILL-EMPTY only: a column
// that already has a value (including anything a human typed in another app) is
// never overwritten. List columns are unioned. Returns the count of fields filled.
async function mergeIntoIntake(firm, intakeCallId, extracted) {
  const table = firm.intakeConfig?.table || "public.intakes";
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(table)) return 0;
  const incoming = flattenExtraction(extracted);
  if (!Object.keys(incoming).length) return 0;

  const listCols = new Set(INTAKE_COLUMNS.filter(([, , t]) => t === "list").map(([c]) => c));
  let client;
  try {
    client = await connectCaseDb(firm);
    const { rows } = await client.query(`SELECT * FROM ${table} WHERE call_id = $1`, [intakeCallId]);
    if (!rows.length) return 0;
    const current = rows[0];

    const updates = {};
    let added = 0;
    for (const [col, val] of Object.entries(incoming)) {
      if (!(col in current)) continue; // column not present in this table
      const cur = current[col];
      if (listCols.has(col)) {
        const merged = mergeListValue(cur, val);
        if (merged && merged !== (cur || "")) {
          updates[col] = merged;
          added += merged.split(",").length - String(cur || "").split(",").filter((s) => s.trim()).length;
        }
      } else if (cur === null || cur === undefined || cur === "") {
        updates[col] = val;
        added += 1;
      }
    }
    if (!Object.keys(updates).length) return 0;

    // Keep the raw extraction archive current too (fill-empty, same semantics).
    const { merged: mergedData } = deepFillMerge(current.data || {}, extracted);
    updates.data = JSON.stringify(mergedData);

    const names = Object.keys(updates);
    const sets = names.map((n, i) => (n === "data" ? `${n} = $${i + 1}::jsonb` : `${n} = $${i + 1}`));
    const values = names.map((n) => updates[n]);
    values.push(intakeCallId);
    await client.query(
      `UPDATE ${table} SET ${sets.join(", ")} WHERE call_id = $${values.length}`,
      values,
    );
    return added;
  } catch (err) {
    console.error(`[${firm.id}][intake] Merge error:`, err.message);
    return 0;
  } finally {
    if (client) { try { await client.end(); } catch { /* ignore */ } }
  }
}

async function insertInteraction(firm, rec) {
  const table = firm.intakeConfig?.interactionsTable || "public.intake_interactions";
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(table)) {
    console.error(`[${firm.id}][follow-up] Invalid interactions table "${table}"`);
    return { inserted: false };
  }
  let client;
  try {
    client = await connectCaseDb(firm);

    // The interactions table is optional — if it hasn't been created yet, say so
    // once instead of erroring on every call/text.
    const existing = await tableColumns(firm, client, table);
    if (!existing.size) {
      firm._warnedNoInteractions = firm._warnedNoInteractions || new Set();
      if (!firm._warnedNoInteractions.has(table)) {
        firm._warnedNoInteractions.add(table);
        console.warn(`[${firm.id}][follow-up] Table ${table} does not exist — follow-up interactions will not be logged (see MIGRATION.sql). Intake merging still works.`);
      }
      return { inserted: false, missingTable: true };
    }

    const res = await client.query(
      `INSERT INTO ${table} (intake_call_id, phone, type, direction, source_id, content, transcript, quo_link, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (source_id) DO NOTHING`,
      [rec.intakeCallId, rec.phone, rec.type, rec.direction, rec.sourceId,
       rec.content || null, rec.transcript || null, rec.quoLink || null, JSON.stringify(rec.data || {})],
    );
    return { inserted: res.rowCount > 0 };
  } catch (err) {
    console.error(`[${firm.id}][follow-up] Insert error:`, err.message);
    return { inserted: false, error: err.message };
  } finally {
    if (client) { try { await client.end(); } catch { /* ignore */ } }
  }
}

// Capture a follow-up interaction on a tracked number: log it, then (if it has
// text) extract and merge new details into the intake. Best-effort.
async function captureFollowUp(firm, { phone, type, direction, sourceId, content, transcript, quoLink, extractText }) {
  const window = getFollowUpWindow(firm, phone);
  if (!window || !sourceId) return;

  const { inserted, missingTable } = await insertInteraction(firm, {
    intakeCallId: window.intakeCallId, phone: phoneKey(phone), type, direction,
    sourceId, content, transcript, quoLink,
  });
  // Not inserted and the table exists → we already logged this one (dedup), so
  // don't re-extract. If the table is simply absent, still merge into the intake.
  if (!inserted && !missingTable) return;
  if (inserted) {
    console.log(`[${firm.id}][follow-up] Logged ${type} for intake ${window.intakeCallId} (${sourceId})`);
  }

  const text = extractText && extractText.trim();
  if (!text) return;
  const extracted = await extractIntake(firm, text);
  if (!extracted) return;
  const added = await mergeIntoIntake(firm, window.intakeCallId, extracted);
  if (added > 0) {
    console.log(`[${firm.id}][follow-up] Merged ${added} field(s) into intake ${window.intakeCallId}`);
    await intakeNotify(firm, `📝 *Intake updated* from ${type} — filled ${added} field${added === 1 ? "" : "s"}${intakeLink(firm, window.intakeCallId)}`,
      { phone });
  }
}

// --- Inbound email → intake ---

// Normalize the many inbound-parse payload shapes (SendGrid, Mailgun, Postmark,
// CloudMailin) into one flat object.
function normalizeInboundEmail(body) {
  const b = body || {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), b);
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const html = pick("html", "HtmlBody", "body-html", "message.html");
  const text = pick("text", "plain", "TextBody", "body-plain", "message.plain", "message.text");
  return {
    from: pick("from", "From", "sender", "envelope.from", "headers.from"),
    to: pick("to", "To", "recipient", "envelope.to", "headers.to"),
    subject: pick("subject", "Subject", "headers.subject"),
    // Strip tags if only HTML was supplied.
    text: text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  };
}

function extractEmailAddress(raw) {
  const m = String(raw || "").match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0].toLowerCase() : "";
}

// Find the intake this email belongs to, most reliable signal first:
//  1. a Quo call id anywhere in the subject/body/to (plus-addressing, quoted
//     intake link, or a pasted reference) — unambiguous
//  2. the sender's address matching intakes.email
//  3. a phone number in the text matching intakes.phone
async function matchIntakeForEmail(firm, client, email) {
  const table = firm.intakeConfig?.table || "public.intakes";
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(table)) return null;
  const haystack = `${email.to}\n${email.subject}\n${email.text}`;

  const callIds = [...haystack.matchAll(/\bAC[0-9a-f]{24,}\b/gi)].map((m) => m[0]);
  for (const id of callIds) {
    const { rows } = await client.query(`SELECT call_id, phone FROM ${table} WHERE call_id = $1`, [id]);
    if (rows.length) return { callId: rows[0].call_id, phone: rows[0].phone, via: "call id in email" };
  }

  const sender = extractEmailAddress(email.from);
  if (sender) {
    const { rows } = await client.query(
      `SELECT call_id, phone FROM ${table} WHERE lower(email) = $1 ORDER BY created_at DESC LIMIT 1`, [sender]);
    if (rows.length) return { callId: rows[0].call_id, phone: rows[0].phone, via: `sender email ${sender}` };
  }

  // Phone numbers in the body, matched on last-10 digits.
  const digits = [...haystack.matchAll(/\+?1?[\s.(-]*(\d{3})[\s.)-]*(\d{3})[\s.-]*(\d{4})\b/g)]
    .map((m) => m[1] + m[2] + m[3]);
  for (const d of [...new Set(digits)]) {
    const { rows } = await client.query(
      `SELECT call_id, phone FROM ${table} WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1
       ORDER BY created_at DESC LIMIT 1`, [d]);
    if (rows.length) return { callId: rows[0].call_id, phone: rows[0].phone, via: `phone ${d} in email` };
  }
  return null;
}

// Ingest one inbound email: match it to an intake, extract, fill-empty merge,
// log the interaction, notify. Unmatched mail alerts by default rather than
// creating a duplicate intake (these are replies to existing matters).
async function handleInboundEmail(firm, req, res) {
  const cfg = firm.intakeConfig || {};
  if (!cfg.enabled || !firm.caseDbUrl) {
    return res.status(503).json({ error: "intake not configured for this firm" });
  }
  const provided = req.get("x-webhook-token") || req.query.token || "";
  if (firm.emailWebhookToken && provided !== firm.emailWebhookToken) {
    return res.status(401).json({ error: "invalid token" });
  }
  res.status(200).json({ received: true });

  try {
    const email = normalizeInboundEmail(req.body);
    if (!email.text && !email.subject) {
      console.warn(`[${firm.id}][email] Empty email payload — keys: [${Object.keys(req.body || {}).join(", ")}]`);
      return;
    }
    const sourceId = `email:${crypto.createHash("sha256")
      .update(`${email.from}|${email.subject}|${email.text}`).digest("hex").slice(0, 32)}`;

    let client;
    let match = null;
    try {
      client = await connectCaseDb(firm);
      match = await matchIntakeForEmail(firm, client, email);
    } finally {
      if (client) { try { await client.end(); } catch { /* ignore */ } }
    }

    if (!match) {
      const who = extractEmailAddress(email.from) || email.from || "unknown sender";
      if (cfg.emailUnmatched !== "create") {
        console.warn(`[${firm.id}][email] No matching intake for ${who} — alerting`);
        if (cfg.emailNotify !== "off") {
          await intakeNotify(firm,
            `📧 *Unmatched intake email* from ${who}\n_${email.subject || "(no subject)"}_\nCouldn't tie it to an existing intake — attach it manually.`);
        }
        return;
      }
      // Opt-in: treat it as a brand-new lead.
      const extracted = await extractIntake(firm, `${email.subject}\n\n${email.text}`);
      if (!extracted) return;
      const senderEmail = extractEmailAddress(email.from);
      if (senderEmail) extracted.client = { ...(extracted.client || {}), email: senderEmail };
      const { inserted } = await insertIntake(firm, {
        callId: sourceId, phone: extracted.client?.phone || null,
        quoLink: null, transcript: `From: ${email.from}\nSubject: ${email.subject}\n\n${email.text}`,
        data: extracted,
      });
      if (inserted) {
        console.log(`[${firm.id}][email] Created new intake from unmatched email (${sourceId})`);
        if (cfg.emailNotify === "all") {
          await intakeNotify(firm, `📧 *New intake from email* — ${extracted.client?.name || who}${intakeLink(firm, sourceId)}`);
        }
      }
      return;
    }

    console.log(`[${firm.id}][email] Matched intake ${match.callId} via ${match.via}`);
    const { inserted } = await insertInteraction(firm, {
      intakeCallId: match.callId, phone: null, type: "email", direction: "inbound",
      sourceId, content: `Subject: ${email.subject}\n\n${email.text}`.slice(0, 20000),
      transcript: null, quoLink: null,
    });
    // Dedup: already ingested this exact email.
    if (!inserted && !firm._warnedNoInteractions?.has(cfg.interactionsTable)) return;

    const extracted = await extractIntake(firm, `${email.subject}\n\n${email.text}`);
    if (!extracted) return;
    const added = await mergeIntoIntake(firm, match.callId, extracted);
    if (added > 0) {
      console.log(`[${firm.id}][email] Merged ${added} field(s) into intake ${match.callId}`);
      if (cfg.emailNotify === "all") {
        await intakeNotify(firm,
          `📧 *Intake updated* from email — filled ${added} field${added === 1 ? "" : "s"}${intakeLink(firm, match.callId)}`,
          { phone: match.phone });
      }
    }
  } catch (err) {
    console.error(`[${firm.id}][email] Error:`, err.message);
  }
}

// Backfill: pull messages/calls with this caller from BEFORE the intake call
// (within the same look-back window) so texts sent ahead of the qualifying call
// aren't missed. Logs each as an interaction, then does ONE extraction over the
// combined text and merges it into the intake. Best-effort.
async function backfillFollowUps(firm, { externalPhone, intakeCallId }) {
  if (!firm.quoApiKey || !externalPhone) return;
  const hours = firm.intakeConfig?.followUpHours || 72;
  const sinceMs = Date.now() - hours * 3600 * 1000;
  const phoneIds = await loadQuoPhoneNumberIds(firm);
  if (!phoneIds.length) return;

  const items = [];
  for (const pid of phoneIds) {
    const [messages, calls] = await Promise.all([
      fetchQuoHistory(firm, "messages", pid, externalPhone),
      fetchQuoHistory(firm, "calls", pid, externalPhone),
    ]);
    for (const m of messages) {
      const at = Date.parse(m.createdAt || m.sentAt || 0);
      if (!Number.isFinite(at) || at < sinceMs) continue;
      items.push({
        type: "text", sourceId: m.id, at,
        direction: m.direction === "outgoing" ? "outbound" : "inbound",
        content: m.text || m.body || "",
      });
    }
    for (const c of calls) {
      if (c.id === intakeCallId) continue; // the qualifying call itself
      const at = Date.parse(c.createdAt || c.answeredAt || 0);
      if (!Number.isFinite(at) || at < sinceMs) continue;
      items.push({
        type: "call", sourceId: c.id, at,
        direction: c.direction === "outgoing" ? "outbound" : "inbound",
        content: "", needsTranscript: true,
      });
    }
  }
  if (!items.length) return;

  // Oldest first; cap transcript fetches to keep this bounded.
  items.sort((a, b) => a.at - b.at);
  let transcriptBudget = 5;
  const texts = [];
  let logged = 0;

  for (const it of items) {
    let transcript = null;
    if (it.needsTranscript && transcriptBudget > 0) {
      transcript = await fetchCallTranscript(firm, it.sourceId);
      transcriptBudget--;
    }
    const { inserted } = await insertInteraction(firm, {
      intakeCallId, phone: phoneKey(externalPhone), type: it.type,
      direction: it.direction, sourceId: it.sourceId,
      content: it.content || null, transcript, quoLink: null,
    });
    if (!inserted) continue; // already captured live
    logged++;
    const t = (transcript || it.content || "").trim();
    if (t) texts.push(t);
  }
  if (!logged) return;
  console.log(`[${firm.id}][backfill] Logged ${logged} prior interaction(s) for intake ${intakeCallId}`);

  if (!texts.length) return;
  const extracted = await extractIntake(firm, texts.join("\n\n"));
  if (!extracted) return;
  const added = await mergeIntoIntake(firm, intakeCallId, extracted);
  if (added > 0) {
    console.log(`[${firm.id}][backfill] Merged ${added} field(s) from prior messages into ${intakeCallId}`);
    await intakeNotify(firm, `📝 *Intake updated* from ${logged} earlier message${logged === 1 ? "" : "s"} — filled ${added} field${added === 1 ? "" : "s"}${intakeLink(firm, intakeCallId)}`,
      { phone: externalPhone });
  }
}

// On startup, rehydrate follow-up windows from recent intakes so a redeploy
// doesn't drop active windows.
async function loadFollowUpWindows(firm) {
  if (!firm.intakeConfig?.enabled || !firm.caseDbUrl) return;
  const table = firm.intakeConfig?.table || "public.intakes";
  const hours = firm.intakeConfig?.followUpHours || 72;
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(table)) return;
  let client;
  try {
    client = await connectCaseDb(firm);
    const { rows } = await client.query(
      `SELECT call_id, phone, extract(epoch from created_at) * 1000 as created_ms
       FROM ${table} WHERE created_at > now() - ($1 || ' hours')::interval`,
      [String(hours)],
    );
    let n = 0;
    for (const r of rows) {
      const key = phoneKey(r.phone);
      if (!key) continue;
      firm.followUpWindows.set(key, { intakeCallId: r.call_id, expiresAt: Number(r.created_ms) + hours * 3600 * 1000 });
      n++;
    }
    if (n) console.log(`[${firm.id}][follow-up] Rehydrated ${n} active window(s)`);
  } catch (err) {
    console.error(`[${firm.id}][follow-up] Rehydrate error:`, err.message);
  } finally {
    if (client) { try { await client.end(); } catch { /* ignore */ } }
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
      // Include the id and body — a bare status code isn't diagnosable.
      const body = await res.text().catch(() => "");
      console.error(`[${firm.id}][call-check] Quo API responded ${res.status} for callId=${callId}: ${body.slice(0, 300)}`);
      return null;
    }
    const json = await res.json();
    return json.data || json;
  } catch (err) {
    console.error(`[${firm.id}][call-check] Error fetching call:`, err.message);
    return null;
  }
}

// Fetch the verbatim call transcript from Quo. The /call-summary webhook only
// carries the AI summary (lossy), so intake extraction reads this instead.
// Returns the transcript as speaker-labeled text, or null if unavailable/not ready.
async function fetchCallTranscript(firm, callId) {
  if (!firm.quoApiKey || !callId) return null;
  try {
    const res = await fetchWithRetry(`https://api.openphone.com/v1/call-transcripts/${callId}`, {
      headers: { Authorization: firm.quoApiKey },
    }, { label: `${firm.id}][transcript` });
    if (!res.ok) {
      console.warn(`[${firm.id}][transcript] Quo API responded ${res.status} for ${callId}`);
      return null;
    }
    const json = await res.json();
    const data = json.data || json;
    const dialogue = data.dialogue || data.segments || [];
    if (!Array.isArray(dialogue) || dialogue.length === 0) {
      console.warn(`[${firm.id}][transcript] No transcript dialogue for ${callId} (status: ${data.status || "?"})`);
      return null;
    }
    return dialogue
      .map((seg) => {
        const who = seg.identifier || seg.speaker || seg.userId || "";
        const content = seg.content || seg.text || "";
        return who ? `${who}: ${content}` : content;
      })
      .filter(Boolean)
      .join("\n");
  } catch (err) {
    console.error(`[${firm.id}][transcript] Error fetching transcript:`, err.message);
    return null;
  }
}

// --- Quo history (used to backfill interactions from BEFORE the intake call) ---

// Quo's /v1/messages and /v1/calls require the firm's own phoneNumberId, not the
// E.164 number — fetch and cache the account's phone number IDs.
async function loadQuoPhoneNumberIds(firm) {
  if (!firm.quoApiKey) return [];
  if (firm.quoPhoneNumberIds?.length) return firm.quoPhoneNumberIds;
  try {
    const res = await fetchWithRetry("https://api.openphone.com/v1/phone-numbers", {
      headers: { Authorization: firm.quoApiKey },
    }, { label: `${firm.id}][quo-numbers` });
    if (!res.ok) {
      console.warn(`[${firm.id}][quo-numbers] Quo API responded ${res.status}`);
      return [];
    }
    const json = await res.json();
    const ids = (json.data || []).map((p) => p.id).filter(Boolean);
    firm.quoPhoneNumberIds = ids;
    console.log(`[${firm.id}][quo-numbers] Loaded ${ids.length} phone number id(s)`);
    return ids;
  } catch (err) {
    console.error(`[${firm.id}][quo-numbers] Error:`, err.message);
    return [];
  }
}

// List recent messages or calls between one of the firm's lines and `participant`.
async function fetchQuoHistory(firm, kind, phoneNumberId, participant, maxResults = 25) {
  try {
    const url = new URL(`https://api.openphone.com/v1/${kind}`);
    url.searchParams.set("phoneNumberId", phoneNumberId);
    url.searchParams.append("participants[]", participant);
    url.searchParams.set("maxResults", String(maxResults));
    const res = await fetchWithRetry(url.toString(), {
      headers: { Authorization: firm.quoApiKey },
    }, { label: `${firm.id}][backfill` });
    if (!res.ok) {
      // Log the body — Quo's 400s name the offending param (as the contacts
      // maxResults cap did), which a bare status code can't tell us.
      const body = await res.text().catch(() => "");
      console.warn(`[${firm.id}][backfill] ${kind} responded ${res.status}: ${body.slice(0, 300)}`);
      return [];
    }
    const json = await res.json();
    return json.data || [];
  } catch (err) {
    console.error(`[${firm.id}][backfill] Error fetching ${kind}:`, err.message);
    return [];
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
        if (user.deleted) continue;
        if (user.is_bot) {
          // Bot users are excluded from slackUsers (they're not staff), but we
          // index them separately so an app can be @-mentioned. Slack exposes
          // the owning app on profile.api_app_id, which is how an App ID (A…)
          // resolves to the member ID (U…) that <@…> actually needs.
          const appId = user.profile?.api_app_id;
          if (appId) firm.slackBots.set(appId, user.id);
          const botName = (user.profile?.display_name || user.real_name || user.name || "").toLowerCase().trim();
          if (botName) firm.slackBots.set(botName, user.id);
          continue;
        }
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
    console.log(`[${firm.id}][slack] Loaded ${total} users, ${firm.slackUsers.size} name mappings, ${firm.slackBots.size} bot mappings`);
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

async function findThreadByPhone(firm, phoneNumber, { retry = true } = {}) {
  if (!firm.slackBotToken || !firm.slackLeadCallsChannelId || !phoneNumber) return null;
  const last10 = lastTenDigits(phoneNumber);
  console.log(`[${firm.id}][lead-thread] Searching for phone ${phoneNumber} (last10: ${last10})`);
  let messages = await fetchLeadChannelHistory(firm);
  let threadTs = searchChannelHistoryForPhone(messages, phoneNumber);
  if (threadTs) return threadTs;
  if (!retry) {
    console.log(`[${firm.id}][lead-thread] No thread found for ${phoneNumber} — posting standalone`);
    return null;
  }
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

// skipThreadSearch: post as a standalone message without hunting for a prior
// thread (used for closed-client alerts, which never have one — the search
// would cost two history fetches and a 5s retry for nothing).
// mentionUsers: always @-mention, even when not threaded.
async function postLeadToSlack(firm, text, phoneFrom, phoneTo,
  { mentionUsersIfThreaded = [], skipThreadSearch = false, mentionUsers = [], threadRetry = true } = {}) {
  if (firm.slackBotToken && firm.slackLeadCallsChannelId) {
    try {
      const phones = [phoneFrom, phoneTo].filter(Boolean);
      let threadTs = null;
      if (!skipThreadSearch) {
        for (const phone of phones) {
          if (firm.phoneLines[phone]) continue;
          threadTs = await findThreadByPhone(firm, phone, { retry: threadRetry });
          if (threadTs) break;
        }
      }
      const finalText = mentionUsers.length
        ? insertMentionsAfterTitle(text, mentionUsers)
        : (threadTs ? insertMentionsAfterTitle(text, mentionUsersIfThreaded) : text);
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
        // parentTs is what later messages should thread under: the existing
        // thread if we replied into one, otherwise this new top-level post.
        return { permalink, ts: msgTs, parentTs: threadTs || msgTs };
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

// Channel topics list roles in a fixed order: Attorney | Paralegal | LA.
// includeLA=false drops the 3rd mention (the legal assistant) so they aren't
// pinged on posts a human already handled. Topics with only 2 names are
// unaffected.
const TOPIC_LA_INDEX = 2;

function extractMentionsFromTopic(firm, topic, { includeLA = true } = {}) {
  if (!topic) return "";
  const trim = (list) => (includeLA ? list : list.slice(0, TOPIC_LA_INDEX));

  const userIdMatches = topic.match(/<@(U[A-Z0-9]+)>/g);
  if (userIdMatches && userIdMatches.length > 0) {
    const kept = trim(userIdMatches);
    console.log(`[${firm.id}][mentions] Found ${userIdMatches.length} user mentions in topic, tagging ${kept.length}${includeLA ? "" : " (LA excluded)"}`);
    return kept.length ? kept.join(" ") + "\n" : "";
  }
  const atMatches = topic.match(/@(\w+)/g);
  if (!atMatches) {
    console.log(`[${firm.id}][mentions] No mentions found in topic: "${topic}"`);
    return "";
  }
  // Resolve names first so positions still line up when one fails to resolve.
  const resolved = atMatches.map((atName) => {
    const name = atName.slice(1).toLowerCase();
    const userId = firm.slackUsers.get(name);
    if (!userId) console.log(`[${firm.id}][mentions] Could not resolve "${name}" to a Slack user`);
    return userId ? `<@${userId}>` : null;
  });
  const mentions = trim(resolved).filter(Boolean);
  if (mentions.length > 0) {
    console.log(`[${firm.id}][mentions] Resolved ${mentions.length}/${atMatches.length} mentions${includeLA ? "" : " (LA excluded)"}`);
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

async function postToCaseChannel(firm, text, phoneFrom, phoneTo, { skipMentions = false, includeLA = true } = {}) {
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
    const mentions = skipMentions ? "" : extractMentionsFromTopic(firm, liveTopic ?? channel.topic, { includeLA });
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
    const externalPhone = firm.phoneLines[from] ? to : from;
    const closedClient = shouldAlertClosedClient(firm, externalPhone);
    if (closedClient) {
      // Former client — surface in #lead-calls too; may be a new matter.
      await postLeadToSlack(firm, CLOSED_CLIENT_PREFIX + text, from, to,
        { threadRetry: false, mentionUsers: firm.leadThreadTagUsers });
      console.log(`[${firm.id}][call-check] Closed client — also sent to lead-calls`);
    } else {
      await threadInLeadChannelIfMatch(firm, text, from, to, { mentionUsers: firm.leadThreadTagUsers });
    }
    if (!isActiveClient(firm, externalPhone)) {
      await postToLegalAssistant(firm, closedClient ? CLOSED_CLIENT_PREFIX + text : text, from, to);
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
    // Sona answered (AI) — LA still needs to follow up. Human-answered was
    // already handled by a person, so don't ping the LA.
    await postToCaseChannel(firm, text, from, to, { includeLA: isSona });
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
  return !isClosedClient(firm, phoneNumber);
}

// A former client: has a case number whose status IS closed/archived. Distinct
// from "not an active client" (which also covers strangers with no case at all).
function isClosedClient(firm, phoneNumber) {
  const caseNumber = extractCaseNumber(getContactName(firm, phoneNumber));
  if (!caseNumber) return false;
  const entry = getCaseEntry(firm, caseNumber);
  if (entry) return isClosedStatus(firm, entry.status);
  // Has a case number, but the case isn't in the tracker at all — an old matter
  // that aged out. Treat it as long-closed (no closed_at → past the grace period).
  // Guarded on a populated cache: with the sync unconfigured or a failed refresh
  // every case would look "missing" and every client would become a former one.
  if (!(firm.caseStatusCache?.size > 0)) return false;
  console.log(`[${firm.id}][closed-client] Case ${caseNumber} not in tracker — treating as long-closed`);
  return true;
}

const CLOSED_CLIENT_PREFIX = "🔁 *Closed Client Message*\n";

// Should a message from this former client be alerted into #lead-calls?
// Only once the case has been closed longer than the grace period — before
// that they're most likely still following up on the case that just closed.
// If closed_at is unknown (not selected by the query, or null), we alert
// rather than silently dropping it.
function shouldAlertClosedClient(firm, phoneNumber) {
  if (!isClosedClient(firm, phoneNumber)) return false;
  const caseNumber = extractCaseNumber(getContactName(firm, phoneNumber));
  const closedAt = getCaseClosedAt(firm, caseNumber);
  if (!closedAt) return true;
  const days = firm.caseStatusConfig?.closedGraceDays ?? 21;
  const ageDays = (Date.now() - closedAt) / 86400000;
  if (ageDays >= days) return true;
  console.log(`[${firm.id}][closed-client] Case ${caseNumber} closed ${ageDays.toFixed(1)}d ago (< ${days}d) — not alerting lead-calls`);
  return false;
}

function isKnownBusiness(firm, phoneNumber) {
  const contactName = getContactName(firm, phoneNumber);
  if (!contactName) return false;
  if (extractCaseNumber(contactName)) return false;
  return true;
}

// Resolve the configured callback bot to a Slack mention. Accepts an App ID
// (A…) — looked up via the bot index built from users.list — or a member id
// (U…/B…) used as-is. Returns "<@Uxxx>" or null.
function resolveCallbackBotMention(firm) {
  const id = firm.callbackBotId;
  if (!id) return null;
  if (/^[UB][A-Z0-9]+$/i.test(id)) return `<@${id}>`;
  const resolved = firm.slackBots.get(id) || firm.slackBots.get(id.toLowerCase());
  if (resolved) return `<@${resolved}>`;
  if (!firm._warnedCallbackBot) {
    firm._warnedCallbackBot = true;
    console.warn(`[${firm.id}][callback] Could not resolve callback bot "${id}" — is the app installed in this workspace and does the bot token have users:read?`);
  }
  return null;
}

// A request stays "outstanding" this long if the firm never calls the client
// back. Past it the client is tagged again rather than staying silently
// suppressed, and the map can't grow without bound.
const CALLBACK_PENDING_TTL_MS = 48 * 60 * 60 * 1000;

function hasPendingCallback(firm, phone) {
  const key = phoneKey(phone);
  if (!key) return false;
  const entry = firm.pendingCallbacks.get(key);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    firm.pendingCallbacks.delete(key);
    return false;
  }
  return true;
}

function markPendingCallback(firm, phone, callId) {
  const key = phoneKey(phone);
  if (!key) return;
  firm.pendingCallbacks.set(key, { callId, expiresAt: Date.now() + CALLBACK_PENDING_TTL_MS });
}

// Settle an outstanding request — only the firm actually calling the client
// back does that. A client calling in again is NOT a settlement: they are
// calling precisely because nobody has called them yet, so clearing on any
// call would let the very next summary tag them a second time.
// `callId` guards against a call clearing a request it raised itself.
function clearPendingCallback(firm, phone, callId) {
  const key = phoneKey(phone);
  if (!key) return;
  const entry = firm.pendingCallbacks.get(key);
  if (!entry) return;
  if (callId && entry.callId === callId) return;
  firm.pendingCallbacks.delete(key);
  console.log(`[${firm.id}][callback] Firm called ${phone} back — outstanding request cleared`);
}

// Did the caller ask for someone to call them back? Deliberately narrow: this
// fires an automation, so a false positive creates real work. Missed calls are
// excluded upstream — this only runs on calls a human or Sona actually took.
async function detectCallbackRequest(firm, text) {
  if (!ANTHROPIC_API_KEY || !text) return false;
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
        max_tokens: 10,
        system: `You read summaries/transcripts of phone calls to a law firm and decide ONE thing: does the caller need someone from the firm to CALL THEM BACK?

Answer "yes" only when the call clearly leaves a return call outstanding, e.g.:
- the caller asks to be called back, or asks for someone specific to call them
- they were told someone will call them back / follow up by phone
- they could not reach the person they needed and left a request to be reached
- the person they needed was unavailable and the call ended unresolved

Answer "no" for everything else, including:
- the matter was fully handled on the call with nothing left to return
- the caller only wanted information and got it
- follow-up is by text, email, or mail rather than a phone call
- the firm is calling the client (outbound) with nothing requested back
- sales, vendors, insurers, other firms, spam, wrong numbers

If it is ambiguous or the summary is too thin to tell, answer "no".

Respond with ONLY "yes" or "no".`,
        messages: [{ role: "user", content: `Call summary / transcript:\n${text}` }],
      }),
    }, { label: `${firm.id}][callback` });
    if (!res.ok) {
      console.error(`[${firm.id}][callback] Anthropic API error ${res.status}`);
      return false;
    }
    const json = await res.json();
    const reply = (json.content?.[0]?.text || "").toLowerCase().trim();
    return reply.startsWith("yes");
  } catch (err) {
    console.error(`[${firm.id}][callback] Detection error:`, err.message);
    return false;
  }
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
  if (!text) {
    // Nothing to classify. Report the summary's shape and Quo's own status so a
    // benign "no summary generated" is distinguishable from a payload change.
    const obj = payload?.data?.object || {};
    const s = obj.summary;
    const shape = s === undefined ? "absent"
      : s === null ? "null"
      : Array.isArray(s) ? `empty array`
      : typeof s === "string" ? `empty string`
      : typeof s;
    console.warn(`[${firm.id}][lead] No text to classify — Quo status="${obj.status || "?"}", summary=${shape}, keys: [${Object.keys(obj).join(", ") || "none"}]`);
    return { isLead: false, isQualified: false, label: "No (No Summary)" };
  }

  if (!ANTHROPIC_API_KEY) {
    console.warn(`[${firm.id}][lead] ANTHROPIC_API_KEY not set — cannot classify`);
    return { isLead: false, isQualified: false, label: "No (Unclassified)" };
  }

  try {
    const systemPrompt = `You classify call summaries for a ${firm.practiceArea} law firm (${firm.name}).

Classify each call into ONE of these categories:
- "qualified_lead": someone seeking legal help for a situation the firm handles: car accidents, truck accidents, motorcycle accidents, pedestrian accidents, slip and fall, workplace injuries, workers comp, wrongful death, drunk driver, hit and run, or any personal injury.
- "lead": someone seeking legal help for something OUTSIDE ${firm.practiceArea} (family law, divorce, child support, criminal, immigration, etc.) OR a vague legal inquiry.
- "not_lead": anything else.

Signals that this IS a lead — any one of these is enough:
- The caller describes an accident or injury and wants the firm to look at it
- They ask for an appointment, consultation, case evaluation, or "to speak with an attorney"
- Someone calls ON BEHALF OF an injured person — a spouse, parent, child, relative, friend, coworker, or employer. The caller does not have to be the injured party.
- The summary reports accident details typical of a new intake: a date of accident, how the crash happened, injuries, hospital or medical treatment, a police report, insurance information
- A FORMER client whose prior matter is closed is calling about a NEW incident

"not_lead" is for:
- Calls from insurance adjusters / insurance companies (Progressive, USAA, GEICO, State Farm, etc.) about claims, demands, subrogation
- Calls from other law firms about case management, mediation, opposing counsel, co-counsel
- Calls from medical providers (doctors, clinics, physiotherapy) about appointments, records, payments
- Sales calls, marketing, recruiting, vendors
- Press / media inquiries
- Wrong numbers, spam, automated phone systems
- Someone with an OPEN matter at this firm calling about that matter

CRITICAL RULES:
- Only treat it as an existing matter when there is real evidence of an existing relationship WITH THIS FIRM: a case number, a named attorney or paralegal here, questions about their settlement / status / lien / disbursement / medical records on a case the firm is already handling, or the summary says they are a current client.
- Ordinary phrases like "the accident", "her accident", "the injured party", or "the police report" are NOT evidence of an existing case. A first-time caller naturally says "the accident". Do not classify on those words alone.
- A caller relaying a third party's accident is a lead, not an existing-case call. Two or more names in the summary (caller + injured person) is normal for a new intake.
- The call being answered by staff, or an appointment being scheduled, does not make it an existing case — that is what intake does with a new lead.
- Language does not matter. Calls in Spanish or any other language are classified the same way as English.
- TIE-BREAK: if the summary describes an accident or injury and there is no clear evidence of an existing relationship with this firm and the caller is not an adjuster/law firm/provider/vendor, answer "qualified_lead". A missed lead costs the firm far more than an extra one to review.

Respond with ONLY a single word: "qualified_lead", "lead", or "not_lead". No explanation.`;

    // Give the model the routing facts it can't infer from the summary: which of
    // the firm's lines was dialed (a line named "Leads"/"Intake" is a strong
    // prior) and whether the outside number is already a saved contact. Without
    // these it guesses at the caller's relationship to the firm from wording.
    const outside = phones.find((p) => !firm.phoneLines[p]);
    const lineLabel = firm.phoneLines[phoneTo] || firm.phoneLines[phoneFrom] || null;
    const contactName = outside ? getContactName(firm, outside) : null;
    const contextLines = [
      lineLabel ? `Firm line involved: "${lineLabel}"` : null,
      contactName
        ? `The outside number is a saved contact named "${contactName}". A saved contact whose matter is closed may still be a new lead.`
        : `The outside number is NOT a saved contact — the firm has no record of this caller.`,
    ].filter(Boolean);
    const context = contextLines.length ? `Context:\n${contextLines.join("\n")}\n\n` : "";

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
        messages: [{ role: "user", content: `${context}Call summary:\n${text}` }],
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

    const externalPhone = firm.phoneLines[from] ? to : from;
    // Inbound texts from a FORMER client go to #lead-calls and intake as well —
    // a closed-case client texting in is often a new matter.
    const closedClient = !isOutbound && shouldAlertClosedClient(firm, externalPhone);

    let threadedInLeads = false;
    if (closedClient) {
      await postLeadToSlack(firm, CLOSED_CLIENT_PREFIX + text, from, to,
        { threadRetry: false, mentionUsers: firm.leadThreadTagUsers });
      threadedInLeads = true;
      console.log(`[${firm.id}][messages] Closed client — ALSO sent to lead-calls`);
    } else {
      threadedInLeads = await threadInLeadChannelIfMatch(firm, text, from, to);
    }

    if (closedClient) {
      await postToLegalAssistant(firm, CLOSED_CLIENT_PREFIX + text, from, to);
      console.log(`[${firm.id}][messages] Closed client — ALSO sent to legalassistant-phone`);
    } else if (!isOutbound && !threadedInLeads && shouldRouteToLegalAssistant(firm, from, to)) {
      await postToLegalAssistant(firm, text, from, to);
      console.log(`[${firm.id}][messages] ALSO sent to legalassistant-phone`);
    }

    await postToCaseChannel(firm, text, from, to, { skipMentions: isOutbound });

    // Follow-up capture: if this number is in an intake follow-up window, log the
    // text and merge any new details into the intake. Best-effort.
    if (getFollowUpWindow(firm, externalPhone)) {
      const msgId = obj.id || extractField(payload, "data.object.id", "data.id");
      await captureFollowUp(firm, {
        phone: externalPhone, type: "text", direction: isOutbound ? "outbound" : "inbound",
        sourceId: msgId, content: body, quoLink: null, extractText: body,
      }).catch((err) => console.error(`[${firm.id}][follow-up] Error:`, err.message));
    }
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

    const externalPhone = firm.phoneLines[from] ? to : from;
    const closedClient = shouldAlertClosedClient(firm, externalPhone);
    if (closedClient) {
      // Former client — post into #lead-calls too (may be a new matter).
      await postLeadToSlack(firm, CLOSED_CLIENT_PREFIX + text, from, to,
        { threadRetry: false, mentionUsers: firm.leadThreadTagUsers });
      console.log(`[${firm.id}][calls] Closed client — ALSO sent to lead-calls`);
    } else {
      await threadInLeadChannelIfMatch(firm, text, from, to, { mentionUsers: firm.leadThreadTagUsers });
    }

    if (!isActiveClient(firm, externalPhone)) {
      await postToLegalAssistant(firm, closedClient ? CLOSED_CLIENT_PREFIX + text : text, from, to);
      console.log(`[${firm.id}][calls] ALSO sent to legalassistant-phone`);
    } else {
      console.log(`[${firm.id}][calls] Skipping legalassistant-phone — existing client`);
    }

    await postToCaseChannel(firm, text, from, to);

    // Follow-up capture: missed calls and voicemails on a tracked number. A
    // voicemail with a transcript feeds the extractor; a bare missed call is
    // logged as an interaction only (no text to extract).
    if (getFollowUpWindow(firm, externalPhone)) {
      const vmTranscript = voicemail && typeof voicemail === "object" ? (voicemail.transcript || voicemail.transcription || "") : "";
      await captureFollowUp(firm, {
        phone: externalPhone, type: hasVoicemail ? "voicemail" : "missed_call",
        direction: "inbound", sourceId: callId, content: text,
        transcript: vmTranscript || null, extractText: vmTranscript,
      }).catch((err) => console.error(`[${firm.id}][follow-up] Error:`, err.message));
    }
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

    // from/to normally come from the in-memory cache filled by the /calls
    // webhook. That misses when /calls isn't configured for this firm, the
    // process restarted, or the call is older than CACHE_TTL — in which case
    // both would be "N/A" and the summary would post useless numbers or (with
    // the phone-line filter on) be dropped entirely. Fall back to the Quo API.
    let cached = callId ? getCachedCall(firm, callId) : null;
    if (callId && (!cached?.from || !cached?.to)) {
      const call = await fetchCallFromQuo(firm, callId);
      if (call?.from || call?.to) {
        cached = {
          ...(cached || {}),
          from: cached?.from || call.from,
          to: cached?.to || call.to,
          direction: cached?.direction || call.direction,
          answeredBy: cached?.answeredBy || call.answeredBy,
          userId: cached?.userId || call.userId,
        };
        cacheCall(firm, callId, cached);
        console.log(`[${firm.id}][call-summary] Cache miss for ${callId} — recovered from/to via Quo API`);
      } else {
        console.warn(`[${firm.id}][call-summary] Cache miss for ${callId} and Quo API lookup failed — from/to unknown`);
      }
    }
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
    let leadParentTs = null;   // thread the intake confirmation under the lead post
    if (isLead) {
      const handlerDisplay = sona ? "Sona" : (getQuoUserName(firm, cached?.answeredBy) || getQuoUserName(firm, cached?.userId) || "Human");
      const qualTag = isQualified ? "🔥 *Qualified Lead Call*" : "📋 *Lead Call*";
      const leadText = `${qualTag}\nHandled By: ${handlerDisplay}\nFrom: ${fromDisplay}\nTo: ${toDisplay}\nSummary:\n${summary}${translation}${linkLine}`;
      const leadPostOpts = sona ? { mentionUsersIfThreaded: firm.leadThreadTagUsers } : {};
      const leadPost = await postLeadToSlack(firm, leadText, from, to, leadPostOpts);
      leadPermalink = leadPost?.permalink || null;
      leadParentTs = leadPost?.parentTs || null;
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

    // Callback request: a client (case open OR closed) spoke to someone and is
    // still owed a return call. Tag the callback app so it can pick it up.
    // Missed calls never reach here — this is only calls that were answered.
    let caseText = text;
    const clientPhone = firm.phoneLines[from] ? to : from;
    const isClient = !!extractCaseNumber(getContactName(firm, clientPhone));
    if (isClient && firm.callbackBotId) {
      // The firm calling the client is the one thing that settles a request.
      if (isOwnLine(firm, from)) clearPendingCallback(firm, clientPhone, callId);
      const botMention = resolveCallbackBotMention(firm);
      if (botMention && hasPendingCallback(firm, clientPhone)) {
        // Still owed the same return call — tagging again would open a second
        // task for one outstanding callback. Skips the detection call too.
        console.log(`[${firm.id}][callback] Request already outstanding for ${clientPhone} — not tagging again`);
      } else if (botMention && await detectCallbackRequest(firm, summaryText)) {
        caseText = `${botMention} request a call back\n${text}`;
        // Surface it in the missed-calls report as well — an outstanding return
        // call is work the same people work off that list. Sona counts the same.
        const callbackText = `↩️ *Call Back Requested*\nFrom: ${fromDisplay}\nTo: ${toDisplay}${linkLine}`;
        await postToSlack(firm.slackWebhooks.missedCalls, callbackText);
        markPendingCallback(firm, clientPhone, callId);
        console.log(`[${firm.id}][callback] Call-back requested for ${clientPhone} — tagged callback app, sent to missed-calls`);
      }
    }

    // Tag the LA on Sona calls (AI answered, needs follow-up) but not on
    // human-answered call summaries.
    await postToCaseChannel(firm, caseText, from, to, { includeLA: sona });

    // Intake (opt-in). Best-effort, after routing. If this caller is already in
    // a follow-up window, treat the call as a follow-up (log + merge into the
    // existing intake); otherwise a qualified lead opens a new intake.
    const externalPhone = firm.phoneLines[from] ? to : from;
    if (getFollowUpWindow(firm, externalPhone)) {
      const transcript = await fetchCallTranscript(firm, callId);
      await captureFollowUp(firm, {
        phone: externalPhone, type: sona ? "sona_call" : "call",
        direction: isInbound ? "inbound" : "outbound", sourceId: callId,
        content: summaryText, transcript, quoLink: deepLink,
        extractText: [transcript, summaryText].filter(Boolean).join("\n\n"),
      }).catch((err) => console.error(`[${firm.id}][follow-up] Error:`, err.message));
    } else {
      await runIntake(firm, { callId, deepLink, summaryText, externalPhone, isQualified, leadParentTs })
        .catch((err) => console.error(`[${firm.id}][intake] Error:`, err.message));
    }
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
// Inbound email (SendGrid/Mailgun/Postmark/CloudMailin inbound-parse → here).
// Accepts form-encoded posts too, which most parse providers send.
app.post("/webhooks/email/:firmId", express.urlencoded({ extended: true, limit: "10mb" }), withFirm(handleInboundEmail));
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
    callbackBotId: f.callbackBotId || "",
    callbackBotResolved: !!resolveCallbackBotMention(f),
    restrictToPhoneLines: !!f.restrictToPhoneLines,
    caseStatusConfig: {
      query: f.caseStatusConfig?.query || "",
      closedValues: f.caseStatusConfig?.closedValues || ["archived"],
      closedGraceDays: f.caseStatusConfig?.closedGraceDays ?? 21,
    },
    caseStatusCount: f.caseStatusCache ? f.caseStatusCache.size : 0,
    intakeConfig: {
      enabled: !!f.intakeConfig?.enabled,
      table: f.intakeConfig?.table || "public.intakes",
      interactionsTable: f.intakeConfig?.interactionsTable || "public.intake_interactions",
      notifyChannelId: f.intakeConfig?.notifyChannelId || "",
      appUrl: f.intakeConfig?.appUrl || "",
      emailNotify: f.intakeConfig?.emailNotify || "all",
      followUpHours: f.intakeConfig?.followUpHours || 72,
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
  const validTable = (t) => /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(t);
  if (ic.table && typeof ic.table === "string" && ic.table.trim() && !validTable(ic.table.trim())) {
    return { error: "intakeConfig.table must be a valid table name like public.intakes" };
  }
  if (ic.interactionsTable && typeof ic.interactionsTable === "string" && ic.interactionsTable.trim()
      && !validTable(ic.interactionsTable.trim())) {
    return { error: "intakeConfig.interactionsTable must be a valid table name" };
  }
  return {
    config: {
      name: String(name).trim(),
      practiceArea: String(practiceArea || "personal injury").trim(),
      phoneLines: phoneLines || {},
      leadThreadTagUsers: leadThreadTagUsers || [],
      callbackBotId: typeof body?.callbackBotId === "string" ? body.callbackBotId.trim() : "",
      restrictToPhoneLines: !!(body && body.restrictToPhoneLines),
      caseStatusConfig: {
        query: typeof csc.query === "string" ? csc.query.trim() : "",
        closedValues: Array.isArray(csc.closedValues) ? csc.closedValues : undefined,
        closedGraceDays: csc.closedGraceDays,
      },
      intakeConfig: {
        enabled: !!ic.enabled,
        table: typeof ic.table === "string" ? ic.table.trim() : "",
        interactionsTable: typeof ic.interactionsTable === "string" ? ic.interactionsTable.trim() : "",
        notifyChannelId: typeof ic.notifyChannelId === "string" ? ic.notifyChannelId.trim() : "",
        appUrl: typeof ic.appUrl === "string" ? ic.appUrl.trim() : "",
        emailNotify: ic.emailNotify,
        followUpHours: ic.followUpHours,
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
  firm.callbackBotId = config.callbackBotId || "";
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
  await loadFollowUpWindows(firm);
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
