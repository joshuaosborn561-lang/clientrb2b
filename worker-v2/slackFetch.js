const logger = require('./logger');

async function fetchAllSlackMessages({ slack_token, slack_channel_id, oldest }) {
  const slackToken = String(slack_token || '').trim();
  const channelId = String(slack_channel_id || '').trim();
  if (!slackToken || !channelId) {
    throw new Error('SLACK_TOKEN and CHANNEL_ID required');
  }
  let allMessages = [];
  let cursor;
  while (true) {
    const params = new URLSearchParams({ channel: channelId, oldest, limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch('https://slack.com/api/conversations.history?' + params, {
      headers: { Authorization: 'Bearer ' + slackToken },
    });
    if (!res.ok) throw new Error('Slack HTTP error: ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error('Slack API error: ' + data.error);
    allMessages = allMessages.concat(data.messages || []);
    if (data.has_more && data.response_metadata && data.response_metadata.next_cursor) {
      cursor = data.response_metadata.next_cursor;
    } else {
      break;
    }
  }
  logger.info('Fetched Slack messages', { channel: channelId, count: allMessages.length });
  return allMessages;
}

module.exports = { fetchAllSlackMessages };

