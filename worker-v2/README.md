## `worker-v2/` (Prospeo → BetterContact → SmartLead + HeyReach)

Polls each **active** client’s RB2B Slack channel (multi-tenant when `UI_PUBLIC_URL` + `WORKER_CONFIG_SECRET` are set), then:

- treats masked RB2B emails as missing; enriches via **Prospeo**, then **BetterContact** when configured
- **SmartLead** when a usable email exists
- **HeyReach** when a LinkedIn URL exists
- posts enrollment summary to that client’s Slack channel
- optional touchpoint ingest for visit → first engagement webhooks

### ICP filtering (off by default, per client)

ICP filtering is **opt-in per client** (`icp_filter_enabled` in the UI). It is **off by default**, so
every RB2B visitor is enrolled. Enable it only for clients who want to skip small companies /
excluded industries. A global `DISABLE_ICP_FILTER=1` always forces it off (used for backfills).

> A single hardcoded ICP filter applied to all clients is what silently dropped every Nieto lead in
> live runs while backfills (which disabled the filter) succeeded. Keep ICP off unless a client asks.

### Dedup / idempotency

Every fully-handled Slack message is recorded (`processed_messages` in the UI DB) so the cron can
re-scan a wide window cheaply: only messages never enrolled do enrichment/enroll work. This prevents
duplicate SmartLead submits, duplicate Slack posts, and long runs being killed mid-way. A message is
recorded only after it reaches a terminal state with **no fixable error** — anything that failed on a
bad campaign id, rate limit, or enrichment timeout is retried on the next run.

- `LOOKBACK_SECONDS` — defaults to 30 days (safe because of dedup).
- `FORCE_REPROCESS=1` — re-handle messages even if already recorded.

### One-off / catch-up backfill (single client)

Catch-up is automatic: once a client is **active** with valid SmartLead config, the next cron run
enrolls every not-yet-handled message inside `LOOKBACK_SECONDS`. To run it immediately for one client:

```bash
LOOKBACK_SECONDS=2592000 WORKER_ONLY_CLIENT_ID=<client-uuid> node index.js
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
