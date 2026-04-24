#!/usr/bin/env node
/**
 * Re-run the same pipeline (Prospeo → BetterContact → SmartLead/HeyReach) for
 * messages where RB2B has no *usable* email (masked/empty) — without processing
 * leads that already have a real email in the alert.
 *
 * Defaults: 30d lookback (set ENRICHMENT_BACKFILL_LOOKBACK_SECONDS to override).
 * Set ENRICHMENT_BACKFILL_LOG_NOTION=1 to also write Notion for still-miss leads.
 *
 * Usage (locally with env or via Railway run):
 *   ENRICHMENT_BACKFILL=1 node backfill.js
 *   npx @railway/cli run -s worker-v2-template -- node backfill.js
 */
process.env.ENRICHMENT_BACKFILL = '1';
require('./index.js');
