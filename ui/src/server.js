const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const { Pool } = require('pg');
const { ensureTouchpointSchema, registerTouchpointRoutes } = require('./touchpoints');
const { registerWorkerConfigRoutes } = require('./workerConfigApi');
const { readState, buildAuthorizeUrl, exchangeCode, publicBase, publicBaseFromRequest } = require('./slackOauth');

const app = express();
app.set('trust proxy', 1);

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
  res.locals.publicBase = publicBaseFromRequest(req) || publicBase();
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
  await pool.query(`alter table clients add column if not exists bettercontact_api_key text;`);
  await pool.query(`alter table clients add column if not exists notion_api_key text;`);
  await pool.query(`alter table clients add column if not exists notion_enrichment_db_id text;`);
  await pool.query(`alter table clients add column if not exists notion_title_property text;`);
  await pool.query(`alter table clients drop column if exists worker_config_secret;`);
  await pool.query(`alter table clients add column if not exists slack_install_token text;`);
  await pool.query(`create unique index if not exists clients_slack_install_token_key on clients(slack_install_token) where slack_install_token is not null;`);
  await pool.query(`
    update clients
    set slack_install_token = encode(gen_random_bytes(18), 'hex')
    where slack_install_token is null or slack_install_token = '';
  `);

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
  const base = publicBase() || (process.env.UI_PUBLIC_URL || '').replace(/\/$/, '') || 'https://YOUR-UI.railway.app';
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
  res.render('index', { title: 'Clients', clients: rows });
});

/**
 * Public shareable link: maps secret token → client, then same OAuth as /clients/:id/slack-install.
 * Send this URL to the customer; when they open it, the bot token is stored on *this* client row.
 */
app.get('/install/slack/:token', async (req, res) => {
  const token = String(req.params.token || '')
    .trim()
    .replace(/[^0-9a-f]/gi, '');
  if (!token) return res.status(404).send('Not found');
  const { rows } = await pool.query('select id from clients where slack_install_token = $1', [token]);
  if (rows.length === 0) return res.status(404).send('Invalid or expired install link. Ask for a new link from the client page.');
  return redirectSlackOAuth(req, res, rows[0].id);
});

/**
 * Must be registered before `GET /clients/:id` so `slack-install` is not captured as an :id.
 */
function redirectSlackOAuth(req, res, clientUuid) {
  const out = buildAuthorizeUrl({ clientId: clientUuid, req });
  if (out.error) {
    return res
      .status(500)
      .send(
        'Slack OAuth is not configured. On the UI Railway service set: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and a public base URL (UI_PUBLIC_URL or Railway will infer from RAILWAY_PUBLIC_DOMAIN).'
      );
  }
  return res.redirect(out.url);
}

app.get('/clients/:id/slack-install', async (req, res) => {
  if (req.params.id === 'new') return res.status(404).send('Not found');
  const { rows } = await pool.query('select id from clients where id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).send('Not found');
  return redirectSlackOAuth(req, res, req.params.id);
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
    bettercontact_api_key,
    notion_api_key,
    notion_enrichment_db_id,
    notion_title_property,
    smartlead_api_key,
    heyreach_api_key,
    slack_bot_token_ui,
  } = req.body;

  const { rows: ins } = await pool.query(
    `insert into clients
      (name, status, slack_channel_id, heyreach_campaign_id, smartlead_campaign_id, notes, webhook_secret,
       slack_token, prospeo_api_key, bettercontact_api_key, notion_api_key, notion_enrichment_db_id, notion_title_property,
       smartlead_api_key, heyreach_api_key, slack_bot_token_ui,
       touchpoint_ingest_secret, slack_install_token)
     values ($1,$2,$3,$4,$5,$6, encode(gen_random_bytes(24), 'hex'),
       $7,$8,$9,$10,$11,$12,$13,$14,$15, encode(gen_random_bytes(24), 'hex'), encode(gen_random_bytes(18), 'hex'))
     returning id`,
    [
      (name || '').trim(),
      normalizeStatus(status),
      (slack_channel_id || '').trim(),
      (heyreach_campaign_id || '').trim() || null,
      (smartlead_campaign_id || '').trim() || null,
      (notes || '').trim() || null,
      emptyToNull(slack_token),
      emptyToNull(prospeo_api_key),
      emptyToNull(bettercontact_api_key),
      emptyToNull(notion_api_key),
      emptyToNull(notion_enrichment_db_id),
      emptyToNull(notion_title_property) || 'Name',
      emptyToNull(smartlead_api_key),
      emptyToNull(heyreach_api_key),
      emptyToNull(slack_bot_token_ui),
    ]
  );
  if (ins[0] && ins[0].id) {
    return res.redirect('/clients/' + ins[0].id);
  }
  res.redirect('/');
});

app.get('/clients/:id', async (req, res) => {
  const { rows } = await pool.query('select * from clients where id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).send('Not found');
  const client = rows[0];
  const base = publicBaseFromRequest(req) || publicBase();
  const shareInstallUrl = base && client.slack_install_token ? base + '/install/slack/' + client.slack_install_token : '';
  res.render('client', {
    title: `Client: ${client.name}`,
    client,
    envBlock: envBlock(client),
    shareInstallUrl,
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
    bettercontact_api_key,
    notion_api_key,
    notion_enrichment_db_id,
    notion_title_property,
    smartlead_api_key,
    heyreach_api_key,
    slack_bot_token_ui,
  } = req.body;

  const { rows: curRows } = await pool.query('select * from clients where id = $1', [req.params.id]);
  if (curRows.length === 0) return res.status(404).send('Not found');
  const cur = curRows[0];

  const nextSlackToken = emptyToNull(slack_token) != null ? emptyToNull(slack_token) : cur.slack_token;
  const nextProspeo = emptyToNull(prospeo_api_key) != null ? emptyToNull(prospeo_api_key) : cur.prospeo_api_key;
  const nextBc = emptyToNull(bettercontact_api_key) != null ? emptyToNull(bettercontact_api_key) : cur.bettercontact_api_key;
  const nextNotion = emptyToNull(notion_api_key) != null ? emptyToNull(notion_api_key) : cur.notion_api_key;
  const nextNotionDb = emptyToNull(notion_enrichment_db_id) != null ? emptyToNull(notion_enrichment_db_id) : cur.notion_enrichment_db_id;
  const nextNotionTitle = emptyToNull(notion_title_property) != null ? emptyToNull(notion_title_property) : cur.notion_title_property;
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
      bettercontact_api_key = $10,
      notion_api_key = $11,
      notion_enrichment_db_id = $12,
      notion_title_property = $13,
      smartlead_api_key = $14,
      heyreach_api_key = $15,
      slack_bot_token_ui = $16
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
      nextBc,
      nextNotion,
      nextNotionDb,
      nextNotionTitle || 'Name',
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

/** For debugging Slack OAuth: exact redirect URL this app uses (no secrets). */
app.get('/health/slack', (req, res) => {
  const b = publicBaseFromRequest(req) || publicBase();
  return res.json({
    ok: true,
    public_base: b || null,
    from_request: publicBaseFromRequest(req) || null,
    from_env: publicBase() || null,
    redirect_uri: b ? b + '/auth/slack/callback' : null,
    slack_client_id_set: Boolean(String(process.env.SLACK_CLIENT_ID || '').trim()),
  });
});

/**
 * Standalone page for Slack OAuth outcome (no client list / no API key surface).
 * Query: ok=1&client=UUID | err=CODE&client=UUID(optional)
 */
app.get('/auth/slack/result', (req, res) => {
  const clientId = String(req.query.client || '').trim() || null;
  if (req.query.ok === '1' && clientId) {
    return res.render('slack_oauth_result', {
      layout: false,
      isOk: true,
      heading: 'Slack connected',
      message: 'The bot token for this client was saved. Invite the bot to the RB2B channel if needed, then you can return to the client page.',
      clientId,
    });
  }
  const err = String(req.query.err || '').toLowerCase();
  const withClient = clientId
    ? ' <a href="/clients/' + clientId + '">Open this client</a> to try again.'
    : ' Open a client and use <strong>Add Slack app to client workspace</strong> from there.';
  const wantRedirect = (publicBase() || (process.env.UI_PUBLIC_URL || '').replace(/\/$/, '')) + '/auth/slack/callback';
  const table = {
    missing: {
      h: 'Slack did not send an authorization code',
      m:
        '<strong>Common cause:</strong> using Slack’s <em>“Install to Workspace”</em> in the app dashboard. That can open an install URL with an empty <code>redirect_uri</code> and no <code>code=</code> in the return — use our app’s button instead. <br/><br/>' +
        '<strong>What to do:</strong> in our UI open a <strong>client</strong> → <strong>Add Slack app to client workspace</strong> (or from the list: <strong>Slack</strong> link), then approve. Do not use Slack’s “Install to Workspace” from <strong>Install App</strong> for this. <br/><br/>' +
        'In Slack’s app settings → <strong>Redirect URLs</strong>, the URL must be exactly: <br/><code style="word-break: break-all;">' +
        wantRedirect +
        '</code> <br/>(or copy from <a href="/health/slack"><code>/health/slack</code></a>).' +
        withClient,
    },
    denied: { h: 'Slack install was cancelled', m: 'You can try again from the client page.' + withClient },
    invalid_state: { h: 'Request expired or invalid', m: 'Start the install again from the client page (link is only valid a few minutes).' + withClient },
    unknown_client: { h: 'Unknown client', m: 'The client record may have been removed. Open the home page and pick a client again.' },
    failed: { h: 'Could not complete Slack sign-in', m: 'The token exchange failed. Check <code>SLACK_CLIENT_ID</code>, <code>SLACK_CLIENT_SECRET</code>, and that the redirect URL in Slack matches this app’s <code>UI_PUBLIC_URL</code>.' + withClient },
    no_token: { h: 'No bot token from Slack', m: 'Slack did not return an access token. Check bot scopes and try reinstalling the app in that workspace.' + withClient },
  };
  const row = table[err] || { h: 'Something went wrong', m: 'Try the Slack install again from a client page.' + withClient };
  return res.render('slack_oauth_result', {
    layout: false,
    isOk: false,
    heading: row.h,
    message: row.m,
    clientId,
  });
});

function slackResultPath(ok, err, clientId) {
  if (ok && clientId) return '/auth/slack/result?ok=1&client=' + encodeURIComponent(clientId);
  const p = new URLSearchParams();
  p.set('err', err);
  if (clientId) p.set('client', clientId);
  return '/auth/slack/result?' + p.toString();
}

/** Registered in the Slack app as a Redirect URL: {public base}/auth/slack/callback */
app.get('/auth/slack/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  const err = req.query.error;
  if (err) return res.redirect(slackResultPath(false, 'denied', null));
  if (!code || !state) {
    console.warn('Slack OAuth callback without code/state', {
      hasCode: Boolean(code),
      hasState: Boolean(state),
      queryKeys: Object.keys(req.query),
      fromRequest: publicBaseFromRequest(req),
    });
    return res.redirect(slackResultPath(false, 'missing', null));
  }
  const parsed = readState(String(state));
  if (!parsed) return res.redirect(slackResultPath(false, 'invalid_state', null));
  const { clientId, redirectUri } = parsed;
  const { rows } = await pool.query('select id from clients where id = $1', [clientId]);
  if (rows.length === 0) return res.redirect(slackResultPath(false, 'unknown_client', null));
  const tokenResult = await exchangeCode(code, redirectUri);
  if (tokenResult.error) {
    console.error('Slack OAuth exchange', tokenResult.error);
    return res.redirect(slackResultPath(false, 'failed', clientId));
  }
  const token = tokenResult.access_token;
  if (!token) return res.redirect(slackResultPath(false, 'no_token', clientId));
  const dup = /^1|true|yes$/i.test(String(process.env.SLACK_DUPLICATE_TOKENS || '').trim());
  if (dup) {
    await pool.query('update clients set slack_token = $2, slack_bot_token_ui = $2 where id = $1', [clientId, token]);
  } else {
    await pool.query('update clients set slack_token = $2 where id = $1', [clientId, token]);
  }
  res.redirect(slackResultPath(true, null, clientId));
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
