## `worker-v2/` (LeadMagic → ManyChat SMS / SmartLead)

This is a **new** worker that does **not** modify the legacy worker in the repo root.

It polls a Slack channel where RB2B posts identified visitor alerts, then:

- enriches missing **work email** via LeadMagic `POST /v1/people/email-finder`
- enriches **mobile** via LeadMagic `POST /v1/people/mobile-finder`
- if a mobile is found, it triggers a **ManyChat SMS automation** (via `createSubscriber` + `sendFlow`)
- otherwise, if an email is available, it adds the lead to **SmartLead**
- if a LinkedIn URL exists, it optionally adds to **HeyReach** (independent of SMS/email routing)

### Required env vars

- `SLACK_TOKEN`
- `CHANNEL_ID`
- `LEADMAGIC_API_KEY`

### ManyChat SMS env vars (required for SMS path)

- `MANYCHAT_API_TOKEN`
- `MANYCHAT_FLOW_NS`
- `MANYCHAT_SMS_CONSENT_PHRASE` (optional)
- `MANYCHAT_HAS_OPT_IN_SMS` (defaults to `true`)
- `MANYCHAT_HAS_OPT_IN_EMAIL` (defaults to `false`)

### SmartLead env vars (required for email fallback path)

- `SMARTLEAD_API_KEY`
- `SMARTLEAD_CAMPAIGN_ID`

### HeyReach env vars (optional)

- `HEYREACH_API_KEY`
- `HEYREACH_CAMPAIGN_ID`

### Railway cron

Create a Railway service pointing at `worker-v2/` and set a cron schedule + command:

- command: `node index.js`

If you already have a legacy Railway cron using the repo root, **leave it alone** and create a new service for each new client.

