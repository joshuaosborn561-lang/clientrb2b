## `worker-v2/` (LeadMagic → SmartLead + HeyReach)

This is a **new** worker that does **not** modify the legacy worker in the repo root.

It polls a Slack channel where RB2B posts identified visitor alerts, then:

- enriches missing **work email** via LeadMagic `POST /v1/people/email-finder`
- if an email is available, adds the lead to **SmartLead**
- if a LinkedIn URL exists, adds the lead to **HeyReach** (independent of email)

### Required env vars

- `SLACK_TOKEN`
- `CHANNEL_ID`
- `LEADMAGIC_API_KEY`

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
