const logger = require('./logger');

const BASE = 'https://app.bettercontact.rocks/api/v2';

async function findWorkEmailBetterContact(lead, cfg = null) {
  const key = String(cfg?.bettercontact_api_key || process.env.BETTERCONTACT_API_KEY || '').trim();
  if (!key) return null;

  const companyDomain = lead.companyWebsite
    ? String(lead.companyWebsite).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    : lead.companyDomain
      ? String(lead.companyDomain).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      : '';
  if (!lead.firstName || !lead.lastName) {
    logger.warn('BetterContact enrich skipped: need first+last name');
    return null;
  }
  if (!lead.company && !companyDomain) {
    logger.warn('BetterContact enrich skipped: need company or domain');
    return null;
  }

  const row = {
    first_name: lead.firstName,
    last_name: lead.lastName,
    company: lead.company || undefined,
    company_domain: companyDomain || undefined,
  };
  if (lead.linkedinUrl) {
    let u = String(lead.linkedinUrl).trim();
    if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
    row.linkedin_url = u;
  }

  try {
    const res = await fetch(BASE + '/async', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({
        data: [row],
        enrich_email_address: true,
        enrich_phone_number: false,
      }),
    });
    const text = await res.text();
    let created = null;
    try {
      created = text ? JSON.parse(text) : null;
    } catch {
      // ignore
    }
    if (res.status !== 201 && res.status !== 200) {
      logger.warn('BetterContact create failed', { status: res.status, snippet: text?.slice(0, 200) });
      return null;
    }
    const requestId = created?.id;
    if (!requestId) {
      logger.warn('BetterContact no request id', { snippet: text?.slice(0, 150) });
      return null;
    }

    const maxMs = Number(process.env.BETTERCONTACT_POLL_MS || 5 * 60 * 1000);
    const stepMs = Number(process.env.BETTERCONTACT_POLL_STEP_MS || 2000);
    const deadline = Date.now() + maxMs;
    let lastStatus = '';
    while (Date.now() < deadline) {
      const gr = await fetch(BASE + '/async/' + encodeURIComponent(requestId), {
        headers: { 'X-API-Key': key },
      });
      const gtext = await gr.text();
      let g = null;
      try {
        g = gtext ? JSON.parse(gtext) : null;
      } catch {
        // ignore
      }
      if (!gr.ok) {
        await sleep(stepMs);
        continue;
      }
      const st = String(g?.status || '');
      lastStatus = st;
      if (st === 'terminated' || st === 'completed' || st === 'done' || st === 'success') {
        return pickEmailFromResult(g);
      }
      if (st === 'failed' || st === 'error') {
        logger.warn('BetterContact job failed', { status: st });
        return null;
      }
      await sleep(stepMs);
    }
    logger.warn('BetterContact poll timeout', { requestId, lastStatus });
    return null;
  } catch (err) {
    logger.error('BetterContact error', { error: err.message });
    return null;
  }
}

function pickEmailFromResult(g) {
  if (!g || !Array.isArray(g.data) || g.data.length === 0) return null;
  const d = g.data[0];
  const raw = d.contact_email_address;
  if (!raw || String(raw).includes('*')) return null;
  const status = String(d.contact_email_address_status || '').toLowerCase();
  if (status && status.includes('undeliverable')) return null;
  return String(raw).trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { findWorkEmailBetterContact };
