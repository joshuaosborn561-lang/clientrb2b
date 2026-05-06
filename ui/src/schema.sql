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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
