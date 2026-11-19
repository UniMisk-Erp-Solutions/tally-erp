'use strict';
// Supabase Auth (users) and Supabase Storage (files), called through the Supabase gateway with the service key.
const fs = require('fs');
const { cfg, q1 } = require('./core');

const BUCKET = 'documents';
const enabled = () => !!(cfg.SUPABASE_URL && cfg.SUPABASE_SERVICE_KEY);
const hdr = (extra = {}) => ({ apikey: cfg.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + cfg.SUPABASE_SERVICE_KEY, ...extra });
const call = (path, opt = {}) => fetch(cfg.SUPABASE_URL + path, { ...opt, headers: hdr(opt.headers), signal: AbortSignal.timeout(20000) });

// ---------------- Auth ----------------
/** Check an email + password with Supabase Auth. Returns the auth user id, or null when wrong. */
async function passwordLogin(email, password) {
  const r = await call('/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status === 400 || r.status === 401 || r.status === 422) return null;
  if (!r.ok) throw Object.assign(new Error('Sign-in service is not available'), { status: 503 });
  return (await r.json()).user?.id || null;
}
/** Create the user in Supabase Auth (already confirmed). If it exists, find it and set the password. */
async function ensureAuthUser(email, password, meta = {}) {
  const r = await call('/auth/v1/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: meta }) });
  if (r.ok) return (await r.json()).id;
  const found = await findAuthUser(email);
  if (!found) throw new Error('Could not create the user in Supabase Auth: ' + (await r.text()).slice(0, 200));
  await setAuthPassword(found, password);
  return found;
}
async function findAuthUser(email) {
  for (let page = 1; page < 20; page++) {
    const r = await call(`/auth/v1/admin/users?page=${page}&per_page=200`);
    if (!r.ok) return null;
    const list = (await r.json()).users || [];
    const u = list.find((x) => (x.email || '').toLowerCase() === email.toLowerCase());
    if (u) return u.id;
    if (list.length < 200) return null;
  }
  return null;
}
async function deleteAuthUser(authId) { await call('/auth/v1/admin/users/' + authId, { method: 'DELETE' }); }
async function setAuthPassword(authId, password) {
  const r = await call('/auth/v1/admin/users/' + authId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  if (!r.ok) throw new Error('Could not change the password: ' + (await r.text()).slice(0, 200));
}

// ---------------- Storage ----------------
let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const r = await call('/storage/v1/bucket/' + BUCKET);
  if (!r.ok) {
    const c = await call('/storage/v1/bucket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 26214400 }) });
    if (!c.ok) throw new Error('Could not create the storage bucket: ' + (await c.text()).slice(0, 200));
  }
  bucketReady = true;
}
const objPath = (p) => p.split('/').map(encodeURIComponent).join('/');
async function putFile(storagePath, buf, mime) {
  await ensureBucket();
  const r = await call(`/storage/v1/object/${BUCKET}/${objPath(storagePath)}`, { method: 'POST', headers: { 'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'true' }, body: buf });
  if (!r.ok) throw new Error('Storage upload failed: ' + (await r.text()).slice(0, 200));
}
async function getFile(storagePath) {
  const r = await call(`/storage/v1/object/${BUCKET}/${objPath(storagePath)}`);
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}
/** Original file of a document: Supabase Storage first, then the database copy, then the disk (older installs). */
async function loadFile(doc) {
  if (doc.storage_path && enabled()) { try { const b = await getFile(doc.storage_path); if (b) return b; } catch { /* try the next place */ } }
  const f = await q1('select data from document_files where doc_id=$1', [doc.id]);
  if (f) return f.data;
  if (doc.file_path && fs.existsSync(doc.file_path)) return fs.readFileSync(doc.file_path);
  return null;
}

module.exports = { enabled, passwordLogin, ensureAuthUser, findAuthUser, setAuthPassword, deleteAuthUser, ensureBucket, putFile, getFile, loadFile, BUCKET };
