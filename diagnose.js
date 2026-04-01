const logger = require('./logger');
const { parseRB2BMessage } = require('./parser');

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;
const SMARTLEAD_CAMPAIGN_ID = process.env.SMARTLEAD_CAMPAIGN_ID;

async function main() {
  console.log('\n========== DIAGNOSE START ==========\n');

  console.log('--- ENV VARS ---');
  console.log('SLACK_TOKEN:', SLACK_TOKEN ? 'set (' + SLACK_TOKEN.substring(0, 10) + '...)' : 'MISSING');
  console.log('CHANNEL_ID:', CHANNEL_ID || 'MISSING');
  console.log('APOLLO_API_KEY:', APOLLO_API_KEY ? 'set' : 'MISSING');
  console.log('SMARTLEAD_API_KEY:', SMARTLEAD_API_KEY ? 'set' : 'MISSING');
  console.log('SMARTLEAD_CAMPAIGN_ID:', SMARTLEAD_CAMPAIGN_ID || 'MISSING');

  console.log('\n--- SLACK FETCH (last 10 messages, 7 days back) ---');
  const oldest = String(Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60);
  const params = new URLSearchParams({ channel: CHANNEL_ID, oldest, limit: '10' });

  let messages = [];
  try {
    const res = await fetch('https://slack.com/api/conversations.history?' + params, {
      headers: { Authorization: 'Bearer ' + SLACK_TOKEN },
    });
    const data = await res.json();
    console.log('Slack API ok:', data.ok);
    if (!data.ok) { console.log('Slack error:', data.error); return; }
    messages = data.messages || [];
    console.log('Messages found:', messages.length);
  } catch (err) {
    console.log('Slack fetch FAILED:', err.message);
    return;
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    console.log('\n--- MESSAGE ' + (i + 1) + ' ---');
    console.log('Has text:', !!msg.text, '| Length:', msg.text ? msg.text.length : 0);
    console.log('Has attachments:', !!(msg.attachments && msg.attachments.length));
    console.log('Has blocks:', !!(msg.blocks && msg.blocks.length));

    console.log('\nRAW TEXT:');
    console.log('>>>');
    console.log(msg.text || '(empty)');
    console.log('<<<');

    if (msg.attachments) {
      msg.attachments.forEach(function(att, j) {
        console.log('\nATTACHMENT ' + (j+1) + ':');
        console.log('fallback:', att.fallback ? att.fallback.substring(0, 500) : '(none)');
        console.log('text:');
        console.log(att.text ? att.text : '(none)');
        if (att.fields) {
          console.log('fields:');
          att.fields.forEach(function(f) { console.log('  ' + f.title + ': ' + f.value); });
        }
      });
    }

    if (msg.blocks) {
      msg.blocks.forEach(function(block, j) {
        console.log('\nBLOCK ' + (j+1) + ' (type: ' + block.type + '):');
        if (block.text) console.log('block text:', (block.text.text || '').substring(0, 500));
        if (block.elements) {
          block.elements.forEach(function(el) {
            if (el.elements) {
              el.elements.forEach(function(sub) {
                console.log('  sub (' + sub.type + '):', JSON.stringify(sub.text || sub.url || sub).substring(0, 300));
              });
            }
          });
        }
      });
    }

    console.log('\nPARSER RESULT:');
    let lead = parseRB2BMessage(msg.text);
    let source = 'text';
    if (!lead && msg.attachments) {
      for (const att of msg.attachments) {
        const t = att.text || att.fallback || '';
        if (t) { lead = parseRB2BMessage(t); source = 'attachment'; }
        if (lead) break;
      }
    }
    if (!lead && msg.blocks) {
      for (const block of msg.blocks) {
        const bt = block.text ? block.text.text : '';
        if (bt) { lead = parseRB2BMessage(bt); source = 'block'; }
        if (lead) break;
      }
    }
    console.log(lead ? 'PARSED (from ' + source + '): ' + JSON.stringify(lead, null, 2) : 'FAILED TO PARSE');
  }

  console.log('\n--- SMARTLEAD API TEST ---');
  if (SMARTLEAD_API_KEY && SMARTLEAD_CAMPAIGN_ID) {
    try {
      const slRes = await fetch('https://server.smartlead.ai/api/v1/campaigns/' + SMARTLEAD_CAMPAIGN_ID + '?api_key=' + SMARTLEAD_API_KEY);
      const slData = await slRes.json();
      console.log('SmartLead status:', slRes.status);
      console.log('Campaign:', JSON.stringify(slData).substring(0, 500));
    } catch (err) { console.log('SmartLead FAILED:', err.message); }
  }

  console.log('\n--- APOLLO API TEST ---');
  if (APOLLO_API_KEY) {
    try {
      const apRes = await fetch('https://api.apollo.io/v1/people/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_API_KEY },
        body: JSON.stringify({ linkedin_url: 'https://www.linkedin.com/in/test', reveal_personal_emails: false }),
      });
      console.log('Apollo status:', apRes.status);
      const apData = await apRes.json();
      console.log('Apollo response:', JSON.stringify(apData).substring(0, 500));
    } catch (err) { console.log('Apollo FAILED:', err.message); }
  }

  console.log('\n========== DIAGNOSE END ==========\n');
}

main().catch(function(err) { console.error('Fatal:', err.message); process.exit(1); });
