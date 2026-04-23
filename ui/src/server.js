const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const { Pool } = require('pg');
const { ensureTouchpointSchema, registerTouchpointRoutes } = require('./touchpoints');
const { registerWorkerConfigRoutes } = require('./workerConfigApi');
const { readState, buildAuthorizeUrl, exchangeCode } = require('./slackOauth');

const app = express();

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

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
  res.locals.maskSecret = (v) => {
    const s = String(v || '').trim();
    if (!s) return '—';
    return 'saved (···' + s.slice(-4) + ')';
  };
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
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

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

  await pool.query(`alter table clients add column if not exists slack_token text;`);
  await pool.query(`alter table clients add column if not exists prospeo_api_key text;`);
  await pool.query(`alter table clients add column if not exists smartlead_api_key text;`);
  await pool.query(`alter table clients add column if not exists heyreach_api_key text;`);
  await pool.query(`alter table clients drop column if exists worker_config_secret;`);

  await ensureTouchpointSchema(pool);
}

function normalizeStatus(s) {
  if (s === 'paused') return 'paused';
  return 'active';
}

function emptyToNull(v) {
  const t = String(v || '').trim();
  return t === '' ? null : t;
}

function envBlock(client) {
  const base = (process.env.UI_PUBLIC_URL || 'https://YOUR-UI.railway.app').replace(/\/$/, '');
  return [
    `# --- Worker v2 Railway env for: ${client.name}`,
    `# Integration keys live in this UI (Postgres); worker pulls them via GET /api/worker-config/:id`,
    ``,
    `WORKER_CLIENT_ID=${client.id}`,
    `UI_PUBLIC_URL=${base}`,
    `# Same token on BOTH the UI service and this worker (Railway variables):`,
    `WORKER_CONFIG_SECRET=...`,
    ``,
    `# Optional`,
    `# LOOKBACK_SECONDS=604800`,
    ``,
    `# Fallback only if not using config API`,
    `# SLACK_TOKEN=...`,
    `# CHANNEL_ID=${client.slack_channel_id}`,
  ].join('\n');
}

app.get('/', async (req, res) => {
  const { rows } = await pool.query('select * from clients order by created_at desc');
  res.render('index', { title: 'Clients', clients: rows, slackOauth: req.query.slack_oauth });
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
    notes,
    slack_token,
    prospeo_api_key,
    smartlead_api_key,
    heyreach_api_key,
    slack_bot_token_ui,
  } = req.body;

  await pool.query(
    `insert into clients
      (name, status, slack_channel_id, heyreach_campaign_id, smartlead_campaign_id, notes, webhook_secret,
       slack_token, prospeo_api_key, smartlead_api_key, heyreach_api_key, slack_bot_token_ui,
       touchpoint_ingest_secret)
     values ($1,$2,$3,$4,$5,$6, encode(gen_random_bytes(24), 'hex'),
       $7,$8,$9,$10,$11, encode(gen_random_bytes(24), 'hex'))`,
    [
      (name || '').trim(),
      normalizeStatus(status),
      (slack_channel_id || '').trim(),
      (heyreach_campaign_id || '').trim() || null,
      (smartlead_campaign_id || '').trim() || null,
      (notes || '').trim() || null,
      emptyToNull(slack_token),
      emptyToNull(prospeo_api_key),
      emptyToNull(smartlead_api_key),
      emptyToNull(heyreach_api_key),
      emptyToNull(slack_bot_token_ui),
    ]
  );

  res.redirect('/');
});

app.get('/clients/:id', async (req, res) => {
  const { rows } = await pool.query('select * from clients where id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).send('Not found');
  const client = rows[0];
  res.render('client', {
    title: `Client: ${client.name}`,
    client,
    envBlock: envBlock(client),
    slackOauth: req.query.slack_oauth,
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
    notes,
    slack_token,
    prospeo_api_key,
    smartlead_api_key,
    heyreach_api_key,
    slack_bot_token_ui,
  } = req.body;

  const { rows: curRows } = await pool.query('select * from clients where id = $1', [req.params.id]);
  if (curRows.length === 0) return res.status(404).send('Not found');
  const cur = curRows[0];

  const nextSlackToken = emptyToNull(slack_token) != null ? emptyToNull(slack_token) : cur.slack_token;
  const nextProspeo = emptyToNull(prospeo_api_key) != null ? emptyToNull(prospeo_api_key) : cur.prospeo_api_key;
  const nextSl = emptyToNull(smartlead_api_key) != null ? emptyToNull(smartlead_api_key) : cur.smartlead_api_key;
  const nextHr = emptyToNull(heyreach_api_key) != null ? emptyToNull(heyreach_api_key) : cur.heyreach_api_key;
  const nextUiSlack = emptyToNull(slack_bot_token_ui) != null ? emptyToNull(slack_bot_token_ui) : cur.slack_bot_token_ui;

  await pool.query(
    `update clients set
      name = $2,
      status = $3,
      slack_channel_id = $4,
      heyreach_campaign_id = $5,
      smartlead_campaign_id = $6,
      notes = $7,
      slack_token = $8,
      prospeo_api_key = $9,
      smartlead_api_key = $10,
      heyreach_api_key = $11,
      slack_bot_token_ui = $12
     where id = $1`,
    [
      req.params.id,
      (name || '').trim(),
      normalizeStatus(status),
      (slack_channel_id || '').trim(),
      (heyreach_campaign_id || '').trim() || null,
      (smartlead_campaign_id || '').trim() || null,
      (notes || '').trim() || null,
      nextSlackToken,
      nextProspeo,
      nextSl,
      nextHr,
      nextUiSlack,
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

app.get('/health', (req, res) => res.json({ ok: true }));

/** Per-client: redirect to Slack OAuth to install the app in the customer's workspace. */
app.get('/clients/:id/slack-install', async (req, res) => {
  const { rows } = await pool.query('select id from clients where id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).send('Not found');
  const out = buildAuthorizeUrl({ clientId: req.params.id });
  if (out.error) {
    return res
      .status(500)
      .send(
        'Slack OAuth is not configured. On the UI Railway service set: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, UI_PUBLIC_URL, and (optional) SLACK_OAUTH_STATE_SECRET.'
      );
  }
  res.redirect(out.url);
});

/** Registered in the Slack app as a Redirect URL: {UI_PUBLIC_URL}/auth/slack/callback */
app.get('/auth/slack/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  const err = req.query.error;
  if (err) return res.redirect('/?slack_oauth=denied');
  if (!code || !state) {
    console.warn('Slack OAuth callback without code/state (open /auth/slack/callback directly, or wrong redirect URL).');
    return res.redirect('/?slack_oauth=missing');
  }
  const clientId = readState(String(state));
  if (!clientId) return res.redirect('/?slack_oauth=invalid_state');
  const { rows } = await pool.query('select id from clients where id = $1', [clientId]);
  if (rows.length === 0) return res.redirect('/?slack_oauth=unknown_client');
  const tokenResult = await exchangeCode(code);
  if (tokenResult.error) {
    console.error('Slack OAuth exchange', tokenResult.error);
    return res.redirect('/clients/' + clientId + '?slack_oauth=failed');
  }
  const token = tokenResult.access_token;
  if (!token) return res.redirect('/clients/' + clientId + '?slack_oauth=no_token');
  const dup = /^1|true|yes$/i.test(String(process.env.SLACK_DUPLICATE_TOKENS || '').trim());
  if (dup) {
    await pool.query('update clients set slack_token = $2, slack_bot_token_ui = $2 where id = $1', [clientId, token]);
  } else {
    await pool.query('update clients set slack_token = $2 where id = $1', [clientId, token]);
  }
  res.redirect('/clients/' + clientId + '?slack_oauth=ok');
});

ensureSchema()
  .then(() => {
    registerTouchpointRoutes(app, pool);
    registerWorkerConfigRoutes(app, pool);
    app.listen(PORT, () => {
      console.log(`UI listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize schema', err);
    process.exit(1);
  });
