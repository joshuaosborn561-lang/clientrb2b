const logger = require('./logger');
const { parseRB2BMessage } = require('./parser');
const { findWorkEmail } = require('./prospeo');
const { addToHeyReach } = require('./heyreach');
const { addToSmartLead } = require('./smartlead');
const { postSlackMessage } = require('./slack');
const { parseRb2bVisitAt } = require('./visitTime');
const { reportTouchpoint } = require('./ingest');
const { listActiveClients, fetchClientConfig } = require('./uiClient');
const { fetchAllSlackMessages } = require('./slackFetch');
const { isUsableWorkEmail } = require('./emailUtils');
const { findWorkEmailBetterContact } = require('./bettercontact');

const LOOKBACK_SECONDS = Number(process.env.LOOKBACK_SECONDS || 7 * 24 * 60 * 60);

// --- ICP filtering (copied defaults from legacy worker) ---
const EXCLUDED_EMPLOYEE_RANGES = ['1-10', '11-50'];
const EXCLUDED_INDUSTRIES = [
  'food', 'restaurant', 'restaurants', 'dining', 'bakery', 'catering',
  'retail', 'grocery', 'apparel', 'fashion',
  'healthcare', 'hospital', 'medical', 'nursing', 'dental',
  'farming', 'agriculture',
];

function passesICP(lead) {
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

async function runForClient(clientRow, cfg) {
  cfg = mergeWorkerConfig(cfg);
  const clientId = clientRow.id;
  const channelId = cfg.slack_channel_id;
  logger.info('Client run starting', { clientId, name: cfg.name, channel: channelId });

  const oldest = String(Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS);

  let messages;
  try {
    messages = await fetchAllSlackMessages({ slack_token: cfg.slack_token, slack_channel_id: channelId, oldest });
  } catch (err) {
    logger.error('Failed to fetch Slack messages', { clientId, error: err.message });
    return { ok: false, error: 'slack_fetch_failed' };
  }

  if (messages.length === 0) {
    logger.info('No messages found', { clientId });
    return { ok: true, stats: { leadsFound: 0, routedHeyReach: 0, routedSmartLead: 0, skipped: 0, parseFailures: 0 } };
  }

  let leadsFound = 0;
  let routedHeyReach = 0;
  let routedSmartLead = 0;
  let skipped = 0;
  let parseFailures = 0;

  for (const msg of messages) {
    const lead = extractLead(msg);
    if (!lead) {
      parseFailures++;
      continue;
    }

    leadsFound++;
    const leadName = lead.firstName + ' ' + lead.lastName;

    const icpResult = passesICP(lead);
    if (!icpResult.pass) {
      logger.info('Lead skipped (ICP filter)', { clientId, lead: leadName, reason: icpResult.reason });
      skipped++;
      continue;
    }

    const slackTs = msg.ts || null;
    const slackSeenAt = slackTsToDate(slackTs);
    const visitParsed = parseRb2bVisitAt(lead.visitedAt);
    const visitInstant = visitParsed.at;

    const rb2bEmailRaw = String(lead.email || '').trim();
    let email = isUsableWorkEmail(rb2bEmailRaw) ? rb2bEmailRaw : null;
    if (!email) {
      try {
        const companyDomain = lead.companyWebsite ? lead.companyWebsite.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
        const forProspeo = { ...lead, email: null };
        email = await findWorkEmail({ ...forProspeo, companyDomain }, cfg);
      } catch (err) {
        logger.error('Prospeo email enrichment error', { clientId, error: err.message, lead: leadName });
      }
    }
    if (!email) {
      try {
        const bc = await findWorkEmailBetterContact(lead, cfg);
        if (bc && isUsableWorkEmail(bc)) email = bc;
      } catch (err) {
        logger.error('BetterContact error', { clientId, error: err.message, lead: leadName });
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
        routedSmartLead++;
        await reportTouchpoint({
          client_external_id: channelId,
          lead_key: emailKey,
          type: 'enrolled_smartlead',
          slack_message_ts: slackTs,
          visited_at_raw: visitParsed.text || lead.visitedAt || null,
          visit_instant: visitInstant ? visitInstant.toISOString() : null,
        });
      }
    }

    if (linkedinKey) {
      heyResult = await addToHeyReach(lead, cfg);
      if (heyResult.ok) {
        routedHeyReach++;
        await reportTouchpoint({
          client_external_id: channelId,
          lead_key: linkedinKey,
          type: 'enrolled_heyreach',
          slack_message_ts: slackTs,
          visited_at_raw: visitParsed.text || lead.visitedAt || null,
          visit_instant: visitInstant ? visitInstant.toISOString() : null,
        });
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
        '*HeyReach (LinkedIn):* ' +
          (heyResult.ok ? 'enrolled' : 'not enrolled (' + (heyResult.reason || 'failed') + ')')
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

    await postSlackMessage(channelId, lines.join('\n'), cfg.slack_token);
  }

  logger.info('Client run complete', { clientId, leadsFound, routedHeyReach, routedSmartLead, skipped, parseFailures });
  return { ok: true, stats: { leadsFound, routedHeyReach, routedSmartLead, skipped, parseFailures } };
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
    await runForClient({ id: 'single' }, cfg);
    return;
  }

  let clients = [];
  try {
    clients = await listActiveClients();
  } catch (err) {
    logger.error('Failed to list clients from UI', { error: err.message });
    process.exit(1);
  }

  logger.info('Active clients', { count: clients.length });
  for (const c of clients) {
    let cfg;
    try {
      cfg = mergeWorkerConfig(await fetchClientConfig(c.id));
    } catch (err) {
      logger.error('Failed to fetch client config', { clientId: c.id, error: err.message });
      continue;
    }
    await runForClient(c, cfg);
  }
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
