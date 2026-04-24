const logger = require('./logger');
const { parseRB2BMessage } = require('./parser');
const { findWorkEmail } = require('./prospeo');
const { addToHeyReach } = require('./heyreach');
const { addToSmartLead } = require('./smartlead');
const { postSlackMessage } = require('./slack');
const { parseRb2bVisitAt } = require('./visitTime');
const { reportTouchpoint } = require('./ingest');
const { loadWorkerConfig, applyWorkerConfig } = require('./config');
const { isUsableWorkEmail } = require('./emailUtils');
const { findWorkEmailBetterContact } = require('./bettercontact');
const { logEnrichmentMiss } = require('./notionEnrichmentLog');

const LOOKBACK_SECONDS = Number(process.env.LOOKBACK_SECONDS || 7 * 24 * 60 * 60);
/** Set ENRICHMENT_BACKFILL=1 to re-run Prospeo → BetterContact for leads with masked/empty RB2B email only (wider lookback by default). */
const ENRICHMENT_BACKFILL = /^1|true|yes$/i.test(String(process.env.ENRICHMENT_BACKFILL || '').trim());
const ENRICHMENT_BACKFILL_LOOKBACK_SECONDS = Number(
  process.env.ENRICHMENT_BACKFILL_LOOKBACK_SECONDS || 30 * 24 * 60 * 60
);
const BACKFILL_LOG_NOTION = /^1|true|yes$/i.test(String(process.env.ENRICHMENT_BACKFILL_LOG_NOTION || '').trim());

// --- ICP filtering (copied defaults from legacy worker) ---
// Set DISABLE_ICP_FILTER=1 in Railway to route all parsed leads (debug only).
const ICP_DISABLED = /^1|true|yes$/i.test(String(process.env.DISABLE_ICP_FILTER || '').trim());
const EXCLUDED_EMPLOYEE_RANGES = ['1-10', '11-50'];
const EXCLUDED_INDUSTRIES = [
  'food', 'restaurant', 'restaurants', 'dining', 'bakery', 'catering',
  'retail', 'grocery', 'apparel', 'fashion',
  'healthcare', 'hospital', 'medical', 'nursing', 'dental',
  'farming', 'agriculture',
];

function passesICP(lead) {
  if (ICP_DISABLED) return { pass: true, reason: null };
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

async function fetchAllSlackMessages(oldest) {
  const slackToken = process.env.SLACK_TOKEN;
  const channelId = process.env.CHANNEL_ID;
  if (!slackToken || !channelId) {
    throw new Error('SLACK_TOKEN and CHANNEL_ID env vars are required');
  }
  let allMessages = [];
  let cursor;
  while (true) {
    const params = new URLSearchParams({ channel: channelId, oldest, limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch('https://slack.com/api/conversations.history?' + params, {
      headers: { Authorization: 'Bearer ' + slackToken },
    });
    if (!res.ok) throw new Error('Slack HTTP error: ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error('Slack API error: ' + data.error);
    allMessages = allMessages.concat(data.messages || []);
    if (data.has_more && data.response_metadata && data.response_metadata.next_cursor) {
      cursor = data.response_metadata.next_cursor;
    } else {
      break;
    }
  }
  return allMessages;
}

async function main() {
  logger.info('RB2B lead router v2 starting');

  const remote = await loadWorkerConfig();
  applyWorkerConfig(remote);

  const channelId = process.env.CHANNEL_ID;
  const lookbackSec = ENRICHMENT_BACKFILL ? ENRICHMENT_BACKFILL_LOOKBACK_SECONDS : LOOKBACK_SECONDS;
  const oldest = String(Math.floor(Date.now() / 1000) - lookbackSec);
  logger.info('Polling Slack', {
    oldest,
    channel: channelId,
    lookbackSeconds: lookbackSec,
    enrichmentBackfill: ENRICHMENT_BACKFILL,
  });

  let messages;
  try {
    messages = await fetchAllSlackMessages(oldest);
  } catch (err) {
    logger.error('Failed to fetch Slack messages', { error: err.message });
    process.exit(1);
  }

  if (messages.length === 0) {
    logger.info('No messages found');
    return;
  }

  logger.info('Found ' + messages.length + ' messages to process');

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

    if (ENRICHMENT_BACKFILL) {
      const raw = String(lead.email || '').trim();
      if (isUsableWorkEmail(raw)) {
        continue;
      }
    }

    leadsFound++;
    const leadName = lead.firstName + ' ' + lead.lastName;

    const icpResult = passesICP(lead);
    if (!icpResult.pass) {
      logger.info('Lead skipped (ICP filter)', { lead: leadName, reason: icpResult.reason });
      skipped++;
      const skipLines = [
        '*Visitor skipped (ICP filter)*',
        '*Lead:* ' + leadName + (lead.company ? ' · ' + lead.company : ''),
        '*Reason:* ' + icpResult.reason,
        '_To allow them, adjust EXCLUDED_EMPLOYEE_RANGES / EXCLUDED_INDUSTRIES in worker-v2 or remove the filter._',
      ];
      try {
        await postSlackMessage(skipLines.join('\n'));
      } catch (e) {
        // ignore
      }
      continue;
    }

    const slackTs = msg.ts || null;
    const slackSeenAt = slackTsToDate(slackTs);
    const visitParsed = parseRb2bVisitAt(lead.visitedAt);
    const visitInstant = visitParsed.at;

    // RB2B often sends masked emails (****@****); always run Prospeo when we don't have a real address.
    const rb2bEmailRaw = String(lead.email || '').trim();
    let email = isUsableWorkEmail(rb2bEmailRaw) ? rb2bEmailRaw : null;
    let emailSource = email ? 'rb2b' : 'none';
    if (!email) {
      try {
        const companyDomain = lead.companyWebsite ? lead.companyWebsite.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
        const forProspeo = { ...lead, email: null };
        email = await findWorkEmail({ ...forProspeo, companyDomain });
        if (email) emailSource = 'prospeo';
      } catch (err) {
        logger.error('Prospeo email enrichment error', { error: err.message, lead: leadName });
      }
    }
    if (!email) {
      try {
        const bc = await findWorkEmailBetterContact(lead);
        if (bc && isUsableWorkEmail(bc)) {
          email = bc;
          emailSource = 'bettercontact';
        }
      } catch (err) {
        logger.error('BetterContact error', { error: err.message, lead: leadName });
      }
    }
    if (!email) {
      if (!ENRICHMENT_BACKFILL || BACKFILL_LOG_NOTION) {
        try {
          await logEnrichmentMiss(lead, 'prospeo_and_bettercontact_miss');
        } catch (e) {
          // ignore
        }
      }
    }

    const emailKey = email ? normalizeEmailKey(email) : '';
    const linkedinKey = normalizeLinkedinKey(lead.linkedinUrl);

    const enrolledAt = new Date();
    let smartResult = { ok: false };
    let heyResult = { ok: false };

    if (emailKey) {
      smartResult = await addToSmartLead(lead, email);
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
      heyResult = await addToHeyReach(lead);
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
    lines.push(ENRICHMENT_BACKFILL ? '*Enrichment backfill* (masked RB2B; re-ran Prospeo → BetterContact)' : '*Enrollment complete*');
    lines.push('*Lead:* ' + leadName + (lead.company ? ' · ' + lead.company : ''));
    lines.push(
      '*Email source:* ' +
        (emailSource === 'rb2b'
          ? 'RB2B alert (real address in text)'
          : emailSource === 'prospeo'
            ? 'Prospeo'
            : emailSource === 'bettercontact'
              ? 'BetterContact (after Prospeo had no result)'
              : 'none (Prospeo + BetterContact; Notion log if both miss and Notion is configured)')
    );
    if (emailKey) {
      const sm =
        smartResult.ok
          ? 'enrolled `' + emailKey + '`' + (smartResult.detail ? ' ' + smartResult.detail : '')
          : 'not enrolled — *' + (smartResult.reason || 'failed') + '*' + (smartResult.detail ? ' — ' + String(smartResult.detail).slice(0, 400) : '');
      lines.push('*SmartLead (email):* ' + sm);
    } else {
      lines.push('*SmartLead (email):* skipped (no work email; Prospeo also found nothing or is not set)');
    }
    if (linkedinKey) {
      lines.push(
        '*HeyReach (LinkedIn):* ' +
          (heyResult.ok ? 'enrolled' : 'not enrolled — ' + (heyResult.reason || 'failed') + (heyResult.detail ? ' — ' + String(heyResult.detail).slice(0, 200) : ''))
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

    await postSlackMessage(lines.join('\n'));
  }

  logger.info('Run complete', { leadsFound, routedHeyReach, routedSmartLead, skipped, parseFailures });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
