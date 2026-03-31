const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { parseRB2BMessage } = require('./parser');
const { enrichWithApollo } = require('./enrichment');
const { addToHeyReach } = require('./heyreach');
const { addToSmartLead } = require('./smartlead');

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const STATE_FILE = path.join(__dirname, 'state.json');

// --- ICP filtering ---

const EXCLUDED_EMPLOYEE_RANGES = ['1-10', '11-50'];

const EXCLUDED_INDUSTRIES = [
  'food', 'restaurant', 'restaurants', 'dining', 'bakery', 'catering',
  'retail', 'grocery', 'apparel', 'fashion',
  'healthcare', 'hospital', 'medical', 'nursing', 'dental',
  'farming', 'agriculture',
];

function passesICP(lead) {
  // Employee size check
  if (EXCLUDED_EMPLOYEE_RANGES.includes(lead.employees)) {
    return { pass: false, reason: `Employee range too small: ${lead.employees}` };
  }

  // Industry check — permissive, only skip clearly irrelevant
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

// --- State persistence ---

function loadLastCheckedTs() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (data.lastCheckedTs) return data.lastCheckedTs;
    }
  } catch (err) {
    logger.warn('Failed to read state file, using default', { error: err.message });
  }
  // Default: 24 hours ago
  return String(Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000));
}

function saveLastCheckedTs(ts) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastCheckedTs: ts }), 'utf8');
  } catch (err) {
    logger.error('Failed to save state file', { error: err.message });
  }
}

// --- Slack polling ---

async function fetchSlackMessages(oldest) {
  if (!SLACK_TOKEN || !CHANNEL_ID) {
    throw new Error('SLACK_TOKEN and CHANNEL_ID are required');
  }

  const params = new URLSearchParams({
    channel: CHANNEL_ID,
    oldest,
    limit: '50',
  });

  const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });

  if (!res.ok) {
    throw new Error(`Slack HTTP error: ${res.status}`);
  }

  const data = await res.json();

  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  return data.messages || [];
}

// --- Main orchestration ---

async function main() {
  logger.info('RB2B lead router starting');

  const oldest = loadLastCheckedTs();
  logger.info('Polling Slack', { oldest, channel: CHANNEL_ID });

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
  let latestTs = oldest;

  for (const msg of messages) {
    // Track the latest timestamp for state persistence
    if (msg.ts && msg.ts > latestTs) {
      latestTs = msg.ts;
    }

    const lead = parseRB2BMessage(msg.text);
    if (!lead) continue; // Not an RB2B message

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
    }
  }

  // Save state
  saveLastCheckedTs(latestTs);

  // Summary
  logger.info('Run complete', {
    leadsFound,
    routedHeyReach,
    routedSmartLead,
    skipped,
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
