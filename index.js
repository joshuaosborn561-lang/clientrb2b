const logger = require('./logger');
const { parseRB2BMessage } = require('./parser');
const { enrichWithApollo } = require('./enrichment');
const { addToHeyReach } = require('./heyreach');
const { addToSmartLead } = require('./smartlead');

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

// How far back to look on each run (20 min covers the 15 min interval with buffer)
const LOOKBACK_SECONDS = 20 * 60;

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

// --- Slack polling ---
async function fetchSlackMessages(oldest) {
  if (!SLACK_TOKEN || !CHANNEL_ID) {
    throw new Error('SLACK_TOKEN and CHANNEL_ID env vars are required');
  }
  const params = new URLSearchParams({ channel: CHANNEL_ID, oldest, limit: '50' });
  const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Slack HTTP error: ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data.messages || [];
}

// --- Main ---
async function main() {
  logger.info('RB2B lead router starting');

  const oldest = String(Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS);
  logger.info('Polling Slack', { oldest, channel: CHANNEL_ID, lookbackMinutes: LOOKBACK_SECONDS / 60 });

  let messages;
  try {
    messages = await fetchSlackMessages(oldest);
  } catch (err) {
    logger.error('Failed to fetch Slack messages', { error: err.message });
    process.exit(1);
  }

  if (messages.length === 0) {
    logger.info('No new messages found');
    return;
  }

  logger.info(`Found ${messages.length} messages to process`);

  let leadsFound = 0;
  let routedHeyReach = 0;
  let routedSmartLead = 0;
  let skipped = 0;
  let parseFailures = 0;

  for (const msg of messages) {
    // Debug: log raw message text so we can see what Slack is sending
    logger.info('Processing message', {
      ts: msg.ts,
      hasText: !!msg.text,
      textLength: msg.text ? msg.text.length : 0,
      preview: msg.text ? msg.text.substring(0, 200) : '(no text)',
      hasAttachments: !!(msg.attachments && msg.attachments.length),
      hasBlocks: !!(msg.blocks && msg.blocks.length),
    });

    // Try parsing from msg.text first
    let lead = parseRB2BMessage(msg.text);

    // If text parsing failed, try attachments (RB2B may send as attachment)
    if (!lead && msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        const attText = att.text || att.fallback || att.pretext || '';
        if (attText) {
          logger.info('Trying attachment text', { preview: attText.substring(0, 200) });
          lead = parseRB2BMessage(attText);
          if (lead) break;
        }
      }
    }

    // Also try blocks
    if (!lead && msg.blocks && msg.blocks.length > 0) {
      for (const block of msg.blocks) {
        const blockText = block.text?.text || '';
        if (blockText) {
          logger.info('Trying block text', { preview: blockText.substring(0, 200) });
          lead = parseRB2BMessage(blockText);
          if (lead) break;
        }
      }
    }

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

    // Enrich via Apollo
    let email = null;
    try {
      email = await enrichWithApollo(lead);
    } catch (err) {
      logger.error('Unexpected enrichment error', { error: err.message, lead: leadName });
    }

    // Route to HeyReach (LinkedIn)
    if (lead.linkedinUrl) {
      try {
        const added = await addToHeyReach(lead);
        if (added) routedHeyReach++;
      } catch (err) {
        logger.error('Unexpected HeyReach error', { error: err.message, lead: leadName });
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
        logger.error('Unexpected SmartLead error', { error: err.message, lead: leadName });
      }
    } else {
      logger.warn('No email from Apollo, skipping SmartLead', { lead: leadName });
    }
  }

  logger.info('Run complete', { leadsFound, routedHeyReach, routedSmartLead, skipped, parseFailures });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
