'use strict';
// Pair our documents with vouchers pulled from Tally, and build the Matching page rows.
const { q } = require('./core');

const normNo = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
const normName = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(pvt|private|ltd|limited|llp|co|company|the|and)\b/g, ' ')
    .split(/\s+/).filter(Boolean).join(' ');
const close = (a, b, tol = 1.0) => Math.abs(Number(a || 0) - Number(b || 0)) <= tol;
const r2 = (n) => Math.round(n * 100) / 100;
const docTotal = (e) => r2(e.taxable_value + e.cgst + e.sgst + e.igst + e.cess + e.round_off);

/**
 * Pair each postable document with its Tally voucher (or null).
 * Order of preference: stored link (tally_guid) -> invoice number / Tally "Reference" -> same party + amount + date within 3 days.
 * Records created from entries typed directly in Tally (source = 'tally') only hold a voucher: a real document
 * (email / upload) that matches the same voucher replaces them, so one invoice is never listed twice.
 */
async function pair(orgId) {
  const docs = await q(
    `select id, doc_type, status, source, extracted, tally_guid, tally_state, force_post from documents where org_id=$1
     and doc_type in ('purchase_bill','sales_invoice') and status in ('approved','queued','synced') order by id`, [orgId]);
  const vouchers = await q("select * from tally_vouchers where org_id=$1 and vch_type in ('Purchase','Sales')", [orgId]);
  const byGuid = new Map(vouchers.map((v) => [v.guid, v]));
  const byNo = new Map();
  for (const v of vouchers) {
    // Tally may auto-number vouchers (1, 2, 3...) and keep the supplier/customer invoice number in "Reference",
    // so index each voucher under both its number and its reference.
    for (const k of new Set([normNo(v.number), normNo(v.reference)])) {
      if (!k) continue;
      if (!byNo.has(k)) byNo.set(k, []);
      byNo.get(k).push(v);
    }
  }
  const claimed = new Set(); // vouchers owned by real documents
  const held = new Map();    // voucher id -> pair of the Tally-entered record that holds it
  const pairs = [];
  for (const d of docs) { // 1) stored links first, so a link is never stolen by another document
    const v = d.tally_guid ? byGuid.get(d.tally_guid) : null;
    if (!v) continue;
    const p = { doc: d, voucher: v, note: null };
    pairs.push(p);
    if (d.source === 'tally') held.set(v.id, p); else claimed.add(v.id);
  }
  const linked = new Set(pairs.map((p) => p.doc.id));
  for (const d of docs) { // 2) real documents without a link
    if (d.source === 'tally' || linked.has(d.id)) continue;
    const e = d.extracted;
    const want = d.doc_type === 'purchase_bill' ? 'Purchase' : 'Sales';
    let v = (byNo.get(normNo(e.number)) || []).find((x) => x.vch_type === want && !claimed.has(x.id)) || null;
    let note = null;
    if (!v) {
      const total = docTotal(e);
      v = vouchers.find((x) => {
        if (claimed.has(x.id) || x.vch_type !== want) return false;
        if (normName(x.party) !== normName(e.party_name) || !close(x.amount, total)) return false;
        const dd = x.vch_date && e.date ? Math.abs((Date.parse(x.vch_date) - Date.parse(e.date)) / 86400000) : 99;
        return dd <= 3;
      }) || null;
      if (v) note = 'matched on party+amount+date (number differs)';
    }
    if (v) claimed.add(v.id);
    const p = { doc: d, voucher: v, note };
    if (v && held.has(v.id)) p.replaces = held.get(v.id).doc;
    pairs.push(p);
  }
  const out = pairs.filter((p) => !(p.doc.source === 'tally' && claimed.has(p.voucher.id))); // replaced Tally-entered records drop out
  const taken = new Set(out.filter((p) => p.voucher).map((p) => p.voucher.id));
  const extra = vouchers.filter((v) => !taken.has(v.id)); // entered only in Tally
  return { pairs: out, extra };
}

async function run(orgId) {
  const { pairs, extra } = await pair(orgId);
  const rows = pairs.map(({ doc: d, voucher: v, note }) => {
    const e = d.extracted;
    const total = docTotal(e);
    const row = { doc_id: d.id, number: e.number, party: e.party_name, date: e.date, doc_amount: total, doc_status: d.status,
      type: d.doc_type === 'purchase_bill' ? 'Purchase' : 'Sales' };
    if (note) row.note = note;
    if (!v) {
      // approved = not sent to Tally yet (user has not pressed "Sync to Tally"): not a real mismatch
      row.result = d.tally_state === 'deleted_in_tally' ? 'deleted_in_tally' : d.status === 'approved' ? 'not_sent' : 'missing_in_tally';
      return row;
    }
    const issues = [];
    if (!close(v.amount, total)) issues.push(`amount: software ${total.toFixed(2)} vs Tally ${Number(v.amount).toFixed(2)}`);
    if (normName(v.party) !== normName(e.party_name)) issues.push(`party: '${e.party_name}' vs Tally '${v.party}'`);
    if (v.vch_date && e.date && String(v.vch_date) !== e.date) issues.push(`date: ${e.date} vs Tally ${v.vch_date}`);
    return Object.assign(row, { tally_amount: Number(v.amount), tally_party: v.party, tally_number: v.number, issues, result: issues.length ? 'mismatch' : 'matched' });
  });
  const only = extra.map((v) => ({
    result: 'missing_in_software', number: v.number || v.reference, party: v.party, date: String(v.vch_date), tally_amount: Number(v.amount), type: v.vch_type,
  }));
  const all = [...rows, ...only];
  const summary = {};
  for (const k of ['matched', 'mismatch', 'missing_in_tally', 'not_sent', 'deleted_in_tally', 'missing_in_software']) summary[k] = all.filter((r) => r.result === k).length;
  return { summary, rows: all };
}

module.exports = { pair, run, normNo, normName, close, r2, docTotal };
