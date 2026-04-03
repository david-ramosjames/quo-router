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

// --- Helpers ---

function safe(val) {
  if (val === null || val === undefined) return "N/A";
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
  const summary = extractField(payload, "data.summary", "summary", "object.summary") || "";
  const transcript = extractField(payload, "data.transcript", "transcript", "object.transcript") || "";
  const body = extractField(payload, "data.body", "body", "object.body", "data.message", "message") || "";
  return `${summary} ${transcript} ${body}`.toLowerCase();
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
  const handledBy = extractField(payload, "data.handledBy", "handledBy", "object.handledBy");
  if (handledBy && String(handledBy).toLowerCase().includes("sona")) return true;

  const source = extractField(payload, "data.source", "source", "object.source");
  if (source && String(source).toLowerCase().includes("sona")) return true;

  const agent = extractField(payload, "data.agent", "agent", "object.agent");
  if (agent && String(agent).toLowerCase().includes("sona")) return true;

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

    const from = safe(extractField(payload, "data.from", "from", "object.from"));
    const body = safe(extractField(payload, "data.body", "body", "object.body", "data.message", "message"));

    const text = `💬 New Text Message\nFrom: ${from}\nMessage: ${body}`;

    console.log(`[messages] From: ${from}`);
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

    const from = safe(extractField(payload, "data.from", "from", "object.from"));
    const voicemailUrl = extractField(payload, "data.voicemailUrl", "voicemailUrl", "object.voicemailUrl");

    let text = `📞 Missed Call / Voicemail\nFrom: ${from}`;
    if (voicemailUrl) {
      text += `\nVoicemail: ${voicemailUrl}`;
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
    console.log("[call-summary] RAW PAYLOAD:", JSON.stringify(req.body, null, 2));
    const payload = req.body || {};
    const from = safe(extractField(payload, "data.from", "from", "object.from"));
    const summary = safe(extractField(payload, "data.summary", "summary", "object.summary"));

    const sona = isSonaCall(payload);
    const lead = isLeadCall(payload);

    console.log(`[call-summary] From: ${from} | Sona: ${sona} | Lead: ${lead}`);

    // 1. Always post to base channel
    if (sona) {
      const text = `🤖 Sona Call Completed\nFrom: ${from}\nSummary: ${summary}\nLead: ${lead ? "Yes" : "No"}`;
      await postToSlack(SLACK_SONA_CALLS_WEBHOOK_URL, text);
      console.log("[call-summary] Sent to #sona-calls");
    } else {
      const text = `📞 Human Call Completed\nFrom: ${from}\nSummary: ${summary}\nLead: ${lead ? "Yes" : "No"}`;
      await postToSlack(SLACK_HUMAN_CALLS_WEBHOOK_URL, text);
      console.log("[call-summary] Sent to #human-calls");
    }

    // 2. If lead, ALSO send to #lead-calls
    if (lead) {
      const handledBy = sona ? "Sona" : "Human";
      const leadText = `🔥 Potential Lead Call\nHandled By: ${handledBy}\nFrom: ${from}\nSummary: ${summary}`;
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
