const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const { Pool } = require('pg');
const { ensureTouchpointSchema, registerTouchpointRoutes } = require('./touchpoints');

const app = express();

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const WORKER_CONFIG_SECRET = String(process.env.WORKER_CONFIG_SECRET || '').trim();

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the UI service');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.locals.publicBase = (process.env.UI_PUBLIC_URL || '').replace(/\/$/, '');
  next();
});

const pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : undefined });

/** Shared across all clients — set on the UI Railway service (worker reads via API). */
function defaultSlackBotToken() {
  return String(process.env.DEFAULT_SLACK_BOT_TOKEN || '').trim();
}
function defaultProspeoKey() {
  return String(process.env.DEFAULT_PROSPEO_API_KEY || '').trim();
}
function defaultBetterContactKey() {
  return String(process.env.DEFAULT_BETTERCONTACT_API_KEY || '').trim();
}

function workerConfigPayload(c) {
  const base = (process.env.UI_PUBLIC_URL || '').replace(/\/$/, '');
  const slack_token = (c.slack_token && String(c.slack_token).trim()) || defaultSlackBotToken() || null;
  const prospeo_api_key = (c.prospeo_api_key && String(c.prospeo_api_key).trim()) || defaultProspeoKey() || null;
  const bettercontact_api_key =
    (c.bettercontact_api_key && String(c.bettercontact_api_key).trim()) || defaultBetterContactKey() || null;
  return {
    ok: true,
    client_id: c.id,
    name: c.name,
    status: c.status,
    slack_channel_id: c.slack_channel_id,
    slack_token,
    prospeo_api_key,
    bettercontact_api_key,
    smartlead_api_key: c.smartlead_api_key || null,
    smartlead_campaign_id: c.smartlead_campaign_id || null,
    heyreach_api_key: c.heyreach_api_key || null,
    heyreach_campaign_id: c.heyreach_campaign_id || null,
    icp_filter_enabled: c.icp_filter_enabled === true,
    ui_touchpoint_ingest_url: base ? base + '/api/touchpoints/report' : null,
  };
}

async function ensureSchema() {
  await pool.query(`create extension if not exists pgcrypto;`);
  await pool.query(`
    create table if not exists clients (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      status text not null default 'active',
      slack_channel_id text not null,
      heyreach_campaign_id text,
      smartlead_campaign_id text,
      slack_token text,
      prospeo_api_key text,
      smartlead_api_key text,
      heyreach_api_key text,
      bettercontact_api_key text,
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  // Backwards-compatible migrations for existing DBs.
  await pool.query(`alter table clients add column if not exists slack_token text;`);
  await pool.query(`alter table clients add column if not exists prospeo_api_key text;`);
  await pool.query(`alter table clients add column if not exists smartlead_api_key text;`);
  await pool.query(`alter table clients add column if not exists heyreach_api_key text;`);
  await pool.query(`alter table clients add column if not exists bettercontact_api_key text;`);
  // ICP filtering is OFF by default. RB2B website visitors are usually small companies,
  // and a one-size-fits-all ICP filter silently dropped every lead for clients it was not
  // tuned for (this is why Nieto stopped enrolling). Opt in per client only.
  await pool.query(`alter table clients add column if not exists icp_filter_enabled boolean not null default false;`);
  await pool.query(`alter table clients drop column if exists notion_api_key;`);
  await pool.query(`alter table clients drop column if exists notion_enrichment_db_id;`);
  await pool.query(`alter table clients drop column if exists notion_title_property;`);

  await pool.query(`alter table clients drop column if exists manychat_flow_ns;`);
  await pool.query(`alter table clients drop column if exists manychat_sms_consent_phrase;`);

  await pool.query(`
    do $$
    begin
      if not exists (select 1 from pg_proc where proname = 'set_updated_at') then
        create or replace function set_updated_at() returns trigger as $fn$
        begin
          new.updated_at = now();
          return new;
        end;
        $fn$ language plpgsql;
      end if;
    end
    $$;
  `);
  await pool.query(`
    do $$
    begin
      if not exists (select 1 from pg_trigger where tgname = 'clients_set_updated_at') then
        create trigger clients_set_updated_at before update on clients
        for each row execute function set_updated_at();
      end if;
    end
    $$;
  `);

  await ensureTouchpointSchema(pool);

  // Dedup: which RB2B Slack messages the worker has already fully handled per client.
  // Lets the cron re-scan a wide window cheaply (only new messages do enrichment/enroll work),
  // prevents duplicate SmartLead submits + duplicate Slack posts, and makes catch-up idempotent.
  await pool.query(`
    create table if not exists processed_messages (
      client_id uuid not null references clients(id) on delete cascade,
      slack_message_ts text not null,
      lead_key text,
      outcome text,
      processed_at timestamptz not null default now(),
      primary key (client_id, slack_message_ts)
    );
  `);
  await pool.query(`create index if not exists processed_messages_client_idx on processed_messages(client_id);`);

  await pool.query(`
    insert into clients (name, status, slack_channel_id, heyreach_campaign_id, smartlead_campaign_id, notes)
    select 'Nieto', 'paused', 'C0000000000', null, null,
           'Set status=active + the real RB2B Slack channel ID and SmartLead/HeyReach campaign IDs + API keys (Edit). Shared Prospeo/BetterContact/Slack bot come from UI Railway env. ICP filter is off by default so every visitor is enrolled.'
    where not exists (select 1 from clients where lower(trim(name)) = 'nieto');
  `);
}

function normalizeStatus(s) {
  if (s === 'paused') return 'paused';
  return 'active';
}

function isChecked(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  return t === 'on' || t === 'true' || t === '1' || t === 'yes';
}

function maskSecret(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (t.length <= 10) return '••••••';
  return t.slice(0, 4) + '…' + t.slice(-4);
}

function requireWorkerAuth(req, res) {
  const auth = String(req.headers.authorization || '');
  const token = String(auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '').trim();
  if (!WORKER_CONFIG_SECRET || token !== WORKER_CONFIG_SECRET) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

function envBlock(client) {
  const base = (process.env.UI_PUBLIC_URL || 'https://YOUR-UI.railway.app').replace(/\/$/, '');
  return [
    `# --- Worker v2 env for: ${client.name}`,
    `# Multi-tenant worker-v2 (recommended):`,
    `UI_PUBLIC_URL=${base}`,
    `WORKER_CONFIG_SECRET=... (same as UI)`,
    ``,
    `# Shared defaults (UI service — worker merges into each client):`,
    `# DEFAULT_SLACK_BOT_TOKEN=xoxb-...`,
    `# DEFAULT_PROSPEO_API_KEY=pk_...`,
    `# DEFAULT_BETTERCONTACT_API_KEY=...`,
    ``,
    `# Per client in the UI: Slack channel ID, optional Slack bot if workspace ≠ default, SmartLead + HeyReach.`,
    ``,
    `# Touchpoint ingest (same secret on UI + worker)`,
    `UI_TOUCHPOINT_INGEST_SECRET=...`,
    `UI_TOUCHPOINT_INGEST_URL=${base}/api/touchpoints/report`,
    ``,
    `# Webhooks (configure in SmartLead + HeyReach; use client page for exact URLs)`,
    `# SmartLead → ${base}/hooks/smartlead/${client.id}/${client.webhook_secret || 'SECRET'}`,
    `# HeyReach → ${base}/hooks/heyreach/${client.id}/${client.webhook_secret || 'SECRET'}`,
    ``,
    `# UI must post back to Slack (same workspace as RB2B channel)`,
    `SLACK_BOT_TOKEN=...`,
  ].join('\n');
}

app.get('/', async (req, res) => {
  const { rows } = await pool.query('select * from clients order by created_at desc');
  res.render('index', { title: 'Clients', clients: rows });
});

app.get('/clients/new', async (req, res) => {
  res.render('client_form', { title: 'New client', client: null, mode: 'new' });
});

app.post('/clients', async (req, res) => {
  const {
    name,
    status,
    slack_channel_id,
    heyreach_campaign_id,
    smartlead_campaign_id,
    slack_token,
    smartlead_api_key,
    heyreach_api_key,
    icp_filter_enabled,
    notes,
  } = req.body;

  await pool.query(
    `insert into clients
      (name, status, slack_channel_id, heyreach_campaign_id, smartlead_campaign_id,
       slack_token, smartlead_api_key, heyreach_api_key, icp_filter_enabled,
       notes, webhook_secret)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, encode(gen_random_bytes(24), 'hex'))`,
    [
      (name || '').trim(),
      normalizeStatus(status),
      (slack_channel_id || '').trim(),
      (heyreach_campaign_id || '').trim() || null,
      (smartlead_campaign_id || '').trim() || null,
      (slack_token || '').trim() || null,
      (smartlead_api_key || '').trim() || null,
      (heyreach_api_key || '').trim() || null,
      isChecked(icp_filter_enabled),
      (notes || '').trim() || null,
    ]
  );

  const { rows } = await pool.query('select id from clients order by created_at desc limit 1');
  res.redirect(rows[0] ? '/clients/' + rows[0].id : '/');
});

app.get('/clients/:id', async (req, res) => {
  const { rows } = await pool.query('select * from clients where id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).send('Not found');
  const client = rows[0];
  res.render('client', {
    title: `Client: ${client.name}`,
    client,
    envBlock: envBlock(client),
    maskSecret,
    defaultSlackBotToken,
    defaultProspeoKey,
    defaultBetterContactKey,
  });
});

app.get('/clients/:id/edit', async (req, res) => {
  const { rows } = await pool.query('select * from clients where id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).send('Not found');
  res.render('client_form', { title: `Edit: ${rows[0].name}`, client: rows[0], mode: 'edit' });
});

app.post('/clients/:id', async (req, res) => {
  const {
    name,
    status,
    slack_channel_id,
    heyreach_campaign_id,
    smartlead_campaign_id,
    slack_token,
    smartlead_api_key,
    heyreach_api_key,
    icp_filter_enabled,
    notes,
  } = req.body;

  const { rows: curRows } = await pool.query('select * from clients where id = $1', [req.params.id]);
  if (curRows.length === 0) return res.status(404).send('Not found');
  const emptyToNull = (v) => {
    const t = String(v || '').trim();
    return t ? t : null;
  };

  const nextSlackToken = emptyToNull(slack_token) != null ? emptyToNull(slack_token) : curRows[0].slack_token;
  const nextSmartKey = emptyToNull(smartlead_api_key) != null ? emptyToNull(smartlead_api_key) : curRows[0].smartlead_api_key;
  const nextHeyKey = emptyToNull(heyreach_api_key) != null ? emptyToNull(heyreach_api_key) : curRows[0].heyreach_api_key;

  await pool.query(
    `update clients set
      name = $2,
      status = $3,
      slack_channel_id = $4,
      heyreach_campaign_id = $5,
      smartlead_campaign_id = $6,
      slack_token = $7,
      smartlead_api_key = $8,
      heyreach_api_key = $9,
      icp_filter_enabled = $10,
      notes = $11
     where id = $1`,
    [
      req.params.id,
      (name || '').trim(),
      normalizeStatus(status),
      (slack_channel_id || '').trim(),
      (heyreach_campaign_id || '').trim() || null,
      (smartlead_campaign_id || '').trim() || null,
      nextSlackToken,
      nextSmartKey,
      nextHeyKey,
      isChecked(icp_filter_enabled),
      (notes || '').trim() || null,
    ]
  );
  res.redirect('/clients/' + req.params.id);
});

app.post('/clients/:id/toggle', async (req, res) => {
  const { rows } = await pool.query('select status from clients where id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).send('Not found');
  const next = rows[0].status === 'paused' ? 'active' : 'paused';
  await pool.query('update clients set status = $2 where id = $1', [req.params.id, next]);
  res.redirect('/clients/' + req.params.id);
});

// --- Worker API (multi-tenant) ---
app.get('/api/worker/clients', async (req, res) => {
  if (!requireWorkerAuth(req, res)) return;
  const { rows } = await pool.query(
    `select id, name, status, slack_channel_id
     from clients
     where status = 'active'
     order by created_at asc`
  );
  res.json({ ok: true, clients: rows });
});

app.get('/api/worker-config/:clientId', async (req, res) => {
  if (!requireWorkerAuth(req, res)) return;
  const { rows } = await pool.query('select * from clients where id = $1', [req.params.clientId]);
  if (rows.length === 0) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json(workerConfigPayload(rows[0]));
});

// Dedup: which Slack messages a client has already fully handled.
app.get('/api/worker/processed/:clientId', async (req, res) => {
  if (!requireWorkerAuth(req, res)) return;
  const oldest = String(req.query.oldest || '').trim();
  const params = [req.params.clientId];
  let sql = 'select slack_message_ts from processed_messages where client_id = $1';
  if (oldest && /^\d+(\.\d+)?$/.test(oldest)) {
    sql += ' and slack_message_ts >= $2';
    params.push(oldest);
  }
  try {
    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, ts: rows.map((r) => r.slack_message_ts) });
  } catch (err) {
    res.json({ ok: true, ts: [] });
  }
});

app.post('/api/worker/processed/:clientId', async (req, res) => {
  if (!requireWorkerAuth(req, res)) return;
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : body.ts ? [{ ts: body.ts, lead_key: body.lead_key, outcome: body.outcome }] : [];
  const valid = items.filter((i) => i && String(i.ts || '').trim());
  if (valid.length === 0) return res.json({ ok: true, saved: 0 });
  try {
    for (const i of valid) {
      await pool.query(
        `insert into processed_messages (client_id, slack_message_ts, lead_key, outcome)
         values ($1,$2,$3,$4)
         on conflict (client_id, slack_message_ts) do update set
           lead_key = coalesce(excluded.lead_key, processed_messages.lead_key),
           outcome = excluded.outcome,
           processed_at = now()`,
        [req.params.clientId, String(i.ts).trim(), (i.lead_key || '').toString().trim() || null, (i.outcome || '').toString().trim() || null]
      );
    }
    res.json({ ok: true, saved: valid.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'save_failed' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

ensureSchema()
  .then(() => {
    registerTouchpointRoutes(app, pool);
    app.listen(PORT, () => {
      console.log(`UI listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize schema', err);
    process.exit(1);
  });
