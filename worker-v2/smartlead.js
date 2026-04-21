const logger = require('./logger');

async function addToSmartLead(lead, email) {
  const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;
  const SMARTLEAD_CAMPAIGN_ID = process.env.SMARTLEAD_CAMPAIGN_ID;
  if (!SMARTLEAD_API_KEY || !SMARTLEAD_CAMPAIGN_ID) {
    logger.warn('SmartLead config missing, skipping');
    return { ok: false, reason: 'missing_config' };
  }

  if (!email) {
    logger.warn('No email available, skipping SmartLead', { lead: `${lead.firstName} ${lead.lastName}` });
    return { ok: false, reason: 'no_email' };
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

    const bodyText = await res.text();
    let data = null;
    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // ignore
    }

    if (!res.ok) {
      logger.error('SmartLead API error', { status: res.status, body: bodyText?.slice(0, 500) });
      return { ok: false, reason: 'http_error', status: res.status, data };
    }

    logger.info('Added to SmartLead campaign', { lead: `${lead.firstName} ${lead.lastName}`, email });
    return { ok: true, data };
  } catch (err) {
    logger.error('SmartLead request failed', { error: err.message, lead: `${lead.firstName} ${lead.lastName}` });
    return { ok: false, reason: 'exception', error: err.message };
  }
}

module.exports = { addToSmartLead };
