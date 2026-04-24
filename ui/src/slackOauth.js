const crypto = require('crypto');

/** Default minimal read access; add chat:write in Slack + SLACK_BOT_SCOPES for UI posts. */
const DEFAULT_SCOPES = 'channels:history';

function stateSecret() {
  return process.env.SLACK_OAUTH_STATE_SECRET || process.env.SLACK_CLIENT_SECRET || '';
}

/**
 * Public HTTPS origin (no trailing slash) from env / Railway. Used as fallback
 * when the incoming HTTP request does not have a public Host header.
 */
function publicBase() {
  const raw = String(process.env.UI_PUBLIC_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (raw) {
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!/^\/\//.test(raw)) return 'https://' + raw;
  }
  const h = String(
    process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_SERVICE_UI_URL || process.env.RAILWAY_STATIC_URL || ''
  )
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .trim();
  if (h) return 'https://' + h;
  return '';
}

/**
 * Use the request URL so OAuth redirect_uri matches the browser, even if UI_PUBLIC_URL
 * is missing or wrong (e.g. Railway internal health checks).
 */
function publicBaseFromRequest(req) {
  if (!req) return publicBase();
  const host = (req.get('x-forwarded-host') || req.get('host') || '')
    .split(',')[0]
    .trim();
  if (!host || host.includes('railway.internal') || host === 'localhost' || /^\[?127\./.test(host)) {
    return publicBase();
  }
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https')
    .split(',')[0]
    .trim() || 'https';
  return proto + '://' + host;
}

function makeState(clientId, redirectCallbackUrl) {
  const secret = stateSecret();
  if (!secret) return null;
  const t = Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      c: String(clientId),
      t,
      u: String(redirectCallbackUrl),
    })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return payload + '.' + sig;
}

/**
 * @returns {{ clientId: string, redirectUri: string } | null}
 */
function readState(state) {
  if (!state || typeof state !== 'string' || !state.includes('.')) return null;
  const secret = stateSecret();
  if (!secret) return null;
  const dot = state.indexOf('.');
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (expected !== sig) return null;
  let o;
  try {
    o = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  if (!o.c || !o.t) return null;
  if (Date.now() - o.t > 20 * 60 * 1000) return null;
  const redirectUri = o.u && String(o.u).trim() ? String(o.u).trim() : publicBase() + '/auth/slack/callback';
  if (!redirectUri || !redirectUri.startsWith('http')) return null;
  return { clientId: String(o.c), redirectUri };
}

function slackClientId() {
  return (process.env.SLACK_CLIENT_ID || '').trim();
}

function botScopes() {
  return (process.env.SLACK_BOT_SCOPES || DEFAULT_SCOPES).trim();
}

function buildAuthorizeUrl({ clientId, req, redirectPath }) {
  const base = publicBaseFromRequest(req);
  if (!base || !slackClientId()) return { error: 'missing_slack_oauth_config' };
  const callback = base + (redirectPath || '/auth/slack/callback');
  const state = makeState(clientId, callback);
  if (!state) return { error: 'missing_state_secret' };
  const q = new URLSearchParams({
    client_id: slackClientId(),
    scope: botScopes(),
    user_scope: '',
    redirect_uri: callback,
    state,
  });
  return { url: 'https://slack.com/oauth/v2/authorize?' + q.toString() };
}

async function exchangeCode(code, redirectUri) {
  const id = (process.env.SLACK_CLIENT_ID || '').trim();
  const sec = (process.env.SLACK_CLIENT_SECRET || '').trim();
  if (!id || !sec) {
    return { error: { message: 'missing env: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET' } };
  }
  if (!redirectUri) {
    return { error: { message: 'missing redirect_uri' } };
  }
  const body = new URLSearchParams({
    client_id: id,
    client_secret: sec,
    code: String(code),
    redirect_uri: String(redirectUri).trim(),
  });
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!data.ok) {
    return { error: data };
  }
  return { access_token: data.access_token, team: data.team };
}

module.exports = {
  makeState,
  readState,
  publicBase,
  publicBaseFromRequest,
  buildAuthorizeUrl,
  exchangeCode,
  slackClientId,
};
