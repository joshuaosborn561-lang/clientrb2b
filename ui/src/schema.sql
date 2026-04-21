-- Optional manual bootstrap for Railway Postgres (UI also creates this on boot).

create extension if not exists pgcrypto;

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active',
  slack_channel_id text not null,
  heyreach_campaign_id text,
  smartlead_campaign_id text,
  notes text,
  webhook_secret text,
  slack_token text,
  prospeo_api_key text,
  smartlead_api_key text,
  heyreach_api_key text,
  slack_bot_token_ui text,
  touchpoint_ingest_secret text,
  worker_config_secret text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
