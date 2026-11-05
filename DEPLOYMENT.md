# Deployment Notes for Short Call SMS Fix

> **Also see:** [PHONE_STAFF_SETUP.md](./PHONE_STAFF_SETUP.md) for Quo → Slack “On a call” status, missed/Sona availability tagging, and daily-report counts.

## Changes Summary

This fix addresses the issue where quo-router was stopping the SMS follow-up flow for short outbound calls by changing the lead's `sequence` to "needs_info" (calls only, no texts).

### Problem

**Example:** Rachel Kay Schuyler had an automated text sent at 11:35 AM. At 1:11 PM, staff made an outbound call lasting under 60 seconds (left voicemail). After that call, quo-router changed the lead's sequence to "needs_info", which stopped the SMS follow-up flow (`TEXTS: Off` in intake-manager).

This was happening regardless of call duration — even a 30-second voicemail drop was treated as a "conversation complete" event that stopped texts.

### Solution

**Rule:** Quo-router will NOT change a lead's sequence to a no-texts sequence ("needs_info" or "stop") because of an outbound call under 2 minutes. The lead's existing text-active sequence is preserved.

**Division of Responsibility:**

- **quo-router** (this repo): Routes webhooks, updates database fields (`sequence`, `follow_up`, `text_sequence_status`), posts to Slack channels. For calls under 2 minutes, preserves ANY text-active sequence (anything except "needs_info" or "stop").

- **follow-up-text** (separate repo): Reads database fields to decide whether to send texts. For outbound calls under 120 seconds (LONG_OUTBOUND_SECONDS), keeps the series running and posts its own Slack review card with 'Keep texting' and 'Stop follow-ups' buttons. Handles the "stop texts" decision for short calls.

**Important:** quo-router does NOT post its own "Stop texts" buttons or handle button clicks. The follow-up-text service already owns that workflow for short outbound calls.

### New Behavior

**Calls under 2 minutes:**
- quo-router preserves the existing sequence (doesn't change to "needs_info")
- Database: `sequence` stays as-is (e.g., "want_to_sign", "referral", etc.)
- follow-up-text continues the SMS flow and posts its own review card with stop buttons

**Calls 2 minutes or longer:**
- quo-router changes sequence to "needs_info" (existing behavior)
- Database: `sequence = 'needs_info'` (calls only, no texts)
- follow-up-text reads this and stops sending texts

### Sequences Explained

| Sequence | Texts? | Description |
|----------|--------|-------------|
| `want_to_sign` | ✅ Yes | Pursuit - wants to sign |
| `referral` | ✅ Yes | Referral case |
| `needs_info` | ❌ No | Calls only - already spoke |
| `stop` | ❌ No | Stopped - closed/lost |
| `null` (new lead) | ✅ Yes | Defaults to "want_to_sign" |

Short calls preserve ANY text-active sequence (everything except "needs_info" and "stop").

## Configuration Required

### 1. Adjust Threshold (Optional)

The threshold is set via the `SHORT_CALL_THRESHOLD_SECONDS` constant in `server.js`:

```javascript
const SHORT_CALL_THRESHOLD_SECONDS = 120; // 2 minutes
```

To change the threshold:
1. Edit `server.js`
2. Modify the constant value (in seconds)
3. Redeploy the service

**Note:** This should match follow-up-text's `LONG_OUTBOUND_SECONDS` threshold (currently 120 seconds) to keep behavior consistent.

### 2. No Slack Configuration Needed

Unlike the original implementation, this fix does NOT require:
- ❌ Slack Interactivity configuration
- ❌ Request URL setup
- ❌ Signing secret
- ❌ Additional endpoints

The follow-up-text service handles Slack buttons for short call reviews.

## How It Works

### Call Duration Detection

1. When a `/call-summary` webhook arrives from Quo, the router extracts:
   - `obj.duration` (primary source)
   - `obj.billableSeconds` (fallback)
   - If not in webhook, fetch from Quo API: `GET /v1/calls/{callId}`

2. Duration is logged in console output:
   ```
   [firmId][call-summary] Cache miss for AC123... — recovered from/to via Quo API (duration: 45s)
   ```

3. Duration is shown in the Slack notification:
   ```
   🔥 *Qualified Lead Call*
   Handled By: Jackie
   From: (512) 764-3037
   To: +15127643037 (45s)
   Summary: ...
   ```

### Sequence Preservation Logic

```javascript
// Determine if this is a short call
const isShortCall = callDurationSeconds != null && callDurationSeconds < 120;

// What sequence would normally be set?
const proposedSequence = nextSequence({ text, isQualified, existing });

// Does the existing sequence allow texts?
const existingAllowsTexts = 
  existing?.sequence !== "needs_info" && 
  existing?.sequence !== "stop";

// For short calls, preserve text-active sequences
if (isShortCall && proposedSequence === "needs_info" && existingAllowsTexts) {
  sequence = existing?.sequence || "want_to_sign";
  console.log(`Short call (45s < 120s) — preserving sequence=${sequence} to keep SMS follow-up active`);
} else {
  sequence = proposedSequence;
}
```

### Database Updates

quo-router updates these fields in `public.leads`:

- **`sequence`**: Preserved for short calls (e.g., "want_to_sign"), changed to "needs_info" for long calls
- **`follow_up`**: Only changed when `closeNow = true` (not affected by this fix)
- **`text_sequence_status`**: Only changed when `closeNow = true` (not affected by this fix)

follow-up-text reads these fields to decide whether to send texts.

### What quo-router Does NOT Do

- ❌ Does NOT call follow-up-text's `/intake/stop` endpoint
- ❌ Does NOT post "Stop texts" buttons (follow-up-text posts its own review cards)
- ❌ Does NOT handle Slack button interactions
- ❌ Does NOT directly control follow-up-text's behavior

quo-router only affects text flow by setting database fields that follow-up-text reads.

## Testing

### Test a Short Call (Under 2 Minutes)

1. Make a test outbound call to a lead
2. Answer and hang up within 2 minutes (e.g., 45 seconds)
3. Wait for the `/call-summary` webhook
4. Check #lead-calls in Slack:
   - Should show duration: `(45s)`
   - Normal notification (no quo-router button)
5. Check console logs:
   ```
   [firmId][lead] Short call (45s < 120s) — preserving sequence=want_to_sign to keep SMS follow-up active
   ```
6. Check database:
   ```sql
   SELECT sequence, follow_up, text_sequence_status 
   FROM leads WHERE phone_e164 = '+15127643037';
   -- sequence should be "want_to_sign" (or whatever it was before)
   -- follow_up should be true
   ```
7. follow-up-text should post its own review card with 'Keep texting' / 'Stop follow-ups' buttons
8. In intake-manager, the lead should show:
   - TEXTS: On (or "active")
   - SEQUENCE: want_to_sign (or whatever text-active sequence it had)

### Test a Long Call (2+ Minutes)

1. Make a test outbound call
2. Answer and stay on the line for 2+ minutes
3. Hang up and wait for webhook
4. Check #lead-calls: shows duration `(135s)` (normal behavior)
5. Check console logs: no preservation message
6. Check database:
   ```sql
   SELECT sequence FROM leads WHERE phone_e164 = '+15127643037';
   -- sequence should be "needs_info"
   ```
7. In intake-manager:
   - TEXTS: Off (stopped)
   - SEQUENCE: needs_info

### Test Sequence Preservation Coverage

Create leads with different starting sequences and verify short calls preserve them:

| Starting Sequence | After Short Call | Expected |
|-------------------|------------------|----------|
| `want_to_sign` | `want_to_sign` | ✅ Preserved |
| `referral` | `referral` | ✅ Preserved |
| `needs_info` | `needs_info` | ℹ️ Already no-texts, stays no-texts |
| `stop` | `stop` | ℹ️ Already stopped, stays stopped |
| `null` (new) | `want_to_sign` | ✅ Defaulted to text-active |

### Test Inbound Calls

Inbound calls are NOT affected by this fix (inbound calls already had different logic). Verify they continue working as before:

1. Make an inbound test call (lead calls the firm)
2. Answer and hang up within 2 minutes
3. Behavior should be unchanged from before this fix

## Troubleshooting

### Duration is always null

- Check Quo webhook payload includes `duration` or `billableSeconds`
- Verify Quo API key is valid: `QUO_API_KEY` or `FIRM_<ID>_QUO_API_KEY`
- Check console logs for `[call-check]` errors

### Texts still stop on short outbound calls

- Verify the lead had a text-active sequence before the call (`want_to_sign`, `referral`, etc.)
- Check console logs for the preservation message
- Verify `SHORT_CALL_THRESHOLD_SECONDS = 120` (matches follow-up-text)
- Check if the call was actually under 2 minutes in the logs

### Texts don't stop on long outbound calls

- Check that the call duration is actually >= 120 seconds in logs
- Verify `nextSequence()` is returning "needs_info" for non-qualified calls
- Check the `isQualified` flag in call processing

### Short call SMS flow continues but no follow-up-text review card

- This is a follow-up-text issue, not quo-router
- Check follow-up-text logs and configuration
- Verify follow-up-text's `LONG_OUTBOUND_SECONDS` threshold matches quo-router's

## Related Services

### quo-router (this repo)

**Role:** Routes Quo webhooks → database updates → Slack notifications

**Controls text flow via:**
- Database field: `leads.sequence`
  - For short calls: preserves text-active sequences
  - For long calls: changes to "needs_info"
- Database field: `leads.follow_up` (only when closing leads)
- Database field: `leads.text_sequence_status` (only when closing leads)

**Does NOT:**
- Call follow-up-text APIs
- Post "Stop texts" buttons
- Handle button clicks

### follow-up-text (separate repo)

**Role:** Reads database → sends automated texts → posts Slack review cards

**Controls text flow via:**
- Reads `leads.sequence` - stops if "needs_info" or "stop"
- Reads `leads.follow_up` - stops if false
- Reads `leads.text_sequence_status` - stops if "stopped"
- For short outbound calls (<120s): keeps series running, posts review card with stop buttons
- Handles button clicks: updates database when user clicks 'Stop follow-ups'

**Parallel fix:** follow-up-text PR #1 fixes the same issue in its own codebase (was stopping on any call event, now preserves flow for calls <120s).

## Migration Notes

No data migration needed. The fix preserves existing behavior for long calls and only changes behavior for short calls (now they keep texts active instead of stopping them).

Existing leads are not affected — the fix applies only to new call events processed after deployment.
