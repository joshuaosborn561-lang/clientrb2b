const logger = require('./logger');

/**
 * Strips Slack mrkdwn formatting from raw message text:
 * - <https://url|label> → https://url
 * - <https://url> → https://url
 * - <mailto:email|label> → email
 * - *bold* → bold
 * - _italic_ → italic
 * - ~strikethrough~ → strikethrough
 */
function stripSlackFormatting(text) {
  return text
    // <url|label> → url
    .replace(/<(https?:\/\/[^|>]+)\|[^>]+>/g, '$1')
    // <url> → url
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    // <mailto:email|label> → email
    .replace(/<mailto:([^|>]+)\|[^>]+>/g, '$1')
    // <mailto:email> → email
    .replace(/<mailto:([^>]+)>/g, '$1')
    // *bold* → bold
    .replace(/\*([^*]+)\*/g, '$1')
    // _italic_ → italic (but not mid-word underscores)
    .replace(/(?:^|\s)_([^_]+)_(?:\s|$)/g, ' $1 ')
    // ~strike~ → strike
    .replace(/~([^~]+)~/g, '$1');
}

/**
 * Parses an RB2B Slack message into a structured lead object.
 * Handles both single-line and multi-line field layouts.
 */
function parseRB2BMessage(text) {
  if (!text) return null;

  try {
    // Strip Slack formatting first
    const cleaned = stripSlackFormatting(text);
    const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);

    // Look for the detail line(s) — may be one line or spread across multiple
    // Try single-line first: "Name: ... Title: ... Company: ..."
    let detailLine = lines.find(l => l.startsWith('Name:') || l.includes('Name:'));
    if (!detailLine) {
      logger.warn('No Name: field found in message, skipping', {
        preview: cleaned.substring(0, 300),
      });
      return null;
    }

    // If the detail line doesn't contain Title:, the fields may be on separate lines.
    // Merge consecutive lines that contain our field markers into one string.
    if (!detailLine.includes('Title:')) {
      const fieldMarkers = ['Name:', 'Title:', 'Company:', 'LinkedIn:', 'Location:'];
      const fieldLines = lines.filter(l => fieldMarkers.some(m => l.includes(m)));
      detailLine = fieldLines.join(' ');
    }

    const nameMatch = detailLine.match(/Name:\s*(.+?)(?:\s+Title:|$)/);
    const titleMatch = detailLine.match(/Title:\s*(.+?)(?:\s+Company:|$)/);

    // Company might end at LinkedIn:, Location:, or end of string
    const companyMatch = detailLine.match(/Company:\s*(.+?)(?:\s+LinkedIn:|\s+Location:|$)/);
    const linkedinMatch = detailLine.match(/LinkedIn:\s*(https?:\/\/[^\s]+)/);
    const locationMatch = detailLine.match(/Location:\s*(.+?)(?:\s+LinkedIn:|$)/);

    // Also try Location after LinkedIn
    const locationAfterLinkedin = detailLine.match(/LinkedIn:\s*https?:\/\/[^\s]+\s+Location:\s*(.+)$/);

    const fullName = nameMatch ? nameMatch[1].trim() : '';
    const nameParts = fullName.split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    if (!firstName) {
      logger.warn('Could not extract name from message', {
        detailLine: detailLine.substring(0, 200),
      });
      return null;
    }

    // --- Visit line ---
    const visitLine = lines.find(l => l.includes('First identified visiting') || l.includes('identified visiting'));
    let visitedUrl = '';
    let visitedAt = '';
    if (visitLine) {
      const urlMatch = visitLine.match(/visiting\s+(https?:\/\/[^\s]+)\s+on\s+(.+)$/);
      if (urlMatch) {
        visitedUrl = urlMatch[1];
        visitedAt = urlMatch[2];
      }
    }

    // --- Company details (may be on separate lines) ---
    const findField = (prefix) => {
      const line = lines.find(l => l.startsWith(prefix));
      return line ? line.replace(prefix, '').trim() : '';
    };

    const lead = {
      firstName,
      lastName,
      title: titleMatch ? titleMatch[1].trim() : '',
      company: companyMatch ? companyMatch[1].trim() : '',
      linkedinUrl: linkedinMatch ? linkedinMatch[1].trim() : '',
      location: locationAfterLinkedin ? locationAfterLinkedin[1].trim()
                : locationMatch ? locationMatch[1].trim() : '',
      companyWebsite: findField('Website:'),
      employees: findField('Est. Employees:'),
      industry: findField('Industry:'),
      revenue: findField('Est. Revenue:'),
      visitedUrl,
      visitedAt,
    };

    logger.info('Parsed lead', {
      name: `${firstName} ${lastName}`,
      company: lead.company,
      hasLinkedIn: !!lead.linkedinUrl,
      employees: lead.employees,
      industry: lead.industry,
    });

    return lead;
  } catch (err) {
    logger.error('Failed to parse RB2B message', {
      error: err.message,
      preview: text.substring(0, 300),
    });
    return null;
  }
}

module.exports = { parseRB2BMessage };
