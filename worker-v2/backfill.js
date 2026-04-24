#!/usr/bin/env node
/**
 * Re-run the same pipeline (Prospeo → BetterContact → SmartLead/HeyReach) for
 * messages where RB2B has no *usable* email (masked/empty) — without processing
 * leads that already have a real email in the alert.
 *
 * Defaults: 30d lookback (set ENRICHMENT_BACKFILL_LOOKBACK_SECONDS to override).
 * Set ENRICHMENT_BACKFILL_LOG_NOTION=1 to also write Notion for still-miss leads.
 *
 * Usage (locally with env or via Railway run from repo root):
 *   ENRICHMENT_BACKFILL=1 node backfill.js
 *   npx @railway/cli run -s <worker-service> -- node worker-v2/backfill.js
 * (If you run `node backfill.js` with no path, Railway uses the repo root and runs the *legacy* backfill.)
 */
process.env.ENRICHMENT_BACKFILL = '1';
require('./index.js');
