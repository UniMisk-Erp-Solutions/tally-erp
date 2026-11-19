'use strict';
// Tracked sync runs ("pipelines"): the dashboard shows real progress from these, and the Sync buttons stay locked
// until the run has finished (done, failed, or stopped by the timeout below).
//
//   kind 'to'   : checking -> posting -> readback -> done      (Sync to Tally)
//   kind 'from' : waiting  -> reading -> done                  (Sync from Tally)
const { q, q1 } = require('./core');

// How long a run may sit in one stage without any sign of life before it is stopped (seconds). Short on purpose: the
// Tally program asks the server for work every 2 seconds, so a long silence means Tally is closed or the program is off.
const STALE = { waiting: 25, checking: 45, reading: 45, posting: 120, readback: 60 };
const WHY = {
  checking: 'Tally did not answer. Open TallyPrime and your company on the Tally computer, and check that the Tally program is running (green light, top right). Then click Sync again.',
  waiting: 'The Tally program did not pick up the request. Check that it is running on the Tally computer (green light, top right). Then click Sync again.',
  reading: 'Tally did not send its data in time. Open TallyPrime and your company, and check that its connection is on (port 9000). Then click Sync again.',
  posting: 'Posting stopped because Tally stopped answering. Documents that were not posted are back to Approved. Open TallyPrime, then click Sync to Tally again.',
  readback: 'The documents were posted, but Tally could not be read again to confirm them. Click Sync from Tally to refresh.',
};
const TALLY_CLOSED = 'TallyPrime is not open on the Tally computer, so the sync was stopped. Open TallyPrime and your company, then click Sync again.';

/**
 * Stop a run. A "to" run also puts its still-waiting documents back to Approved and releases the pre-post check,
 * so nothing is left half-done and nothing gets posted later without a fresh check of Tally.
 */
async function abort(run, message) {
  if (run.kind === 'to') {
    await q("update documents set status='approved' where id = any($1) and status='queued'", [run.doc_ids]);
    await q('update orgs set sync_stage=null where id=$1', [run.org_id]);
  }
  return q1("update sync_runs set status='error', message=$1, finished_at=now(), updated_at=now() where id=$2 returning *", [message, run.id]);
}

/** Latest run for the organisation. A running one that has gone quiet is stopped, so the buttons never stay locked. */
async function current(orgId) {
  let r = await q1('select * from sync_runs where org_id=$1 order by id desc limit 1', [orgId]);
  if (r && r.status === 'running' && (Date.now() - new Date(r.updated_at).getTime()) / 1000 > (STALE[r.stage] || 90)) {
    r = await abort(r, WHY[r.stage] || 'The sync stopped.');
  }
  return r;
}

/** The Tally program reported that TallyPrime itself is not answering. Returns true if a run was stopped because of it. */
async function onTallyClosed(orgId) {
  const run = await q1("select * from sync_runs where org_id=$1 and status='running' order by id desc limit 1", [orgId]);
  if (!run) return false;
  const note = run.kind === 'to' && run.stage === 'posting' ? ' Documents that were not posted are back to Approved.' : '';
  await abort(run, TALLY_CLOSED + note);
  return true;
}

async function start(orgId, kind, stage, docIds = []) {
  const cur = await current(orgId);
  if (cur && cur.status === 'running') {
    throw Object.assign(new Error('A sync is already running. Please wait until it finishes.'), { status: 409 });
  }
  return q1('insert into sync_runs(org_id,kind,stage,doc_ids) values($1,$2,$3,$4) returning *', [orgId, kind, stage, docIds]);
}

const running = (orgId) => q1("select * from sync_runs where org_id=$1 and status='running' order by id desc limit 1", [orgId]);
const queuedLeft = async (run) => (await q1("select count(*)::int c from documents where id = any($1) and status='queued'", [run.doc_ids])).c;
const setStage = (run, stage, extra = {}) =>
  q("update sync_runs set stage=$2, result=coalesce(result,'{}'::jsonb)||$3::jsonb, updated_at=now() where id=$1", [run.id, stage, JSON.stringify(extra)]);
const touch = (run) => q('update sync_runs set updated_at=now() where id=$1', [run.id]);

/** What happened to the documents of a "to" run, counted from their final state. */
async function summarize(run) {
  const rows = await q('select status, tally_state, tally_result, error from documents where id = any($1)', [run.doc_ids]);
  const failed = rows.filter((r) => r.status === 'error');
  return {
    total: rows.length,
    posted: rows.filter((r) => r.status === 'synced' && /^created/.test(r.tally_result || '')).length,
    found: rows.filter((r) => r.status === 'synced' && /^(Already in Tally|Linked)/.test(r.tally_result || '')).length,
    held: rows.filter((r) => r.status === 'approved' && r.tally_state === 'possible_duplicate').length,
    failed: failed.length,
    errors: failed.slice(0, 3).map((r) => r.error),
  };
}

async function finish(run, status, result, message = null) {
  await q("update sync_runs set status=$2, result=coalesce(result,'{}'::jsonb)||$3::jsonb, message=$4, finished_at=now(), updated_at=now() where id=$1",
    [run.id, status, JSON.stringify(result || {}), message]);
}

// ---------- events from the agent API ----------
/** The agent was handed the "read Tally" request. */
async function onPullHanded(orgId) {
  const run = await running(orgId);
  if (run && run.kind === 'from' && run.stage === 'waiting') await setStage(run, 'reading');
}
/** A job (one document) was reported back by the agent. */
async function onJobResult(orgId) {
  const run = await running(orgId);
  if (!run || run.kind !== 'to' || run.stage !== 'posting') return;
  if ((await queuedLeft(run)) === 0) await setStage(run, 'readback'); else await touch(run);
}
/** Tally was read and reconciled. `result` is the reconcile summary, `broken` = Tally answered with an error. */
async function onUpload(orgId, result, broken) {
  const run = await running(orgId);
  if (!run) return;
  if (run.kind === 'from') {
    if (broken) return finish(run, 'error', {}, 'Tally answered with an error. Check the company name in Setup and that the company is open in Tally.');
    return finish(run, 'done', result);
  }
  if (broken) return; // a "to" run keeps asking until it gets a usable read (or times out)
  const left = await queuedLeft(run);
  if (run.stage === 'checking') {
    if (left > 0) return setStage(run, 'posting', { to_post: left, check: result });
    return finish(run, 'done', { ...(await summarize(run)), check: result });
  }
  if (left === 0) return finish(run, 'done', { ...(await summarize(run)), to_post: (run.result || {}).to_post || 0 }); // posting / readback complete
}

// ---------- what the dashboard shows ----------
async function view(run) {
  if (!run) return null;
  const res = run.result || {};
  const total = run.doc_ids.length;
  const done = run.status === 'done', err = run.status === 'error';
  const order = run.kind === 'to' ? ['checking', 'posting', 'readback'] : ['waiting', 'reading'];
  const at = order.indexOf(run.stage);
  const state = (i) => (done ? 'done' : i < at ? 'done' : i === at ? (err ? 'error' : 'active') : 'pending');
  let steps, fraction = 0;
  if (run.kind === 'to') {
    const left = run.stage === 'posting' ? await queuedLeft(run) : 0;
    const toPost = res.to_post || 0;
    const postedNow = Math.max(0, toPost - left);
    fraction = run.stage === 'posting' && toPost ? Math.min(1, postedNow / toPost) : 0;
    steps = [
      { label: 'Approved documents ready', detail: `${total} document${total === 1 ? '' : 's'}`, state: 'done' },
      { label: 'Checking Tally for existing entries', detail: done || at > 0 ? 'Done' : 'Reading Tally…', state: state(0) },
      { label: 'Posting to Tally', detail: run.stage === 'posting' ? `${postedNow} of ${toPost} posted` : done || at > 1 ? (res.posted != null ? `${res.posted} posted` : `${toPost} posted`) : 'Waiting', state: state(1) },
      { label: 'Confirming in Tally', detail: done ? 'Done' : run.stage === 'readback' ? 'Reading Tally…' : 'Waiting', state: state(2) },
    ];
  } else {
    steps = [
      { label: 'Asking the Tally program', detail: done || at > 0 ? 'Done' : 'Waiting for it…', state: state(0) },
      { label: 'Reading Tally', detail: done ? `${res.vouchers ?? 0} entries read` : run.stage === 'reading' ? 'Tally is answering…' : 'Waiting', state: state(1) },
      { label: 'Updating your records', detail: done ? 'Done' : 'Waiting', state: done ? 'done' : 'pending' },
    ];
  }
  const doneCount = steps.filter((s) => s.state === 'done').length;
  const percent = done ? 100 : Math.min(97, Math.round(((doneCount + fraction) / steps.length) * 100));
  return { id: run.id, kind: run.kind, status: run.status, stage: run.stage, steps, percent, result: res, message: run.message, started_at: run.started_at, finished_at: run.finished_at };
}

module.exports = { current, start, view, onPullHanded, onJobResult, onUpload, onTallyClosed };
