/**
 * One-time backfill script — pulls ALL messages from the Slack channel
 * and routes every lead through the pipeline.
 *
 * Usage: node backfill.js
 * Set BACKFILL_DAYS=90 to control how far back (default: 90 days)
 */
const logger = require('./logger');
const { parseRB2BMessage } = require('./parser');
const { enrichWithApollo } = require('./enrichment');
const { addToHeyReach } = require('./heyreach');
const { addToSmartLead } = require('./smartlead');

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BACKFILL_DAYS = parseInt(process.env.BACKFILL_DAYS || '90', 10);

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

function extractLead(msg) {
  let lead = parseRB2BMessage(msg.text);
  if (lead) return lead;
  if (msg.attachments) {
    for (const att of msg.attachments) {
      const t = att.text || att.fallback || '';
      if (t) { lead = parseRB2BMessage(t); if (lead) return lead; }
    }
  }
  if (msg.blocks) {
    for (const block of msg.blocks) {
      const bt = block.text ? block.text.text : '';
      if (bt) { lead = parseRB2BMessage(bt); if (lead) return lead; }
    }
  }
  return null;
}

async function fetchAllSlackMessages(oldest) {
  if (!SLACK_TOKEN || !CHANNEL_ID) throw new Error('SLACK_TOKEN and CHANNEL_ID required');
  let allMessages = [];
  let cursor;
  let page = 0;
  while (true) {
    page++;
    const params = new URLSearchParams({ channel: CHANNEL_ID, oldest, limit: '200' });
    if (cursor) params.set('cursor', cursor);
    logger.info('Fetching page ' + page);
    const res = await fetch('https://slack.com/api/conversations.history?' + params, {
      headers: { Authorization: 'Bearer ' + SLACK_TOKEN },
    });
    if (!res.ok) throw new Error('Slack HTTP error: ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error('Slack API error: ' + data.error);
    allMessages = allMessages.concat(data.messages || []);
    logger.info('Page ' + page + ': ' + (data.messages || []).length + ' msgs (total: ' + allMessages.length + ')');
    if (data.has_more && data.response_metadata && data.response_metadata.next_cursor) {
      cursor = data.response_metadata.next_cursor;
    } else {
      break;
    }
  }
  return allMessages;
}

async function main() {
  logger.info('=== BACKFILL START ===');
  logger.info('Looking back ' + BACKFILL_DAYS + ' days');
  const oldest = String(Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 24 * 60 * 60);

  let messages;
  try {
    messages = await fetchAllSlackMessages(oldest);
  } catch (err) {
    logger.error('Failed to fetch Slack messages', { error: err.message });
    process.exit(1);
  }

  logger.info('Total messages: ' + messages.length);

  let leadsFound = 0, routedHeyReach = 0, routedSmartLead = 0, skipped = 0, parseFailures = 0;

  for (const msg of messages) {
    const lead = extractLead(msg);
    if (!lead) { parseFailures++; continue; }

    leadsFound++;
    const leadName = lead.firstName + ' ' + lead.lastName;

    const icpResult = passesICP(lead);
    if (!icpResult.pass) {
      logger.info('Skipped (ICP)', { lead: leadName, reason: icpResult.reason });
      skipped++;
      continue;
    }

    logger.info('Processing: ' + leadName, { company: lead.company, email: lead.email || 'none', linkedin: lead.linkedinUrl ? 'yes' : 'no' });

    // Use email from message first, Apollo as fallback
    let email = lead.email || null;
    if (!email) {
      try { email = await enrichWithApollo(lead); } catch (err) {
        logger.error('Enrichment error', { error: err.message, lead: leadName });
      }
    }

    if (lead.linkedinUrl) {
      try { const ok = await addToHeyReach(lead); if (ok) routedHeyReach++; } catch (err) {
        logger.error('HeyReach error', { error: err.message, lead: leadName });
      }
    }

    if (email) {
      try { const ok = await addToSmartLead(lead, email); if (ok) routedSmartLead++; } catch (err) {
        logger.error('SmartLead error', { error: err.message, lead: leadName });
      }
    } else {
      logger.warn('No email, skipping SmartLead', { lead: leadName });
    }

    await new Promise(function(r) { setTimeout(r, 500); });
  }

  logger.info('=== BACKFILL COMPLETE ===', { leadsFound, routedHeyReach, routedSmartLead, skipped, parseFailures });
}

main().catch(function(err) { logger.error('Fatal', { error: err.message }); process.exit(1); });
