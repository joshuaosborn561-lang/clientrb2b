const logger = require('./logger');

/**
 * Strips Slack formatting from raw message text:
 * - <url|label> -> url
 * - <url> -> url
 * - <mailto:email|label> -> email
 * - *bold* -> bold
 */
function stripSlackFormatting(text) {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|[^>]+>/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<mailto:([^|>]+)\|[^>]+>/g, '$1')
    .replace(/<mailto:([^>]+)>/g, '$1');
}

/**
 * Parses an RB2B Slack message into a structured lead object.
 *
 * Actual RB2B format in Slack uses *Bold*: value fields:
 *   *Name*: Chuck Black
 *   *Title*: Financial Planner
 *   *Company*: World Financial Group
 *   *Email*: someone@example.com
 *   *LinkedIn*: https://linkedin.com/in/...
 *   *Location*: Houston, TX
 */
function parseRB2BMessage(text) {
  if (!text) return null;

  try {
    const cleaned = stripSlackFormatting(text);

    // Must contain *Name*: to be an RB2B message
    if (!cleaned.includes('*Name*:') && !cleaned.includes('Name:')) {
      return null;
    }

    // Extract fields using *Field*: value pattern (primary)
    // Also fall back to Field: value (without bold)
    function extractField(fieldName) {
      // Try *Field*: value first (bold format)
      const boldRegex = new RegExp('\\*' + fieldName + '\\*:\\s*(.+?)(?=\\s*\\*[A-Z]|\\s*$)', 'm');
      const boldMatch = cleaned.match(boldRegex);
      if (boldMatch) return boldMatch[1].trim();

      // Fallback: Field: value (plain format)
      const plainRegex = new RegExp(fieldName + ':\\s*(.+?)(?=\\s+[A-Z][a-z]+:|\\s*$)', 'm');
      const plainMatch = cleaned.match(plainRegex);
      if (plainMatch) return plainMatch[1].trim();

      return '';
    }

    // Extract each field line by line for more reliable parsing
    const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);

    function extractFromLines(fieldName) {
      for (const line of lines) {
        // Match *Field*: value
        const boldPattern = new RegExp('^\\*' + fieldName + '\\*:\\s*(.+)$', 'i');
        const boldMatch = line.match(boldPattern);
        if (boldMatch) return boldMatch[1].trim();

        // Match Field: value (at start of line)
        const plainPattern = new RegExp('^' + fieldName + ':\\s*(.+)$', 'i');
        const plainMatch = line.match(plainPattern);
        if (plainMatch) return plainMatch[1].trim();
      }
      return '';
    }

    const fullName = extractFromLines('Name');
    const nameParts = fullName.split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    if (!firstName) {
      logger.warn('Could not extract name from RB2B message', {
        preview: cleaned.substring(0, 200),
      });
      return null;
    }

    const email = extractFromLines('Email');
    const linkedinUrl = extractFromLines('LinkedIn');
    let location = extractFromLines('Location');

    // Clean location — RB2B sometimes appends extra block content after it
    // Cut at common suffixes like "profile", "has visited", "Connect"
    const locationCutoff = location.match(/^([^]*?)(?:\s+profile\b|\s+has visited\b|\s+Connect\b|\s+button\b|\s+:)/i);
    if (locationCutoff) {
      location = locationCutoff[1].trim();
    }

    const lead = {
      firstName,
      lastName,
      title: extractFromLines('Title'),
      company: extractFromLines('Company'),
      email: email,
      linkedinUrl: linkedinUrl,
      location: location,
      companyWebsite: extractFromLines('Website'),
      employees: extractFromLines('Est. Employees') || extractFromLines('Employees'),
      industry: extractFromLines('Industry'),
      revenue: extractFromLines('Est. Revenue') || extractFromLines('Revenue'),
      visitedUrl: '',
      visitedAt: '',
    };

    // Try to extract visit info
    const visitLine = lines.find(l => l.includes('identified visiting') || l.includes('visited'));
    if (visitLine) {
      const urlMatch = visitLine.match(/visiting\s+(https?:\/\/[^\s]+)\s+on\s+(.+)$/);
      if (urlMatch) {
        lead.visitedUrl = urlMatch[1];
        lead.visitedAt = urlMatch[2];
      }
    }

    logger.info('Parsed lead', {
      name: firstName + ' ' + lastName,
      company: lead.company,
      hasEmail: !!lead.email,
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
