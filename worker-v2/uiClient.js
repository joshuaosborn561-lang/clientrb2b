const logger = require('./logger');

function requireEnv(name) {
  const v = String(process.env[name] || '').trim();
  if (!v) throw new Error(name + ' is required');
  return v;
}

function baseUrl() {
  return requireEnv('UI_PUBLIC_URL').replace(/\/$/, '');
}

function authHeader() {
  return { Authorization: 'Bearer ' + requireEnv('WORKER_CONFIG_SECRET') };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: authHeader() });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (!res.ok) {
    logger.error('UI API HTTP error', { status: res.status, url, snippet: text?.slice(0, 200) });
    throw new Error('ui_http_' + res.status);
  }
  if (!data || data.ok !== true) {
    logger.error('UI API bad response', { url, snippet: text?.slice(0, 200) });
    throw new Error('ui_bad_response');
  }
  return data;
}

async function listActiveClients() {
  const url = baseUrl() + '/api/worker/clients';
  const data = await fetchJson(url);
  return Array.isArray(data.clients) ? data.clients : [];
}

async function fetchClientConfig(clientId) {
  const url = baseUrl() + '/api/worker-config/' + encodeURIComponent(clientId);
  return await fetchJson(url);
}

/** Returns a Set of Slack message ts strings this client has already fully handled. */
async function fetchProcessedSet(clientId, oldest) {
  try {
    const q = oldest ? '?oldest=' + encodeURIComponent(oldest) : '';
    const url = baseUrl() + '/api/worker/processed/' + encodeURIComponent(clientId) + q;
    const data = await fetchJson(url);
    return new Set(Array.isArray(data.ts) ? data.ts.map((t) => String(t)) : []);
  } catch (err) {
    logger.warn('Could not fetch processed set (continuing without dedup)', { clientId, error: err.message });
    return new Set();
  }
}

/** Marks one Slack message as fully handled so future runs skip it. Best-effort. */
async function markProcessed(clientId, ts, leadKey, outcome) {
  if (!ts) return;
  try {
    const url = baseUrl() + '/api/worker/processed/' + encodeURIComponent(clientId);
    await fetch(url, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: String(ts), lead_key: leadKey || null, outcome: outcome || null }),
    });
  } catch (err) {
    logger.warn('Could not mark message processed', { clientId, ts, error: err.message });
  }
}

module.exports = { listActiveClients, fetchClientConfig, fetchProcessedSet, markProcessed };

