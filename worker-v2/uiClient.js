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

module.exports = { listActiveClients, fetchClientConfig };

