'use strict';
// Integration test: "check before post", Tally-typed entries, no duplicates in either direction.
// Runs against the live server + database with a TEMPORARY organisation that is deleted at the end:
//     docker exec -i tallysync node - < backend/test/integration.js
const assert = require('assert');
const crypto = require('crypto');
const core = require('/srv/src/core.js');
const { q, q1 } = core;

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 8100);
const token = 'test-' + crypto.randomBytes(8).toString('hex');
const email = token + '@t.local';
let orgId, cookie;
let n = 0;
const ok = (m) => { n++; console.log('ok -', m); };

const xml = (vs) =>
  '<ENVELOPE><BODY><DATA><COLLECTION>' +
  vs.map((v) => `<VOUCHER><DATE>${v.date.replace(/-/g, '')}</DATE><VOUCHERNUMBER>${v.number}</VOUCHERNUMBER><VOUCHERTYPENAME>${v.type}</VOUCHERTYPENAME>` +
    `<PARTYLEDGERNAME>${v.party}</PARTYLEDGERNAME><REFERENCE>${v.ref || ''}</REFERENCE><AMOUNT>-${v.amount}</AMOUNT><GUID>${v.guid}</GUID></VOUCHER>`).join('') +
  '</COLLECTION></DATA></BODY></ENVELOPE>';

const agent = { Authorization: 'Bearer ' + token };
const poll = async () => (await fetch(BASE + '/api/agent/poll?tally=1', { headers: agent })).json();
const upload = async (body) => { const r = await fetch(BASE + '/api/agent/vouchers', { method: 'POST', headers: { ...agent, 'Content-Type': 'text/xml' }, body }); assert.strictEqual(r.status, 200); return r.json(); };
const pull = (vs) => upload(xml(vs));
const user = (path, method = 'POST') => fetch(BASE + path, { method, headers: { cookie } }).then((r) => r.json());

const doc = async (status, type, number, party, total, date = '2026-09-10') =>
  (await q1(
    `insert into documents(org_id,source,source_ref,filename,file_path,doc_type,status,extracted)
     values($1,'test',$2,$2,'/dev/null',$3,$4,$5::jsonb) returning id`,
    [orgId, 'T-' + number, type, status,
      JSON.stringify({ doc_type: type, number, date, party_name: party, taxable_value: total, cgst: 0, sgst: 0, igst: 0, cess: 0, round_off: 0, total, items: [], currency: 'INR' })])).id;
const get = (id) => q1('select status, tally_guid, tally_state, dup_guid, extracted, source from documents where id=$1', [id]);
const ev = (id) => q('select kind, detail from doc_events where doc_id=$1 order by id', [id]);
const tallyDocs = () => q("select id, extracted->>'number' as number from documents where org_id=$1 and source='tally' order by id", [orgId]);

(async () => {
  orgId = (await q1("insert into orgs(name, agent_token) values('integration-test',$1) returning id", [token])).id;
  try {
    const { salt, hash } = core.hashPassword('pw-test-1234');
    await q('insert into users(org_id,email,salt,pw_hash) values($1,$2,$3,$4)', [orgId, email, salt, hash]);
    const lr = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pw-test-1234' }) });
    cookie = lr.headers.get('set-cookie').split(';')[0];
    await poll(); // the Tally program is "running": a sync is only started when it was seen recently

    const A = await doc('synced', 'sales_invoice', 'INV-A', 'Alpha Traders', 1180);    // posted earlier
    const B = await doc('approved', 'purchase_bill', 'P-77', 'Beta Supplies', 2360);   // someone already typed it in Tally (same invoice no.)
    const C = await doc('synced', 'sales_invoice', 'INV-C', 'Gamma Stores', 590);      // will be deleted in Tally
    const D = await doc('approved', 'sales_invoice', 'INV-D', 'Delta Corp', 100);      // really missing in Tally: must be posted
    const E = await doc('approved', 'purchase_bill', 'E-5', 'Epsilon Ltd', 500);       // Tally has same party/amount/date, other number
    const F = await doc('approved', 'sales_invoice', 'F-6', 'Phi Traders', 700);       // same, but the user will say "post anyway"

    // ---------- Sync to Tally: Tally is checked FIRST ----------
    const s = await user('/api/sync');
    assert.strictEqual(s.queued, 4);
    assert.strictEqual((await q1('select sync_stage from orgs where id=$1', [orgId])).sync_stage, 'checking');
    let p = await poll();
    assert.strictEqual(p.jobs.length, 0, 'no document may be handed over before Tally was read');
    assert.ok(p.pull, 'the agent must be asked to read Tally'); ok('Sync to Tally: nothing is posted until Tally has been read first');
    p = await poll(); assert.ok(p.pull && p.jobs.length === 0); ok('the check keeps being requested until the answer arrives');

    // a broken answer must not release the documents
    await upload('<ENVELOPE><RESPONSE><LINEERROR>Company not found</LINEERROR></RESPONSE></ENVELOPE>');
    assert.strictEqual((await q1('select sync_stage from orgs where id=$1', [orgId])).sync_stage, 'checking');
    p = await poll(); assert.strictEqual(p.jobs.length, 0); ok('an error answer from Tally does not release documents for posting');

    // the real read of Tally
    const T1 = [
      { guid: 'g-A', type: 'Sales', number: '1', ref: 'INV-A', party: 'Alpha Traders', amount: '1180.00', date: '2026-09-10' },
      { guid: 'g-B', type: 'Purchase', number: 'PV/9', ref: 'P-77', party: 'Beta Supplies', amount: '2360.00', date: '2026-09-10' },
      { guid: 'g-C', type: 'Sales', number: '2', ref: 'INV-C', party: 'Gamma Stores', amount: '590.00', date: '2026-09-10' },
      { guid: 'g-E', type: 'Purchase', number: 'PV/55', ref: '', party: 'Epsilon Ltd', amount: '500.00', date: '2026-09-11' },
      { guid: 'g-F', type: 'Sales', number: '9', ref: '', party: 'Phi Traders', amount: '700.00', date: '2026-09-10' },
      { guid: 'g-X', type: 'Sales', number: '3', ref: '', party: 'Walk-in Customer', amount: '75.00', date: '2026-09-11' },          // typed only in Tally
      { guid: 'g-Y', type: 'Purchase', number: 'PV/12', ref: 'SUP-9', party: 'Zeta Supplies', amount: '900.00', date: '2026-09-12' }, // typed only in Tally
      { guid: 'g-J', type: 'Journal', number: '1', ref: '', party: 'Some Ledger', amount: '10.00', date: '2026-09-11' },
    ];
    let r = await pull(T1);
    assert.strictEqual((await q1('select sync_stage from orgs where id=$1', [orgId])).sync_stage, null); ok('a real read of Tally ends the check');
    assert.strictEqual(r.found, 1);
    const b = await get(B);
    assert.strictEqual(b.status, 'synced'); assert.strictEqual(b.tally_guid, 'g-B');
    assert.ok((await ev(B)).some((e) => e.kind === 'found_in_tally')); ok('bill already in Tally (same invoice no.): marked synced, NOT posted again');
    for (const id of [E, F]) { const d = await get(id); assert.strictEqual(d.status, 'approved'); assert.strictEqual(d.tally_state, 'possible_duplicate'); }
    assert.strictEqual(r.held, 2); ok('same party + amount + date but another number: held as "possible duplicate", not posted');
    assert.strictEqual((await get(D)).status, 'queued'); ok('a bill that is really missing in Tally stays queued for posting');
    assert.strictEqual((await get(A)).tally_guid, 'g-A'); ok('a document posted earlier is linked to its voucher (auto-numbered, invoice no. in Reference)');
    assert.strictEqual(r.created, 2);
    const tds = await tallyDocs(); assert.strictEqual(tds.length, 2);
    assert.deepStrictEqual(tds.map((t) => t.number).sort(), ['3', 'SUP-9']); ok('entries typed directly in Tally become records in the dashboard (Sales + Purchase only)');
    assert.strictEqual((await q1('select count(*)::int c from tally_vouchers where org_id=$1', [orgId])).c, 8);

    // ---------- only the missing bill is handed to the agent ----------
    p = await poll();
    assert.deepStrictEqual(p.jobs.map((j) => j.id), [D]); ok('only the bill that is missing in Tally is handed to the agent');

    // ---------- the user resolves the two held documents ----------
    await user(`/api/documents/${E}/confirm-duplicate`);
    const e1 = await get(E); assert.strictEqual(e1.status, 'synced'); assert.strictEqual(e1.tally_guid, 'g-E'); ok('"same entry": linked to the existing voucher, nothing posted');
    await user(`/api/documents/${F}/force-post`);
    assert.strictEqual((await get(F)).status, 'queued');
    p = await poll(); assert.ok(p.jobs.some((j) => j.id === F)); ok('"post anyway": the document is posted although a similar voucher exists');
    await pull(T1); // another read while F is force-posted: it must stay queued, not be held again
    assert.strictEqual((await get(F)).status, 'queued'); ok('a force-posted document is not held again by the next read');
    await fetch(BASE + `/api/agent/jobs/${F}/result`, { method: 'POST', headers: { ...agent, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, message: 'created=1' }) });

    // ---------- agent posts D; read-back links it ----------
    await fetch(BASE + `/api/agent/jobs/${D}/result`, { method: 'POST', headers: { ...agent, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, message: 'created=1' }) });
    const T2 = [...T1, { guid: 'g-D', type: 'Sales', number: '4', ref: 'INV-D', party: 'Delta Corp', amount: '100.00', date: '2026-09-10' }];
    r = await pull(T2);
    assert.strictEqual((await get(D)).tally_guid, 'g-D'); assert.strictEqual(r.created, 0);
    assert.strictEqual((await tallyDocs()).length, 2); ok('the voucher we just posted is linked to its document; no duplicate record is created');
    r = await pull(T2);
    assert.strictEqual(r.created + r.found + r.updated + r.held + r.deleted, 0); assert.strictEqual((await tallyDocs()).length, 2); ok('reading Tally again changes nothing (no duplicates)');
    {
      const run = (await user('/api/sync/status', 'GET')).run;
      assert.strictEqual(run.kind, 'to'); assert.strictEqual(run.status, 'done'); assert.strictEqual(run.percent, 100);
      assert.ok(run.steps.every((s) => s.state === 'done'), 'all steps done');
      assert.strictEqual(run.result.posted, 2); assert.strictEqual(run.result.found, 2); assert.strictEqual(run.result.failed, 0);
      ok('the Sync to Tally run finished by itself with the right summary (2 posted, 2 already in Tally, 0 failed)');
    }

    // ---------- Tally entry first, bill arrives by email later: one record ----------
    const G = await doc('approved', 'purchase_bill', 'SUP-9', 'Zeta Supplies', 900, '2026-09-12');
    await user('/api/sync');
    r = await pull(T2);
    const g = await get(G);
    assert.strictEqual(g.status, 'synced'); assert.strictEqual(g.tally_guid, 'g-Y');
    assert.deepStrictEqual((await tallyDocs()).map((t) => t.number), ['3']);
    assert.ok((await ev(G)).some((e) => e.kind === 'merged')); ok('same invoice typed in Tally AND received by email: merged into one record');

    // ---------- edits / deletions in Tally ----------
    const T3 = T2.filter((v) => v.guid !== 'g-C' && v.guid !== 'g-X').map((v) => (v.guid === 'g-A' ? { ...v, amount: '1500.00', date: '2026-09-12' } : v));
    r = await pull(T3);
    assert.strictEqual((await get(A)).extracted.total, 1500); ok('voucher edited in Tally: dashboard record updated and logged');
    const c = await get(C); assert.strictEqual(c.status, 'approved'); assert.strictEqual(c.tally_state, 'deleted_in_tally'); ok('voucher deleted in Tally: posted document goes back to approved');
    assert.strictEqual((await tallyDocs()).length, 0); ok('a record typed in Tally disappears when the voucher is deleted there');
    const empty = await upload('<ENVELOPE></ENVELOPE>');
    assert.strictEqual(empty.deleted, 0); ok('an empty read never counts as "everything deleted"');


    // ---------- progress pipeline + lock ----------
    const status = async () => (await user('/api/sync/status', 'GET')).run;
    const raw = (path, method = 'POST') => fetch(BASE + path, { method, headers: { cookie } });
    await q("update sync_runs set status='done' where org_id=$1 and status='running'", [orgId]);
    await q("update documents set status='ignored' where id=$1", [C]); // keep later scenarios free of leftover approved documents
    await q("update orgs set sync_stage=null where id=$1", [orgId]);

    assert.strictEqual((await raw('/api/pull')).status, 200);
    let st = await status();
    assert.strictEqual(st.kind, 'from'); assert.strictEqual(st.status, 'running'); assert.strictEqual(st.stage, 'waiting');
    assert.strictEqual(st.steps[0].state, 'active'); assert.ok(st.percent < 100); ok('Sync from Tally starts a tracked run (step 1 active)');
    assert.strictEqual((await raw('/api/pull')).status, 409); assert.strictEqual((await raw('/api/sync')).status, 409);
    ok('while a run is in progress, both Sync buttons are refused (409), so it cannot be started twice');
    p = await poll(); assert.ok(p.pull);
    st = await status();
    assert.strictEqual(st.stage, 'reading'); assert.strictEqual(st.steps[0].state, 'done'); assert.strictEqual(st.steps[1].state, 'active');
    ok('when the Tally program picks it up, the run moves on to "Reading Tally"');
    await upload('<ENVELOPE><RESPONSE><LINEERROR>No company</LINEERROR></RESPONSE></ENVELOPE>');
    st = await status();
    assert.strictEqual(st.status, 'error'); assert.ok(/company/i.test(st.message)); assert.strictEqual(st.steps[1].state, 'error');
    ok('an error answer from Tally ends the run with a clear message (buttons unlock)');
    assert.strictEqual((await raw('/api/pull')).status, 200); // unlocked again
    p = await poll(); assert.ok(p.pull);
    r = await pull(T3);
    st = await status();
    assert.strictEqual(st.status, 'done'); assert.strictEqual(st.percent, 100); assert.strictEqual(st.result.vouchers, T3.length);
    assert.ok(st.steps.every((s) => s.state === 'done')); ok('a good read completes the run: every step done, 100%, with the number of entries read');

    assert.strictEqual((await raw('/api/pull')).status, 200);
    await q("update sync_runs set updated_at = now() - interval '10 minutes' where org_id=$1 and status='running'", [orgId]);
    st = await status();
    assert.strictEqual(st.status, 'error'); assert.ok(/Tally program/.test(st.message));
    assert.strictEqual((await raw('/api/pull')).status, 200);
    ok('a run that gets no answer is stopped by the timeout with a clear message, so the buttons never stay locked');
    await q("update sync_runs set status='done' where org_id=$1 and status='running'", [orgId]);

    // Sync to Tally where everything is already in Tally: finishes straight after the check, nothing posted
    const H = await doc('approved', 'purchase_bill', 'H-1', 'Eta Co', 300);
    const sj = await (await raw('/api/sync')).json();
    assert.strictEqual(sj.queued, 1);
    st = await status();
    assert.strictEqual(st.kind, 'to'); assert.strictEqual(st.stage, 'checking'); assert.strictEqual(st.steps[1].state, 'active');
    p = await poll(); assert.ok(p.pull && p.jobs.length === 0);
    await pull([...T3, { guid: 'g-H', type: 'Purchase', number: 'PV/77', ref: 'H-1', party: 'Eta Co', amount: '300.00', date: '2026-09-10' }]);
    st = await status();
    assert.strictEqual(st.status, 'done'); assert.strictEqual(st.result.found, 1); assert.strictEqual(st.result.posted, 0);
    assert.strictEqual((await get(H)).status, 'synced');
    ok('everything already in Tally: the run completes right after the check, nothing posted, summary says so');
    assert.strictEqual((await (await raw('/api/sync')).json()).queued, 0); // no approved documents left: no run is created
    assert.strictEqual((await status()).id, st.id); ok('Sync to Tally with nothing approved creates no run');

    // ---------- Tally closed / Tally program off: stop at once, clear message, nothing left half-done ----------
    const pollT = async (t) => (await fetch(BASE + '/api/agent/poll?tally=' + t, { headers: agent })).json();
    await q("update sync_runs set status='done' where org_id=$1 and status='running'", [orgId]);
    await q('update orgs set sync_stage=null where id=$1', [orgId]);
    const J = await doc('approved', 'purchase_bill', 'J-1', 'Theta Ltd', 410);
    const body = async (res) => ({ status: res.status, ...(await res.json()) });

    await q("update orgs set agent_last_seen = now() - interval '10 minutes' where id=$1", [orgId]);
    let r1 = await body(await raw('/api/sync'));
    assert.strictEqual(r1.status, 409); assert.strictEqual(r1.code, 'agent_offline'); assert.ok(/Tally program is not running/.test(r1.detail));
    assert.strictEqual((await get(J)).status, 'approved'); assert.strictEqual((await status()).id, st.id);
    r1 = await body(await raw('/api/pull'));
    assert.strictEqual(r1.status, 409); assert.strictEqual(r1.code, 'agent_offline');
    ok('Tally program not running: both Sync buttons are refused at once with a clear message, nothing is queued, no run is created');

    await pollT(0); // the program is back but TallyPrime is closed
    r1 = await body(await raw('/api/sync'));
    assert.strictEqual(r1.status, 409); assert.strictEqual(r1.code, 'tally_closed'); assert.ok(/not open/.test(r1.detail));
    assert.strictEqual((await get(J)).status, 'approved');
    r1 = await body(await raw('/api/pull')); assert.strictEqual(r1.status, 409); assert.strictEqual(r1.code, 'tally_closed');
    ok('TallyPrime closed: refused at once ("TallyPrime is not open"), documents stay Approved');

    await pollT(1); // TallyPrime opened
    const s2 = await (await raw('/api/sync')).json();
    assert.strictEqual(s2.queued, 1); assert.strictEqual((await get(J)).status, 'queued');
    ok('once TallyPrime is open the same click starts the sync');

    p = await pollT(0); // ...and Tally is closed again in the middle of it
    st = await status();
    assert.strictEqual(st.status, 'error'); assert.ok(/not open/.test(st.message), st.message);
    assert.strictEqual(p.pull, null); assert.strictEqual(p.jobs.length, 0);
    assert.strictEqual((await get(J)).status, 'approved'); assert.strictEqual((await q1('select sync_stage from orgs where id=$1', [orgId])).sync_stage, null);
    ok('Tally closes during a sync: the run stops at once, waiting documents go back to Approved, the pre-post check is released');
    p = await pollT(1);
    assert.strictEqual(p.pull, null); assert.strictEqual(p.jobs.length, 0);
    ok('nothing runs on its own when Tally opens again (no silent posting); the user clicks Sync again');

    assert.strictEqual((await raw('/api/pull')).status, 200); // a "from" run
    p = await pollT(0);
    st = await status(); assert.strictEqual(st.status, 'error'); assert.ok(/not open/.test(st.message));
    p = await pollT(1); assert.strictEqual(p.pull, null);
    ok('Sync from Tally stopped the same way, and its pending read request is dropped');

    // quicker timeouts for programs that cannot report (older versions)
    assert.strictEqual((await raw('/api/pull')).status, 200);
    await q("update sync_runs set updated_at = now() - interval '40 seconds' where org_id=$1 and status='running'", [orgId]);
    st = await status(); assert.strictEqual(st.status, 'error'); assert.ok(/did not pick up/.test(st.message));
    ok('a request nobody picks up is stopped after about 25 seconds, not minutes');

    p = await poll(); assert.strictEqual(p.watch, undefined); ok('no live-watch request is ever sent (sync is button-driven only)');

    // ---- an old Tally program (never says whether TallyPrime is open) is told to update, at once
    await q('update orgs set tally_ok=null, tally_checked_at=null where id=$1', [orgId]);
    let t0 = Date.now(); let old = await raw('/api/pull'); let oj = await old.json();
    assert.strictEqual(old.status, 409); assert.strictEqual(oj.code, 'agent_outdated'); assert.ok(Date.now() - t0 < 2000);
    ok('an old Tally program is refused at once with "download the new one" instead of a long wait');
    await pollT(0); t0 = Date.now(); old = await raw('/api/pull'); oj = await old.json();
    assert.strictEqual(old.status, 409); assert.strictEqual(oj.code, 'tally_closed'); assert.ok(Date.now() - t0 < 2000);
    ok('TallyPrime closed: Sync from Tally says so instantly (under 2 seconds)');
    await pollT(1);

    // ---- the company named in Setup must be open in TallyPrime
    const pollCo = async (co) => (await fetch(BASE + '/api/agent/poll?tally=1&co=' + co, { headers: agent })).json();
    await q("update orgs set tally_company='Acme Traders' where id=$1", [orgId]);
    let pj = await pollCo(1);
    assert.strictEqual(pj.company, 'Acme Traders');
    assert.strictEqual((await raw('/api/pull')).status, 200); // company is open: the sync starts
    await q("update sync_runs set status='error', finished_at=now() where org_id=$1 and status='running'", [orgId]);
    await pollCo(0);
    let t1 = Date.now(); let cr = await raw('/api/pull'); let cj = await cr.json();
    assert.strictEqual(cr.status, 409); assert.strictEqual(cj.code, 'company_closed'); assert.ok(/Acme Traders/.test(cj.detail)); assert.ok(Date.now() - t1 < 2000);
    ok('company named in Setup is not open in TallyPrime: Sync stops at once and names the company');
    assert.strictEqual((await raw('/api/pull')).status, 409);
    await pollCo(1);
    assert.strictEqual((await raw('/api/pull')).status, 200);
    await q("update sync_runs set status='error', finished_at=now() where org_id=$1 and status='running'", [orgId]);
    ok('once that company is open, Sync works again');
    await q("update orgs set tally_company='', company_ok=null where id=$1", [orgId]);
    await pollCo(0); cr = await raw('/api/pull'); assert.notStrictEqual((await cr.json()).code, 'company_closed');
    ok('without a company name nothing is pinned: whichever company is open is used');
    await pollT(1);

    // ---- two computers on one account: one closed Tally must not hide the one that is open
    const pollAs = async (id, t, co) => (await fetch(BASE + `/api/agent/poll?tally=${t}${co === undefined ? '' : '&co=' + co}&id=${id}&h=PC-${id}`, { headers: agent })).json();
    await q("update sync_runs set status='error', finished_at=now() where org_id=$1 and status='running'", [orgId]);
    await q("update orgs set tally_company='' where id=$1", [orgId]);
    await q('delete from tally_agents where org_id=$1', [orgId]); // forget the single test agent used above
    for (let i = 0; i < 6; i++) { await pollAs('pcA', 1); await pollAs('pcB', 0); } // alternating reports, like two PCs polling
    const st2 = await (await fetch(BASE + '/api/stats', { headers: { cookie } })).json();
    assert.strictEqual(st2.org.tally_ok, true); assert.ok(st2.agents.length >= 2);
    assert.strictEqual((await raw('/api/pull')).status, 200);
    await q("update sync_runs set status='error', finished_at=now() where org_id=$1 and status='running'", [orgId]);
    const outB = await pollAs('pcB', 0); assert.strictEqual(outB.pull, null); assert.deepStrictEqual(outB.jobs, []);
    ok('one PC with TallyPrime open keeps the account connected, even while another PC reports closed (no flicker)');
    await pollAs('pcA', 0);
    const both = await raw('/api/pull'); assert.strictEqual(both.status, 409); assert.strictEqual((await both.json()).code, 'tally_closed');
    ok('when every computer reports TallyPrime closed, Sync stops at once');
    await pollAs('pcA', 1); await q("delete from tally_agents where org_id=$1", [orgId]);
    await pollT(1);

    // ---- another PC opens a different company: it becomes the active one, the earlier company is ignored
    const pollCn = async (id, t, cn) => (await fetch(BASE + `/api/agent/poll?tally=${t}&cn=${encodeURIComponent(cn)}&id=${id}&h=PC-${id}`, { headers: agent })).json();
    await q("update orgs set tally_company='', company_ok=null where id=$1", [orgId]);
    await q("update sync_runs set status='error', finished_at=now() where org_id=$1 and status='running'", [orgId]);
    await q('delete from tally_agents where org_id=$1', [orgId]);
    const typedIn = async (company, no) => q1(`insert into documents(org_id,source,source_ref,filename,mime,file_path,doc_type,status,extracted,company) values($1,'tally',$2,$3,'','','sales_invoice','synced','{}'::jsonb,$4) returning id`, [orgId, 'tally:t' + no, 'Tally Sales ' + no, company]);
    await typedIn('Company X', 'x1'); await typedIn('Company Y', 'y1');
    const listNames = async () => (await (await fetch(BASE + '/api/documents', { headers: { cookie } })).json()).filter((d) => d.source === 'tally').map((d) => d.filename).sort();
    let pa = await pollCn('pcA', 1, 'Company X'); assert.strictEqual(pa.company, 'Company X');
    assert.deepStrictEqual(await listNames(), ['Tally Sales x1']);
    await new Promise((r) => setTimeout(r, 1100));
    pa = await pollCn('pcB', 1, 'Company Y'); assert.strictEqual(pa.company, 'Company Y');
    assert.deepStrictEqual(await listNames(), ['Tally Sales y1']);
    ok('a second PC opens another company: it becomes active and the earlier company is ignored');
    const stNew = await (await fetch(BASE + '/api/stats', { headers: { cookie } })).json();
    assert.strictEqual(stNew.org.tally_company, 'Company Y');
    await pollCn('pcA', 1, 'Company X'); // the first PC is still on X: no switch back
    assert.strictEqual((await q1('select tally_company from orgs where id=$1', [orgId])).tally_company, 'Company Y');
    ok('the first PC polling again does not take the active company back');
    await pollAs('pcB', 0); const back = await pollCn('pcA', 1, 'Company X'); assert.strictEqual(back.company, 'Company X');
    assert.deepStrictEqual(await listNames(), ['Tally Sales x1']);
    ok('when the newest PC closes TallyPrime the other PC\'s company is active again');
    await q('delete from tally_agents where org_id=$1', [orgId]); await q("update orgs set tally_company='' where id=$1", [orgId]);
    await pollT(1);

    // ---- Tally's date error is shown readable, with a hint
    const QD = await doc('queued', 'purchase_bill', 'DATE-ERR-1', 'Date Test Co', 100, '2025-09-15');
    await fetch(BASE + `/api/agent/jobs/${QD}/result`, { method: 'POST', headers: { ...agent, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, message: 'Voucher date is missing for: &apos;Purchase&apos; voucher DATE-ERR-1. Verify the data.' }) });
    const eMsg = (await q1('select error from documents where id=$1', [QD])).error;
    assert.ok(!/&apos;/.test(eMsg) && /'Purchase'/.test(eMsg) && /financial year/.test(eMsg) && /2025-09-15/.test(eMsg), eMsg);
    ok("Tally's date error is readable (no &apos;) and explains the financial-year cause");

    // ---- public access: token login, CORS, signed links, rate limit
    const lj = await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pw-test-1234' }) })).json();
    assert.ok(lj.ok && typeof lj.token === 'string'); ok('login returns a token');
    const bearer = { Authorization: 'Bearer ' + lj.token };
    assert.strictEqual((await fetch(BASE + '/api/me', { headers: bearer })).status, 200);
    assert.strictEqual((await fetch(BASE + '/api/me')).status, 401);
    assert.strictEqual((await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + lj.token.slice(0, -3) + 'abc' } })).status, 401);
    ok('Bearer token works; no token / tampered token is refused');
    assert.strictEqual((await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + core.signSession(1, -10) } })).status, 401); ok('expired token is refused');
    const pre = await fetch(BASE + '/api/login', { method: 'OPTIONS', headers: { Origin: 'https://tally-erp-abc.vercel.app', 'Access-Control-Request-Method': 'POST' } });
    assert.strictEqual(pre.status, 204); assert.strictEqual(pre.headers.get('access-control-allow-origin'), 'https://tally-erp-abc.vercel.app');
    assert.ok(/Authorization/.test(pre.headers.get('access-control-allow-headers')));
    for (const o of ['https://evil.example.com', 'https://vercel.app.evil.com', 'https://x.vercel.app.evil.com']) {
      assert.strictEqual((await fetch(BASE + '/api/health', { headers: { Origin: o } })).headers.get('access-control-allow-origin'), null, o);
    }
    ok('CORS allows the Vercel page and refuses other websites');
    const FD = (await q1('select id from documents where org_id=$1 limit 1', [orgId])).id;
    const su = await (await fetch(BASE + '/api/signed-url', { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/api/documents/' + FD + '/file' }) })).json();
    assert.ok(/\/api\/documents\/\d+\/file\?t=/.test(su.url), JSON.stringify(su));
    const tok = new URL(su.url).searchParams.get('t');
    assert.notStrictEqual((await fetch(BASE + '/api/documents/' + FD + '/file?t=' + tok)).status, 401);
    assert.strictEqual((await fetch(BASE + '/api/documents/' + (FD + 1) + '/file?t=' + tok)).status, 401);
    assert.strictEqual((await fetch(BASE + '/api/me?t=' + tok)).status, 401);
    ok('signed link works for its own file only, never for other paths');
    const nopath = await fetch(BASE + '/api/signed-url', { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/api/documents' }) });
    assert.strictEqual(nopath.status, 400); ok('only file/download paths can be linked');
    let last; for (let i = 0; i < 9; i++) last = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify({ email: 'nobody@x.local', password: 'x' }) });
    assert.strictEqual(last.status, 429); ok('repeated wrong passwords are blocked (429)');

    console.log(`\n${n} integration checks passed`);
  } catch (e) {
    console.error('FAILED:', e.stack.split('\n').slice(0, 4).join('\n'));
    process.exitCode = 1;
  } finally {
    const sbm = require('/srv/src/supabase.js');
    for (const u of await q('select auth_id from users where org_id=$1 and auth_id is not null', [orgId])) await sbm.deleteAuthUser(u.auth_id).catch(() => {});
    await q('delete from orgs where id=$1', [orgId]); // cascades to documents, vouchers, events, users
    console.log('temporary test data removed');
    process.exit(process.exitCode || 0);
  }
})();
