const logger = require('./logger');

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

async function postSlackMessage(text) {
  if (!SLACK_TOKEN || !CHANNEL_ID) {
    logger.warn('Slack post skipped: SLACK_TOKEN or CHANNEL_ID missing');
    return false;
  }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + SLACK_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: CHANNEL_ID, text }),
    });
    const data = await res.json();
    if (!data.ok) {
      logger.error('Slack chat.postMessage failed', { error: data.error });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('Slack post failed', { error: err.message });
    return false;
  }
}

module.exports = { postSlackMessage };
