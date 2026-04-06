const logger = require('./logger');
const { parseRB2BMessage } = require('./parser');
const { enrichWithApollo } = require('./enrichment');
const { addToHeyReach } = require('./heyreach');
const { addToSmartLead } = require('./smartlead');

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// Look back 7 days every run. SmartLead and HeyReach dedupe on their end
// (by email and LinkedIn URL), so reprocessing old leads is harmless.
// This guarantees we never miss a lead due to cron delays or downtime.
const LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

// --- ICP filtering ---
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
  if (!SLACK_TOKEN || !CHANNEL_ID) {
    throw new Error('SLACK_TOKEN and CHANNEL_ID env vars are required');
  }
  let allMessages = [];
  let cursor;
  while (true) {
    const params = new URLSearchParams({ channel: CHANNEL_ID, oldest, limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch('https://slack.com/api/conversations.history?' + params, {
      headers: { Authorization: 'Bearer ' + SLACK_TOKEN },
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
  logger.info('RB2B lead router starting');

  const oldest = String(Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS);
  logger.info('Polling Slack', { oldest, channel: CHANNEL_ID, lookbackDays: LOOKBACK_SECONDS / 86400 });

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

    leadsFound++;
    const leadName = lead.firstName + ' ' + lead.lastName;

    const icpResult = passesICP(lead);
    if (!icpResult.pass) {
      logger.info('Lead skipped (ICP filter)', { lead: leadName, reason: icpResult.reason });
      skipped++;
      continue;
    }

    let email = lead.email || null;
    if (!email) {
      try {
        email = await enrichWithApollo(lead);
      } catch (err) {
        logger.error('Enrichment error', { error: err.message, lead: leadName });
      }
    }

    if (lead.linkedinUrl) {
      try {
        const added = await addToHeyReach(lead);
        if (added) routedHeyReach++;
      } catch (err) {
        logger.error('HeyReach error', { error: err.message, lead: leadName });
      }
    }

    if (email) {
      try {
        const added = await addToSmartLead(lead, email);
        if (added) routedSmartLead++;
      } catch (err) {
        logger.error('SmartLead error', { error: err.message, lead: leadName });
      }
    }
  }

  logger.info('Run complete', { leadsFound, routedHeyReach, routedSmartLead, skipped, parseFailures });
}

main().catch(function(err) {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
