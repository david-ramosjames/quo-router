# Phone Staff → Slack Status Setup

This wires Quo call state into Slack so phone staff automatically show **On a call**, and missed/Sona notices tag who was available but did not answer.

## What you get

1. **Slack status auto-update** — when a configured phone-staff member answers a Quo call, their Slack status becomes `:phone: On a call`. When the call ends, the previous status is restored.
2. **Missed / Sona accountability** — missed-call and Sona Slack posts append who was available at that moment (Slack-active and not already on a call), and @-mention those people.
3. **Daily report count** — each event is stored so `quo-lead-review` can report how many times phone staff were available but did not answer in the report window.

Only the people you list under **Phone Staff** are tracked. Attorneys and others are ignored.

---

## Step-by-step Slack setup (admin does this once)

### 1. Confirm the workspace is on a paid Slack plan

Admin profile updates for other users require Pro / Business+ / Enterprise Grid. Free workspaces cannot set other users' status via API.

### 2. Open (or create) the Slack app used by quo-router

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → select the Quo Router app (or create one).
2. You already use this app's **Bot Token** (`xoxb-`) for posting and reading presence.

### 3. Add User Token scopes (for setting status on others)

1. In the app → **OAuth & Permissions**.
2. Under **User Token Scopes**, add:
   - `users.profile:write` — set status text/emoji for other users (admin only)
   - `users.profile:read` — read current status so we can restore it after the call
3. Under **Bot Token Scopes**, confirm you already have (add if missing):
   - `users:read` — required for `users.getPresence` (active vs away)
   - `chat:write` — posting messages (already used)

### 4. Install / reinstall the app as a Workspace Owner or Admin

1. Click **Install to Workspace** (or **Reinstall** after scope changes).
2. Approve as a user who is a **Workspace Owner or Admin**.
3. Copy the **User OAuth Token** (`xoxp-…`) — this is different from the Bot Token.

Role rule: the authorizing admin must outrank (or equal, for some fields) the people whose status will be changed. A Workspace Admin can update Members; updating another Admin usually needs an Owner token.

### 5. Allow API as a profile data source (Slack Admin)

1. Slack Admin → **Settings & permissions** → **Configure profiles** (wording varies by plan).
2. Ensure custom status can be set via **API** / integrations (not locked to SCIM-only).

### 6. Put the user token on the router

Set one of:

```bash
# Preferred (per firm)
FIRM_RAMOSJAMES_SLACK_USER_TOKEN=xoxp-...

# Or legacy default firm
SLACK_USER_TOKEN=xoxp-...
```

Or paste it in the admin UI → firm → Credentials → **Slack User Token**.

Keep the existing **Slack Bot Token** (`xoxb-`). Both are required:
- User token → set/clear "On a call"
- Bot token → presence checks + posting

### 7. Map phone staff (Quo user → Slack user)

For each person whose **main job is answering the phone**:

1. **Slack user ID** — in Slack, click their profile → ⋮ → Copy member ID (`U…`).
2. **Quo user ID** — Quo → Workspace settings → Users, or from the Quo API `GET /v1/users` (`US…` / `U…` style id Quo returns).

In the router admin UI → firm → **Phone Staff**:

```
timezone=America/Chicago
Andrea=U0AAAAAA=USyyyyyyyyy | Mon-Fri 08:00-17:00
Jackie=U026P9FUKHC=USxxxxxxxxx | after-hours
```

Format: `Name=SLACK_USER_ID=QUO_USER_ID | Mon-Fri 08:00-17:00` (one per line).

Hours are per person, in the timezone on the first line (default `America/Chicago`). Someone is not tagged outside their own hours. The person marked `after-hours` is tagged only when no scheduled shift covers the call.

Or in `firms.json`:

```json
"phoneStaff": [
  { "name": "Jackie", "slackUserId": "U026P9FUKHC", "quoUserId": "USxxxxxxxxx" }
]
```

Without `quoUserId`, that person still gets tagged on missed/Sona (via Slack presence), but their Slack status will **not** auto-update when they answer.

### 8. Enable report counts (for quo-lead-review)

1. Ensure `DATABASE_URL` is set on quo-router (events are stored in Postgres).
2. Set a shared secret:

```bash
FIRM_RAMOSJAMES_REPORT_API_TOKEN=long-random-string
# or global
REPORT_API_TOKEN=long-random-string
```

3. On **quo-lead-review**, set:

```bash
QUO_ROUTER_URL=https://your-quo-router.example.com
QUO_ROUTER_FIRM_ID=ramosjames
QUO_ROUTER_REPORT_TOKEN=long-random-string
```

4. Apply the companion patch (this agent could not push to that repo):

```bash
cd quo-lead-review
git apply /path/to/quo-router/patches/quo-lead-review-availability-misses.patch
# or: git am /path/to/quo-router/patches/quo-lead-review-availability-misses.patch
```

The Daily Call Report will then include **Available but did not answer** totals for that day (deterministic section + email metric tile).

### 9. Redeploy and smoke-test

1. Redeploy quo-router.
2. Have a listed phone-staff member answer a test call → their Slack status should show **On a call** within a few seconds.
3. End the call → status should clear / restore.
4. Miss a test call during a listed person's scheduled hours. The staff list is added only on **#lead-calls** and **#legalassistant-phone**. Each person who should be tagged is on their own line with a check mark. #missed-calls and #sona-calls stay as the plain call notice. A call under 5 seconds says **Caller hung up, please call back**. People marked `rings after 10s` stay on **Please call back** until the call has rung that long. Someone on a break or on a call is shown by name and status, with no @. The after-hours person is left off during the day.
5. Check router logs for `[phone-staff]` lines.

---

## How availability is decided

For each configured phone-staff member at the moment of a missed or Sona call:

| State | Tagged? |
|-------|---------|
| ✅ active, on shift, no blocking status, not on a call | Yes |
| 💤 inactive/offline during their shift, no status set | Yes |
| 🌙 after-hours person, and nobody's shift covers this moment | Yes |
| 📞 on a call | No |
| 🚫 Slack status such as lunch, break, meeting, PTO, out of office | No |
| ⏸️ outside their scheduled hours | No |

Until at least one person has hours (or is marked after-hours), inactive people are not tagged — only Slack-active staff, same as the first version. After hours are saved, working-hour staff are never tagged off shift.

---

## Report API

```
GET /api/reports/:firmId/availability-misses?createdAfter=ISO&createdBefore=ISO
Authorization: Bearer <REPORT_API_TOKEN>
```

Example response fields:

- `eventCount` — missed/Sona/menu-hangup events in range
- `eventsWithAvailableStaff` — events where ≥1 phone staff was available
- `availableButDidNotAnswerCount` — sum of available people across those events (a person available on 3 missed calls counts as 3)
- `byUser` — per-person breakdown

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Status never changes | `SLACK_USER_TOKEN` set? Paid plan? Authorizing user still Admin/Owner? `users.profile:write` on the **user** token? `quoUserId` mapped? |
| `not_allowed_token_type` | You used a bot token (`xoxb-`) for profile set — need `xoxp-` |
| `missing_scope` | Reinstall app after adding user scopes |
| `cannot_update_admin_user` | Target is an Admin; authorize with a Workspace Owner |
| Presence always unknown | Bot needs `users:read`; bot must be in a workspace where those users exist |
| Report count always 0 | `DATABASE_URL` set? `phoneStaff` configured? Events only start after deploy |
| Wrong people tagged | Trim `phoneStaff` to answer-responsible roles only |
