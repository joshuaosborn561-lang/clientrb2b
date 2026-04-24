const logger = require('./logger');

/**
 * Append a Notion database row when Prospeo + BetterContact could not find an email.
 * Needs NOTION_API_KEY, NOTION_ENRICHMENT_DB_ID, and a title property (default "Name" from default DB).
 */
async function logEnrichmentMiss(lead, reasonTag) {
  const token = (process.env.NOTION_API_KEY || '').trim();
  const databaseId = (process.env.NOTION_ENRICHMENT_DB_ID || process.env.NOTION_DATABASE_ID || '').trim();
  const titleProp = (process.env.NOTION_TITLE_PROPERTY || 'Name').trim();
  if (!token || !databaseId) return;

  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'Unknown';
  const lines = [
    'Reason: ' + (reasonTag || 'no_email_after_prospeo_and_bettercontact'),
    'Company: ' + (lead.company || ''),
    'Title: ' + (lead.title || ''),
    'LinkedIn: ' + (lead.linkedinUrl || ''),
    'Website: ' + (lead.companyWebsite || ''),
  ].join('\n');

  try {
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties: {
          [titleProp]: {
            title: [{ type: 'text', text: { content: name.slice(0, 200) } }],
          },
        },
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: lines.slice(0, 2000) } }],
            },
          },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      logger.error('Notion log failed', { status: res.status, body: t?.slice(0, 300) });
      return;
    }
    logger.info('Notion enrichment miss logged', { name });
  } catch (err) {
    logger.error('Notion log error', { error: err.message });
  }
}

module.exports = { logEnrichmentMiss };
