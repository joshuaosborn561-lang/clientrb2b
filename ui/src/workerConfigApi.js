/**
 * Worker pulls full client secrets from the UI via GET /api/worker-config/:clientId
 * Authorization: Bearer WORKER_CONFIG_SECRET — set the same value on the UI service and worker (Railway env).
 */

function workerConfigSecretGlobal() {
  return String(process.env.WORKER_CONFIG_SECRET || '').trim();
}

function publicBase() {
  return (process.env.UI_PUBLIC_URL || '').replace(/\/$/, '');
}

function touchpointIngestSecretForClient(client) {
  if (client.touchpoint_ingest_secret && String(client.touchpoint_ingest_secret).trim()) {
    return String(client.touchpoint_ingest_secret).trim();
  }
  return String(process.env.UI_TOUCHPOINT_INGEST_SECRET || '').trim();
}

function registerWorkerConfigRoutes(app, pool) {
  app.get('/api/worker-config/:clientId', async (req, res) => {
    const auth = req.headers.authorization || '';
    const token = String(auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '').trim();

    const { rows } = await pool.query('select * from clients where id = $1', [req.params.clientId]);
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const c = rows[0];
    const expected = workerConfigSecretGlobal();
    if (!expected || token !== expected) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const base = publicBase();
    const ingestSecret = touchpointIngestSecretForClient(c);

    return res.json({
      ok: true,
      client_id: c.id,
      name: c.name,
      slack_token: c.slack_token || null,
      slack_channel_id: c.slack_channel_id,
      prospeo_api_key: c.prospeo_api_key || null,
      smartlead_api_key: c.smartlead_api_key || null,
      smartlead_campaign_id: c.smartlead_campaign_id || null,
      heyreach_api_key: c.heyreach_api_key || null,
      heyreach_campaign_id: c.heyreach_campaign_id || null,
      ui_touchpoint_ingest_url: base ? base + '/api/touchpoints/report' : null,
      ui_touchpoint_ingest_secret: ingestSecret || null,
    });
  });
}

module.exports = { registerWorkerConfigRoutes };
