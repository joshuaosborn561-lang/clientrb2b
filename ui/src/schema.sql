-- Railway Postgres bootstrap for the RB2B Lead Router UI.
-- Run this once against your Railway Postgres DB.

create extension if not exists "uuid-ossp";

create table if not exists clients (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  slug text not null unique,

  -- Slack source (RB2B visitor alerts)
  slack_channel_id text not null,

  -- Campaign IDs per client (you requested these be per-client)
  heyreach_campaign_id text,
  smartlead_campaign_id text,

  -- ManyChat (SMS) routing
  manychat_enabled boolean not null default false,
  manychat_flow_ns text,
  manychat_consent_phrase text,

  -- SmartLead routing
  smartlead_enabled boolean not null default true,

  -- Misc
  status text not null default 'active', -- active|paused
  notes text not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists clients_status_idx on clients(status);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists clients_set_updated_at on clients;
create trigger clients_set_updated_at
before update on clients
for each row
execute function set_updated_at();

