'use strict';
// Express app: dashboard API + Tally agent API.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const core = require('./core');
const sb = require('./supabase');
const { cfg, q, q1 } = core;
const extractor = require('./extractor');
const mailer = require('./mailer');
const matching = require('./matching');
const reconcile = require('./reconcile');
const syncrun = require('./syncrun');
const tallyxml = require('./tallyxml');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // behind the Cloudflare tunnel: real client address and https come from the forwarded headers
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });

// CORS: which web pages may call this API from a browser (the Vercel page). The API itself is protected by login tokens.
const ORIGIN_RES = cfg.ALLOWED_ORIGINS.map((p) => new RegExp('^' + p.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/(:)?\\?\*/g, (m, colon) => (colon ? ':[0-9]+' : '[a-z0-9-]+(?:\\.[a-z0-9-]+)*')) + '$'));
const originAllowed = (o) => ORIGIN_RES.some((re) => re.test(String(o).toLowerCase()));
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && originAllowed(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpErr = (code, msg) => Object.assign(new Error(msg), { status: code });
const PULL_REQUESTS = new Set(); // org ids whose agent should export vouchers on next poll (manual / after a post)
const PULL_RANGE = new Map(); // org id -> {start,end} covered by the pull we last asked for
const LAST_TALLY_READ = new Map(); // org id -> last export request, including automatic reads
const AUTO_TALLY_SYNC_MS = Math.max(15_000, (parseInt(process.env.TALLY_AUTO_SYNC_SECONDS, 10) || 60) * 1000);

/**
 * Before starting a sync: is there anybody to do it? Refuses at once, with a clear message, when the Tally program is not
 * running on the Tally computer, or when it says TallyPrime itself is not open. (Unknown Tally state = let it try.)
 */
const companyClosedText = (name) => `The company "${name}" is not open in TallyPrime. Open that company in TallyPrime (or correct the name in Setup), then click Sync again.`;
async function preflight(orgId) {
  const o = await q1('select agent_last_seen, tally_ok, tally_checked_at, tally_company, company_ok, company_checked_at from orgs where id=$1', [orgId]);
  const age = (t) => (t ? (Date.now() - new Date(t).getTime()) / 1000 : Infinity);
  if (age(o.agent_last_seen) > 60) {
    throw Object.assign(httpErr(409, 'The Tally program is not running on the Tally computer, so nothing can be synced. Start it (the light at the top right turns green), or see Setup if it is not installed yet.'), { code: 'agent_offline' });
  }
  if (!o.tally_checked_at || age(o.tally_checked_at) - age(o.agent_last_seen) > 20) { // an older Tally program never says whether TallyPrime is open, so a closed Tally would only show up as a long wait
    throw Object.assign(httpErr(409, 'The Tally program on the Tally computer is an old version and cannot tell whether TallyPrime is open. Open Setup, click "Download the Tally program" and open the downloaded file once (it replaces the old one). Then click Sync again.'), { code: 'agent_outdated' });
  }
  if (o.tally_company && o.company_ok === false && age(o.company_checked_at) < 30) {
    throw Object.assign(httpErr(409, companyClosedText(o.tally_company)), { code: 'company_closed' });
  }
  if (o.tally_ok === false) {
    throw Object.assign(httpErr(409, 'TallyPrime is not open on the Tally computer, or its connection is off. Open TallyPrime and your company. Once: F1 Help > Settings > Connectivity > Client/Server, set TallyPrime to act as Server on port 9000. Then click Sync again.'), { code: 'tally_closed' });
  }
}

/** Public address of this backend: the configured one (tunnel domain), else the address this request came in on. */
const publicBase = (req) => cfg.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`;

/** Indian financial year to date: 1 April .. today. */
function fyRange() {
  const t = new Date();
  const y = t.getMonth() >= 3 ? t.getFullYear() : t.getFullYear() - 1;
  return { start: `${y}-04-01`, end: t.toISOString().slice(0, 10) };
}

// ---------- auth ----------
function cookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
const FILE_PATHS = [/^\/api\/documents\/\d+\/file$/, /^\/api\/agent-download$/, /^\/api\/agent-config$/]; // paths that may be opened with a link token
const currentUser = wrap(async (req, res, next) => {
  let uid = null;
  const auth = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(auth)) uid = core.readSession(auth.replace(/^Bearer\s+/i, '').trim());
  if (!uid) uid = core.readSession(cookie(req, 'session'));
  if (!uid && req.method === 'GET' && req.query.t && FILE_PATHS.some((re) => re.test(req.path))) uid = core.readUrlToken(String(req.query.t), req.path);
  const u = uid ? await q1('select * from users where id=$1', [uid]) : null;
  if (!u) throw httpErr(401, 'Not logged in');
  req.user = u;
  next();
});
const agentOrg = wrap(async (req, res, next) => {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const org = tok ? await q1('select * from orgs where agent_token=$1', [tok]) : null;
  if (!org) throw httpErr(401, 'Bad agent token');
  req.org = org;
  next();
});

// Wrong-password limit: 8 misses per account+address, 40 per address, in 15 minutes.
const loginFails = new Map();
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.ip || '');
const recentFails = (key) => { const now = Date.now(); const a = (loginFails.get(key) || []).filter((t) => now - t < 15 * 60000); loginFails.set(key, a); return a; };
/** Passwords live in Supabase Auth. A user that is not there yet (older account) is moved over at the first correct sign-in. */
async function checkPassword(u, password) {
  if (!sb.enabled()) return core.verifyPassword(password, u.salt, u.pw_hash);
  if (u.auth_id) return (await sb.passwordLogin(u.email, password)) === u.auth_id;
  if (!core.verifyPassword(password, u.salt, u.pw_hash)) return false;
  const id = await sb.ensureAuthUser(u.email, password, { org_id: u.org_id });
  await q('update users set auth_id=$1 where id=$2', [id, u.id]);
  u.auth_id = id;
  return true;
}
const loginEmail = (e) => { const v = String(e || '').trim().toLowerCase(); return !v || v.includes('@') ? v : v + '@tallysync.local'; };
app.post('/api/login', express.json(), wrap(async (req, res) => {
  const { password = '' } = req.body || {};
  const email = loginEmail((req.body || {}).email); // a plain username like "preet" means preet@tallysync.local
  const idKey = clientIp(req) + '|' + email, ipKey = clientIp(req);
  if (recentFails(idKey).length >= 8 || recentFails(ipKey).length >= 40) throw Object.assign(httpErr(429, 'Too many wrong attempts. Please wait 15 minutes and try again.'), { code: 'rate_limited' });
  const u = await q1('select * from users where email=$1', [email]);
  if (!u || !(await checkPassword(u, String(password)))) {
    recentFails(idKey).push(Date.now()); recentFails(ipKey).push(Date.now());
    throw httpErr(401, 'Wrong email or password');
  }
  loginFails.delete(idKey);
  const token = core.signSession(u.id);
  // The page uses the token (works from any domain). The cookie keeps the page served by this server working too.
  res.setHeader('Set-Cookie', `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${86400 * 14}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true, token });
}));
/** A link for ONE file / download that works in <iframe src> or a plain download, valid for 30 minutes. */
app.post('/api/signed-url', currentUser, express.json(), wrap(async (req, res) => {
  const p = String(req.body?.path || '');
  if (!FILE_PATHS.some((re) => re.test(p))) throw httpErr(400, 'That path cannot be linked');
  const m = p.match(/^\/api\/documents\/(\d+)\/file$/);
  if (m) await ownDoc(m[1], req.user.org_id); // only your own documents
  res.json({ url: `${publicBase(req)}${p}?t=${core.signUrlToken(req.user.id, p)}` });
}));
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', currentUser, wrap(async (req, res) => {
  const org = await q1('select id,name,agent_token,tally_company,own_name,own_gstin,default_role from orgs where id=$1', [req.user.org_id]);
  res.json({ email: req.user.email, org, ai_ready: !!cfg.GEMINI_API_KEY, ai_model: cfg.AI_MODELS.join(' → ') });
}));
app.put('/api/org', currentUser, express.json(), wrap(async (req, res) => {
  const b = req.body || {};
  if (b.own_name !== undefined || b.own_gstin !== undefined) {
    const g = String(b.own_gstin ?? '').trim().toUpperCase().replace(/ /g, '');
    if (g && !extractor.GSTIN_RE.test(g)) throw httpErr(400, 'That GSTIN does not look valid (15 characters, e.g. 27AABCS1234D1Z5)');
    await q('update orgs set own_name=$1, own_gstin=$2 where id=$3', [String(b.own_name ?? '').trim(), g, req.user.org_id]);
  }
  if (b.default_role !== undefined) {
    if (!['buyer', 'seller'].includes(b.default_role)) throw httpErr(400, 'Usual role must be buyer or seller');
    await q('update orgs set default_role=$1 where id=$2', [b.default_role, req.user.org_id]);
  }
  if (b.tally_company !== undefined) await q('update orgs set tally_company=$1, company_ok=null, company_checked_at=null where id=$2', [String(b.tally_company).trim(), req.user.org_id]);
  res.json({ ok: true });
}));
app.get('/api/events', currentUser, wrap(async (req, res) => {
  res.json(await q(
    `select e.id, e.doc_id, e.kind, e.detail, e.at, d.extracted->>'number' as number, d.extracted->>'party_name' as party
     from doc_events e left join documents d on d.id=e.doc_id where e.org_id=$1 order by e.id desc limit 30`, [req.user.org_id]));
}));
app.post('/api/change-password', currentUser, express.json(), wrap(async (req, res) => {
  const { old_password = '', new_password = '' } = req.body || {};
  if (!(await checkPassword(req.user, String(old_password)))) throw httpErr(400, 'Current password is wrong');
  if (String(new_password).length < 8) throw httpErr(400, 'New password must be at least 8 characters');
  if (sb.enabled() && req.user.auth_id) await sb.setAuthPassword(req.user.auth_id, String(new_password));
  else { const { salt, hash } = core.hashPassword(String(new_password)); await q('update users set salt=$1, pw_hash=$2 where id=$3', [salt, hash, req.user.id]); }
  res.json({ ok: true });
}));

// ---------- dashboard summary ----------
app.get('/api/stats', currentUser, wrap(async (req, res) => {
  const o = req.user.org_id;
  const counts = Object.fromEntries((await q(`select status, count(*)::int c from documents where org_id=$1 and (source<>'tally' or company is null or company=(select tally_company from orgs where id=documents.org_id) or (select tally_company from orgs where id=documents.org_id)='') group by status`, [o])).map((r) => [r.status, r.c]));
  const held = (await q1("select count(*)::int c from documents where org_id=$1 and (source<>'tally' or company is null or company=(select tally_company from orgs where id=documents.org_id) or (select tally_company from orgs where id=documents.org_id)='') and tally_state in ('possible_duplicate','deleted_in_tally')", [o])).c;
  const daily = await q(
    `select to_char(d::date,'YYYY-MM-DD') as day, count(x.id)::int c
     from generate_series(current_date-13, current_date, interval '1 day') d
     left join documents x on x.org_id=$1 and x.source<>'tally' and x.created_at::date = d::date group by d order by d`, [o]);
  const mailboxes = await q1('select count(*)::int total, (count(*) filter (where last_error is null))::int listening from mailboxes where org_id=$1 and active', [o]);
  const org = await q1('select agent_last_seen,tally_ok,tally_checked_at,company_ok,company_checked_at,last_pull_at,last_pull_count,last_pull_result,sync_stage,own_gstin,own_name,tally_company,default_role from orgs where id=$1', [o]);
  const agents = await q("select host, agent_key, last_seen, tally_ok, company_ok, company_name from tally_agents where org_id=$1 and last_seen > now() - interval '75 seconds' order by last_seen desc", [o]);
  res.json({ counts, held, daily, mailboxes, org, agents, ai: { models: cfg.AI_MODELS, ready: !!cfg.GEMINI_API_KEY }, server_time: new Date().toISOString() });
}));

// ---------- mailboxes ----------
app.get('/api/mailboxes', currentUser, wrap(async (req, res) => {
  res.json(await q('select id,email,imap_host,active,last_error,last_checked from mailboxes where org_id=$1 order by id', [req.user.org_id]));
}));
app.post('/api/mailboxes', currentUser, express.json(), wrap(async (req, res) => {
  const { email = '', app_password = '', imap_host = 'imap.gmail.com' } = req.body || {};
  const pw = String(app_password).replace(/\s/g, '');
  try { await mailer.testLogin(imap_host, email, pw); }
  catch (e) { throw httpErr(400, `Could not log in to the mailbox: ${e.responseText || e.message}`); }
  const row = await q1(
    `insert into mailboxes(org_id,email,enc_password,imap_host) values($1,$2,$3,$4)
     on conflict (org_id,email) do update set enc_password=excluded.enc_password, active=true, last_error=null returning id`,
    [req.user.org_id, String(email).toLowerCase(), core.encrypt(pw), imap_host]);
  mailer.startMailbox(row.id);
  res.json({ id: row.id });
}));
app.delete('/api/mailboxes/:id', currentUser, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await q('update mailboxes set active=false where id=$1 and org_id=$2', [id, req.user.org_id]);
  mailer.stopMailbox(id);
  res.json({ ok: true });
}));

// ---------- documents ----------
// Filter groups used by the dashboard pills
const GROUPS = {
  review: "status in ('new','extracted')",
  approved: "status='approved' and coalesce(tally_state,'')<>'possible_duplicate'",
  queued: "status='queued'",
  synced: "status='synced'",
  issues: "(status='error' or tally_state in ('possible_duplicate','deleted_in_tally'))",
  ignored: "status='ignored'",
};
app.get('/api/documents', currentUser, wrap(async (req, res) => {
  let sql = `select id,source,sender,subject,filename,doc_type,status,tally_state,warnings,error,tally_result,created_at,
             extracted->>'number' as number, extracted->>'party_name' as party, extracted->>'total' as total
             from documents where org_id=$1 and (source<>'tally' or company is null or company=(select tally_company from orgs where id=documents.org_id) or (select tally_company from orgs where id=documents.org_id)='')`;
  const params = [req.user.org_id];
  if (req.query.status) { params.push(String(req.query.status)); sql += ` and status=$${params.length}`; }
  if (GROUPS[req.query.group]) sql += ' and ' + GROUPS[req.query.group];
  if (req.query.q && String(req.query.q).trim()) {
    params.push('%' + String(req.query.q).trim() + '%');
    const n = params.length;
    sql += ` and (extracted->>'number' ilike $${n} or extracted->>'party_name' ilike $${n} or filename ilike $${n} or sender ilike $${n})`;
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 300, 300);
  res.json(await q(sql + ' order by id desc limit ' + limit, params));
}));

async function ownDoc(id, orgId) {
  const d = await q1('select * from documents where id=$1 and org_id=$2', [parseInt(id, 10) || 0, orgId]);
  if (!d) throw httpErr(404, 'Document not found');
  return d;
}

app.post('/api/documents/upload', currentUser, upload.array('files'), wrap(async (req, res) => {
  const ids = [];
  for (const f of req.files || []) {
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer decodes filenames as latin1
    if (!mailer.ALLOWED.has(path.extname(name).toLowerCase())) throw httpErr(400, `Unsupported file type: ${name}`);
    const id = await mailer.storeAttachment(req.user.org_id, null, 'upload', crypto.randomBytes(6).toString('hex'),
      req.user.email, 'manual upload', name, f.buffer, f.mimetype || '');
    if (id) ids.push(id);
  }
  res.json({ ids });
}));

app.get('/api/documents/:id', currentUser, wrap(async (req, res) => {
  const d = await ownDoc(req.params.id, req.user.org_id);
  delete d.file_path;
  if (d.dup_guid) d.dup_voucher = await q1('select vch_type, number, reference, party, amount, vch_date from tally_vouchers where org_id=$1 and guid=$2', [req.user.org_id, d.dup_guid]);
  res.json(d);
}));
app.get('/api/documents/:id/file', currentUser, wrap(async (req, res) => {
  const d = await ownDoc(req.params.id, req.user.org_id);
  if (d.source === 'tally' || !d.file_path) throw httpErr(404, 'This entry was typed directly in Tally, so there is no file');
  if (d.mime) res.type(d.mime);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(d.filename)}`);
  const data = await sb.loadFile(d);
  if (!data) throw httpErr(404, 'The file is not available');
  res.send(data);
}));

app.put('/api/documents/:id', currentUser, express.json({ limit: '2mb' }), wrap(async (req, res) => {
  const d = await ownDoc(req.params.id, req.user.org_id);
  if (['queued', 'synced'].includes(d.status)) throw httpErr(400, 'Already sent to Tally; cannot edit');
  const data = extractor.normalize(req.body || {});
  if (data.doc_type === 'other') throw httpErr(400, 'Choose a document type');
  const warnings = await extractor.validate(data, req.user.org_id, d.id);
  await q("update documents set extracted=$1::jsonb, doc_type=$2, warnings=$3::jsonb, status='extracted' where id=$4",
    [JSON.stringify(data), data.doc_type, JSON.stringify(warnings), d.id]);
  res.json({ warnings });
}));

app.post('/api/documents/:id/approve', currentUser, wrap(async (req, res) => {
  const d = await ownDoc(req.params.id, req.user.org_id);
  if (!['extracted', 'error'].includes(d.status) || !d.extracted) throw httpErr(400, 'Only extracted documents can be approved');
  await q("update documents set status='approved', approved_at=now() where id=$1", [d.id]);
  res.json({ ok: true });
}));
app.post('/api/documents/:id/reject', currentUser, wrap(async (req, res) => {
  const d = await ownDoc(req.params.id, req.user.org_id);
  await q("update documents set status='ignored' where id=$1", [d.id]);
  res.json({ ok: true });
}));
app.post('/api/documents/:id/retry', currentUser, wrap(async (req, res) => {
  const d = await ownDoc(req.params.id, req.user.org_id);
  await q("update documents set status='new', error=null where id=$1", [d.id]);
  mailer.enqueue(d.id);
  res.json({ ok: true });
}));

/**
 * The "Sync to Tally" button. Approved bills/invoices are queued, but the agent first reads Tally (sync_stage = 'checking').
 * Only after that read is reconciled are the documents that are really missing from Tally handed over for posting,
 * so an entry that is already in Tally is never posted twice.
 */
app.post('/api/sync', currentUser, wrap(async (req, res) => {
  const cur = await syncrun.current(req.user.org_id);
  if (cur && cur.status === 'running') throw httpErr(409, 'A sync is already running. Please wait until it finishes.');
  const approved = (await q1(
    `select count(*)::int c from documents where org_id=$1 and status='approved' and doc_type in ('purchase_bill','sales_invoice')`, [req.user.org_id])).c;
  if (approved) await preflight(req.user.org_id); // refuse at once if the Tally program is off or TallyPrime is closed (nothing is queued)
  const rows = await q(
    `update documents set status='queued' where org_id=$1 and status='approved'
     and doc_type in ('purchase_bill','sales_invoice') returning id`, [req.user.org_id]);
  if (rows.length) {
    await q("update orgs set sync_stage='checking' where id=$1", [req.user.org_id]);
    await syncrun.start(req.user.org_id, 'to', 'checking', rows.map((r) => r.id)); // the dashboard shows this run as a progress pipeline
  }
  const skipped = await q1(
    `select count(*)::int c from documents where org_id=$1 and status='approved' and doc_type in ('purchase_order','sales_order')`,
    [req.user.org_id]);
  res.json({ queued: rows.length, orders_not_postable: skipped.c });
}));

/** User says: this held document is the same entry that is already in Tally -> link it, do not post. */
app.post('/api/documents/:id/confirm-duplicate', currentUser, wrap(async (req, res) => {
  const d = await ownDoc(req.params.id, req.user.org_id);
  if (!d.dup_guid) throw httpErr(400, 'This document is not held as a possible duplicate');
  await q(`update documents set tally_guid=dup_guid, dup_guid=null, status='synced', synced_at=now(), tally_state='in_sync',
           tally_result='Linked to the existing Tally voucher (confirmed by user)' where id=$1`, [d.id]);
  const merged = await q("delete from documents where org_id=$1 and source='tally' and tally_guid=$2 returning id", [req.user.org_id, d.dup_guid]);
  await reconcile.event(req.user.org_id, d.id, 'confirmed_duplicate', 'Confirmed as the same entry that is already in Tally. Linked; nothing was posted.' + (merged.length ? ' The record that was typed in Tally was merged into this document.' : ''));
  res.json({ ok: true });
}));
/** User says: it is a different entry, post it anyway. */
app.post('/api/documents/:id/force-post', currentUser, wrap(async (req, res) => {
  const d = await ownDoc(req.params.id, req.user.org_id);
  if (d.source === 'tally') throw httpErr(400, 'Entries typed in Tally cannot be posted');
  await q("update documents set force_post=true, status='queued', tally_state=null, dup_guid=null where id=$1", [d.id]);
  await reconcile.event(req.user.org_id, d.id, 'force_post', 'Marked as a different entry; it will be posted to Tally even though a similar voucher exists.');
  res.json({ ok: true });
}));

/** Ask the agent to export vouchers from Tally on its next poll. */
app.post('/api/pull', currentUser, wrap(async (req, res) => {
  const cur = await syncrun.current(req.user.org_id);
  if (!(cur && cur.status === 'running')) await preflight(req.user.org_id); // a running sync gets the clearer "already running" answer below
  const run = await syncrun.start(req.user.org_id, 'from', 'waiting'); // 409 if another sync is still running
  PULL_REQUESTS.add(req.user.org_id);
  res.json({ ok: true, run: run.id });
}));
/** Progress of the latest sync run (or null). The dashboard polls this while a run is in progress. */
app.get('/api/sync/status', currentUser, wrap(async (req, res) => {
  res.json({ run: await syncrun.view(await syncrun.current(req.user.org_id)) });
}));
app.get('/api/match', currentUser, wrap(async (req, res) => {
  const result = await matching.run(req.user.org_id);
  const org = await q1('select agent_last_seen, last_pull_at, last_pull_count, last_pull_result, sync_stage from orgs where id=$1', [req.user.org_id]);
  const cnt = await q1('select count(*)::int c from tally_vouchers where org_id=$1', [req.user.org_id]);
  res.json({ ...result, agent: { ...org, pull_pending: PULL_REQUESTS.has(req.user.org_id), vouchers_stored: cnt.c } });
}));

// ---------- Tally agent API (bearer token) ----------
/** Store what this computer says about TallyPrime and the company. Returns whether this computer can work right now. */
async function recordAgent(req) {
  const key = String(req.query.id || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'ip:' + clientIp(req);
  const host = String(req.query.h || '').replace(/[^\w .-]/g, '').slice(0, 60);
  const t = req.query.tally === '1' ? true : req.query.tally === '0' ? false : null;
  const cn = String(req.query.cn || '').slice(0, 120).trim();
  await q(`insert into tally_agents(org_id,agent_key,host,last_seen,tally_ok,tally_checked_at)
          values($1,$2,$3,now(),$4,case when $4::boolean is null then null else now() end)
          on conflict (org_id,agent_key) do update set host=coalesce(nullif($3,''),tally_agents.host), last_seen=now(),
            tally_ok=coalesce($4,tally_agents.tally_ok),
            tally_checked_at=case when $4::boolean is null then tally_agents.tally_checked_at else now() end`, [req.org.id, key, host, t]);
  let co = null;
  if (t === true && req.org.tally_company && (req.query.co === '0' || req.query.co === '1')) co = req.query.co === '1';
  if (t === false) await q('update tally_agents set company_ok=null where org_id=$1 and agent_key=$2', [req.org.id, key]);
  else if (co !== null) await q('update tally_agents set company_ok=$3 where org_id=$1 and agent_key=$2', [req.org.id, key, co]);
  if (cn && t === true) await q('update tally_agents set company_since=case when company_name is distinct from $3 then now() else company_since end, company_name=$3 where org_id=$1 and agent_key=$2', [req.org.id, key, cn]);
  return { key, closed: t === false || co === false };
}
/** The account's state from all computers seen in the last 75 seconds: ready if ANY computer has TallyPrime (and the company) open. */
async function aggregateAgents(org) {
  const rows = await q("select * from tally_agents where org_id=$1 and last_seen > now() - interval '75 seconds'", [org.id]);
  // The company open on the PC that connected (or switched company) last becomes the active one; older ones are ignored.
  const named = rows.filter((r) => r.tally_ok && r.company_name).sort((x, y) => new Date(y.company_since || 0) - new Date(x.company_since || 0) || new Date(y.last_seen) - new Date(x.last_seen));
  if (named.length && named[0].company_name !== org.tally_company) {
    await q('update orgs set tally_company=$2, company_ok=null, company_checked_at=null where id=$1', [org.id, named[0].company_name]);
    org.tally_company = named[0].company_name;
    console.log(`[agent] active company is now "${org.tally_company}" (PC ${named[0].host || named[0].agent_key})`);
  }
  const withT = rows.filter((r) => r.tally_ok !== null);
  const tally = withT.length ? withT.some((r) => r.tally_ok) : null;
  let company = null;
  if (org.tally_company && tally) {
    const up = rows.filter((r) => r.tally_ok);
    company = up.some((r) => r.company_ok === true) ? true : up.some((r) => r.company_ok === false) ? false : null;
  }
  await q(`update orgs set agent_last_seen=now(),
           tally_ok=$2, tally_checked_at=case when $2::boolean is null then tally_checked_at else now() end,
           company_ok=$3, company_checked_at=case when $3::boolean is null then company_checked_at else now() end where id=$1`, [org.id, tally, company]);
  return { tally, company };
}
app.get('/api/agent/poll', agentOrg, wrap(async (req, res) => {
  // Every computer running the Tally program reports for itself (?tally=1/0, ?co=1/0, ?id=, ?h=). The account counts as ready when at least one is.
  const mine = await recordAgent(req);
  const tallyClosed = mine.closed; // THIS computer cannot do any work now
  const agg = await aggregateAgents(req.org);
  if (agg.tally === false && await syncrun.onTallyClosed(req.org.id)) PULL_REQUESTS.delete(req.org.id);
  else if (agg.company === false && await syncrun.onTallyClosed(req.org.id, companyClosedText(req.org.tally_company))) PULL_REQUESTS.delete(req.org.id);
  const jobs = [];
  const checking = !tallyClosed && req.org.sync_stage === 'checking'; // pre-post check running: hand out no jobs until Tally has been read
  const docs = checking || tallyClosed ? [] : await q("select id, extracted from documents where org_id=$1 and status='queued' order by id limit 20", [req.org.id]);
  for (const d of docs) {
    try { jobs.push({ id: d.id, ...tallyxml.buildImport(d.extracted, req.org.tally_company) }); }
    catch (e) { await q("update documents set status='error', error=$1 where id=$2", [String(e.message).slice(0, 300), d.id]); }
  }
  const out = { jobs, pull: null, company: req.org.tally_company };
  // Periodically read Tally while it is reachable so edits/deletions appear without a manual sync.
  const range = fyRange();
  PULL_RANGE.set(req.org.id, range);
  const exportXml = tallyxml.exportRequest(req.org.tally_company, range.start, range.end);
  const requested = !tallyClosed && PULL_REQUESTS.delete(req.org.id);
  const activeRun = !requested && !checking ? await syncrun.current(req.org.id) : null;
  const autoDue = (!activeRun || activeRun.status !== 'running') && Date.now() - (LAST_TALLY_READ.get(req.org.id) || 0) >= AUTO_TALLY_SYNC_MS;
  if (!tallyClosed && (requested || checking || autoDue)) { // while checking, keep asking until the read arrives
    out.pull = exportXml;
    LAST_TALLY_READ.set(req.org.id, Date.now());
    await syncrun.onPullHanded(req.org.id);
  }
  res.json(out);
}));

/** Tally's error text, readable: XML entities decoded, and a hint for the date error (usually a date outside the company's financial year). */
function friendlyTallyError(message, date) {
  let m = String(message || '').replace(/&#(d+);/g, (x, n) => String.fromCharCode(+n)).replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  if (/date is missing|date.*(out of range|not within)/i.test(m)) {
    m += ` Tally did not accept the date${date ? ' ' + date : ''}. This usually means the date is outside the financial year of the company that is open in TallyPrime (check the company's financial year / books beginning date in Tally), or the date on the document is wrong. Fix it and approve again.`;
  }
  return m;
}
app.post('/api/agent/jobs/:id/result', agentOrg, express.json(), wrap(async (req, res) => {
  const d = await q1("select id, extracted->>'date' as date from documents where id=$1 and org_id=$2 and status='queued'", [parseInt(req.params.id, 10) || 0, req.org.id]);
  if (!d) throw httpErr(404, 'No such queued job'); // idempotent: a double report is ignored
  const { ok, message = '' } = req.body || {};
  if (ok) {
    await q("update documents set status='synced', synced_at=now(), tally_result=$1, tally_state=null, force_post=false, error=null, company=$3 where id=$2", [String(message).slice(0, 500), d.id, req.org.tally_company || null]);
    PULL_REQUESTS.add(req.org.id); // read the new voucher back right away so it gets linked to this document
  }
  else await q("update documents set status='error', error=$1 where id=$2", [friendlyTallyError(message, d.date).slice(0, 600), d.id]);
  await syncrun.onJobResult(req.org.id);
  res.json({ ok: true });
}));

/** Agent uploads the raw Tally export XML; we parse and upsert. */
app.post('/api/agent/vouchers', agentOrg, express.text({ type: '*/*', limit: '50mb' }), wrap(async (req, res) => {
  let rows;
  const rawIn = String(req.body || '');
  try { fs.writeFileSync(path.join(cfg.DATA_DIR, 'last_tally_export.xml'), rawIn); } catch { /* debug copy only */ }
  console.log(`[agent] export upload arrived: ${rawIn.length} bytes`);
  try { rows = tallyxml.parseVouchers(rawIn); }
  catch (e) {
    console.log('[agent] could not parse Tally export:', e.message);
    throw httpErr(400, `Could not parse Tally export: ${e.message}`);
  }
  for (const v of rows) {
    await q(
      `insert into tally_vouchers(org_id,guid,vch_type,number,vch_date,party,reference,amount,company) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (org_id,guid) do update set vch_type=excluded.vch_type, number=excluded.number, vch_date=excluded.vch_date,
       party=excluded.party, reference=excluded.reference, amount=excluded.amount, fetched_at=now(), company=excluded.company`,
      [req.org.id, v.guid, v.vch_type, v.number, v.date, v.party, v.reference, v.amount, req.org.tally_company || null]);
  }
  await q('update orgs set last_pull_at=now(), last_pull_count=$1 where id=$2', [rows.length, req.org.id]);
  console.log(`[agent] voucher export received: ${rawIn.length} bytes, ${rows.length} vouchers parsed`);
  if (!rows.length) console.log('[agent] export had no vouchers; first 600 chars:', rawIn.slice(0, 600).replace(/\s+/g, ' '));
  const result = await reconcile.afterPull(req.org.id, rows, PULL_RANGE.get(req.org.id) || fyRange());
  if (Object.values(result).some(Boolean)) console.log('[sync]', JSON.stringify(result));
  // a usable read of Tally ends the pre-post check. An answer that looks like an error is not trusted: the documents stay
  // queued instead of being posted without a real duplicate check.
  const looksBroken = !rows.length && (rawIn.length < 40 || /LINEERROR|<ERROR|No company|not found/i.test(rawIn));
  await q("update orgs set last_pull_result=$1::jsonb, sync_stage=case when $3 then sync_stage else null end where id=$2",
    [JSON.stringify({ ...result, vouchers: rows.length, at: new Date().toISOString(), broken: looksBroken }), req.org.id, looksBroken]);
  await syncrun.onUpload(req.org.id, { ...result, vouchers: rows.length }, looksBroken);
  res.json({ stored: rows.length, ...result });
}));

/** Prefilled agent_config.json for the logged-in client (server address + their own token). */
app.get('/api/agent-config', currentUser, wrap(async (req, res) => {
  const org = await q1('select agent_token from orgs where id=$1', [req.user.org_id]);
  res.setHeader('Content-Disposition', 'attachment; filename="agent_config.json"');
  res.type('application/json').send(JSON.stringify({
    server_url: publicBase(req), agent_token: org.agent_token, tally_url: 'http://localhost:9000', poll_seconds: 10,
  }, null, 2));
}));
/**
 * One-file download: the agent program with THIS client's settings appended to it (a small block at the end of the file).
 * The program installs itself, starts with Windows and reads its settings from itself, so there is nothing else to configure.
 */
const AGENT_EXE = path.join(__dirname, '..', 'downloads', 'TallySync-Agent.exe');
app.get('/api/agent-download', currentUser, wrap(async (req, res) => {
  if (!fs.existsSync(AGENT_EXE)) throw httpErr(404, 'The agent program is not available on the server');
  const org = await q1('select agent_token from orgs where id=$1', [req.user.org_id]);
  const settings = JSON.stringify({ server_url: publicBase(req), agent_token: org.agent_token, tally_url: 'http://localhost:9000' });
  const trailer = Buffer.from('<<TALLYSYNC_CONFIG>>' + Buffer.from(settings).toString('base64') + '<<END>>', 'ascii');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(AGENT_EXE).size + trailer.length,
    'Content-Disposition': 'attachment; filename="TallySync-Agent.exe"', 'Cache-Control': 'no-store',
  });
  const rs = fs.createReadStream(AGENT_EXE);
  rs.on('error', () => res.destroy());
  rs.on('end', () => res.end(trailer));
  rs.pipe(res, { end: false });
}));
// The plain program (no settings inside). Contains no secrets; the token comes only from the config file.
app.use('/downloads', express.static(path.join(__dirname, '..', 'downloads')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// The web page is normally served by Vercel; this keeps a local/direct copy working too (docker image: /srv/frontend).
const FRONTEND_DIR = [process.env.FRONTEND_DIR, path.join(__dirname, '..', 'frontend'), path.join(__dirname, '..', '..', 'frontend')].find((d) => d && fs.existsSync(path.join(d, 'index.html')));
if (FRONTEND_DIR) app.use(express.static(FRONTEND_DIR));
app.use((err, req, res, next) => { // JSON errors in the same shape the dashboard expects: {detail}
  if (res.headersSent) return next(err);
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ detail: status === 500 ? 'Server error' : err.message, code: status < 500 && typeof err.code === 'string' ? err.code : undefined });
});

async function main() {
  await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  if (sb.enabled()) await sb.ensureBucket().catch((e) => console.error('storage bucket:', e.message));
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ORG_NAME } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD && !(await q1('select 1 from users limit 1'))) {
    const org = await q1('insert into orgs(name,agent_token) values($1,$2) returning id', [ORG_NAME || 'My Company', crypto.randomBytes(32).toString('base64url')]);
    const { salt, hash } = core.hashPassword(ADMIN_PASSWORD);
    const authId = sb.enabled() ? await sb.ensureAuthUser(ADMIN_EMAIL.toLowerCase(), ADMIN_PASSWORD, { org_id: org.id }) : null;
    await q('insert into users(org_id,email,salt,pw_hash,auth_id) values($1,$2,$3,$4,$5)', [org.id, ADMIN_EMAIL.toLowerCase(), salt, hash, authId]);
  }
  app.listen(cfg.PORT, '0.0.0.0', () => console.log(`TallySync listening on :${cfg.PORT}`));
  await mailer.startAll();
}
if (require.main === module) main().catch((e) => { console.error('fatal', e); process.exit(1); });
module.exports = { app };
