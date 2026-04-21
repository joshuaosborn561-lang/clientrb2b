const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const { Pool } = require('pg');

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
    `# Email (SmartLead) + LinkedIn (HeyReach)`,
    client.heyreach_campaign_id ? `HEYREACH_CAMPAIGN_ID=${client.heyreach_campaign_id}` : `# HEYREACH_CAMPAIGN_ID=...`,
    `HEYREACH_API_KEY=...`,
    client.smartlead_campaign_id ? `SMARTLEAD_CAMPAIGN_ID=${client.smartlead_campaign_id}` : `# SMARTLEAD_CAMPAIGN_ID=...`,
    `SMARTLEAD_API_KEY=...`,
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
    notes,
  } = req.body;

  await pool.query(
    `insert into clients
      (name, status, slack_channel_id, heyreach_campaign_id, smartlead_campaign_id, notes)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      (name || '').trim(),
      normalizeStatus(status),
      (slack_channel_id || '').trim(),
      (heyreach_campaign_id || '').trim() || null,
      (smartlead_campaign_id || '').trim() || null,
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
    notes,
  } = req.body;

  await pool.query(
    `update clients set
      name = $2,
      status = $3,
      slack_channel_id = $4,
      heyreach_campaign_id = $5,
      smartlead_campaign_id = $6,
      notes = $7
     where id = $1`,
    [
      req.params.id,
      (name || '').trim(),
      normalizeStatus(status),
      (slack_channel_id || '').trim(),
      (heyreach_campaign_id || '').trim() || null,
      (smartlead_campaign_id || '').trim() || null,
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
