'use strict';
const net = require('net');
/*
 * TallySync agent (Windows). Download once, double-click once:
 *   - installs itself into %LOCALAPPDATA%\TallySync
 *   - starts with Windows (per-user startup entry) and runs quietly in the background, no window
 *   - the settings are built into the downloaded file, so there is nothing else to configure
 * Remove it completely with:   TallySync-Agent.exe --uninstall
 *
 * It only makes OUTGOING HTTP calls to the server, so no router / firewall changes are needed.
 * Development: node tally_agent.js  (reads agent_config.json next to this file; runs in the console)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const MARK = '<<TALLYSYNC_CONFIG>>';
const END_MARK = '<<END>>';
const EXE_NAME = 'TallySync-Agent.exe';
const RUNKEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WIN = process.platform === 'win32';
const TEST = process.env.TALLYSYNC_TEST_DIR; // test hook: use a throw-away folder and never touch the registry
const INSTALL_DIR = TEST || (WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TallySync') : path.join(os.homedir(), '.tallysync'));
const NO_REG = !!TEST || process.env.TALLYSYNC_NO_REGISTRY === '1';
const LOGFILE = path.join(INSTALL_DIR, 'agent.log');
const PIDFILE = path.join(INSTALL_DIR, 'agent.pid');
const args = process.argv.slice(2);
let SEA = false;
try { SEA = require('node:sea').isSea(); } catch { /* plain node */ }
const SELF = SEA ? process.execPath : __filename;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let toFile = false; // background mode logs to a file, there is no window
function log(...a) {
  const line = new Date().toLocaleString() + ' ' + a.join(' ');
  if (!toFile) return console.log(line);
  try {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    try { if (fs.statSync(LOGFILE).size > 1e6) fs.renameSync(LOGFILE, LOGFILE + '.old'); } catch { /* no log yet */ }
    fs.appendFileSync(LOGFILE, line + '\n');
  } catch { /* logging must never stop the agent */ }
}

// ---------- settings: built into the downloaded exe (a small block appended to the file), or agent_config.json ----------
function embeddedConfig() {
  if (!SEA) return null;
  try {
    const fd = fs.openSync(process.execPath, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 16384), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const s = buf.toString('latin1');
    const i = s.lastIndexOf(MARK), j = s.lastIndexOf(END_MARK);
    if (i < 0 || j < i) return null;
    return JSON.parse(Buffer.from(s.slice(i + MARK.length, j), 'base64').toString('utf8'));
  } catch { return null; }
}
function loadConfig() {
  const e = embeddedConfig();
  if (e) return e;
  const f = path.join(path.dirname(SELF), 'agent_config.json');
  if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* fall through */ } }
  return null;
}

let SERVER = '', TALLY = 'http://localhost:9000', AUTH = {};
const TICK = 2000; // ask the server for work every 2 seconds (tiny request); Tally is only read when needed
function applyConfig(c) {
  SERVER = String(c.server_url || '').replace(/\/+$/, '');
  TALLY = c.tally_url || 'http://localhost:9000';
  AUTH = { Authorization: `Bearer ${c.agent_token}` };
}

// ---------- talking to Tally ----------
async function tallyPost(xml) {
  const r = await fetch(TALLY, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml, signal: AbortSignal.timeout(60000) });
  return r.text();
}
/** [ok, message] from a Tally import response. */
function importResult(resp) {
  const n = (tag) => { const m = resp.match(new RegExp(`<${tag}>(\\d+)</${tag}>`)); return m ? parseInt(m[1], 10) : 0; };
  const errors = n('ERRORS'), created = n('CREATED'), altered = n('ALTERED');
  const line = resp.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/);
  if (errors || resp.includes('<LINEERROR>')) return [false, line ? line[1].trim() : `Tally reported ${errors} error(s)`];
  if (created || altered) return [true, `created=${created} altered=${altered}`];
  return [false, 'Tally accepted the request but created nothing: ' + resp.replace(/\s+/g, ' ').slice(0, 200)];
}
async function doJob(job) {
  try {
    for (const lx of job.ledgers) await tallyPost(lx); // make sure ledgers exist ("already exists" errors are fine)
    return importResult(await tallyPost(job.voucher)); // post the voucher
  } catch (e) {
    return [false, `Cannot reach Tally: ${e.message}`];
  }
}
async function sendExport(xml, why) {
  const count = (xml.match(/<GUID>/g) || []).length; // one GUID per voucher in our export
  log(`${why}: Tally returned ${xml.length} bytes, ${count} vouchers`);
  if (!count) log('No vouchers in the reply. Start of reply:', xml.replace(/\s+/g, ' ').slice(0, 300));
  const u = await fetch(`${SERVER}/api/agent/vouchers`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'text/xml' }, body: xml });
  log('uploaded:', (await u.text()).slice(0, 160));
  if (!u.ok) throw new Error(`server answered ${u.status}`);
}
/** Does TallyPrime itself answer on this computer? (Open, with its connection switched on.) */
/** Is something listening on Tally's port? A plain connection test: it works even while Tally is busy and slow to answer HTTP. */
function tcpOpen(host, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const end = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(ms, () => end(false));
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}
async function tallyReachable() {
  let host = 'localhost', port = 9000;
  try { const u = new URL(TALLY); host = u.hostname; port = Number(u.port) || 80; } catch { /* keep the defaults */ }
  const hosts = host === 'localhost' ? ['127.0.0.1', '::1'] : [host]; // some PCs resolve "localhost" to IPv6, some to IPv4
  for (let attempt = 0; attempt < 2; attempt++) { // two tries, so one unlucky moment does not flip the status
    for (const h of hosts) if (await tcpOpen(h, port, 1500)) return true;
    if (!attempt) await sleep(300);
  }
  return false;
}
async function loop() {
  log('agent started ->', SERVER, '| tally:', TALLY);
  let lastErr = '';
  let tallyWas = null;
  for (;;) {
    try {
      const up = await tallyReachable(); // told to the server on every poll, so a closed Tally stops a sync at once with a clear message
      if (up !== tallyWas) { log(up ? 'TallyPrime is reachable' : 'TallyPrime is not reachable (is it open, with the connection on port 9000?)'); tallyWas = up; }
      const r = await fetch(`${SERVER}/api/agent/poll?tally=${up ? 1 : 0}`, { headers: AUTH, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`server answered ${r.status}`);
      const data = await r.json();
      if (lastErr) log('connection to the server is OK again');
      lastErr = '';
      if (!up) { await sleep(TICK); continue; } // nothing can be done while Tally is closed; the server has already stopped any sync
      for (const job of data.jobs) {
        const [ok, message] = await doJob(job);
        log('doc', job.id, ok ? 'OK' : 'FAILED', message);
        await fetch(`${SERVER}/api/agent/jobs/${job.id}/result`, {
          method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok, message }),
        });
      }
      if (data.pull) { // "Sync from Tally" / the check before "Sync to Tally": send a fresh export
        const xml = await tallyPost(data.pull);
        await sendExport(xml, 'reading Tally');
      }
    } catch (e) {
      const why = e.message + (e.cause && (e.cause.code || e.cause.message) ? ` (${e.cause.code || e.cause.message})` : '');
      if (why !== lastErr) log('server/Tally connection problem:', why); // log a repeating problem once, not every 2 seconds
      lastErr = why;
    }
    await sleep(TICK);
  }
}

// ---------- one agent per PC ----------
// A small "agent.pid" file in the install folder says which process is the running agent. No network port is used:
// some Windows PCs reserve ranges of ports, which would make a port-based lock fail.
function isAgentPid(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; } // no such process
  if (!WIN) return true;
  try { // the number could have been reused by another program after a crash: check the program name too
    const out = cp.execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { windowsHide: true, encoding: 'utf8' });
    return /TallySync-Agent/i.test(out);
  } catch { return true; }
}
function runningPid() {
  try { const pid = parseInt(fs.readFileSync(PIDFILE, 'utf8'), 10); return isAgentPid(pid) ? pid : null; } catch { return null; }
}
function takeLock() {
  if (runningPid()) return false; // another agent is already running on this PC
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.writeFileSync(PIDFILE, String(process.pid));
  const release = () => { try { if (parseInt(fs.readFileSync(PIDFILE, 'utf8'), 10) === process.pid) fs.unlinkSync(PIDFILE); } catch { /* ignore */ } };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  return true;
}
/**
 * Stop every agent that is running FROM the install folder (an old copy that never wrote a lock file would otherwise keep its file
 * locked and block an update). Only programs whose path is inside the install folder are touched, never this installer itself.
 */
function killInstalledAgents() {
  if (!WIN) return;
  const dest = path.join(INSTALL_DIR, EXE_NAME).replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name='${EXE_NAME}'" | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${dest}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: 'ignore', timeout: 20000 }); } catch { /* nothing to stop */ }
}
/** Stop a running agent (before an update or uninstall) and wait until it is gone. */
async function stopRunning() {
  const pid = runningPid();
  if (!pid) return;
  try { process.kill(pid); } catch { /* already gone */ }
  for (let i = 0; i < 20 && runningPid(); i++) await sleep(250);
}

// ---------- install / start with Windows / uninstall ----------
function startHidden() {
  cp.spawn('wscript.exe', [path.join(INSTALL_DIR, 'start.vbs')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
async function install() {
  console.log('TallySync agent setup\n');
  console.log('Installing. It will start by itself every time Windows starts and run quietly in the background.\n');
  await stopRunning(); // an older copy may be running (this is an update)
  killInstalledAgents(); // ...including copies that started before the lock file existed
  await sleep(800);
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  const dest = path.join(INSTALL_DIR, EXE_NAME);
  for (let i = 0; ; i++) {
    try { fs.copyFileSync(SELF, dest); break; } catch (e) {
      if (i === 2) { // still locked: Windows lets a running program be renamed, so move the old file aside and copy the new one
        try { fs.renameSync(dest, `${dest}.old-${Date.now()}`); } catch { /* try the copy again anyway */ }
      }
      if (i >= 6) throw e;
      killInstalledAgents();
      await sleep(1000);
    }
  }
  try { // leftovers of earlier updates
    for (const n of fs.readdirSync(INSTALL_DIR)) if (n.startsWith(EXE_NAME + '.old-')) { try { fs.rmSync(path.join(INSTALL_DIR, n), { force: true }); } catch { /* still in use */ } }
  } catch { /* ignore */ }
  const vbs = path.join(INSTALL_DIR, 'start.vbs'); // launches the agent with no window at all
  fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${dest}"" --run", 0, False\r\n`);
  if (!NO_REG) cp.execFileSync('reg', ['add', RUNKEY, '/v', 'TallySync', '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f'], { windowsHide: true, stdio: 'ignore' });
  startHidden();
  console.log('Done. TallySync agent is installed and running.\n');
  console.log('  - It starts automatically whenever Windows starts. You never need to open it again.');
  console.log('  - You can delete the file you downloaded.');
  console.log('  - In Tally, turn on the connection once: F1 Help > Settings > Connectivity > Client/Server: Server, port 9000.');
  console.log('\nThis window closes by itself.');
  setTimeout(() => process.exit(0), 12000);
}
async function uninstall() {
  console.log('Removing the TallySync agent...');
  await stopRunning();
  killInstalledAgents();
  await sleep(500);
  if (!NO_REG) { try { cp.execFileSync('reg', ['delete', RUNKEY, '/v', 'TallySync', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch { /* not installed */ } }
  try { fs.rmSync(path.join(INSTALL_DIR, 'start.vbs'), { force: true }); } catch { /* ignore */ }
  const inside = path.resolve(SELF).toLowerCase().startsWith(path.resolve(INSTALL_DIR).toLowerCase());
  if (!inside) {
    try { fs.rmSync(INSTALL_DIR, { recursive: true, force: true }); } catch (e) { console.log('Could not remove the folder:', e.message); }
  } else { // running from inside the folder: it can only be deleted after this program has exited
    // wait ~6 s (this program exits after ~2.5 s and releases its own file), then delete the folder
    cp.spawn('cmd.exe', ['/d', '/s', '/c', `"ping -n 7 127.0.0.1 >nul & rmdir /s /q "${INSTALL_DIR}""`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  }
  console.log('Done. It will no longer start with Windows.');
  setTimeout(() => process.exit(0), 2500);
}

// ---------- entry ----------
async function main() {
  if (args.includes('--uninstall')) return uninstall();
  const cfg = loadConfig();
  if (!cfg) {
    console.log('This copy has no settings. Download the program again from the dashboard (Setup > Connect Tally).');
    setInterval(() => {}, 1 << 30); // keep the window open so the message can be read
    return;
  }
  applyConfig(cfg);
  if (args.includes('--run')) { // started by Windows at login (no window): log to a file
    toFile = true;
    if (!takeLock()) process.exit(0); // already running
    return loop();
  }
  if (!SEA || !WIN) return loop(); // development / non-Windows: run in this window
  const installedHere = path.resolve(path.dirname(SELF)).toLowerCase() === path.resolve(INSTALL_DIR).toLowerCase();
  if (installedHere) { // the user double-clicked the installed copy
    if (runningPid()) console.log('TallySync agent is already running in the background. Nothing to do.');
    else { startHidden(); console.log('TallySync agent started in the background.'); }
    setTimeout(() => process.exit(0), 5000);
    return;
  }
  return install();
}
main().catch((e) => {
  console.log('\nCould not finish: ' + e.message);
  console.log('Close this window, then open the downloaded file again. If it still fails, restart the computer once and try again.');
  setInterval(() => {}, 1 << 30); // keep the window open so the message can be read
});
