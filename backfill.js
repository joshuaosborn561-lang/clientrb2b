/**
 * One-time backfill script — pulls ALL messages from the Slack channel
 * (paginating through full history) and routes every lead through the pipeline.
 *
 * Usage: node backfill.js
 * Or set BACKFILL_DAYS=90 to limit how far back to look (default: 90 days)
 */
const logger = require('./logger');
const { parseRB2BMessage } = require('./parser');
const { enrichWithApollo } = require('./enrichment');
const { addToHeyReach } = require('./heyreach');
const { addToSmartLead } = require('./smartlead');

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BACKFILL_DAYS = parseInt(process.env.BACKFILL_DAYS || '90', 10);

// --- ICP filtering (same as index.js) ---
const EXCLUDED_EMPLOYEE_RANGES = ['1-10', '11-50'];
const EXCLUDED_INDUSTRIES = [
  'food', 'restaurant', 'restaurants', 'dining', 'bakery', 'catering',
  'retail', 'grocery', 'apparel', 'fashion',
  'healthcare', 'hospital', 'medical', 'nursing', 'dental',
  'farming', 'agriculture',
];

function passesICP(lead) {
  if (EXCLUDED_EMPLOYEE_RANGES.includes(lead.employees)) {
    return { pass: false, reason: `Employee range too small: ${lead.employees}` };
  }
  if (lead.industry) {
    const lower = lead.industry.toLowerCase();
    for (const keyword of EXCLUDED_INDUSTRIES) {
      if (lower.includes(keyword)) {
        return { pass: false, reason: `Excluded industry: ${lead.industry}` };
      }
    }
  }
  return { pass: true, reason: null };
}

// --- Slack pagination — fetch ALL messages ---
async function fetchAllSlackMessages(oldest) {
  if (!SLACK_TOKEN || !CHANNEL_ID) {
    throw new Error('SLACK_TOKEN and CHANNEL_ID env vars are required');
  }

  let allMessages = [];
  let cursor = undefined;
  let page = 0;

  while (true) {
    page++;
    const params = new URLSearchParams({ channel: CHANNEL_ID, oldest, limit: '200' });
    if (cursor) params.set('cursor', cursor);

    logger.info(`Fetching Slack page ${page}`, { cursor: cursor || '(first)' });

    const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
    });

    if (!res.ok) throw new Error(`Slack HTTP error: ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);

    const messages = data.messages || [];
    allMessages = allMessages.concat(messages);
    logger.info(`Page ${page}: ${messages.length} messages (total so far: ${allMessages.length})`);

    // Check for more pages
    if (data.has_more && data.response_metadata?.next_cursor) {
      cursor = data.response_metadata.next_cursor;
    } else {
      break;
    }
  }

  return allMessages;
}

// --- Extract lead from message (text, attachments, blocks) ---
function extractLead(msg) {
  let lead = parseRB2BMessage(msg.text);
  if (lead) return lead;

  if (msg.attachments && msg.attachments.length > 0) {
    for (const att of msg.attachments) {
      const attText = att.text || att.fallback || att.pretext || '';
      if (attText) {
        lead = parseRB2BMessage(attText);
        if (lead) return lead;
      }
    }
  }

  if (msg.blocks && msg.blocks.length > 0) {
    for (const block of msg.blocks) {
      const blockText = block.text?.text || '';
      if (blockText) {
        lead = parseRB2BMessage(blockText);
        if (lead) return lead;
      }
    }
  }

  return null;
}

// --- Main ---
async function main() {
  logger.info('=== BACKFILL START ===');
  logger.info(`Looking back ${BACKFILL_DAYS} days`);

  const oldest = String(Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 24 * 60 * 60);

  let messages;
  try {
    messages = await fetchAllSlackMessages(oldest);
  } catch (err) {
    logger.error('Failed to fetch Slack messages', { error: err.message });
    process.exit(1);
  }

  logger.info(`Total messages fetched: ${messages.length}`);

  let leadsFound = 0;
  let routedHeyReach = 0;
  let routedSmartLead = 0;
  let skipped = 0;
  let parseFailures = 0;
  let enrichedWithEmail = 0;

  for (const msg of messages) {
    const lead = extractLead(msg);
    if (!lead) {
      parseFailures++;
      continue;
    }

    leadsFound++;
    const leadName = `${lead.firstName} ${lead.lastName}`;

    // ICP filter
    const icpResult = passesICP(lead);
    if (!icpResult.pass) {
      logger.info('Lead skipped (ICP filter)', { lead: leadName, reason: icpResult.reason });
      skipped++;
      continue;
    }

    logger.info(`Processing lead ${leadsFound}: ${leadName}`, {
      company: lead.company,
      linkedin: lead.linkedinUrl ? 'yes' : 'no',
      employees: lead.employees,
      industry: lead.industry,
    });

    // Enrich via Apollo
    let email = null;
    try {
      email = await enrichWithApollo(lead);
      if (email) enrichedWithEmail++;
    } catch (err) {
      logger.error('Enrichment error', { error: err.message, lead: leadName });
    }

    // Route to HeyReach (LinkedIn)
    if (lead.linkedinUrl) {
      try {
        const added = await addToHeyReach(lead);
        if (added) routedHeyReach++;
      } catch (err) {
        logger.error('HeyReach error', { error: err.message, lead: leadName });
      }
    } else {
      logger.warn('No LinkedIn URL, skipping HeyReach', { lead: leadName });
    }

    // Route to SmartLead (email)
    if (email) {
      try {
        const added = await addToSmartLead(lead, email);
        if (added) routedSmartLead++;
      } catch (err) {
        logger.error('SmartLead error', { error: err.message, lead: leadName });
      }
    } else {
      logger.warn('No email from Apollo, skipping SmartLead', { lead: leadName });
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  logger.info('=== BACKFILL COMPLETE ===', {
    totalMessages: messages.length,
    leadsFound,
    passedICP: leadsFound - skipped,
    skippedICP: skipped,
    enrichedWithEmail,
    routedHeyReach,
    routedSmartLead,
    parseFailures,
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
