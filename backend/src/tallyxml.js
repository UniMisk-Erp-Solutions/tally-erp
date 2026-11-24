'use strict';
// Tally XML builders/parsers. Accounting-style vouchers (ledger entries): simplest and most robust.
const { XMLParser } = require('fast-xml-parser');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tdate = (iso) => String(iso || '').replace(/-/g, '');

function envelope(report, company, inner) {
  const comp = company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : '';
  return (
    '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>' +
    `<REQUESTDESC><REPORTNAME>${report}</REPORTNAME><STATICVARIABLES>${comp}</STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
  );
}

/** GST state codes (first two digits of a GSTIN) -> state names as TallyPrime spells them. */
const GST_STATES = { '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', 10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur', 15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal', 20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat', 26: 'Dadra & Nagar Haveli and Daman & Diu', 27: 'Maharashtra', 29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry', 35: 'Andaman & Nicobar Islands', 36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh' };
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

/** Everything the document tells us about the party, as Tally ledger details. */
function partyDetails(d) {
  const gstin = String(d.party_gstin || '').trim().toUpperCase();
  const valid = GSTIN_RE.test(gstin);
  const lines = String(d.party_address || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  const address = [];
  for (const part of lines) { // keep short lines, at most 4
    const last = address[address.length - 1];
    if (last && (last + ', ' + part).length <= 60 && address.length >= 4) address[address.length - 1] = last + ', ' + part;
    else if (last && (last + ', ' + part).length <= 40) address[address.length - 1] = last + ', ' + part;
    else address.push(part.slice(0, 100));
  }
  return {
    gstin: gstin || null,
    address: address.slice(0, 4),
    state: valid ? GST_STATES[gstin.slice(0, 2)] || null : null,
    pan: valid ? gstin.slice(2, 12) : null,
    regType: valid ? 'Regular' : 'Unregistered',
  };
}

function ledgerXml(name, parent, gstin, party) {
  let x = `<NAME>${esc(name)}</NAME><PARENT>${esc(parent)}</PARENT>`;
  if (party) { // the party's own ledger: full details from the document
    x += '<ISBILLWISEON>Yes</ISBILLWISEON>';
    if (party.address.length) x += `<ADDRESS.LIST TYPE="String">${party.address.map((a) => `<ADDRESS>${esc(a)}</ADDRESS>`).join('')}</ADDRESS.LIST>`;
    x += '<COUNTRYNAME>India</COUNTRYNAME>';
    if (party.state) x += `<LEDSTATENAME>${esc(party.state)}</LEDSTATENAME>`;
    x += `<GSTREGISTRATIONTYPE>${party.regType}</GSTREGISTRATIONTYPE>`;
    if (party.pan) x += `<INCOMETAXNUMBER>${party.pan}</INCOMETAXNUMBER>`;
  }
  if (gstin) x += `<PARTYGSTIN>${esc(gstin)}</PARTYGSTIN>`;
  return '<TALLYMESSAGE xmlns:UDF="TallyUDF">' + `<LEDGER NAME="${esc(name)}" ACTION="Create">${x}</LEDGER>` + '</TALLYMESSAGE>';
}

const TAX_KEYS = [['cgst', 'CGST'], ['sgst', 'SGST'], ['igst', 'IGST'], ['cess', 'Cess']];

/** Ledgers the voucher needs: [name, parent group, gstin]. */
function ledgerPlan(d) {
  const purchase = ['purchase_bill', 'purchase_order'].includes(d.doc_type);
  const out = [
    [d.party_name, purchase ? 'Sundry Creditors' : 'Sundry Debtors', d.party_gstin || null, partyDetails(d)],
    [purchase ? 'Purchase' : 'Sales', purchase ? 'Purchase Accounts' : 'Sales Accounts', null],
  ];
  for (const [k, label] of TAX_KEYS) if (d[k]) out.push([`${purchase ? 'Input' : 'Output'} ${label}`, 'Duties & Taxes', null]);
  if (d.round_off) out.push(['Round Off', 'Indirect Expenses', null]);
  return out;
}

/** Purchase / Sales voucher. POs and SOs are not accounting vouchers, so they are rejected. */
function voucherXml(d) {
  if (!['purchase_bill', 'sales_invoice'].includes(d.doc_type)) {
    throw new Error('Only purchase bills and sales invoices can be posted as vouchers');
  }
  const purchase = d.doc_type === 'purchase_bill';
  const vtype = purchase ? 'Purchase' : 'Sales';
  const total = Math.round((d.taxable_value + d.cgst + d.sgst + d.igst + d.cess + d.round_off) * 100) / 100;
  // Tally sign rules: debit = ISDEEMEDPOSITIVE Yes with negative amount; credit = No with positive amount.
  const partyDebit = !purchase; // sales: party is debited
  const entries = [];
  const entry = (name, amount, debit) =>
    entries.push(
      '<ALLLEDGERENTRIES.LIST>' +
      `<LEDGERNAME>${esc(name)}</LEDGERNAME>` +
      `<ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
      `<AMOUNT>${(debit ? -amount : amount).toFixed(2)}</AMOUNT>` +
      '</ALLLEDGERENTRIES.LIST>');

  entry(d.party_name, total, partyDebit);
  entry(vtype, d.taxable_value, !partyDebit);
  for (const [k, label] of TAX_KEYS) if (d[k]) entry(`${purchase ? 'Input' : 'Output'} ${label}`, d[k], !partyDebit);
  if (d.round_off) {
    // positive round_off adds to the total (party side already includes it), so it sits opposite the party
    entry('Round Off', Math.abs(d.round_off), (d.round_off > 0) !== partyDebit);
  }
  const items = (d.items || []).slice(0, 12).map((i) => `${i.description || ''} x${i.qty ?? ''}${i.unit ? ' ' + i.unit : ''}${i.rate ? ' @' + i.rate : ''}${i.hsn ? ' HSN ' + i.hsn : ''}`).join('; ');
  const narration = [
    `Inv ${d.number}${d.date ? ' dt ' + d.date : ''}`, d.reference_no ? `Ref ${d.reference_no}` : '', d.due_date ? `Due ${d.due_date}` : '',
    d.payment_terms ? `Terms ${d.payment_terms}` : '', d.place_of_supply ? `POS ${d.place_of_supply}` : '', items ? `Items: ${items}` : '',
    d.notes ? String(d.notes) : '', 'via TallySync'].filter(Boolean).join(' | ').slice(0, 700);
  return (
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">' +
    `<VOUCHER VCHTYPE="${vtype}" ACTION="Create" OBJVIEW="Accounting Voucher View">` +
    `<DATE>${tdate(d.date)}</DATE><VOUCHERTYPENAME>${vtype}</VOUCHERTYPENAME>` +
    `<VOUCHERNUMBER>${esc(d.number)}</VOUCHERNUMBER><REFERENCE>${esc(d.number)}</REFERENCE>` +
    `<PARTYLEDGERNAME>${esc(d.party_name)}</PARTYLEDGERNAME><NARRATION>${esc(narration)}</NARRATION>` +
    `${entries.join('')}</VOUCHER></TALLYMESSAGE>`
  );
}

/** XML payloads the agent must post, in order: ledgers first, then the voucher. */
function buildImport(d, company) {
  return {
    ledgers: ledgerPlan(d).map(([n, p, g, party]) => envelope('All Masters', company, ledgerXml(n, p, g, party))),
    voucher: envelope('Vouchers', company, voucherXml(d)),
  };
}

function exportRequest(company, fromDate, toDate) {
  const comp = company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : '';
  return (
    '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
    '<ID>TSVouchers</ID></HEADER><BODY><DESC><STATICVARIABLES>' +
    `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${comp}` +
    `<SVFROMDATE>${tdate(fromDate)}</SVFROMDATE><SVTODATE>${tdate(toDate)}</SVTODATE>` +
    '</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="TSVouchers"><TYPE>Voucher</TYPE>' +
    '<FETCH>Date,VoucherNumber,VoucherTypeName,PartyLedgerName,Reference,Amount,GUID</FETCH>' +
    '</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
  );
}

/** Parse a Tally collection export into simple objects. */
function parseVouchers(xml) {
  // strip illegal control characters Tally sometimes emits as numeric entities
  xml = xml.replace(/&#(?:[0-8]|1[1-2]|1[4-9]|2[0-9]|3[0-1]);/g, '');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
  const root = parser.parse(xml);
  const found = [];
  (function walk(node) {
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'VOUCHER') (Array.isArray(v) ? v : [v]).forEach((x) => found.push(x));
        else walk(v);
      }
    }
  })(root);
  const text = (v, tag) => {
    const x = v[tag];
    return typeof x === 'string' ? x.trim() : x && typeof x === 'object' && typeof x['#text'] === 'string' ? x['#text'].trim() : '';
  };
  return found
    .map((v) => {
      const d = text(v, 'DATE');
      return {
        guid: text(v, 'GUID') || v['@_REMOTEID'] || '',
        vch_type: text(v, 'VOUCHERTYPENAME') || v['@_VCHTYPE'] || '',
        number: text(v, 'VOUCHERNUMBER'),
        date: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
        party: text(v, 'PARTYLEDGERNAME'),
        reference: text(v, 'REFERENCE'),
        amount: Math.abs(parseFloat(text(v, 'AMOUNT').replace(/,/g, '')) || 0),
      };
    })
    .filter((o) => o.guid);
}

module.exports = { esc, buildImport, voucherXml, ledgerPlan, exportRequest, parseVouchers };
