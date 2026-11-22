// Security helpers for the MyEduAI backend. No extra packages needed.
const crypto = require('crypto');

// ---------- passwords ----------
const MIN_PASSWORD = Math.max(8, parseInt(process.env.MIN_PASSWORD, 10) || 8);
const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop', 'iloveyou1', 'admin123', 'welcome1', 'abc12345', 'letmein123', 'school123', 'student123', 'teacher123', 'parent123', 'test1234', 'changeme1', 'myedu123', 'india123', 'mohit123', 'abcd1234', 'asdf1234']);
// returns an error message, or null when the password is acceptable (keep in sync with pwProblem in the app)
function pwProblem(pw, loginId) {
  pw = String(pw == null ? '' : pw);
  if (pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters with a letter and a number`;
  if (Buffer.byteLength(pw) > 72) return 'Password is too long (maximum 72 characters)';   // bcrypt ignores everything after 72 bytes
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return `Password must be at least ${MIN_PASSWORD} characters with a letter and a number`;
  if (COMMON.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) return 'This password is too common. Choose another one';
  if (loginId && pw.toLowerCase() === String(loginId).toLowerCase()) return 'Password must not be the same as the login ID';
  return null;
}

// ---------- input checks ----------
const LOGIN_ID_RE = /^[a-z0-9+][a-z0-9._@+-]{2,59}$/;     // phone numbers and e-mail addresses both pass
const isLoginId = (s) => LOGIN_ID_RE.test(String(s || ''));
const isEmail = (s) => { s = String(s || ''); return s === '' || (s.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)); };
const isPhone = (s) => { s = String(s || ''); return s === '' || /^\+?[0-9 ()-]{7,20}$/.test(s); };
const isDay = (s) => { s = String(s || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
// trimmed text without control characters, cut to max length
const text = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

// ---------- uploaded files: check the real file signature, not only the type the browser claims ----------
function sniffOk(mime, buf) {
  if (!buf || buf.length < 4) return false;
  const h = buf.subarray(0, 12), s = (a, b) => h.subarray(a, b).toString('latin1');
  if (mime === 'application/pdf') return s(0, 4) === '%PDF';
  if (mime === 'image/png') return h[0] === 0x89 && s(1, 4) === 'PNG';
  if (mime === 'image/jpeg') return h[0] === 0xff && h[1] === 0xd8;
  if (mime === 'image/webp') return s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP';
  if (mime === 'application/msword') return h[0] === 0xd0 && h[1] === 0xcf;
  if (/wordprocessingml/.test(mime)) return h[0] === 0x50 && h[1] === 0x4b;
  if (mime === 'text/plain') return !buf.subarray(0, 2000).includes(0);
  return false;
}

// ---------- response headers ----------
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  next();
}

// ---------- rate limiter kept in the database ----------
// A Worker runs in many short-lived copies, so counters kept in memory are not shared and can be dodged.
// Counters here live in PostgreSQL (table rate_hits), so every copy sees the same numbers.
function makeRateLimiter(q) {
  const ip = (req) => String(req.headers['cf-connecting-ip'] || req.ip || 'unknown');
  const win = (ms) => Math.floor(Date.now() / ms);
  async function hit(key, windowMs) {
    const r = await q('INSERT INTO rate_hits (k, win, n) VALUES ($1,$2,1) ON CONFLICT (k, win) DO UPDATE SET n = rate_hits.n + 1 RETURNING n', [key, win(windowMs)]);
    if (Math.random() < 0.01) q("DELETE FROM rate_hits WHERE created < now() - interval '2 days'").catch(() => {});
    return Number(r.rows[0].n);
  }
  async function peek(key, windowMs) {   // never blocks the app if the table is missing
    try { const r = await q('SELECT n FROM rate_hits WHERE k=$1 AND win=$2', [key, win(windowMs)]); return r.rows[0] ? Number(r.rows[0].n) : 0; }
    catch (e) { console.error('rate limiter read failed:', e.message); return 0; }
  }
  const clear = (key) => q('DELETE FROM rate_hits WHERE k=$1', [key]).catch(() => {});
  const fail = async (key, windowMs) => { try { await hit(key, windowMs); } catch (e) { console.error('rate limiter write failed:', e.message); } };
  const limit = ({ name, windowMs, max, key }) => async (req, res, next) => {
    try {
      const n = await hit(name + ':' + (key ? key(req) : ip(req)), windowMs);
      if (n > max) { res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000))); return res.status(429).json({ error: 'Too many requests. Please wait a while and try again.' }); }
    } catch (e) { console.error('rate limiter unavailable (run migrate.js):', e.message); }
    next();
  };
  return { ip, hit, peek, clear, fail, limit };
}

module.exports = { MIN_PASSWORD, pwProblem, isLoginId, isEmail, isPhone, isDay, text, sniffOk, securityHeaders, makeRateLimiter, crypto };
