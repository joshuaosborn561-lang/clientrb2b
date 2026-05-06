## `worker-v2/` (Prospeo → BetterContact → SmartLead + HeyReach)

Polls each **active** client’s RB2B Slack channel (multi-tenant when `UI_PUBLIC_URL` + `WORKER_CONFIG_SECRET` are set), then:

- treats masked RB2B emails as missing; enriches via **Prospeo**, then **BetterContact** when configured
- **SmartLead** when a usable email exists
- **HeyReach** when a LinkedIn URL exists
- posts enrollment summary to that client’s Slack channel
- optional touchpoint ingest for visit → first engagement webhooks

### One-off backfill (single client, custom lookback)

Example: last 14 days for one client UUID (still uses UI config API):

```bash
LOOKBACK_SECONDS=1209600 WORKER_ONLY_CLIENT_ID=<client-uuid> node index.js
```

List client IDs: `GET /api/worker/clients` with `Authorization: Bearer $WORKER_CONFIG_SECRET`.

### Multi-tenant (recommended)

**Worker service**

- `UI_PUBLIC_URL` — public UI base URL
- `WORKER_CONFIG_SECRET` — same bearer secret as the UI service

**UI service** (shared defaults merged into every client’s worker config)

- `DEFAULT_SLACK_BOT_TOKEN` — `xoxb-…` with `conversations:history` (and channel access) for RB2B channels
- `DEFAULT_PROSPEO_API_KEY`
- `DEFAULT_BETTERCONTACT_API_KEY`

**Per client** (in the UI DB): Slack channel ID, SmartLead + HeyReach API keys and campaign IDs only.

Legacy single-tenant still works if `UI_PUBLIC_URL` / `WORKER_CONFIG_SECRET` are unset: use `SLACK_TOKEN`, `CHANNEL_ID`, and provider keys as env vars on the worker.

### Touchpoint / timing (optional)

- `UI_TOUCHPOINT_INGEST_URL` — e.g. `https://your-ui.example.com/api/touchpoints/report`
- `UI_TOUCHPOINT_INGEST_SECRET` — same on UI + worker

### Railway cron

Command: `node index.js` (see `railway.toml`).
