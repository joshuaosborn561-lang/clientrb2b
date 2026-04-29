const logger = require('./logger');

/**
 * Find work email when RB2B alert has none.
 * Uses Prospeo Enrich Person: https://prospeo.io/api-docs/enrich-person
 */
async function findWorkEmail(lead, cfg = null) {
  const PROSPEO_API_KEY = String(cfg?.prospeo_api_key || process.env.PROSPEO_API_KEY || '').trim();
  if (!PROSPEO_API_KEY) return null;

  const data = {};
  if (lead.linkedinUrl) {
    let u = String(lead.linkedinUrl).trim();
    if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
    data.linkedin_url = u;
  } else {
    if (lead.firstName) data.first_name = lead.firstName;
    if (lead.lastName) data.last_name = lead.lastName;
    const domainFromWebsite = lead.companyWebsite
      ? String(lead.companyWebsite).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      : '';
    const domain = domainFromWebsite || (lead.companyDomain ? String(lead.companyDomain).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '');
    if (domain) data.company_website = domain;
    if (lead.company) data.company_name = lead.company;
  }

  if (!data.linkedin_url && !(data.first_name && data.last_name && (data.company_website || data.company_name))) {
    logger.warn('Prospeo enrich skipped: insufficient datapoints', { hasLinkedIn: !!lead.linkedinUrl });
    return null;
  }

  try {
    const res = await fetch('https://api.prospeo.io/enrich-person', {
      method: 'POST',
      headers: {
        'X-KEY': PROSPEO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        only_verified_email: true,
        data,
      }),
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // ignore
    }

    if (!res.ok || body?.error) {
      logger.warn('Prospeo enrich no email or error', {
        status: res.status,
        error_code: body?.error_code,
        snippet: text?.slice(0, 300),
      });
      return null;
    }

    const emailObj = body?.person?.email;
    const email = typeof emailObj === 'string' ? emailObj : emailObj?.email || null;
    if (email && !String(email).includes('*')) {
      logger.info('Prospeo email found', { email });
      return String(email).trim();
    }
    if (email) {
      logger.warn('Prospeo returned masked or non-revealed email', { preview: String(email).slice(0, 40) });
    }
    return null;
  } catch (err) {
    logger.error('Prospeo enrich failed', { error: err.message });
    return null;
  }
}

module.exports = { findWorkEmail };
