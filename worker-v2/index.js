const logger = require('./logger');
const { parseRB2BMessage } = require('./parser');
const { findWorkEmail } = require('./prospeo');
const { addToHeyReach } = require('./heyreach');
const { addToSmartLead } = require('./smartlead');
const { postSlackMessage } = require('./slack');
const { parseRb2bVisitAt } = require('./visitTime');
const { reportTouchpoint } = require('./ingest');
const { listActiveClients, fetchClientConfig, fetchProcessedSet, markProcessed } = require('./uiClient');
const { fetchAllSlackMessages } = require('./slackFetch');
const { isUsableWorkEmail } = require('./emailUtils');
const { findWorkEmailBetterContact } = require('./bettercontact');

// Default lookback is wide (30 days) on purpose: dedup means re-scanning a wide window is cheap
// (only messages we have never fully handled do enrichment/enroll work), and it makes catch-up automatic.
const LOOKBACK_SECONDS = Number(process.env.LOOKBACK_SECONDS || 30 * 24 * 60 * 60);
/** When set (UUID), multi-tenant mode processes only this client (e.g. backfill one workspace). Still uses /api/worker-config/:id. */
const WORKER_ONLY_CLIENT_ID = String(process.env.WORKER_ONLY_CLIENT_ID || process.env.BACKFILL_CLIENT_ID || '').trim();
/** Global override to never apply ICP filtering (e.g. backfills). Per-client opt-in is the normal control. */
const ICP_DISABLED = /^(1|true|yes)$/i.test(String(process.env.DISABLE_ICP_FILTER || '').trim());
/** Re-handle messages even if already marked processed (force a clean re-run). */
const FORCE_REPROCESS = /^(1|true|yes)$/i.test(String(process.env.FORCE_REPROCESS || '').trim());

// --- ICP filtering (copied defaults from legacy worker) ---
const EXCLUDED_EMPLOYEE_RANGES = ['1-10', '11-50'];
const EXCLUDED_INDUSTRIES = [
  'food', 'restaurant', 'restaurants', 'dining', 'bakery', 'catering',
  'retail', 'grocery', 'apparel', 'fashion',
  'healthcare', 'hospital', 'medical', 'nursing', 'dental',
  'farming', 'agriculture',
];

function passesICP(lead, cfg) {
  // ICP filtering is opt-in per client. Off by default so every RB2B visitor is enrolled.
  // A global DISABLE_ICP_FILTER always wins (used for backfills).
  if (ICP_DISABLED) return { pass: true, reason: null };
  if (!cfg || cfg.icp_filter_enabled !== true) return { pass: true, reason: null };
  if (EXCLUDED_EMPLOYEE_RANGES.includes(lead.employees)) {
    return { pass: false, reason: 'Employee range too small: ' + lead.employees };
  }
  if (lead.industry) {
    const lower = lead.industry.toLowerCase();
    for (const keyword of EXCLUDED_INDUSTRIES) {
      if (lower.includes(keyword)) {
        return { pass: false, reason: 'Excluded industry: ' + lead.industry };
      }
    }
  }
  return { pass: true, reason: null };
}

function slackTsToDate(ts) {
  if (ts == null || ts === '') return null;
  const parts = String(ts).split('.');
  const sec = parseInt(parts[0], 10);
  if (Number.isNaN(sec)) return null;
  const micro = parts[1] ? parseInt(String(parts[1]).padEnd(6, '0').slice(0, 6), 10) : 0;
  return new Date(sec * 1000 + micro / 1000);
}

function formatDurationMs(ms) {
  if (ms == null || Number.isNaN(ms)) return null;
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h % 24 > 0) parts.push((h % 24) + 'h');
  if (m % 60 > 0 && d === 0) parts.push((m % 60) + 'm');
  if (parts.length === 0) parts.push(Math.max(1, sec) + 's');
  return parts.join(' ');
}

function normalizeEmailKey(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeLinkedinKey(url) {
  if (!url) return '';
  let u = String(url).trim();
  u = u.replace(/^https?:\/\//i, '');
  u = u.replace(/^www\./i, '');
  u = u.replace(/\/$/, '');
  return u.toLowerCase();
}

function extractLead(msg) {
  let lead = parseRB2BMessage(msg.text);
  if (lead) return lead;

  if (msg.attachments && msg.attachments.length > 0) {
    for (const att of msg.attachments) {
      const t = att.text || att.fallback || '';
      if (t) {
        lead = parseRB2BMessage(t);
        if (lead) return lead;
      }
    }
  }

  if (msg.blocks && msg.blocks.length > 0) {
    for (const block of msg.blocks) {
      const bt = block.text ? block.text.text : '';
      if (bt) {
        lead = parseRB2BMessage(bt);
        if (lead) return lead;
      }
    }
  }

  return null;
}

function mergeWorkerConfig(cfg) {
  const slack_token =
    String(cfg.slack_token || '').trim() || String(process.env.DEFAULT_SLACK_BOT_TOKEN || process.env.SLACK_TOKEN || '').trim();
  const prospeo_api_key =
    String(cfg.prospeo_api_key || '').trim() || String(process.env.DEFAULT_PROSPEO_API_KEY || process.env.PROSPEO_API_KEY || '').trim();
  const bettercontact_api_key =
    String(cfg.bettercontact_api_key || '').trim() ||
    String(process.env.DEFAULT_BETTERCONTACT_API_KEY || process.env.BETTERCONTACT_API_KEY || '').trim();
  return { ...cfg, slack_token, prospeo_api_key, bettercontact_api_key };
}

function multiTenantEnabled() {
  const ui = String(process.env.UI_PUBLIC_URL || '').trim();
  const secret = String(process.env.WORKER_CONFIG_SECRET || '').trim();
  return !!(ui && secret);
}

async function runForClient(clientRow, cfg, dedup) {
  cfg = mergeWorkerConfig(cfg);
  const clientId = clientRow.id;
  const channelId = cfg.slack_channel_id;
  logger.info('Client run starting', {
    clientId,
    name: cfg.name,
    channel: channelId,
    icpFilter: ICP_DISABLED ? 'globally-off' : cfg.icp_filter_enabled === true ? 'on' : 'off',
    dedup: dedup ? 'on' : 'off',
  });

  if (!channelId) {
    logger.error('No Slack channel configured for client', { clientId, name: cfg.name });
    return { ok: false, error: 'missing_channel' };
  }

  const oldest = String(Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS);

  let messages;
  try {
    messages = await fetchAllSlackMessages({ slack_token: cfg.slack_token, slack_channel_id: channelId, oldest });
  } catch (err) {
    logger.error('Failed to fetch Slack messages', { clientId, error: err.message });
    return { ok: false, error: 'slack_fetch_failed' };
  }

  let processedSet = new Set();
  if (dedup && !FORCE_REPROCESS) {
    processedSet = await fetchProcessedSet(clientId, oldest);
  }

  if (messages.length === 0) {
    logger.info('No messages found', { clientId });
    return { ok: true, stats: { leadsFound: 0, routedHeyReach: 0, routedSmartLead: 0, skipped: 0, parseFailures: 0, deduped: 0 } };
  }

  let leadsFound = 0;
  let routedHeyReach = 0;
  let routedSmartLead = 0;
  let skipped = 0;
  let parseFailures = 0;
  let deduped = 0;

  for (const msg of messages) {
    const slackTs = msg.ts || null;

    if (slackTs && processedSet.has(String(slackTs))) {
      deduped++;
      continue;
    }

    try {
      const outcome = await processMessage(msg, clientId, channelId, cfg);
      if (!outcome) {
        parseFailures++;
        continue;
      }
      if (outcome.kind === 'icp_skip') {
        skipped++;
        continue;
      }
      leadsFound++;
      if (outcome.routedSmartLead) routedSmartLead++;
      if (outcome.routedHeyReach) routedHeyReach++;

      // Mark processed only once a message reaches a terminal state with no transient errors,
      // so anything that hit a fixable failure (bad campaign id, rate limit, timeout) is retried next run.
      if (dedup && slackTs && !outcome.transient) {
        await markProcessed(clientId, slackTs, outcome.leadKey || null, outcome.label || null);
      }
    } catch (err) {
      logger.error('Unexpected error handling message (will retry next run)', { clientId, ts: slackTs, error: err.message });
    }
  }

  logger.info('Client run complete', { clientId, leadsFound, routedHeyReach, routedSmartLead, skipped, parseFailures, deduped });
  return { ok: true, stats: { leadsFound, routedHeyReach, routedSmartLead, skipped, parseFailures, deduped } };
}

/**
 * Handle one Slack message end to end.
 * Returns null when it is not a parseable lead, otherwise an outcome describing what happened.
 * `transient` means a fixable failure occurred and the message should be retried later.
 */
async function processMessage(msg, clientId, channelId, cfg) {
  const lead = extractLead(msg);
  if (!lead) return null;

  const leadName = lead.firstName + ' ' + lead.lastName;

  const icpResult = passesICP(lead, cfg);
  if (!icpResult.pass) {
    logger.info('Lead skipped (ICP filter)', { clientId, lead: leadName, reason: icpResult.reason });
    return { kind: 'icp_skip' };
  }

  const slackTs = msg.ts || null;
  const slackSeenAt = slackTsToDate(slackTs);
  const visitParsed = parseRb2bVisitAt(lead.visitedAt);
  const visitInstant = visitParsed.at;

  let transient = false;

  const rb2bEmailRaw = String(lead.email || '').trim();
  let email = isUsableWorkEmail(rb2bEmailRaw) ? rb2bEmailRaw : null;
  if (!email) {
    try {
      const companyDomain = lead.companyWebsite ? lead.companyWebsite.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
      const forProspeo = { ...lead, email: null };
      email = await findWorkEmail({ ...forProspeo, companyDomain }, cfg);
    } catch (err) {
      logger.error('Prospeo email enrichment error', { clientId, error: err.message, lead: leadName });
      transient = true;
    }
  }
  if (!email) {
    try {
      const bc = await findWorkEmailBetterContact(lead, cfg);
      if (bc && isUsableWorkEmail(bc)) email = bc;
    } catch (err) {
      logger.error('BetterContact error', { clientId, error: err.message, lead: leadName });
      transient = true;
    }
  }

  const emailKey = email ? normalizeEmailKey(email) : '';
  const linkedinKey = normalizeLinkedinKey(lead.linkedinUrl);

  const enrolledAt = new Date();
  let smartResult = { ok: false };
  let heyResult = { ok: false };

  if (emailKey) {
    smartResult = await addToSmartLead(lead, email, cfg);
    if (smartResult.ok) {
      await reportTouchpoint({
        client_external_id: channelId,
        lead_key: emailKey,
        type: 'enrolled_smartlead',
        slack_message_ts: slackTs,
        visited_at_raw: visitParsed.text || lead.visitedAt || null,
        visit_instant: visitInstant ? visitInstant.toISOString() : null,
      });
    } else if (['http_error', 'exception', 'missing_config', 'rate_limited'].includes(smartResult.reason)) {
      // We have an email but could not enroll — almost always a fixable SmartLead config/transient issue.
      transient = true;
    }
  }

  if (linkedinKey) {
    heyResult = await addToHeyReach(lead, cfg);
    if (heyResult.ok) {
      await reportTouchpoint({
        client_external_id: channelId,
        lead_key: linkedinKey,
        type: 'enrolled_heyreach',
        slack_message_ts: slackTs,
        visited_at_raw: visitParsed.text || lead.visitedAt || null,
        visit_instant: visitInstant ? visitInstant.toISOString() : null,
      });
    } else if (['http_error', 'exception'].includes(heyResult.reason)) {
      transient = true;
    }
  }

  const lines = [];
  lines.push('*Enrollment complete*');
  lines.push('*Client:* ' + cfg.name);
  lines.push('*Lead:* ' + leadName + (lead.company ? ' · ' + lead.company : ''));
  if (emailKey) {
    lines.push(
      '*SmartLead (email):* ' +
        (smartResult.ok ? 'enrolled `' + emailKey + '`' : 'not enrolled (' + (smartResult.reason || 'failed') + ')')
    );
  } else {
    lines.push('*SmartLead (email):* skipped (no email)');
  }
  if (linkedinKey) {
    lines.push(
      '*HeyReach (LinkedIn):* ' + (heyResult.ok ? 'enrolled' : 'not enrolled (' + (heyResult.reason || 'failed') + ')')
    );
  } else {
    lines.push('*HeyReach (LinkedIn):* skipped (no LinkedIn URL)');
  }
  if (visitParsed.text) {
    lines.push('*RB2B visit text:* `' + visitParsed.text + '`');
  }
  if (visitInstant) {
    lines.push('*Parsed visit time:* `' + visitInstant.toISOString() + '`');
  }
  if (visitInstant && slackSeenAt) {
    const d = formatDurationMs(slackSeenAt.getTime() - visitInstant.getTime());
    if (d) lines.push('*RB2B alert vs parsed visit:* ' + d + ' (Slack message time minus visit; cron adds more delay)');
  }
  if (slackSeenAt) {
    lines.push('*Enrolled at (worker):* `' + enrolledAt.toISOString() + '`');
    const pipe = formatDurationMs(enrolledAt.getTime() - slackSeenAt.getTime());
    if (pipe) lines.push('*RB2B alert → enrolled (pipeline):* ' + pipe);
  }
  lines.push('_First send/open/reply timing is posted when SmartLead/HeyReach webhooks fire._');

  // Only notify Slack when there is something worth saying (a real enroll or a fixable failure we will retry).
  const enrolledAny = smartResult.ok || heyResult.ok;
  if (enrolledAny || transient) {
    await postSlackMessage(channelId, lines.join('\n'), cfg.slack_token);
  }

  const label = enrolledAny
    ? smartResult.ok && heyResult.ok
      ? 'enrolled_both'
      : smartResult.ok
        ? 'enrolled_smartlead'
        : 'enrolled_heyreach'
    : 'no_contact';

  return {
    kind: 'lead',
    routedSmartLead: smartResult.ok,
    routedHeyReach: heyResult.ok,
    transient,
    leadKey: emailKey || linkedinKey || null,
    label,
  };
}

async function main() {
  logger.info('RB2B lead router v2 starting', { multiTenant: multiTenantEnabled() });

  if (!multiTenantEnabled()) {
    logger.warn('Multi-tenant disabled: set UI_PUBLIC_URL + WORKER_CONFIG_SECRET to process all clients. Running legacy single-tenant mode.');
    const cfg = mergeWorkerConfig({
      name: 'single-tenant',
      slack_channel_id: process.env.CHANNEL_ID,
      slack_token: process.env.SLACK_TOKEN,
      prospeo_api_key: process.env.PROSPEO_API_KEY,
      bettercontact_api_key: process.env.BETTERCONTACT_API_KEY,
      smartlead_api_key: process.env.SMARTLEAD_API_KEY,
      smartlead_campaign_id: process.env.SMARTLEAD_CAMPAIGN_ID,
      heyreach_api_key: process.env.HEYREACH_API_KEY,
      heyreach_campaign_id: process.env.HEYREACH_CAMPAIGN_ID,
    });
    await runForClient({ id: 'single' }, cfg, false);
    return;
  }

  let clients = [];
  try {
    if (WORKER_ONLY_CLIENT_ID) {
      clients = [{ id: WORKER_ONLY_CLIENT_ID, name: 'single-run', status: 'active', slack_channel_id: '' }];
      logger.info('Single-client run', { clientId: WORKER_ONLY_CLIENT_ID, lookbackSeconds: LOOKBACK_SECONDS });
    } else {
      clients = await listActiveClients();
    }
  } catch (err) {
    logger.error('Failed to list clients from UI', { error: err.message });
    process.exit(1);
  }

  logger.info('Clients to run', { count: clients.length, onlyClient: !!WORKER_ONLY_CLIENT_ID });
  for (const c of clients) {
    let cfg;
    try {
      cfg = mergeWorkerConfig(await fetchClientConfig(c.id));
    } catch (err) {
      logger.error('Failed to fetch client config', { clientId: c.id, error: err.message });
      continue;
    }
    await runForClient(c, cfg, true);
  }
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
