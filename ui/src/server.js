const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const UI_ADMIN_USER = process.env.UI_ADMIN_USER || 'admin';
const UI_ADMIN_PASS = process.env.UI_ADMIN_PASS;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the UI service');
}
if (!UI_ADMIN_PASS) {
  throw new Error('UI_ADMIN_PASS is required for the UI service');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function requireBasicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="rb2b-lead-router-ui"');
    return res.status(401).send('Auth required');
  }
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
  if (user !== UI_ADMIN_USER || !constantTimeEqual(pass, UI_ADMIN_PASS)) {
    res.set('WWW-Authenticate', 'Basic realm="rb2b-lead-router-ui"');
    return res.status(401).send('Invalid credentials');
  }
  return next();
}

app.use(requireBasicAuth);

const pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : undefined });

async function ensureSchema() {
  // Needed for gen_random_uuid(). Railway Postgres typically has this available.
  await pool.query(`create extension if not exists pgcrypto;`);
  await pool.query(`
    create table if not exists clients (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      status text not null default 'active',
      slack_channel_id text not null,
      heyreach_campaign_id text,
      smartlead_campaign_id text,
      manychat_flow_ns text,
      manychat_sms_consent_phrase text,
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  // updated_at trigger (best-effort; if extension not available, we still function)
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
}

function normalizeStatus(s) {
  if (s === 'paused') return 'paused';
  return 'active';
}

function envBlock(client) {
  return [
    `# --- Worker v2 env for: ${client.name}`,
    `SLACK_TOKEN=...`,
    `CHANNEL_ID=${client.slack_channel_id}`,
    ``,
    `LEADMAGIC_API_KEY=...`,
    ``,
    `# Routing (existing integrations)`,
    client.heyreach_campaign_id ? `HEYREACH_CAMPAIGN_ID=${client.heyreach_campaign_id}` : `# HEYREACH_CAMPAIGN_ID=...`,
    `HEYREACH_API_KEY=...`,
    client.smartlead_campaign_id ? `SMARTLEAD_CAMPAIGN_ID=${client.smartlead_campaign_id}` : `# SMARTLEAD_CAMPAIGN_ID=...`,
    `SMARTLEAD_API_KEY=...`,
    ``,
    `# ManyChat SMS`,
    `MANYCHAT_API_TOKEN=...`,
    client.manychat_flow_ns ? `MANYCHAT_FLOW_NS=${client.manychat_flow_ns}` : `# MANYCHAT_FLOW_NS=...`,
    client.manychat_sms_consent_phrase ? `MANYCHAT_SMS_CONSENT_PHRASE=${client.manychat_sms_consent_phrase}` : `# MANYCHAT_SMS_CONSENT_PHRASE=I agree to receive SMS updates.`,
    ``,
    `# Required for ManyChat createSubscriber when adding a phone`,
    `MANYCHAT_HAS_OPT_IN_SMS=true`,
    `MANYCHAT_HAS_OPT_IN_EMAIL=false`,
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
    manychat_flow_ns,
    manychat_sms_consent_phrase,
    notes,
  } = req.body;

  await pool.query(
    `insert into clients
      (name, status, slack_channel_id, heyreach_campaign_id, smartlead_campaign_id, manychat_flow_ns, manychat_sms_consent_phrase, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      (name || '').trim(),
      normalizeStatus(status),
      (slack_channel_id || '').trim(),
      (heyreach_campaign_id || '').trim() || null,
      (smartlead_campaign_id || '').trim() || null,
      (manychat_flow_ns || '').trim() || null,
      (manychat_sms_consent_phrase || '').trim() || null,
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
    manychat_flow_ns,
    manychat_sms_consent_phrase,
    notes,
  } = req.body;

  await pool.query(
    `update clients set
      name = $2,
      status = $3,
      slack_channel_id = $4,
      heyreach_campaign_id = $5,
      smartlead_campaign_id = $6,
      manychat_flow_ns = $7,
      manychat_sms_consent_phrase = $8,
      notes = $9
     where id = $1`,
    [
      req.params.id,
      (name || '').trim(),
      normalizeStatus(status),
      (slack_channel_id || '').trim(),
      (heyreach_campaign_id || '').trim() || null,
      (smartlead_campaign_id || '').trim() || null,
      (manychat_flow_ns || '').trim() || null,
      (manychat_sms_consent_phrase || '').trim() || null,
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

app.get('/health', (req, res) => res.json({ ok: true }));

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`UI listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize schema', err);
    process.exit(1);
  });

