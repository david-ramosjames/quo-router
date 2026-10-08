// Reads #lead-calls the way a person would and saves each new post on the lead.
// The first run only marks the posts already in the channel as seen, so old
// history is not replayed into the lead list.

const SEQUENCES = new Set(["want_to_sign", "needs_info", "referral", "stop"]);

export function nextSequence({ text, isQualified, existing }) {
  if (/\breferral\b|\breferal\b/i.test(text || "")) return "referral";
  if (isQualified) return "want_to_sign";
  if (existing === "want_to_sign" || existing === "referral" || existing === "stop") return existing;
  return "needs_info";
}

function firstPhone(text, toE164) {
  const matches = String(text || "").match(/(?:\+?1[\s.-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}/g) || [];
  for (const raw of matches) {
    const e164 = toE164(raw);
    if (e164) return e164;
  }
  return null;
}

function firstEmail(text) {
  return String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
}

function appendDetail(current, addition) {
  const next = String(addition || "").trim();
  if (!next) return current || null;
  const prior = String(current || "");
  if (prior.includes(next)) return prior || null;
  const combined = prior ? `${prior}\n\n${next}` : next;
  return combined.slice(-15000);
}

async function decideSequence(firm, detail, deps) {
  const ruled = nextSequence({ text: detail, isQualified: false, existing: null });
  if (ruled === "referral") return "referral";
  if (!deps.llmConfigured() || !detail) return "want_to_sign";
  const score = await deps.llmExtract({
    label: `${firm.id}][lead-sequence`,
    name: "lead_sequence",
    description: "Which follow-up sequence this lead is on",
    maxTokens: 180,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sequence: { type: "string", enum: ["want_to_sign", "needs_info", "referral", "stop"] },
        reason: { type: "string" },
      },
      required: ["sequence", "reason"],
    },
    system: `You set the follow-up sequence for one lead at a Texas personal injury firm.
The case detail is the Slack posts and call summaries gathered so far.
want_to_sign: a form fill, a missed call, or a first conversation we still want to pursue. Texts apply.
needs_info: we already spoke and they are not ready to decide. Calls only.
referral: the post is marked Referral or Referal.
stop: they signed, the matter is lost, or this is not a new lead.
Use only the text you are given.`,
    user: detail.slice(0, 8000),
  });
  return SEQUENCES.has(score?.sequence) ? score.sequence : "want_to_sign";
}

function kindFor(sequence, existingKind) {
  if (sequence === "needs_info") return "needs_info";
  if (sequence === "want_to_sign") return "pursue";
  return existingKind || "pursue";
}

async function remember(client, channelId, ts, leadId) {
  await client.query(
    `insert into public.lead_channel_posts (channel_id, message_ts, lead_id)
     values ($1, $2, $3)
     on conflict (channel_id, message_ts) do nothing`,
    [channelId, ts, leadId],
  );
}

export async function absorbLeadChannel(firm, deps) {
  if (!firm.caseDbUrl || !firm.slackBotToken || !firm.slackLeadCallsChannelId) return;
  const channelId = firm.slackLeadCallsChannelId;
  const messages = await deps.fetchHistory(firm);
  const posts = messages
    .filter((message) => message?.ts && (!message.thread_ts || message.thread_ts === message.ts))
    .filter((message) => !message.subtype || message.subtype === "bot_message")
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  if (!posts.length) return;

  let client;
  try {
    client = await deps.connectCaseDb(firm);
    const seen = await client.query(
      `select message_ts from public.lead_channel_posts where channel_id = $1`,
      [channelId],
    );
    if (seen.rows.length === 0) {
      await client.query("begin");
      try {
        for (const message of posts) await remember(client, channelId, message.ts, null);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      console.log(`[${firm.id}][lead-channel] Marked ${posts.length} existing posts as seen`);
      return;
    }
    const known = new Set(seen.rows.map((row) => row.message_ts));
    const fresh = posts.filter((message) => !known.has(message.ts)).slice(0, 20);
    if (!fresh.length) return;

    if (!firm.slackBotUserId) {
      const auth = await fetch("https://slack.com/api/auth.test", {
        headers: { Authorization: `Bearer ${firm.slackBotToken}` },
      }).then((response) => response.json()).catch(() => null);
      if (auth?.ok) {
        firm.slackBotUserId = auth.user_id || null;
        firm.slackBotId = auth.bot_id || null;
      }
    }

    for (const message of fresh) {
      if (message.user && message.user === firm.slackBotUserId) {
        await remember(client, channelId, message.ts, null);
        continue;
      }
      if (message.bot_id && message.bot_id === firm.slackBotId) {
        await remember(client, channelId, message.ts, null);
        continue;
      }
      const text = String(deps.messageText(message) || "").trim();
      if (!text) {
        await remember(client, channelId, message.ts, null);
        continue;
      }
      const phoneE164 = firstPhone(text, deps.leadPhoneE164);
      const found = await client.query(
        `select id, kind, case_detail, sequence, signed_case, case_id, lead_status
         from public.leads
         where (slack_channel_id = $1 and slack_message_ts = $2)
            or ($3::text is not null and phone_e164 = $3
                and signed_case = false and case_id is null
                and lead_status not in ('Lost', 'Referred', 'Promoted', 'Signed'))
         order by case when slack_message_ts = $2 then 0 else 1 end, created_at desc
         limit 1`,
        [channelId, message.ts, phoneE164],
      );
      const existing = found.rows[0];
      const closed = existing && (
        existing.signed_case
        || existing.case_id
        || ["Lost", "Referred", "Promoted", "Signed"].includes(existing.lead_status)
        || existing.sequence === "stop"
      );
      const caseDetail = appendDetail(existing?.case_detail, text);
      let sequence = existing?.sequence || null;
      if (!closed) {
        try {
          sequence = await decideSequence(firm, caseDetail, deps);
        } catch (error) {
          console.error(`[${firm.id}][lead-channel] Sequence decision failed:`, error.message);
          sequence = sequence || "want_to_sign";
        }
      }
      const kind = kindFor(sequence, existing?.kind);

      if (existing) {
        await client.query(
          `update public.leads set
             case_detail = $2,
             sequence = case when $3::boolean then sequence else $4 end,
             kind = case when $3::boolean then kind else $5 end,
             email = coalesce(email, $6),
             phone_e164 = coalesce(phone_e164, $7),
             slack_channel_id = coalesce(slack_channel_id, $8),
             slack_message_ts = coalesce(slack_message_ts, $9)
           where id = $1`,
          [
            existing.id, caseDetail, Boolean(closed), sequence, kind,
            firstEmail(text), phoneE164, channelId, message.ts,
          ],
        );
        await remember(client, channelId, message.ts, existing.id);
        console.log(`[${firm.id}][lead-channel] Updated lead ${existing.id} sequence=${sequence || "unchanged"}`);
        continue;
      }

      if (!phoneE164) {
        await remember(client, channelId, message.ts, null);
        continue;
      }
      const inserted = await client.query(
        `insert into public.leads (
           lead_date, phone_e164, email, source_channel, lead_status, kind, arrival,
           case_detail, sequence, follow_up, slack_channel_id, slack_message_ts
         ) values (
           current_date, $1, $2, 'Web form', 'New', $3, 'form',
           $4, $5, $6, $7, $8
         )
         returning id`,
        [
          phoneE164, firstEmail(text), kind, caseDetail, sequence,
         sequence !== "stop", channelId, message.ts,
        ],
      );
      const id = inserted.rows[0]?.id || null;
      await remember(client, channelId, message.ts, id);
      if (id) console.log(`[${firm.id}][lead-channel] Opened lead ${id} sequence=${sequence}`);
    }
  } catch (error) {
    console.error(`[${firm.id}][lead-channel] Could not read the channel:`, error.message);
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}
