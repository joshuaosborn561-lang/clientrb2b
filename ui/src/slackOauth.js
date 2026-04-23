const crypto = require('crypto');

const DEFAULT_SCOPES = [
  'channels:history',
  'groups:history',
  'channels:read',
  'groups:read',
  'chat:write',
].join(',');

function stateSecret() {
  return process.env.SLACK_OAUTH_STATE_SECRET || process.env.SLACK_CLIENT_SECRET || '';
}

function publicBase() {
  return (process.env.UI_PUBLIC_URL || '').replace(/\/$/, '');
}

function makeState(clientId) {
  const secret = stateSecret();
  if (!secret) return null;
  const t = Date.now();
  const payload = Buffer.from(JSON.stringify({ c: String(clientId), t })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return payload + '.' + sig;
}

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
  if (!o.c || !o.t || Date.now() - o.t > 20 * 60 * 1000) return null;
  return o.c;
}

function slackClientId() {
  return (process.env.SLACK_CLIENT_ID || '').trim();
}

function botScopes() {
  return (process.env.SLACK_BOT_SCOPES || DEFAULT_SCOPES).trim();
}

function buildAuthorizeUrl({ clientId, redirectPath }) {
  const base = publicBase();
  if (!base || !slackClientId()) return { error: 'missing_slack_oauth_config' };
  const state = makeState(clientId);
  if (!state) return { error: 'missing_state_secret' };
  const redir = base + (redirectPath || '/auth/slack/callback');
  const q = new URLSearchParams({
    client_id: slackClientId(),
    scope: botScopes(),
    user_scope: '',
    redirect_uri: redir,
    state,
  });
  return { url: 'https://slack.com/oauth/v2/authorize?' + q.toString() };
}

async function exchangeCode(code) {
  const id = (process.env.SLACK_CLIENT_ID || '').trim();
  const sec = (process.env.SLACK_CLIENT_SECRET || '').trim();
  const base = publicBase();
  if (!id || !sec || !base) {
    return { error: { message: 'missing env: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, UI_PUBLIC_URL' } };
  }
  const redirectUri = base + '/auth/slack/callback';
  const body = new URLSearchParams({
    client_id: id,
    client_secret: sec,
    code: String(code),
    redirect_uri: redirectUri,
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
  buildAuthorizeUrl,
  exchangeCode,
  slackClientId,
};
