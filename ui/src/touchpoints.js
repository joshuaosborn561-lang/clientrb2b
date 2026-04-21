const express = require('express');

const jsonParser = express.json({ limit: '2mb', type: '*/*' });

function randomSecret() {
  return crypto.randomBytes(24).toString('hex');
}

async function ensureTouchpointSchema(pool) {
  await pool.query(`
    alter table clients add column if not exists webhook_secret text;
  `);
  await pool.query(`
    update clients
    set webhook_secret = encode(gen_random_bytes(24), 'hex')
    where webhook_secret is null or webhook_secret = '';
  `);

  await pool.query(`
    create table if not exists lead_touchpoints (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references clients(id) on delete cascade,
      lead_key text not null,
      slack_message_ts text,
      visited_at_raw text,
      visit_instant timestamptz,
      enrolled_smartlead_at timestamptz,
      enrolled_heyreach_at timestamptz,
      first_email_engagement_at timestamptz,
      first_linkedin_engagement_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (client_id, lead_key)
    );
  `);

  await pool.query(`
    create index if not exists lead_touchpoints_client_idx on lead_touchpoints(client_id);
  `);

  await pool.query(`
    do $$
    begin
      if not exists (select 1 from pg_trigger where tgname = 'lead_touchpoints_set_updated_at') then
        create trigger lead_touchpoints_set_updated_at before update on lead_touchpoints
        for each row execute function set_updated_at();
      end if;
    end
    $$;
  `);
}

function ingestSecret() {
  return process.env.UI_TOUCHPOINT_INGEST_SECRET;
}

function slackToken() {
  return process.env.SLACK_BOT_TOKEN || process.env.SLACK_TOKEN || '';
}

async function slackPostMessage(channelId, text) {
  const token = slackToken();
  if (!token || !channelId) return { ok: false, error: 'missing_slack' };
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: channelId, text }),
  });
  const data = await res.json();
  if (!data.ok) return { ok: false, error: data.error || 'slack_error' };
  return { ok: true };
}

function formatDurationMs(ms) {
  if (ms == null || Number.isNaN(ms)) return null;
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h % 24 > 0) parts.push((h % 24) + 'h');
  if (m % 60 > 0 && d === 0) parts.push((m % 60) + 'm');
  if (parts.length === 0) parts.push(Math.max(1, sec) + 's');
  return parts.join(' ');
}

async function getClientByChannel(pool, slackChannelId) {
  const { rows } = await pool.query('select * from clients where slack_channel_id = $1 limit 1', [slackChannelId]);
  return rows[0] || null;
}

async function getClientById(pool, id) {
  const { rows } = await pool.query('select * from clients where id = $1', [id]);
  return rows[0] || null;
}

function normalizeLeadKeyEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function extractLinkedinFromHeyreachPayload(body) {
  const candidates = [];
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string' && (v.includes('linkedin.com/in') || v.includes('linkedin.com/company'))) {
        candidates.push(v);
      } else if (typeof v === 'object' && v !== null) walk(v);
    }
  };
  walk(body);
  for (const c of candidates) {
    const n = normalizeLeadKeyLinkedin(c);
    if (n) return n;
  }
  return '';
}

function normalizeLeadKeyLinkedin(url) {
  if (!url) return '';
  let u = String(url).trim();
  u = u.replace(/^https?:\/\//i, '');
  u = u.replace(/^www\./i, '');
  u = u.replace(/\/$/, '');
  return u.toLowerCase();
}

async function upsertTouchpoint(pool, clientId, leadKey, patch) {
  await pool.query(
    `insert into lead_touchpoints (client_id, lead_key, slack_message_ts, visited_at_raw, visit_instant)
     values ($1, $2, $3, $4, $5)
     on conflict (client_id, lead_key) do update set
       slack_message_ts = coalesce(excluded.slack_message_ts, lead_touchpoints.slack_message_ts),
       visited_at_raw = coalesce(excluded.visited_at_raw, lead_touchpoints.visited_at_raw),
       visit_instant = coalesce(excluded.visit_instant, lead_touchpoints.visit_instant),
       updated_at = now()`,
    [
      clientId,
      leadKey,
      patch.slack_message_ts || null,
      patch.visited_at_raw || null,
      patch.visit_instant || null,
    ]
  );

  if (patch.enrolled_smartlead_at) {
    await pool.query(
      `update lead_touchpoints set enrolled_smartlead_at = coalesce(enrolled_smartlead_at, $3), updated_at = now()
       where client_id = $1 and lead_key = $2`,
      [clientId, leadKey, patch.enrolled_smartlead_at]
    );
  }
  if (patch.enrolled_heyreach_at) {
    await pool.query(
      `update lead_touchpoints set enrolled_heyreach_at = coalesce(enrolled_heyreach_at, $3), updated_at = now()
       where client_id = $1 and lead_key = $2`,
      [clientId, leadKey, patch.enrolled_heyreach_at]
    );
  }
}

async function fetchTouchpoint(pool, clientId, leadKey) {
  const { rows } = await pool.query(
    'select * from lead_touchpoints where client_id = $1 and lead_key = $2',
    [clientId, leadKey]
  );
  return rows[0] || null;
}

async function handleIngestReport(pool, body) {
  const clientExternal = body.client_external_id;
  const type = body.type;
  const leadKey = String(body.lead_key || '').trim();
  if (!clientExternal || !type || !leadKey) {
    return { status: 400, json: { ok: false, error: 'missing_fields' } };
  }

  const client = await getClientByChannel(pool, clientExternal);
  if (!client) return { status: 404, json: { ok: false, error: 'client_not_found' } };

  const patch = {
    slack_message_ts: body.slack_message_ts || null,
    visited_at_raw: body.visited_at_raw || null,
    visit_instant: body.visit_instant ? new Date(body.visit_instant) : null,
  };
  if (type === 'enrolled_smartlead') patch.enrolled_smartlead_at = new Date();
  if (type === 'enrolled_heyreach') patch.enrolled_heyreach_at = new Date();

  await upsertTouchpoint(pool, client.id, leadKey, patch);
  return { status: 200, json: { ok: true } };
}

async function maybeNotifyFirstEngagement(pool, client, row, engagementLabel, at) {
  const visit = row.visit_instant ? new Date(row.visit_instant) : null;
  const parts = ['*' + engagementLabel + '*', 'Lead: `' + row.lead_key + '`'];
  if (visit && !Number.isNaN(visit.getTime())) {
    const dur = formatDurationMs(at.getTime() - visit.getTime());
    parts.push('Time from *website visit* to first engagement: *' + (dur || 'unknown') + '*');
  } else if (row.visited_at_raw) {
    parts.push('Visit time (RB2B text): `' + row.visited_at_raw + '` — could not parse for duration.');
  } else {
    parts.push('No visit timestamp in RB2B alert; engagement at `' + at.toISOString() + '`');
  }
  await slackPostMessage(client.slack_channel_id, parts.join('\n'));
}

async function handleSmartLeadWebhook(pool, clientId, secret, reqBody) {
  const client = await getClientById(pool, clientId);
  if (!client || client.webhook_secret !== secret) {
    return { status: 401, json: { ok: false } };
  }

  const event = String(reqBody.event || reqBody.type || '').toUpperCase();
  const email = normalizeLeadKeyEmail(reqBody.lead?.email || reqBody.email);
  if (!email) return { status: 200, json: { ok: true, ignored: true } };

  const engagementEvents = ['EMAIL_SENT', 'SENT', 'EMAIL_OPENED', 'EMAIL_CLICKED', 'EMAIL_REPLIED'];
  if (!engagementEvents.includes(event)) {
    return { status: 200, json: { ok: true, ignored: true } };
  }

  const tsRaw = reqBody.timestamp || reqBody.sent_at || reqBody.created_at;
  const at = tsRaw ? new Date(tsRaw) : new Date();
  if (Number.isNaN(at.getTime())) return { status: 200, json: { ok: true } };

  const row = await fetchTouchpoint(pool, client.id, email);
  if (!row) return { status: 200, json: { ok: true, unknown_lead: true } };

  if (row.first_email_engagement_at) {
    return { status: 200, json: { ok: true, duplicate: true } };
  }

  await pool.query(
    'update lead_touchpoints set first_email_engagement_at = $3, updated_at = now() where client_id = $1 and lead_key = $2 and first_email_engagement_at is null',
    [client.id, email, at]
  );

  const updated = await fetchTouchpoint(pool, client.id, email);
  await maybeNotifyFirstEngagement(pool, client, updated, 'First email engagement', at);
  return { status: 200, json: { ok: true } };
}

function isHeyreachEngagementEvent(eventName) {
  const e = String(eventName || '').toLowerCase();
  return (
    e.includes('message_sent') ||
    e.includes('messagesent') ||
    e.includes('connection_request') ||
    e.includes('connection_accepted') ||
    e.includes('inmail') ||
    e === 'engagement'
  );
}

async function handleHeyreachWebhook(pool, clientId, secret, reqBody) {
  const client = await getClientById(pool, clientId);
  if (!client || client.webhook_secret !== secret) {
    return { status: 401, json: { ok: false } };
  }

  const eventName = reqBody.event || reqBody.type || reqBody.eventType || reqBody.name || '';
  if (!isHeyreachEngagementEvent(eventName)) {
    return { status: 200, json: { ok: true, ignored: true } };
  }

  const leadKey = extractLinkedinFromHeyreachPayload(reqBody);
  if (!leadKey) return { status: 200, json: { ok: true, ignored: true } };

  const tsRaw = reqBody.timestamp || reqBody.createdAt || reqBody.sentAt || reqBody.date;
  const at = tsRaw ? new Date(tsRaw) : new Date();
  if (Number.isNaN(at.getTime())) return { status: 200, json: { ok: true } };

  const row = await fetchTouchpoint(pool, client.id, leadKey);
  if (!row) return { status: 200, json: { ok: true, unknown_lead: true } };

  if (row.first_linkedin_engagement_at) {
    return { status: 200, json: { ok: true, duplicate: true } };
  }

  await pool.query(
    'update lead_touchpoints set first_linkedin_engagement_at = $3, updated_at = now() where client_id = $1 and lead_key = $2 and first_linkedin_engagement_at is null',
    [client.id, leadKey, at]
  );

  const updated = await fetchTouchpoint(pool, client.id, leadKey);
  await maybeNotifyFirstEngagement(pool, client, updated, 'First LinkedIn engagement', at);
  return { status: 200, json: { ok: true } };
}

function registerTouchpointRoutes(app, pool) {
  app.post('/api/touchpoints/report', jsonParser, async (req, res) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!ingestSecret() || token !== ingestSecret()) {
      return res.status(401).json({ ok: false });
    }
    const out = await handleIngestReport(pool, req.body || {});
    return res.status(out.status).json(out.json);
  });

  app.post('/hooks/smartlead/:clientId/:secret', jsonParser, async (req, res) => {
    const out = await handleSmartLeadWebhook(pool, req.params.clientId, req.params.secret, req.body || {});
    return res.status(out.status).json(out.json);
  });

  app.post('/hooks/heyreach/:clientId/:secret', jsonParser, async (req, res) => {
    const out = await handleHeyreachWebhook(pool, req.params.clientId, req.params.secret, req.body || {});
    return res.status(out.status).json(out.json);
  });
}

module.exports = {
  ensureTouchpointSchema,
  registerTouchpointRoutes,
};
