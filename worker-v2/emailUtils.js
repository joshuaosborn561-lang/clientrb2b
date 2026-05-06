/**
 * RB2B often sends placeholders like ****@**** instead of a real address.
 */
function isUsableWorkEmail(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (t.includes('*')) return false;
  if (/redacted|hidden|unavailable|n\/a|not\s+available|withheld/i.test(t)) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(t)) return false;
  const local = t.split('@')[0] || '';
  if (local.length < 2) return false;
  return true;
}

module.exports = { isUsableWorkEmail };
