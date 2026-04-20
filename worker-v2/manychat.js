const logger = require('./logger');

const MANYCHAT_API_TOKEN = process.env.MANYCHAT_API_TOKEN;
const MANYCHAT_FLOW_NS = process.env.MANYCHAT_FLOW_NS;
const MANYCHAT_SMS_CONSENT_PHRASE = process.env.MANYCHAT_SMS_CONSENT_PHRASE || 'I agree to receive SMS updates.';

function bearerHeaders() {
  if (!MANYCHAT_API_TOKEN) return null;
  return {
    Authorization: `Bearer ${MANYCHAT_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function findSubscriberByPhone(phoneE164) {
  const headers = bearerHeaders();
  if (!headers) return null;

  const params = new URLSearchParams({ phone: phoneE164 });
  const res = await fetch(`https://api.manychat.com/fb/subscriber/findBySystemField?${params.toString()}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    logger.error('ManyChat findBySystemField failed', { status: res.status, body });
    return null;
  }
  const data = await res.json();
  if (data.status !== 'success') return null;
  return data.data || null;
}

async function createSubscriberFromLead({ firstName, lastName, phoneE164, email }) {
  const headers = bearerHeaders();
  if (!headers) return null;

  // Per swagger: phone requires has_opt_in_sms and (if true) consent_phrase. Email similarly with has_opt_in_email.
  const hasOptInSms = String(process.env.MANYCHAT_HAS_OPT_IN_SMS || 'true').toLowerCase() === 'true';
  const hasOptInEmail = String(process.env.MANYCHAT_HAS_OPT_IN_EMAIL || 'false').toLowerCase() === 'true';

  const payload = {
    first_name: firstName || '',
    last_name: lastName || '',
    phone: phoneE164 || undefined,
    email: email || undefined,
    has_opt_in_sms: phoneE164 ? hasOptInSms : undefined,
    has_opt_in_email: email ? hasOptInEmail : undefined,
    consent_phrase: phoneE164 && hasOptInSms ? MANYCHAT_SMS_CONSENT_PHRASE : undefined,
  };

  const res = await fetch('https://api.manychat.com/fb/subscriber/createSubscriber', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.error('ManyChat createSubscriber failed', { status: res.status, body });
    return null;
  }
  const data = await res.json();
  if (data.status !== 'success') {
    logger.error('ManyChat createSubscriber non-success', { data });
    return null;
  }
  return data.data || null;
}

async function sendFlowToSubscriber(subscriberId, flowNs) {
  const headers = bearerHeaders();
  if (!headers) return false;
  const ns = flowNs || MANYCHAT_FLOW_NS;
  if (!subscriberId || !ns) return false;

  const res = await fetch('https://api.manychat.com/fb/sending/sendFlow', {
    method: 'POST',
    headers,
    body: JSON.stringify({ subscriber_id: Number(subscriberId), flow_ns: ns }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.error('ManyChat sendFlow failed', { status: res.status, body, subscriberId, flow_ns: ns });
    return false;
  }
  const data = await res.json();
  if (data.status !== 'success') {
    logger.error('ManyChat sendFlow non-success', { data, subscriberId, flow_ns: ns });
    return false;
  }
  return true;
}

async function triggerSmsFlowForLead(lead, phoneE164, email) {
  if (!MANYCHAT_API_TOKEN) {
    logger.warn('MANYCHAT_API_TOKEN not set, skipping ManyChat');
    return { triggered: false, reason: 'missing_token' };
  }
  if (!phoneE164) return { triggered: false, reason: 'missing_phone' };
  if (!MANYCHAT_FLOW_NS) return { triggered: false, reason: 'missing_flow_ns' };

  let subscriber = await findSubscriberByPhone(phoneE164);
  if (!subscriber) {
    subscriber = await createSubscriberFromLead({
      firstName: lead.firstName,
      lastName: lead.lastName,
      phoneE164,
      email,
    });
  }

  const subscriberId = subscriber && (subscriber.id || subscriber.subscriber_id);
  if (!subscriberId) return { triggered: false, reason: 'no_subscriber_id' };

  const ok = await sendFlowToSubscriber(subscriberId, MANYCHAT_FLOW_NS);
  return { triggered: ok, reason: ok ? null : 'send_flow_failed', subscriberId };
}

module.exports = { triggerSmsFlowForLead };

