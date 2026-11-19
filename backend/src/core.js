'use strict';
// Config, DB pool, crypto (Fernet-compatible so old stored mailbox passwords still decrypt) and password helpers.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Return DATE as 'YYYY-MM-DD' strings, NUMERIC/BIGINT as numbers (no timezone surprises).
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => parseInt(v, 10));

const env = process.env;
for (const k of ['DATABASE_URL', 'FERNET_KEY']) if (!env[k]) throw new Error(`${k} is not set`);

const cfg = {
  DATABASE_URL: env.DATABASE_URL,
  SECRET_KEY: env.SECRET_KEY || 'change-me',
  FERNET_KEY: env.FERNET_KEY,
  DATA_DIR: env.DATA_DIR || '/data',
  GEMINI_API_KEY: env.GEMINI_API_KEY || '',
  // Models tried in order; on an error or used-up free quota the next one is used immediately. Free-tier models only (see extractor.js).
  AI_MODELS: (env.AI_MODELS || 'gemini-3.1-flash-lite,gemini-3.6-flash,gemma-4-26b-a4b-it').split(',').map((m) => m.trim()).filter(Boolean),
  AI_MIN_INTERVAL: parseFloat(env.AI_MIN_INTERVAL || '4'), // seconds between AI calls (free-tier friendly)
  PORT: parseInt(env.PORT || '8100', 10),
  // Public address of this backend (what the Tally program and the Vercel page call), e.g. https://tally-api.unimisk.com
  PUBLIC_API_URL: (env.PUBLIC_API_URL || '').replace(/\/+$/, ''),
  // Optional: where the Supabase Studio lives, shown as a link in Setup > Advanced
  STUDIO_URL: (env.STUDIO_URL || '').replace(/\/+$/, ''),
  // Web pages allowed to call this API from a browser. "*" matches one subdomain label / any port.
  ALLOWED_ORIGINS: (env.ALLOWED_ORIGINS || 'https://*.vercel.app,https://*.unimisk.com,http://localhost:*,http://127.0.0.1:*').split(',').map((s) => s.trim()).filter(Boolean),
};
if (env.NODE_ENV === 'production' && cfg.SECRET_KEY === 'change-me') throw new Error('SECRET_KEY must be set in production');
cfg.FILES_DIR = path.join(cfg.DATA_DIR, 'files');
fs.mkdirSync(cfg.FILES_DIR, { recursive: true });

const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 10 });
pool.on('error', (e) => console.error('pg pool error', e.message));

/** Run a query, return all rows. */
async function q(sql, params = []) {
  return (await pool.query(sql, params)).rows;
}
/** Run a query, return the first row or null. */
async function q1(sql, params = []) {
  return (await q(sql, params))[0] || null;
}

// ---------- Fernet (AES-128-CBC + HMAC-SHA256), same format Python's cryptography.Fernet used ----------
const fkey = Buffer.from(cfg.FERNET_KEY.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
if (fkey.length !== 32) throw new Error('FERNET_KEY must be a 32-byte url-safe base64 key');
const signKey = fkey.subarray(0, 16);
const encKey = fkey.subarray(16);

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-128-cbc', encKey, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const body = Buffer.concat([Buffer.from([0x80]), ts, iv, ct]);
  const mac = crypto.createHmac('sha256', signKey).update(body).digest();
  return Buffer.concat([body, mac]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function decrypt(token) {
  const raw = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (raw[0] !== 0x80 || raw.length < 57) throw new Error('bad token');
  const body = raw.subarray(0, raw.length - 32);
  const mac = raw.subarray(raw.length - 32);
  const calc = crypto.createHmac('sha256', signKey).update(body).digest();
  if (!crypto.timingSafeEqual(mac, calc)) throw new Error('bad token signature');
  const iv = body.subarray(9, 25);
  const d = crypto.createDecipheriv('aes-128-cbc', encKey, iv);
  return Buffer.concat([d.update(body.subarray(25)), d.final()]).toString('utf8');
}

// ---------- passwords (PBKDF2-SHA256, 200k rounds; hex output - compatible with the earlier hashes) ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.pbkdf2Sync(password, salt, 200000, 32, 'sha256').toString('hex');
  return { salt, hash: h };
}
function verifyPassword(password, salt, hash) {
  const a = Buffer.from(hashPassword(password, salt).hash);
  const b = Buffer.from(hash || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- signed tokens (login token / cookie, and short-lived file links) ----------
const mac = (s) => crypto.createHmac('sha256', cfg.SECRET_KEY).update(s).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Login token (also used as the cookie value): "<userId>:<expiresAt>", signed. */
function signSession(userId, ttlSeconds = 14 * 86400) {
  const v = Buffer.from(`${userId}:${Math.floor(Date.now() / 1000) + ttlSeconds}`).toString('base64url');
  return `${v}.${mac(v)}`;
}
function readSession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [v, sig] = token.split('.');
  if (!safeEq(sig, mac(v))) return null;
  const [id, exp] = Buffer.from(v, 'base64url').toString().split(':');
  if (!exp || Number(exp) < Date.now() / 1000) return null; // expired, or an old token without an expiry
  const n = parseInt(id, 10);
  return Number.isFinite(n) ? n : null;
}
/** A link token that is valid for ONE url path only (file preview, downloads): <iframe src> and downloads cannot send headers. */
function signUrlToken(userId, urlPath, ttlSeconds = 1800) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${userId}.${exp}.${mac(`url|${userId}|${urlPath}|${exp}`)}`;
}
function readUrlToken(t, urlPath) {
  if (typeof t !== 'string') return null;
  const [uid, exp, sig] = t.split('.');
  if (!uid || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  if (!safeEq(sig, mac(`url|${uid}|${urlPath}|${exp}`))) return null;
  return parseInt(uid, 10) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { cfg, pool, q, q1, encrypt, decrypt, hashPassword, verifyPassword, signSession, readSession, signUrlToken, readUrlToken, sleep };
