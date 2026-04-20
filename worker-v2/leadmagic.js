const logger = require('./logger');

const LEADMAGIC_API_KEY = process.env.LEADMAGIC_API_KEY;

async function postJson(url, body) {
  if (!LEADMAGIC_API_KEY) {
    throw new Error('LEADMAGIC_API_KEY is required');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-API-Key': LEADMAGIC_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // leave as null
  }
  if (!res.ok) {
    logger.error('LeadMagic HTTP error', { status: res.status, body: text?.slice(0, 1000) });
    throw new Error('LeadMagic HTTP error: ' + res.status);
  }
  return data;
}

async function findWorkEmail({ firstName, lastName, companyDomain, companyName, fullName }) {
  if (!LEADMAGIC_API_KEY) return null;

  const body = {};
  if (fullName) body.full_name = fullName;
  if (firstName) body.first_name = firstName;
  if (lastName) body.last_name = lastName;
  if (companyDomain) body.domain = companyDomain;
  if (companyName) body.company_name = companyName;

  try {
    const data = await postJson('https://api.leadmagic.io/v1/people/email-finder', body);
    const email = data?.email || null;
    if (email) logger.info('LeadMagic email found', { email, status: data?.status || null });
    return email;
  } catch (err) {
    logger.error('LeadMagic email-finder failed', { error: err.message });
    return null;
  }
}

async function findMobile({ profileUrl, workEmail, personalEmail }) {
  if (!LEADMAGIC_API_KEY) return null;

  const body = {};
  if (profileUrl) body.profile_url = profileUrl;
  if (workEmail) body.work_email = workEmail;
  if (personalEmail) body.personal_email = personalEmail;

  try {
    const data = await postJson('https://api.leadmagic.io/v1/people/mobile-finder', body);
    const mobile = data?.mobile_number || null;
    if (mobile) logger.info('LeadMagic mobile found', { mobile, credits: data?.credits_consumed });
    return mobile;
  } catch (err) {
    logger.error('LeadMagic mobile-finder failed', { error: err.message });
    return null;
  }
}

module.exports = { findWorkEmail, findMobile };

