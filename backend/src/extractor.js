'use strict';
// AI extraction (Gemma via Google AI Studio REST API) + validation. Free Gemma models only.
const fs = require('fs');
const path = require('path');
const { cfg, q, q1, sleep } = require('./core');
const { normName } = require('./matching');

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const DOC_TYPES = new Set(['purchase_bill', 'sales_invoice', 'purchase_order', 'sales_order', 'other']);

const PROMPT = `You read business documents for an Indian accounting system.
Look at the attached document and answer with ONE JSON object only (no markdown, no commentary).

Decide "doc_type" as one of:
  purchase_bill   - a bill/invoice we RECEIVED from a supplier
  sales_invoice   - an invoice WE issued to a customer
  purchase_order  - a PO we issued to a supplier
  sales_order     - an order received from a customer
  other           - anything else (newsletter, receipt of payment, personal, unrelated)

If doc_type is "other", return {"doc_type":"other"} and nothing else.

Otherwise return:
{
 "doc_type": "...",
 "number": "document / invoice / PO number",
 "date": "YYYY-MM-DD",
 "party_name": "the OTHER party (supplier for purchase docs, customer for sales docs)",
 "party_gstin": "15 char GSTIN of that party or null",
 "own_gstin": "GSTIN of our side or null",
 "supplier_name": "the SELLER named on the document (for a sales order: the company that received the order)",
 "supplier_gstin": "GSTIN of the seller or null",
 "buyer_name": "the BUYER named on the document (for a purchase order: the company that issued it)",
 "buyer_gstin": "GSTIN of the buyer or null",
 "place_of_supply": "state or null",
 "due_date": "YYYY-MM-DD or null (payment due date / delivery date for orders)",
 "reference_no": "related PO / order / booking reference printed on the document, or null",
 "payment_terms": "e.g. Net 30, or null",
 "party_address": "address of the other party, or null",
 "notes": "anything important not covered above (short), or null",
 "currency": "ISO code of the currency PRINTED on the document, e.g. INR, USD, AUD",
 "items": [{"description":"", "hsn":"", "qty":0, "unit":"", "rate":0, "discount":0, "amount":0, "gst_rate":0}],
Include EVERY line item on the document, one entry per line, in order.
 "taxable_value": 0,
 "cgst": 0, "sgst": 0, "igst": 0, "cess": 0, "round_off": 0,
 "total": 0,
 "confidence": 0.0
}
Use numbers (not strings) for amounts. Use null when a value is not on the document.
"confidence" is your own 0-1 estimate of how accurate the extraction is.`;

// ---------- turn a stored file into model input parts ----------
let _mupdf;
async function mupdf() {
  return (_mupdf ||= await import('mupdf'));
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
  }
  return String(v);
}

async function fileParts(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const m = await mupdf();
    const doc = m.Document.openDocument(fs.readFileSync(filePath), 'application/pdf');
    const n = doc.countPages();
    let text = '';
    for (let i = 0; i < n; i++) text += doc.loadPage(i).toStructuredText('preserve-whitespace').asText() + '\n';
    if (text.trim().length > 80) return [{ text: text.slice(0, 60000) }]; // digital PDF: text is cheaper and more exact
    const parts = [];
    for (let i = 0; i < Math.min(n, 4); i++) {
      const s = 150 / 72;
      const pix = doc.loadPage(i).toPixmap(m.Matrix.scale(s, s), m.ColorSpace.DeviceRGB, false, true);
      parts.push({ inline_data: { mime_type: 'image/png', data: Buffer.from(pix.asPNG()).toString('base64') } });
    }
    return parts;
  }
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    const mime = { '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'image/jpeg';
    return [{ inline_data: { mime_type: mime, data: fs.readFileSync(filePath).toString('base64') } }];
  }
  if (ext === '.xlsx' || ext === '.xlsm') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const out = [];
    for (const ws of wb.worksheets.slice(0, 3)) {
      out.push(`# sheet ${ws.name}`);
      let rows = 0;
      ws.eachRow({ includeEmpty: false }, (row) => {
        if (rows++ >= 300) return;
        const vals = row.values.slice(1).map(cellText);
        if (vals.some((v) => v !== '')) out.push(vals.join(' | '));
      });
    }
    return [{ text: out.join('\n').slice(0, 60000) }];
  }
  if (ext === '.csv' || ext === '.txt') return [{ text: fs.readFileSync(filePath, 'utf8').slice(0, 60000) }];
  throw new Error(`unsupported file type ${ext}`);
}

function parseJson(text) {
  text = text.trim().replace(/^```(?:json)?|```$/gm, '').trim();
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('model did not return JSON');
  return JSON.parse(text.slice(s, e + 1));
}

// ---------- rate-limited, retrying model call ----------
let chain = Promise.resolve();
let lastCall = 0;
function gate() {
  const p = chain.then(async () => {
    const wait = cfg.AI_MIN_INTERVAL * 1000 - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
  });
  chain = p.catch(() => {});
  return p;
}

// Only models that Google lists as "free of charge" on the Gemini API free tier. Pro, image, audio and "-latest" aliases
// (which can silently move to a model without a free tier) are refused, so the software can never pick a paid-only model.
const FREE_MODELS = new Set([
  'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3-flash-preview',
  'gemma-4-26b-a4b-it', 'gemma-4-31b-it',
]);
const cooldown = new Map();   // model -> ms timestamp until which it is skipped (free quota used up)
const noThinking = new Set(); // models that rejected the "minimal thinking" setting

async function postModel(model, parts) {
  const gen = { temperature: 0 };
  // Thinking makes answers slower. Minimal thinking is enough for reading a document.
  if (!noThinking.has(model)) gen.thinkingConfig = { thinkingLevel: 'minimal' };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': cfg.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: gen }),
    signal: AbortSignal.timeout(120000),
  });
  return { status: r.status, raw: await r.text(), retryAfter: parseInt(r.headers.get('retry-after') || '0', 10) };
}

async function callModel(filePath) {
  if (!cfg.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  for (const m of cfg.AI_MODELS) {
    if (!FREE_MODELS.has(m)) throw new Error(`Refusing to use '${m}': it is not on the free-tier allow-list`);
  }
  const parts = [{ text: PROMPT }, ...(await fileParts(filePath))];
  let lastErr = new Error('no model available');
  for (let round = 0; round < 3; round++) {
    for (const model of cfg.AI_MODELS) {
      if ((cooldown.get(model) || 0) > Date.now()) continue;
      for (let attempt = 0; attempt < 2; attempt++) {
        await gate();
        const t0 = Date.now();
        try {
          const { status, raw, retryAfter } = await postModel(model, parts);
          if (status === 200) {
            const cand = JSON.parse(raw).candidates[0].content.parts;
            const out = parseJson(cand.filter((p) => !p.thought).map((p) => p.text || '').join(''));
            console.log(`[ai] ${model} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
            return out;
          }
          if (status === 400 && /thinking/i.test(raw) && !noThinking.has(model)) { noThinking.add(model); attempt--; continue; }
          if (status === 429) { // free quota used up: the free tier refuses (never charges), so move on to the next model at once
            cooldown.set(model, Date.now() + (retryAfter || 60) * 1000);
            lastErr = new Error(`free quota used up for ${model} (HTTP 429)`);
            break;
          }
          lastErr = new Error(`HTTP ${status} from ${model}: ${raw.slice(0, 160)}`);
          if (status === 400 || status === 403 || status === 404) break; // this model cannot be used: next one
          await sleep(2000); // temporary server error: one quick retry, then the next model
        } catch (err) {
          lastErr = err;
          await sleep(2000);
        }
      }
    }
    // every model failed in this round: wait for the soonest cooldown (max 30 s) before the next round
    const soonest = Math.min(...cfg.AI_MODELS.map((m) => cooldown.get(m) || 0));
    await sleep(Math.min(Math.max(soonest - Date.now(), 5000), 30000));
  }
  throw new Error(`AI extraction failed: ${lastErr}`);
}

// ---------- normalise + validate ----------
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

function normalize(d) {
  d = { ...d };
  d.doc_type = DOC_TYPES.has(d.doc_type) ? d.doc_type : 'other';
  if (d.doc_type === 'other') return { doc_type: 'other' };
  for (const k of ['taxable_value', 'cgst', 'sgst', 'igst', 'cess', 'round_off', 'total']) d[k] = num(d[k]);
  d.items = (Array.isArray(d.items) ? d.items : [])
    .filter((it) => it && typeof it === 'object')
    .map((it) => ({ ...it, qty: num(it.qty), rate: num(it.rate), amount: num(it.amount), discount: num(it.discount), gst_rate: num(it.gst_rate) }));
  for (const k of ['party_gstin', 'own_gstin']) if (d[k]) d[k] = String(d[k]).trim().toUpperCase().replace(/ /g, '');
  d.number = String(d.number ?? '').trim();
  d.party_name = String(d.party_name ?? '').trim();
  d.confidence = num(d.confidence);
  return d;
}

async function validate(d, orgId, docId = null) {
  if (d.doc_type === 'other') return [];
  const w = [];
  if (!d.number) w.push('Missing document number');
  if (!d.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.date))) w.push('Missing or invalid date (need YYYY-MM-DD)');
  if (!d.party_name) w.push('Missing party name');
  if (d.party_gstin && !GSTIN_RE.test(d.party_gstin)) w.push(`Party GSTIN format looks wrong: ${d.party_gstin}`);
  const tax = d.cgst + d.sgst + d.igst + d.cess;
  const calc = d.taxable_value + tax + d.round_off;
  if (d.total && Math.abs(calc - d.total) > 1.0) w.push(`Total mismatch: taxable+tax+round = ${calc.toFixed(2)} but total = ${d.total.toFixed(2)}`);
  if (d.items.length) {
    const s = d.items.reduce((a, i) => a + i.amount, 0);
    if (d.taxable_value && Math.abs(s - d.taxable_value) > 1.0) w.push(`Line items sum ${s.toFixed(2)} differs from taxable value ${d.taxable_value.toFixed(2)}`);
  }
  if (d.cgst && d.igst) w.push('Both CGST and IGST present');
  if (d.number && d.party_name) {
    const dup = await q1(
      `select id from documents where org_id=$1 and id<>coalesce($2,-1) and status not in ('ignored','error')
       and extracted->>'number'=$3 and lower(extracted->>'party_name')=lower($4) and doc_type=$5 limit 1`,
      [orgId, docId, d.number, d.party_name, d.doc_type]);
    if (dup) w.push(`Possible duplicate of document #${dup.id}`);
  }
  const cur = String(d.currency || 'INR').trim().toUpperCase().slice(0, 3);
  if (cur !== 'INR') w.push(`Document currency is ${cur}, not INR. Tally posting assumes INR amounts - convert or check before syncing`);
  if (d.total && !(d.cgst || d.sgst || d.igst || d.cess) && Math.abs(d.taxable_value - d.total) > 1.0) {
    w.push('Tax amount not captured in CGST/SGST/IGST fields - check the tax split');
  }
  if ((d.confidence ?? 1) < 0.6) w.push('Low AI confidence - check carefully');
  return w;
}

/**
 * Decide purchase vs sales from OUR identity (Settings > Your company) instead of the AI's guess about who "we" are.
 * Mutates the raw AI answer. Returns a warning text when it could not tell, otherwise null.
 */
function applyIdentity(d, org) {
  if (!d || d.doc_type === 'other') return null;
  const usual = org && org.default_role === 'seller' ? 'seller' : 'buyer'; // "we are mostly the buyer" unless Settings says otherwise
  const ownG = String((org && org.own_gstin) || '').trim().toUpperCase().replace(/ /g, '');
  const ownN = normName((org && org.own_name) || '');
  const configured = !!(ownG || ownN);
  const isUs = (name, gstin) =>
    !!((ownG && gstin && String(gstin).trim().toUpperCase().replace(/ /g, '') === ownG) || (ownN && name && normName(name).includes(ownN)));
  const sup = configured && isUs(d.supplier_name, d.supplier_gstin);
  const buy = configured && isUs(d.buyer_name, d.buyer_gstin);
  const before = d.doc_type;
  let seller, warning = null;
  if (configured && sup !== buy) {
    seller = sup; // our GSTIN / name is on exactly one side: certain
  } else {
    seller = usual === 'seller'; // cannot tell: fall back to the usual role and say so
    d.__fallback = true;
  }
  const invoice = d.doc_type === 'sales_invoice' || d.doc_type === 'purchase_bill';
  d.doc_type = invoice ? (seller ? 'sales_invoice' : 'purchase_bill') : (seller ? 'sales_order' : 'purchase_order');
  const other = seller ? { name: d.buyer_name, gstin: d.buyer_gstin } : { name: d.supplier_name, gstin: d.supplier_gstin };
  if (other.name) { d.party_name = other.name; d.party_gstin = other.gstin || null; }
  const mine = seller ? d.supplier_gstin : d.buyer_gstin;
  if (mine) d.own_gstin = mine;
  if (d.__fallback) {
    delete d.__fallback;
    const role = seller ? 'the seller (a sale)' : 'the buyer (a purchase)';
    if (configured) warning = `Could not tell which side is your company from the name/GSTIN in Settings, so it was treated as you being ${role}, your usual role. Check the type.`;
    else if (d.doc_type !== before) warning = `Your company is not set in Settings, so this was treated as you being ${role}, your usual role. Set your GSTIN in Settings > Your company for exact results.`;
  }
  return warning;
}

/** Run extraction for a stored document and update its row. */
async function processDocument(docId) {
  const doc = await q1('select * from documents where id=$1', [docId]);
  if (!doc) return;
  try {
    const raw = await callModel(doc.file_path);
    const org = await q1('select own_name, own_gstin, default_role from orgs where id=$1', [doc.org_id]);
    const identityWarning = applyIdentity(raw, org);
    const data = normalize(raw);
    if (data.doc_type === 'other') {
      await q("update documents set doc_type='other', status='ignored', extracted=$1::jsonb where id=$2", [JSON.stringify(data), docId]);
      return;
    }
    const warnings = await validate(data, doc.org_id, docId);
    if (identityWarning) warnings.unshift(identityWarning);
    await q("update documents set doc_type=$1, status='extracted', extracted=$2::jsonb, warnings=$3::jsonb, error=null where id=$4",
      [data.doc_type, JSON.stringify(data), JSON.stringify(warnings), docId]);
  } catch (e) {
    await q("update documents set status='error', error=$1 where id=$2", [String(e.message || e).slice(0, 500), docId]);
  }
}

module.exports = { callModel, normalize, validate, processDocument, applyIdentity, GSTIN_RE };
