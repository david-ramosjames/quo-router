# Deployment Notes for Short Call SMS Fix

## Changes Summary

This fix addresses the issue where ANY call event was stopping the SMS follow-up flow, even very short calls (e.g., under 60 seconds where staff left a voicemail). 

### New Behavior

**Calls under 2 minutes:**
- SMS follow-up flow CONTINUES by default
- Slack notification in #lead-calls includes a "Stop texts" button for manual control
- The `sequence` field remains "want_to_sign" (which allows texts) instead of changing to "needs_info"

**Calls 2 minutes or longer:**
- SMS follow-up flow STOPS automatically (existing behavior)
- The `sequence` field changes to "needs_info" (calls only, no texts)
- This is the correct behavior for longer conversations

## Configuration Required

### 1. Call Duration Threshold

The threshold is set via the `SHORT_CALL_THRESHOLD_SECONDS` constant in `server.js`:

```javascript
const SHORT_CALL_THRESHOLD_SECONDS = 120; // 2 minutes
```

To change the threshold:
1. Edit `server.js`
2. Modify the constant value (in seconds)
3. Redeploy the service

### 2. Slack Interactive Components

The "Stop texts" button requires Slack to send button click events to this service.

**Setup Steps:**

1. Go to your Slack App settings: https://api.slack.com/apps
2. Select your Quo Router app
3. Navigate to **"Interactivity & Shortcuts"**
4. Enable **"Interactivity"**
5. Set the **Request URL** to:
   ```
   https://your-quo-router-domain.com/slack/interactions
   ```
6. Click **"Save Changes"**

### 3. Verify Slack Bot Token

The bot token must have these scopes (should already be configured):
- `chat:write` - to post messages
- `chat:write.public` - to post to public channels

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

### Sequence Preservation Logic

For existing leads:

```javascript
// Short call (<2 min) + would change to "needs_info" + currently "want_to_sign"
if (isShortCall && proposedSequence === "needs_info" && existing.sequence === "want_to_sign") {
  sequence = "want_to_sign"; // Keep texts active
}
```

### Slack Button Action

When someone clicks "Stop texts":

1. Slack sends a POST to `/slack/interactions`
2. Router updates the lead:
   ```sql
   UPDATE leads 
   SET sequence = 'needs_info',
       follow_up = false,
       text_sequence_status = 'stopped'
   WHERE phone_e164 = $1
   ```
3. Slack message updates to show "✅ SMS follow-up stopped"
4. follow-up-text service (separate repo) will see the stopped status and not send more texts

## Testing

### Test a Short Call

1. Make a test call to your Quo number
2. Answer and hang up within 2 minutes (e.g., 45 seconds)
3. Wait for the `/call-summary` webhook
4. Check #lead-calls in Slack:
   - Should show duration: `(45s)`
   - Should have a red "Stop texts" button
5. Check console logs:
   ```
   [firmId][lead] Short call (45s < 120s) — preserving sequence=want_to_sign to keep SMS follow-up active
   ```
6. In intake-manager, the lead should show:
   - TEXTS: On (or "active")
   - SEQUENCE: want_to_sign

### Test a Long Call

1. Make a test call
2. Answer and stay on the line for 2+ minutes
3. Hang up and wait for webhook
4. Check #lead-calls: no "Stop texts" button (normal behavior)
5. Check intake-manager:
   - TEXTS: Off (stopped)
   - SEQUENCE: needs_info

### Test the Stop Button

1. After a short call appears in #lead-calls
2. Click the "Stop texts" button
3. Button should change to "✅ SMS follow-up stopped"
4. Check intake-manager: TEXTS should now be Off
5. Check console logs:
   ```
   [firmId][slack-interaction] Stopped SMS follow-up for +15127643037 (callId: AC123...)
   ```

## Troubleshooting

### Button doesn't work

- Check that the Slack Request URL is set correctly
- Verify the Request URL returns 200 OK (test with Slack's "Verify" button)
- Check console logs for `[slack-interaction]` errors

### Duration is always null

- Check Quo webhook payload includes `duration` or `billableSeconds`
- Verify Quo API key is valid: `QUO_API_KEY` or `FIRM_<ID>_QUO_API_KEY`
- Check console logs for `[call-check]` errors

### Texts still stop on short calls

- Verify the lead existed and had `sequence = "want_to_sign"` before the call
- Check console logs for the preservation message
- Verify `SHORT_CALL_THRESHOLD_SECONDS` is set correctly

### Texts don't stop on long calls

- Check that the call duration is actually >= 120 seconds
- Verify `nextSequence()` is returning "needs_info" for non-qualified calls
- Check the `isQualified` flag in call processing

## Database Impact

The fix updates the `public.leads` table when a call is processed:

- **Short calls:** `sequence` remains unchanged (typically "want_to_sign")
- **Long calls:** `sequence` changes to "needs_info" (existing behavior)
- **Button click:** Sets `sequence = 'needs_info'`, `follow_up = false`, `text_sequence_status = 'stopped'`

Events are logged to `public.lead_events`:
```json
{
  "event_type": "sequence_changed",
  "actor": "slack-button",
  "payload": {
    "sequence": "needs_info",
    "reason": "Short call SMS stopped via Slack button",
    "call_id": "AC123..."
  }
}
```

## Related Services

This fix only addresses quo-router. The follow-up-text service (separate repo) reads:
- `leads.sequence` - if "needs_info" or "stop", don't send texts
- `leads.follow_up` - if false, don't send texts
- `leads.text_sequence_status` - if "stopped", don't send texts

A parallel fix is being implemented in follow-up-text for the same issue.
