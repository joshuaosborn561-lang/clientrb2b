const logger = require('./logger');

function summarizeSmartLeadBody(data) {
  if (!data || typeof data !== 'object') return String(data).slice(0, 300);
  const a = data.added_count;
  const s = data.skipped_count;
  const sk = data.skipped_leads;
  const parts = [];
  if (a != null) parts.push('added=' + a);
  if (s != null) parts.push('skipped=' + s);
  if (data.success != null) parts.push('success=' + data.success);
  if (data.message) parts.push('message=' + String(data.message).slice(0, 120));
  if (Array.isArray(sk) && sk.length) {
    parts.push('reasons: ' + JSON.stringify(sk).slice(0, 400));
  }
  return parts.join(' | ') || JSON.stringify(data).slice(0, 500);
}

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
        settings: {
          return_lead_ids: true,
        },
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
      return { ok: false, reason: 'http_error', status: res.status, data, detail: bodyText?.slice(0, 200) };
    }

    if (!data) {
      logger.error('SmartLead empty JSON on 200', { body: bodyText?.slice(0, 300) });
      return { ok: false, reason: 'empty_response' };
    }

    const added = data.added_count != null ? Number(data.added_count) : null;
    const skipped = data.skipped_count != null ? Number(data.skipped_count) : 0;
    if (added === 0) {
      const summary = summarizeSmartLeadBody(data);
      logger.warn('SmartLead returned 0 added', { email, campaignId: SMARTLEAD_CAMPAIGN_ID, summary });
      return { ok: false, reason: skipped > 0 ? 'skipped' : 'zero_added', data, detail: summary };
    }

    logger.info('Added to SmartLead campaign', {
      lead: `${lead.firstName} ${lead.lastName}`,
      email,
      added_count: data?.added_count,
      lead_ids: data?.lead_ids,
    });
    return { ok: true, data, detail: 'added=' + added };
  } catch (err) {
    logger.error('SmartLead request failed', { error: err.message, lead: `${lead.firstName} ${lead.lastName}` });
    return { ok: false, reason: 'exception', error: err.message };
  }
}

module.exports = { addToSmartLead };
