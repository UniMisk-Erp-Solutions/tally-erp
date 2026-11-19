'use strict';
// Offline unit tests (no database, no network): node test/unit.js
process.env.DATABASE_URL ||= 'postgresql://x:x@127.0.0.1:1/x';
process.env.FERNET_KEY ||= Buffer.alloc(32, 7).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
process.env.DATA_DIR ||= require('os').tmpdir() + '/tallysync-test';
const assert = require('assert');
const core = require('../src/core');
const t = require('../src/tallyxml');
const ex = require('../src/extractor');
const matching = require('../src/matching');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok -', name); };

ok('fernet round trip', () => assert.strictEqual(core.decrypt(core.encrypt('abcd efgh ijkl mnop')), 'abcd efgh ijkl mnop'));
ok('fernet rejects tampering', () => {
  const tok = core.encrypt('secret');
  const bad = tok.slice(0, -4) + (tok.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => core.decrypt(bad));
});
ok('password hash/verify', () => {
  const { salt, hash } = core.hashPassword('pw12345678');
  assert.ok(core.verifyPassword('pw12345678', salt, hash));
  assert.ok(!core.verifyPassword('wrong', salt, hash));
});
ok('session cookie sign/verify', () => {
  const s = core.signSession(42);
  assert.strictEqual(core.readSession(s), 42);
  assert.strictEqual(core.readSession(s.slice(0, -2) + 'xx'), null);
});

const bill = { doc_type: 'purchase_bill', number: 'INV-12', date: '2026-11-10', party_name: 'ABC Traders & Co', party_gstin: '27AABCS1234D1Z5',
  taxable_value: 1000, cgst: 90, sgst: 90, igst: 0, cess: 0, round_off: 0, total: 1180, items: [{ description: 'Widget', qty: 2 }] };

function balance(xml) { // sum of signed amounts must be zero
  const re = /<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g; let m, s = 0;
  while ((m = re.exec(xml))) s += parseFloat(m[1]);
  return Math.round(s * 100) / 100;
}
ok('purchase voucher balances', () => assert.strictEqual(balance(t.voucherXml(bill)), 0));
ok('sales voucher with negative round-off balances', () =>
  assert.strictEqual(balance(t.voucherXml({ ...bill, doc_type: 'sales_invoice', round_off: -0.4, total: 1179.6 })), 0));
ok('sales voucher with positive round-off balances', () =>
  assert.strictEqual(balance(t.voucherXml({ ...bill, round_off: 0.4, total: 1180.4 })), 0));
ok('xml escaping of party name', () => assert.ok(t.voucherXml(bill).includes('ABC Traders &amp; Co')));
ok('PO is rejected as voucher', () => assert.throws(() => t.voucherXml({ ...bill, doc_type: 'purchase_order' })));
ok('import has ledgers + voucher', () => {
  const p = t.buildImport(bill, 'Test Co');
  assert.strictEqual(p.ledgers.length, 4);
  assert.ok(p.voucher.includes('SVCURRENTCOMPANY>Test Co<'));
});
ok('parse Tally export', () => {
  const xml = '<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER><DATE>20261110</DATE><VOUCHERNUMBER>INV-12</VOUCHERNUMBER>' +
    '<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><PARTYLEDGERNAME>ABC Traders &amp; Co</PARTYLEDGERNAME><AMOUNT>-1,180.00</AMOUNT><GUID>g1</GUID></VOUCHER>' +
    '<VOUCHER REMOTEID="r2"><DATE>20261112</DATE><VOUCHERNUMBER>X-9</VOUCHERNUMBER><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><AMOUNT>500</AMOUNT><GUID>g2</GUID></VOUCHER>' +
    '</COLLECTION></DATA></BODY></ENVELOPE>';
  const r = t.parseVouchers(xml);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0], { guid: 'g1', vch_type: 'Purchase', number: 'INV-12', date: '2026-11-10', party: 'ABC Traders & Co', reference: '', amount: 1180 });
});
ok('normalize coerces numbers + drops non-docs', () => {
  const d = ex.normalize({ doc_type: 'purchase_bill', total: '1,180', taxable_value: '1000', items: [{ qty: '2', rate: '500' }], party_gstin: ' 27aabcs1234d1z5 ' });
  assert.strictEqual(d.taxable_value, 1000);
  assert.strictEqual(d.party_gstin, '27AABCS1234D1Z5');
  assert.deepStrictEqual(ex.normalize({ doc_type: 'weird' }), { doc_type: 'other' });
});
ok('matching helpers', () => {
  assert.strictEqual(matching.normNo('SST/2026/0457'), matching.normNo('sst-2026-0457'));
  assert.strictEqual(matching.normName('ABC Traders Pvt. Ltd.'), matching.normName('abc traders private limited'));
});
const ID = { own_name: 'Demo Buyer LLP', own_gstin: '27AAACD5678K1Z2' };
ok('identity: bill addressed to us becomes a PURCHASE, other side is the party', () => {
  const d = { doc_type: 'sales_invoice', supplier_name: 'Sharma Steel Traders Pvt Ltd', supplier_gstin: '27AABCS1234D1Z5', buyer_name: 'Demo Buyer LLP', buyer_gstin: '27AAACD5678K1Z2' };
  assert.strictEqual(ex.applyIdentity(d, ID), null);
  assert.strictEqual(d.doc_type, 'purchase_bill'); assert.strictEqual(d.party_name, 'Sharma Steel Traders Pvt Ltd'); assert.strictEqual(d.party_gstin, '27AABCS1234D1Z5');
});
ok('identity: invoice we issue becomes a SALES invoice', () => {
  const d = { doc_type: 'purchase_bill', supplier_name: 'Demo Buyer LLP', supplier_gstin: '27AAACD5678K1Z2', buyer_name: 'Patel Traders', buyer_gstin: '27AAAFP9988R1Z3' };
  ex.applyIdentity(d, ID); assert.strictEqual(d.doc_type, 'sales_invoice'); assert.strictEqual(d.party_name, 'Patel Traders');
});
ok('identity: PO we issued = purchase order; order received = sales order', () => {
  const po = { doc_type: 'sales_order', supplier_name: 'Sharma Steel', supplier_gstin: '27AABCS1234D1Z5', buyer_name: 'Demo Buyer LLP', buyer_gstin: '27AAACD5678K1Z2' };
  ex.applyIdentity(po, ID); assert.strictEqual(po.doc_type, 'purchase_order');
  const so = { doc_type: 'purchase_order', supplier_name: 'Demo Buyer LLP', supplier_gstin: null, buyer_name: 'Kapadia Enterprises', buyer_gstin: '24AAAFK7766P1Z4' };
  ex.applyIdentity(so, ID); assert.strictEqual(so.doc_type, 'sales_order'); assert.strictEqual(so.party_name, 'Kapadia Enterprises');
});
ok('usual role = buyer: a document that does not show our side is treated as a purchase, with a warning', () => {
  const d = { doc_type: 'sales_invoice', supplier_name: 'Acme', supplier_gstin: '27AAAAA0000A1Z5', buyer_name: 'Somebody', buyer_gstin: null };
  const w = ex.applyIdentity(d, { ...ID, default_role: 'buyer' });
  assert.strictEqual(d.doc_type, 'purchase_bill'); assert.strictEqual(d.party_name, 'Acme'); assert.ok(/usual role/.test(w));
});
ok('usual role = seller: the same document becomes a sale', () => {
  const d = { doc_type: 'purchase_bill', supplier_name: 'Acme', buyer_name: 'Somebody', buyer_gstin: '24AAAFK7766P1Z4' };
  ex.applyIdentity(d, { ...ID, default_role: 'seller' }); assert.strictEqual(d.doc_type, 'sales_invoice'); assert.strictEqual(d.party_name, 'Somebody');
});
ok('mostly buyer, sometimes seller: our GSTIN decides exactly, the usual role never overrides it', () => {
  const ours = { ...ID, default_role: 'buyer' };
  const sale = { doc_type: 'purchase_bill', supplier_name: 'Demo Buyer LLP', supplier_gstin: '27AAACD5678K1Z2', buyer_name: 'Patel Traders', buyer_gstin: '27AAAFP9988R1Z3' };
  assert.strictEqual(ex.applyIdentity(sale, ours), null); assert.strictEqual(sale.doc_type, 'sales_invoice');
  const buy = { doc_type: 'sales_invoice', supplier_name: 'Sharma Steel', supplier_gstin: '27AABCS1234D1Z5', buyer_name: 'Demo Buyer LLP', buyer_gstin: '27AAACD5678K1Z2' };
  assert.strictEqual(ex.applyIdentity(buy, ours), null); assert.strictEqual(buy.doc_type, 'purchase_bill');
});
ok('no identity set: usual role (buyer) applies and warns only when it changes the type', () => {
  const a = { doc_type: 'purchase_bill', supplier_name: 'X', buyer_name: 'Y' };
  assert.strictEqual(ex.applyIdentity(a, { own_name: '', own_gstin: '', default_role: 'buyer' }), null);
  const b = { doc_type: 'sales_invoice', supplier_name: 'X', buyer_name: 'Y' };
  assert.ok(/not set in Settings/.test(ex.applyIdentity(b, { own_name: '', own_gstin: '', default_role: 'buyer' }))); assert.strictEqual(b.doc_type, 'purchase_bill');
});
console.log(`\n${n} tests passed`);
process.exit(0);
