const { Pool } = require('pg');

let pool;

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL env var is required for UI');
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : undefined });
  return pool;
}

async function ensureSchema() {
  const p = getPool();
  await p.query(`create extension if not exists pgcrypto;`);
  await p.query(`
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
  await p.query(`create index if not exists clients_status_idx on clients(status);`);
}

module.exports = {
  getPool,
  ensureSchema,
};
