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
      notion_api_key text,
      notion_enrichment_db_id text,
      notion_title_property text,
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
  await pool.query(`alter table clients add column if not exists notion_api_key text;`);
  await pool.query(`alter table clients add column if not exists notion_enrichment_db_id text;`);
  await pool.query(`alter table clients add column if not exists notion_title_property text;`);

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
}

function normalizeStatus(s) {
  if (s === 'paused') return 'paused';
  return 'active';
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
    `# (Legacy single-tenant mode is still supported but not recommended)`,
    `# SLACK_TOKEN=...`,
    `# CHANNEL_ID=${client.slack_channel_id}`,
    ``,
    `# Client secrets are stored in the UI DB and fetched at runtime.`,
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
    prospeo_api_key,
    smartlead_api_key,
    heyreach_api_key,
    bettercontact_api_key,
    notion_api_key,
    notion_enrichment_db_id,
    notion_title_property,
    notes,
  } = req.body;

  await pool.query(
    `insert into clients
      (name, status, slack_channel_id, heyreach_campaign_id, smartlead_campaign_id,
       slack_token, prospeo_api_key, smartlead_api_key, heyreach_api_key, bettercontact_api_key,
       notion_api_key, notion_enrichment_db_id, notion_title_property,
       notes, webhook_secret)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, encode(gen_random_bytes(24), 'hex'))`,
    [
      (name || '').trim(),
      normalizeStatus(status),
      (slack_channel_id || '').trim(),
      (heyreach_campaign_id || '').trim() || null,
      (smartlead_campaign_id || '').trim() || null,
      (slack_token || '').trim() || null,
      (prospeo_api_key || '').trim() || null,
      (smartlead_api_key || '').trim() || null,
      (heyreach_api_key || '').trim() || null,
      (bettercontact_api_key || '').trim() || null,
      (notion_api_key || '').trim() || null,
      (notion_enrichment_db_id || '').trim() || null,
      (notion_title_property || '').trim() || null,
      (notes || '').trim() || null,
    ]
  );

  res.redirect('/');
});

app.get('/clients/:id', async (req, res) => {
  const { rows } = await pool.query('select * from clients where id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).send('Not found');
  const client = rows[0];
  res.render('client', { title: `Client: ${client.name}`, client, envBlock: envBlock(client) });
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
    prospeo_api_key,
    smartlead_api_key,
    heyreach_api_key,
    bettercontact_api_key,
    notion_api_key,
    notion_enrichment_db_id,
    notion_title_property,
    notes,
  } = req.body;

  const { rows: curRows } = await pool.query('select * from clients where id = $1', [req.params.id]);
  if (curRows.length === 0) return res.status(404).send('Not found');
  const cur = curRows[0];
  const emptyToNull = (v) => {
    const t = String(v || '').trim();
    return t ? t : null;
  };

  const nextSlackToken = emptyToNull(slack_token) != null ? emptyToNull(slack_token) : cur.slack_token;
  const nextProspeo = emptyToNull(prospeo_api_key) != null ? emptyToNull(prospeo_api_key) : cur.prospeo_api_key;
  const nextSmartKey = emptyToNull(smartlead_api_key) != null ? emptyToNull(smartlead_api_key) : cur.smartlead_api_key;
  const nextHeyKey = emptyToNull(heyreach_api_key) != null ? emptyToNull(heyreach_api_key) : cur.heyreach_api_key;
  const nextBc = emptyToNull(bettercontact_api_key) != null ? emptyToNull(bettercontact_api_key) : cur.bettercontact_api_key;
  const nextNotion = emptyToNull(notion_api_key) != null ? emptyToNull(notion_api_key) : cur.notion_api_key;
  const nextNotionDb = emptyToNull(notion_enrichment_db_id) != null ? emptyToNull(notion_enrichment_db_id) : cur.notion_enrichment_db_id;
  const nextNotionTitle = emptyToNull(notion_title_property) != null ? emptyToNull(notion_title_property) : cur.notion_title_property;

  await pool.query(
    `update clients set
      name = $2,
      status = $3,
      slack_channel_id = $4,
      heyreach_campaign_id = $5,
      smartlead_campaign_id = $6,
      slack_token = $7,
      prospeo_api_key = $8,
      smartlead_api_key = $9,
      heyreach_api_key = $10,
      bettercontact_api_key = $11,
      notion_api_key = $12,
      notion_enrichment_db_id = $13,
      notion_title_property = $14,
      notes = $15
     where id = $1`,
    [
      req.params.id,
      (name || '').trim(),
      normalizeStatus(status),
      (slack_channel_id || '').trim(),
      (heyreach_campaign_id || '').trim() || null,
      (smartlead_campaign_id || '').trim() || null,
      nextSlackToken,
      nextProspeo,
      nextSmartKey,
      nextHeyKey,
      nextBc,
      nextNotion,
      nextNotionDb,
      nextNotionTitle,
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
  const c = rows[0];
  const base = (process.env.UI_PUBLIC_URL || '').replace(/\/$/, '');
  res.json({
    ok: true,
    client_id: c.id,
    name: c.name,
    status: c.status,
    slack_channel_id: c.slack_channel_id,
    slack_token: c.slack_token || null,
    prospeo_api_key: c.prospeo_api_key || null,
    bettercontact_api_key: c.bettercontact_api_key || null,
    smartlead_api_key: c.smartlead_api_key || null,
    smartlead_campaign_id: c.smartlead_campaign_id || null,
    heyreach_api_key: c.heyreach_api_key || null,
    heyreach_campaign_id: c.heyreach_campaign_id || null,
    notion_api_key: c.notion_api_key || null,
    notion_enrichment_db_id: c.notion_enrichment_db_id || null,
    notion_title_property: c.notion_title_property || null,
    ui_touchpoint_ingest_url: base ? base + '/api/touchpoints/report' : null,
  });
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
