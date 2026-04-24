const logger = require('./logger');

async function addToHeyReach(lead) {
  const HEYREACH_API_KEY = process.env.HEYREACH_API_KEY;
  const HEYREACH_CAMPAIGN_ID = process.env.HEYREACH_CAMPAIGN_ID;
  if (!HEYREACH_API_KEY || !HEYREACH_CAMPAIGN_ID) {
    logger.warn('HeyReach config missing, skipping');
    return { ok: false, reason: 'missing_config' };
  }

  if (!lead.linkedinUrl) {
    logger.warn('No LinkedIn URL, skipping HeyReach', { lead: `${lead.firstName} ${lead.lastName}` });
    return { ok: false, reason: 'no_linkedin' };
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

    const bodyText = await res.text();
    if (!res.ok) {
      logger.error('HeyReach API error', { status: res.status, body: bodyText?.slice(0, 500) });
      return { ok: false, reason: 'http_error', status: res.status, detail: bodyText?.slice(0, 200) };
    }

    logger.info('Added to HeyReach campaign', { lead: `${lead.firstName} ${lead.lastName}` });
    return { ok: true, detail: bodyText?.slice(0, 150) };
  } catch (err) {
    logger.error('HeyReach request failed', { error: err.message, lead: `${lead.firstName} ${lead.lastName}` });
    return { ok: false, reason: 'exception', error: err.message };
  }
}

module.exports = { addToHeyReach };
