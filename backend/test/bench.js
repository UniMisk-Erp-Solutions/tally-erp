'use strict';
// Speed + accuracy check of each AI model on real files (uses the free tier; a handful of calls).
//   docker exec -i tallysync node - < test/bench.js
const fs = require('fs');
const path = require('path');
const core = require('/srv/src/core.js');
const ex = require('/srv/src/extractor.js');

(async () => {
  const dir = path.join(core.cfg.FILES_DIR, '1');
  const pdf = fs.readdirSync(dir).find((f) => /Unimisk/i.test(f) && f.endsWith('.pdf'));
  if (!pdf) throw new Error('no sample PDF found in ' + dir);
  const files = [['digital PDF', path.join(dir, pdf)]];
  // a scanned-style image of the same invoice (tests the vision path)
  const m = await import('mupdf');
  const doc = m.Document.openDocument(fs.readFileSync(path.join(dir, pdf)), 'application/pdf');
  const s = 150 / 72;
  fs.writeFileSync('/tmp/bench_scan.png', Buffer.from(doc.loadPage(0).toPixmap(m.Matrix.scale(s, s), m.ColorSpace.DeviceRGB, false, true).asPNG()));
  files.push(['scanned image', '/tmp/bench_scan.png']);

  const models = [...core.cfg.AI_MODELS];
  console.log('expected: sales_invoice, number 2627116, total 43070\n');
  for (const model of models) {
    for (const [label, file] of files) {
      core.cfg.AI_MODELS = [model]; // test this model alone
      const t0 = Date.now();
      try {
        const r = ex.normalize(await ex.callModel(file));
        const good = r.number === '2627116' && Math.abs(r.total - 43070) < 1;
        console.log(`${model.padEnd(24)} ${label.padEnd(14)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${good ? 'CORRECT' : 'WRONG  '} ${r.doc_type} ${r.number} ${r.total}`);
      } catch (e) {
        console.log(`${model.padEnd(24)} ${label.padEnd(14)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  FAILED  ${String(e.message).slice(0, 110)}`);
      }
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
