const logger = require('./logger');

async function postSlackMessage(channelId, text, tokenOverride) {
  const token = String(tokenOverride || process.env.SLACK_TOKEN || '').trim();
  const ch = String(channelId || process.env.CHANNEL_ID || '').trim();
  if (!token || !ch) {
    logger.warn('Slack post skipped: missing token or channel', { hasToken: !!token, hasChannel: !!ch });
    return false;
  }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: ch, text }),
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
