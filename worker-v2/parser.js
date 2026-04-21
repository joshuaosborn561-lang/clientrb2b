const logger = require('./logger');

function stripSlackFormatting(text) {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|[^>]+>/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<mailto:([^|>]+)\|[^>]+>/g, '$1')
    .replace(/<mailto:([^>]+)>/g, '$1');
}

function parseRB2BMessage(text) {
  if (!text) return null;

  try {
    const cleaned = stripSlackFormatting(text);
    if (!cleaned.includes('*Name*:') && !cleaned.includes('Name:')) return null;

    const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);

    function extractFromLines(fieldName) {
      for (const line of lines) {
        const boldPattern = new RegExp('^\\*' + fieldName + '\\*:\\s*(.+)$', 'i');
        const boldMatch = line.match(boldPattern);
        if (boldMatch) return boldMatch[1].trim();

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

    if (!firstName) return null;

    const email = extractFromLines('Email');
    const linkedinUrl = extractFromLines('LinkedIn');
    let location = extractFromLines('Location');

    const locationCutoff = location.match(/^([^]*?)(?:\s+profile\b|\s+has visited\b|\s+Connect\b|\s+button\b|\s+:)/i);
    if (locationCutoff) location = locationCutoff[1].trim();

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

    const visitLine = lines.find((l) => l.includes('identified visiting') || l.includes('visited'));
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
    });

    return lead;
  } catch (err) {
    logger.error('Failed to parse RB2B message', { error: err.message });
    return null;
  }
}

module.exports = { parseRB2BMessage };

