const logger = require('./logger');

// SmartLead enforces 60 requests / minute. Space calls process-wide to stay under it,
// and back off + retry on 429 so a single run can enroll a whole backlog without losing leads.
const MIN_INTERVAL_MS = Number(process.env.SMARTLEAD_MIN_INTERVAL_MS || 1100);
const MAX_ATTEMPTS = Number(process.env.SMARTLEAD_MAX_RETRIES || 5);
let lastCallAt = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

async function addToSmartLead(lead, email, cfg = {}) {
  const SMARTLEAD_API_KEY = (cfg.smartlead_api_key || process.env.SMARTLEAD_API_KEY || '').trim();
  const SMARTLEAD_CAMPAIGN_ID = String(cfg.smartlead_campaign_id || process.env.SMARTLEAD_CAMPAIGN_ID || '').trim();
  if (!SMARTLEAD_API_KEY || !SMARTLEAD_CAMPAIGN_ID) {
    logger.warn('SmartLead config missing, skipping');
    return { ok: false, reason: 'missing_config' };
  }

  if (!email) {
    logger.warn('No email available, skipping SmartLead', { lead: `${lead.firstName} ${lead.lastName}` });
    return { ok: false, reason: 'no_email' };
  }

  const url = `https://server.smartlead.ai/api/v1/campaigns/${SMARTLEAD_CAMPAIGN_ID}/leads?api_key=${SMARTLEAD_API_KEY}`;
  const payload = JSON.stringify({
    lead_list: [
      {
        email,
        first_name: lead.firstName,
        last_name: lead.lastName,
        company_name: lead.company,
      },
    ],
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      const bodyText = await res.text();
      let data = null;
      try {
        data = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        // ignore
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 20) * 1000;
        logger.warn('SmartLead rate limited, backing off', { attempt, waitMs, lead: `${lead.firstName} ${lead.lastName}` });
        if (attempt < MAX_ATTEMPTS) {
          await sleep(waitMs);
          continue;
        }
        return { ok: false, reason: 'rate_limited', status: 429 };
      }

      if (!res.ok) {
        logger.error('SmartLead API error', { status: res.status, body: bodyText?.slice(0, 500) });
        return { ok: false, reason: 'http_error', status: res.status, data };
      }

      logger.info('Added to SmartLead campaign', { lead: `${lead.firstName} ${lead.lastName}`, email });
      return { ok: true, data };
    } catch (err) {
      logger.error('SmartLead request failed', { error: err.message, attempt, lead: `${lead.firstName} ${lead.lastName}` });
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1000 * attempt);
        continue;
      }
      return { ok: false, reason: 'exception', error: err.message };
    }
  }

  return { ok: false, reason: 'rate_limited' };
}

module.exports = { addToSmartLead };
