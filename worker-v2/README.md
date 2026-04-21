## `worker-v2/` (Prospeo → SmartLead + HeyReach)

This is a **new** worker that does **not** modify the legacy worker in the repo root.

It polls a Slack channel where RB2B posts identified visitor alerts, then:

- enriches missing **work email** via Prospeo `POST https://api.prospeo.io/enrich-person` (when `PROSPEO_API_KEY` is set)
- if an email is available, adds the lead to **SmartLead**
- if a LinkedIn URL exists, adds the lead to **HeyReach** (independent of email)
- posts an **enrollment summary** to the same Slack channel (`chat.postMessage`)
- reports enrollments to the **UI** so webhooks can tie SmartLead/HeyReach events back to visit time

### Required env vars

- `SLACK_TOKEN` — bot token with `conversations:history` (read RB2B channel)
- `CHANNEL_ID` — that client’s RB2B Slack channel ID
- `PROSPEO_API_KEY` (optional; Prospeo `X-KEY` header — omit if RB2B always includes email)

### Touchpoint / timing (optional but recommended)

- `UI_TOUCHPOINT_INGEST_URL` — e.g. `https://your-ui.example.com/api/touchpoints/report`
- `UI_TOUCHPOINT_INGEST_SECRET` — same value on UI + worker

### SmartLead (email)

- `SMARTLEAD_API_KEY`
- `SMARTLEAD_CAMPAIGN_ID`

### HeyReach (LinkedIn)

- `HEYREACH_API_KEY`
- `HEYREACH_CAMPAIGN_ID`

### Railway cron

Create a Railway service pointing at `worker-v2/` and set a cron schedule + command:

- command: `node index.js`

If you already have a legacy Railway cron using the repo root, **leave it alone** and create a new service for each new client.
