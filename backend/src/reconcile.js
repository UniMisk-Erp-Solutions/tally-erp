'use strict';
// Runs after every read of Tally ("Sync from Tally", or the check that "Sync to Tally" does first).
//
//   Document waiting to be posted, voucher with the same invoice no. already in Tally -> marked synced, NOT posted again
//   Document waiting to be posted, Tally has same party + amount + date (other number) -> held as "possible duplicate"
//   Voucher typed directly in Tally, nothing in the dashboard for it  -> added to the dashboard as a record
//   Voucher typed in Tally AND a bill for it arrives by email         -> merged into one record
//   Voucher edited in Tally   -> Tally wins, the dashboard record is updated and the change logged
//   Voucher deleted in Tally  -> posted document goes back to "approved"; a Tally-only record is removed
const { q, q1 } = require('./core');
const extractor = require('./extractor');
const { pair, normName, close, r2 } = require('./matching');

async function event(orgId, docId, kind, detail) {
  await q('insert into doc_events(org_id, doc_id, kind, detail) values($1,$2,$3,$4)', [orgId, docId, kind, detail]);
}

/** Tally is the book of record: if a linked voucher no longer agrees with the document, take Tally's values. */
async function autoResolve(orgId, doc, v) {
  const e = { ...doc.extracted };
  const changes = [];
  if (normName(v.party) !== normName(e.party_name)) { changes.push(`party "${e.party_name}" -> "${v.party}"`); e.party_name = v.party; }
  if (v.vch_date && e.date && String(v.vch_date) !== e.date) { changes.push(`date ${e.date} -> ${v.vch_date}`); e.date = String(v.vch_date); }
  const taxes = e.cgst + e.sgst + e.igst + e.cess;
  const ours = r2(e.taxable_value + taxes + e.round_off);
  if (!close(v.amount, ours)) {
    changes.push(`total ${ours.toFixed(2)} -> ${Number(v.amount).toFixed(2)}`);
    e.total = Number(v.amount);
    const taxable = r2(e.total - taxes - e.round_off);
    if (taxable >= 0) e.taxable_value = taxable;
    else changes.push('(tax split could not be adjusted - check the document)');
  }
  if (!changes.length) return false;
  const warnings = await extractor.validate(e, orgId, doc.id);
  await q("update documents set extracted=$1::jsonb, warnings=$2::jsonb, tally_state='in_sync' where id=$3", [JSON.stringify(e), JSON.stringify(warnings), doc.id]);
  await event(orgId, doc.id, 'updated_from_tally', `Changed in Tally, dashboard updated to match: ${changes.join('; ')}`);
  return true;
}

/**
 * @param vouchers parsed vouchers from this read of Tally
 * @param range    {start,end} ISO dates the read covered (only vouchers inside it can be judged "deleted")
 */
async function afterPull(orgId, vouchers, range) {
  const res = { created: 0, found: 0, held: 0, merged: 0, updated: 0, deleted: 0, reset: 0 };
  const guids = [...new Set(vouchers.map((v) => v.guid))];
  const active = ((await q1('select tally_company from orgs where id=$1', [orgId])) || {}).tally_company || null;

  // 1) vouchers that disappeared from Tally. Skipped when the read returned nothing (could be an error, not a real wipe).
  if (guids.length && range) {
    const gone = (await q(
      `delete from tally_vouchers where org_id=$1 and vch_date between $2 and $3 and not (guid = any($4))
       and ($5::text is null or company is null or company=$5) returning guid`,
      [orgId, range.start, range.end, guids, active])).map((g) => g.guid);
    res.deleted = gone.length;
    if (gone.length) {
      const back = await q(
        `update documents set status='approved', tally_state='deleted_in_tally', tally_guid=null, synced_at=null
         where org_id=$1 and source<>'tally' and status='synced' and tally_guid = any($2) returning id`, [orgId, gone]);
      res.reset = back.length;
      for (const d of back) await event(orgId, d.id, 'deleted_in_tally', 'Voucher was deleted in Tally. The document is back to "approved"; click Sync to Tally to post it again.');
      const removed = await q(`delete from documents where org_id=$1 and source='tally' and tally_guid = any($2) returning extracted->>'number' as number`, [orgId, gone]);
      if (removed.length) await event(orgId, null, 'deleted_in_tally', `${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} made directly in Tally ${removed.length === 1 ? 'was' : 'were'} deleted there and removed here (${removed.map((r) => r.number).slice(0, 5).join(', ')}).`);
    }
    // a held "possible duplicate" whose Tally voucher is gone can be posted normally again
    await q(`update documents set tally_state=null, dup_guid=null where org_id=$1 and tally_state='possible_duplicate' and dup_guid = any($2)`, [orgId, gone]);
  }

  // 2) pair documents with vouchers
  const { pairs, extra } = await pair(orgId);
  for (const { doc, voucher: v, note, replaces } of pairs) {
    if (!v) continue;
    if (doc.source === 'tally') { if (await autoResolve(orgId, doc, v)) res.updated++; continue; }
    if (!doc.tally_guid) {
      if (doc.force_post) continue; // user chose "post anyway": leave it queued
      if (doc.status === 'synced') {
        await q("update documents set tally_guid=$1, tally_state='in_sync' where id=$2", [v.guid, doc.id]);
      } else if (note) {
        // not posted yet and only a fuzzy match (same party, amount, date but another number): never guess, ask the user
        if (doc.tally_state !== 'possible_duplicate' || doc.status !== 'approved') {
          await event(orgId, doc.id, 'possible_duplicate', `Not posted: Tally already has a ${v.vch_type} voucher (no. ${v.number || v.reference}) for the same party, amount and date. Open the document to confirm it is the same entry or post it anyway.`);
        }
        await q("update documents set status='approved', tally_state='possible_duplicate', dup_guid=$1 where id=$2", [v.guid, doc.id]);
        res.held++;
        continue;
      } else {
        // exact invoice-number match: it is already in Tally, so do not post it
        await q("update documents set tally_guid=$1, status='synced', synced_at=now(), tally_state='in_sync', dup_guid=null, tally_result='Already in Tally (found before posting)' where id=$2", [v.guid, doc.id]);
        await event(orgId, doc.id, 'found_in_tally', `Already in Tally (${v.vch_type} voucher no. ${v.number || v.reference}), so it was not posted again.`);
        res.found++;
      }
      if (replaces) { // the same invoice was first typed in Tally and is now also here as a real document: keep one record
        await q('delete from documents where id=$1', [replaces.id]);
        await event(orgId, doc.id, 'merged', `This document matches an entry that was typed directly in Tally (voucher no. ${v.number || v.reference}). The two records were merged.`);
        res.merged++;
      }
    } else if (doc.tally_state === 'possible_duplicate') {
      await q("update documents set tally_state='in_sync', dup_guid=null where id=$1", [doc.id]);
    }
    if (await autoResolve(orgId, doc, v)) res.updated++;
  }
  // a document held as "possible duplicate" whose candidate no longer matches anything is released
  await q(`update documents set tally_state=null, dup_guid=null where org_id=$1 and tally_state='possible_duplicate' and status='approved'
           and not exists (select 1 from tally_vouchers t where t.org_id=documents.org_id and t.guid=documents.dup_guid)`, [orgId]);

  // 3) vouchers typed directly in Tally become records in the dashboard
  for (const v of extra) {
    const type = v.vch_type === 'Purchase' ? 'purchase_bill' : 'sales_invoice';
    const amount = Number(v.amount);
    const extracted = {
      doc_type: type, number: v.reference || v.number, date: v.vch_date ? String(v.vch_date) : '', party_name: v.party, currency: 'INR',
      taxable_value: amount, cgst: 0, sgst: 0, igst: 0, cess: 0, round_off: 0, total: amount, items: [], confidence: 1,
      notes: `Entered directly in Tally (voucher no. ${v.number}). The tax split is not available from Tally.`,
    };
    const row = await q1(
      `insert into documents(org_id,source,source_ref,sender,subject,filename,mime,file_path,doc_type,status,extracted,tally_guid,tally_state,tally_result,synced_at,company)
       values($1,'tally',$2,'Tally (typed there)','',$3,'','',$4,'synced',$5::jsonb,$6,'in_sync','Entered directly in Tally',now(),$7)
       on conflict (org_id,source_ref,filename) do nothing returning id`,
      [orgId, 'tally:' + v.guid, `Tally ${v.vch_type} voucher ${v.number}`, type, JSON.stringify(extracted), v.guid, active]);
    if (row) res.created++;
  }
  if (res.created) await event(orgId, null, 'new_from_tally', `Added ${res.created} entr${res.created === 1 ? 'y' : 'ies'} that were typed directly in Tally.`);
  return res;
}

module.exports = { afterPull, event };
