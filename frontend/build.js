// Vercel build: writes dist/ = index.html + config.js built from the two Vercel environment variables.
const fs = require('fs');
const path = require('path');
const API_URL = (process.env.API_URL || '').trim().replace(/\/+$/, '');
const STUDIO_URL = (process.env.STUDIO_URL || '').trim().replace(/\/+$/, '');
if (!/^https:\/\/[^\s/]+$/.test(API_URL)) {
  console.error('API_URL is missing or invalid. Set it in Vercel > Settings > Environment Variables, e.g. https://tally-api.unimisk.com');
  process.exit(1);
}
const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(out, 'index.html'));
fs.writeFileSync(path.join(out, 'config.js'), `window.TALLYSYNC_CONFIG = ${JSON.stringify({ API_URL, STUDIO_URL })};\n`);
console.log('built dist/ for API', API_URL);
