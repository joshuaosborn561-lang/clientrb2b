const logger = require('./logger');

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

async function enrichWithApollo(lead) {
  if (!APOLLO_API_KEY) {
    logger.warn('APOLLO_API_KEY not set, skipping enrichment');
    return null;
  }

  if (!lead.linkedinUrl) {
    logger.warn('No LinkedIn URL for Apollo enrichment', { lead: `${lead.firstName} ${lead.lastName}` });
    return null;
  }

  try {
    const res = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': APOLLO_API_KEY,
      },
      body: JSON.stringify({
        linkedin_url: lead.linkedinUrl,
        reveal_personal_emails: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('Apollo API error', { status: res.status, body });
      return null;
    }

    const data = await res.json();
    const email = data?.person?.email || null;

    if (email) {
      logger.info('Apollo enrichment found email', { lead: `${lead.firstName} ${lead.lastName}`, email });
    } else {
      logger.warn('Apollo enrichment returned no email', { lead: `${lead.firstName} ${lead.lastName}` });
    }

    return email;
  } catch (err) {
    logger.error('Apollo enrichment failed', { error: err.message, lead: `${lead.firstName} ${lead.lastName}` });
    return null;
  }
}

module.exports = { enrichWithApollo };
