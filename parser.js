const logger = require('./logger');

/**
 * Parses an RB2B Slack message into a structured lead object.
 *
 * Expected format:
 *   Jennifer Pfeister  from Rocket Arena
 *   Name: Jennifer Pfeister Title: Vice President ... Company: Rocket Arena LinkedIn: https://...
 *   First identified visiting https://... on March 31, 2026 at 10:47AM EDT
 *   About Rocket Arena
 *   Website: https://...
 *   Est. Employees: 51-200
 *   Industry: Creative Arts And Entertainment
 *   Est. Revenue: $10M - $20M
 */
function parseRB2BMessage(text) {
  if (!text) return null;

  try {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    // --- Person details line (Name: ... Title: ... Company: ... LinkedIn: ... Location: ...) ---
    const detailLine = lines.find(l => l.startsWith('Name:'));
    if (!detailLine) return null;

    const nameMatch = detailLine.match(/Name:\s*(.+?)\s+Title:/);
    const titleMatch = detailLine.match(/Title:\s*(.+?)\s+Company:/);
    const companyMatch = detailLine.match(/Company:\s*(.+?)\s+LinkedIn:/);
    const linkedinMatch = detailLine.match(/LinkedIn:\s*(https?:\/\/[^\s]+)/);
    const locationMatch = detailLine.match(/Location:\s*(.+)$/);

    const fullName = nameMatch ? nameMatch[1].trim() : '';
    const nameParts = fullName.split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // --- Visit line ---
    const visitLine = lines.find(l => l.startsWith('First identified visiting'));
    let visitedUrl = '';
    let visitedAt = '';
    if (visitLine) {
      const urlMatch = visitLine.match(/visiting\s+(https?:\/\/[^\s]+)\s+on\s+(.+)$/);
      if (urlMatch) {
        visitedUrl = urlMatch[1];
        visitedAt = urlMatch[2];
      }
    }

    // --- Company details ---
    const websiteLine = lines.find(l => l.startsWith('Website:'));
    const employeesLine = lines.find(l => l.startsWith('Est. Employees:'));
    const industryLine = lines.find(l => l.startsWith('Industry:'));
    const revenueLine = lines.find(l => l.startsWith('Est. Revenue:'));

    const extract = (line, prefix) => line ? line.replace(prefix, '').trim() : '';

    return {
      firstName,
      lastName,
      title: titleMatch ? titleMatch[1].trim() : '',
      company: companyMatch ? companyMatch[1].trim() : '',
      linkedinUrl: linkedinMatch ? linkedinMatch[1].trim() : '',
      location: locationMatch ? locationMatch[1].trim() : '',
      companyWebsite: extract(websiteLine, 'Website:'),
      employees: extract(employeesLine, 'Est. Employees:'),
      industry: extract(industryLine, 'Industry:'),
      revenue: extract(revenueLine, 'Est. Revenue:'),
      visitedUrl,
      visitedAt,
    };
  } catch (err) {
    logger.error('Failed to parse RB2B message', { error: err.message });
    return null;
  }
}

module.exports = { parseRB2BMessage };
