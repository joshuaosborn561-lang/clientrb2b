## RB2B Lead Router UI (Railway)

This folder is a small Railway UI to manage **client records** (Slack channel ID + campaign IDs) and generate a **copy/paste env block** for deploying `worker-v2/`.

It **does not** change the legacy worker in the repo root.

### Deploy on Railway

- **Create a new Railway service** from this repo.
- Set the **Root Directory** to `ui/`.
- Add a Railway **Postgres** plugin to this service and ensure `DATABASE_URL` is injected.
- Set env vars:
  - `PGSSLMODE=require`: recommended on Railway
- Start command: `npm start`

### First run / DB schema

On boot, the UI will create the `clients` table if it doesn’t exist.

If you prefer manual schema setup, use `src/schema.sql`.

