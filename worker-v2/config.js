const logger = require('./logger');

/**
 * Pulls secrets from the UI when WORKER_CLIENT_ID + UI_PUBLIC_URL + WORKER_CONFIG_SECRET are set.
 * Falls back to process.env only when those are not all present or the fetch fails.
 */
async function loadWorkerConfig() {
  const clientId = process.env.WORKER_CLIENT_ID;
  const base = (process.env.UI_PUBLIC_URL || '').replace(/\/$/, '');
  const secret = process.env.WORKER_CONFIG_SECRET || '';
  if (!clientId || !base || !secret) {
    return null;
  }

  try {
    const res = await fetch(base + '/api/worker-config/' + clientId, {
      headers: { Authorization: 'Bearer ' + secret },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // ignore
    }
    if (!res.ok || !data || !data.ok) {
      logger.error('Worker config fetch failed', { status: res.status, snippet: text?.slice(0, 200) });
      return null;
    }
    return data;
  } catch (err) {
    logger.error('Worker config fetch error', { error: err.message });
    return null;
  }
}

function applyWorkerConfig(data) {
  if (!data) return;
  if (data.slack_token) process.env.SLACK_TOKEN = String(data.slack_token);
  if (data.slack_channel_id) process.env.CHANNEL_ID = String(data.slack_channel_id);
  if (data.prospeo_api_key) process.env.PROSPEO_API_KEY = String(data.prospeo_api_key);
  if (data.smartlead_api_key) process.env.SMARTLEAD_API_KEY = String(data.smartlead_api_key);
  if (data.smartlead_campaign_id != null && data.smartlead_campaign_id !== '')
    process.env.SMARTLEAD_CAMPAIGN_ID = String(data.smartlead_campaign_id);
  if (data.heyreach_api_key) process.env.HEYREACH_API_KEY = String(data.heyreach_api_key);
  if (data.heyreach_campaign_id != null && data.heyreach_campaign_id !== '')
    process.env.HEYREACH_CAMPAIGN_ID = String(data.heyreach_campaign_id);
  if (data.ui_touchpoint_ingest_url) process.env.UI_TOUCHPOINT_INGEST_URL = String(data.ui_touchpoint_ingest_url);
  if (data.ui_touchpoint_ingest_secret)
    process.env.UI_TOUCHPOINT_INGEST_SECRET = String(data.ui_touchpoint_ingest_secret);
}

module.exports = { loadWorkerConfig, applyWorkerConfig };
