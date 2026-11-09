const crypto = require('crypto');

// Normalize a phone number to E.164. Assumes US/Canada when no country code is given.
function e164(input) {
  if (!input) return '';
  const s = String(input).trim();
  if (s.startsWith('client:')) return s;
  const digits = s.replace(/[^\d]/g, '');
  if (s.startsWith('+')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return digits ? '+' + digits : '';
}

function prettyPhone(n) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(n || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (n || '');
}

const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

function escapeXml(s) {
  return String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function safeJson(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

module.exports = { e164, prettyPhone, randomToken, escapeXml, safeJson };
