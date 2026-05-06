/**
 * Parse RB2B "visited on ..." tail into a Date when possible.
 */
function parseRb2bVisitAt(raw) {
  if (!raw || typeof raw !== 'string') return { at: null, text: raw || '' };
  const trimmed = raw.trim();
  if (!trimmed) return { at: null, text: '' };

  const d = new Date(trimmed);
  if (!Number.isNaN(d.getTime())) return { at: d, text: trimmed };

  const mdy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(.+)$/);
  if (mdy) {
    const d2 = new Date(`${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')} ${mdy[4]}`);
    if (!Number.isNaN(d2.getTime())) return { at: d2, text: trimmed };
  }

  return { at: null, text: trimmed };
}

module.exports = { parseRb2bVisitAt };
