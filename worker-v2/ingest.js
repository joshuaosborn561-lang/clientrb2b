const logger = require('./logger');

async function reportTouchpoint(payload) {
  const UI_TOUCHPOINT_INGEST_URL = process.env.UI_TOUCHPOINT_INGEST_URL;
  const UI_TOUCHPOINT_INGEST_SECRET = process.env.UI_TOUCHPOINT_INGEST_SECRET;
  if (!UI_TOUCHPOINT_INGEST_URL || !UI_TOUCHPOINT_INGEST_SECRET) {
    return;
  }
  try {
    const res = await fetch(UI_TOUCHPOINT_INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + UI_TOUCHPOINT_INGEST_SECRET,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text();
      logger.error('Touchpoint ingest HTTP error', { status: res.status, body: t?.slice(0, 500) });
    }
  } catch (err) {
    logger.error('Touchpoint ingest failed', { error: err.message });
  }
}

module.exports = { reportTouchpoint };
