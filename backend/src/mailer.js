'use strict';
// IMAP IDLE listener: one connection per mailbox. Read-only: never marks mail as read, moves or deletes it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { cfg, q, q1, decrypt, sleep } = require('./core');
const extractor = require('./extractor');

const ALLOWED = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.xlsx', '.xlsm', '.csv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MIN_BYTES = 3000; // skip tiny inline images / signatures

// ---------- AI work queue (one document at a time: friendly to free-tier rate limits) ----------
const workQ = [];
let working = false;
function enqueue(id) {
  workQ.push(id);
  pump();
}
async function pump() {
  if (working) return;
  working = true;
  try {
    while (workQ.length) {
      const id = workQ.shift();
      try { await extractor.processDocument(id); } catch (e) { console.error('ai worker error', e.message); }
    }
  } finally { working = false; }
}

/** Save an attachment to disk and create the document row. Returns the new id, or null if already imported. */
async function storeAttachment(orgId, mailboxId, source, ref, sender, subject, filename, content, mime) {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  const folder = path.join(cfg.FILES_DIR, String(orgId));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${crypto.randomBytes(5).toString('hex')}_${safe}`);
  fs.writeFileSync(file, content);
  const row = await q1(
    `insert into documents(org_id,mailbox_id,source,source_ref,sender,subject,filename,mime,file_path)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (org_id,source_ref,filename) do nothing returning id`,
    [orgId, mailboxId, source, ref, String(sender).slice(0, 200), String(subject).slice(0, 300), filename.slice(0, 200), mime, file]);
  if (!row) { // already imported
    fs.rmSync(file, { force: true });
    return null;
  }
  await q('insert into document_files(doc_id,data) values($1,$2) on conflict (doc_id) do nothing', [row.id, content]);
  enqueue(row.id);
  return row.id;
}

// ---------- one mailbox ----------
const running = new Map(); // mailboxId -> { stop: bool, client }

async function handleNew(client, mailbox) {
  let uids;
  if (mailbox.last_uid) {
    const all = await client.search({ uid: `${mailbox.last_uid + 1}:*` }, { uid: true });
    uids = (all || []).filter((u) => u > mailbox.last_uid); // "n:*" always returns at least the newest message
  } else {
    // first run: only the last 7 days
    uids = (await client.search({ since: new Date(Date.now() - 7 * 86400000) }, { uid: true })) || [];
  }
  uids.sort((a, b) => a - b);
  let maxUid = mailbox.last_uid;
  for (const uid of uids) {
    maxUid = Math.max(maxUid, uid);
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) continue;
    const mail = await simpleParser(msg.source);
    for (const att of mail.attachments || []) {
      const ext = path.extname(att.filename || '').toLowerCase();
      if (!ALLOWED.has(ext)) continue;
      // tiny images are logos / signatures; small PDFs, Excel and CSV files can be real (short) documents
      if (IMAGE_EXT.has(ext) && (att.size || att.content.length) < MIN_BYTES) continue;
      await storeAttachment(mailbox.org_id, mailbox.id, 'email', `${mailbox.id}:${uid}`,
        mail.from?.text || '', mail.subject || '', att.filename, att.content, att.contentType || '');
    }
  }
  if (maxUid !== mailbox.last_uid) {
    await q('update mailboxes set last_uid=$1 where id=$2', [maxUid, mailbox.id]);
    mailbox.last_uid = maxUid;
  }
  await q('update mailboxes set last_checked=now(), last_error=null where id=$1', [mailbox.id]);
}

async function mailboxLoop(id, state) {
  let backoff = 10;
  while (!state.stop) {
    const mailbox = await q1('select * from mailboxes where id=$1 and active', [id]);
    if (!mailbox) return;
    let client;
    try {
      client = new ImapFlow({
        host: mailbox.imap_host, port: 993, secure: true, logger: false,
        auth: { user: mailbox.email, pass: decrypt(mailbox.enc_password) },
      });
      client.on('error', () => {}); // connection errors surface through the awaits below
      state.client = client;
      await client.connect();
      await client.mailboxOpen('INBOX', { readOnly: true }); // read-only: cannot change flags
      backoff = 10;

      let dirty = true;
      let wake;
      client.on('exists', () => { dirty = true; wake?.(); }); // IDLE push: server tells us when mail arrives
      let closed = false;
      client.on('close', () => { closed = true; wake?.(); });

      while (!state.stop && !closed) {
        if (dirty) {
          dirty = false;
          await handleNew(client, mailbox);
          continue; // mail may have arrived while we were processing: re-check the flag first
        }
        // sleep until new mail (IDLE event), a close, or 20 min (safety re-check)
        let timer;
        await new Promise((res) => { wake = res; timer = setTimeout(res, 20 * 60 * 1000); });
        clearTimeout(timer);
        wake = null;
        dirty = true;
      }
      if (closed && !state.stop) throw new Error('connection closed');
    } catch (e) {
      await q('update mailboxes set last_error=$1 where id=$2', [String(e.message || e).slice(0, 300), id]).catch(() => {});
      await sleep(backoff * 1000);
      backoff = Math.min(backoff * 2, 600);
    } finally {
      try { await client?.logout(); } catch { /* ignore */ }
    }
  }
}

function startMailbox(id) {
  if (running.has(id)) return;
  const state = { stop: false, client: null };
  running.set(id, state);
  mailboxLoop(id, state).finally(() => running.delete(id));
}

function stopMailbox(id) {
  const s = running.get(id);
  if (s) { s.stop = true; try { s.client?.close(); } catch { /* ignore */ } }
}

async function startAll() {
  // requeue anything left unprocessed from a previous run
  for (const r of await q("select id from documents where status='new' order by id")) enqueue(r.id);
  for (const r of await q('select id from mailboxes where active')) startMailbox(r.id);
}

async function testLogin(host, email, password) {
  const c = new ImapFlow({ host, port: 993, secure: true, logger: false, auth: { user: email, pass: password } });
  c.on('error', () => {});
  await c.connect();
  await c.logout();
  return true;
}

module.exports = { ALLOWED, storeAttachment, enqueue, startMailbox, stopMailbox, startAll, testLogin };
