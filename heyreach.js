const logger = require('./logger');

const HEYREACH_API_KEY = process.env.HEYREACH_API_KEY;
const HEYREACH_CAMPAIGN_ID = process.env.HEYREACH_CAMPAIGN_ID;

async function addToHeyReach(lead) {
  if (!HEYREACH_API_KEY || !HEYREACH_CAMPAIGN_ID) {
    logger.warn('HeyReach config missing, skipping');
    return false;
  }

  if (!lead.linkedinUrl) {
    logger.warn('No LinkedIn URL, skipping HeyReach', { lead: `${lead.firstName} ${lead.lastName}` });
    return false;
  }

  try {
    const res = await fetch('https://api.heyreach.io/api/public/lead/AddLeadsToCampaign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': HEYREACH_API_KEY,
      },
      body: JSON.stringify({
        campaignId: HEYREACH_CAMPAIGN_ID,
        leads: [
          {
            linkedInProfileUrl: lead.linkedinUrl,
            firstName: lead.firstName,
            lastName: lead.lastName,
            companyName: lead.company,
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('HeyReach API error', { status: res.status, body });
      return false;
    }

    logger.info('Added to HeyReach campaign', { lead: `${lead.firstName} ${lead.lastName}` });
    return true;
  } catch (err) {
    logger.error('HeyReach request failed', { error: err.message, lead: `${lead.firstName} ${lead.lastName}` });
    return false;
  }
}

module.exports = { addToHeyReach };
