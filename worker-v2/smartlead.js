const logger = require('./logger');

const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;
const SMARTLEAD_CAMPAIGN_ID = process.env.SMARTLEAD_CAMPAIGN_ID;

async function addToSmartLead(lead, email) {
  if (!SMARTLEAD_API_KEY || !SMARTLEAD_CAMPAIGN_ID) {
    logger.warn('SmartLead config missing, skipping');
    return false;
  }

  if (!email) {
    logger.warn('No email available, skipping SmartLead', { lead: `${lead.firstName} ${lead.lastName}` });
    return false;
  }

  try {
    const url = `https://server.smartlead.ai/api/v1/campaigns/${SMARTLEAD_CAMPAIGN_ID}/leads?api_key=${SMARTLEAD_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lead_list: [
          {
            email,
            first_name: lead.firstName,
            last_name: lead.lastName,
            company_name: lead.company,
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('SmartLead API error', { status: res.status, body });
      return false;
    }

    logger.info('Added to SmartLead campaign', { lead: `${lead.firstName} ${lead.lastName}`, email });
    return true;
  } catch (err) {
    logger.error('SmartLead request failed', { error: err.message, lead: `${lead.firstName} ${lead.lastName}` });
    return false;
  }
}

module.exports = { addToSmartLead };

