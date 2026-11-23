#!/usr/bin/env node
// pickwise browser probe and registry tool.
//
//   node browser-probe.js serve [seconds] [port]   start the probe (default 300 s, port 47831)
//   node browser-probe.js list                     show this computer's registered browsers
//   node browser-probe.js remove <deviceId>        unregister a browser
//
// serve: listens on 127.0.0.1 only. A browser that loads
// http://127.0.0.1:<port>/?id=<deviceId> must run on THIS computer, so the hit
// registers it (browser type from the User-Agent) in
// ~/.claude/pickwise/browsers/<hostname>.json. Each hit is printed as one JSON
// line. GET /quit stops the probe early.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOST = os.hostname();
const DIR = path.join(os.homedir(), '.claude', 'pickwise', 'browsers');
const REGISTRY = path.join(DIR, `${HOST}.json`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function load() {
  try {
    const r = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    return { host: HOST, browsers: Array.isArray(r.browsers) ? r.browsers : [] };
  } catch {
    return { host: HOST, browsers: [] };
  }
}

function save(reg) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n');
}

function kind(ua) {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Brave/.test(ua)) return 'Brave';
  if (/Vivaldi/.test(ua)) return 'Vivaldi';
  if (/Chrome\//.test(ua)) return 'Chrome';
  return 'Browser';
}

function register(id, browser) {
  const reg = load();
  const today = new Date().toISOString().slice(0, 10);
  const existing = reg.browsers.find((b) => b.deviceId === id);
  if (existing) {
    existing.browser = browser;
    existing.verified = today;
  } else {
    const same = reg.browsers.filter((b) => b.browser === browser).length;
    const label = `${browser}${same ? ` ${same + 1}` : ''} (${HOST})`;
    reg.browsers.push({ deviceId: id, browser, label, verified: today });
  }
  save(reg);
  return reg.browsers.find((b) => b.deviceId === id);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function serve(secs, port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/quit') {
      res.end('bye\n');
      console.error('probe stopped by /quit');
      return setTimeout(() => process.exit(0), 50);
    }
    if (url.pathname !== '/') {
      res.writeHead(404);
      return res.end();
    }
    const id = url.searchParams.get('id') || '';
    const browser = kind(req.headers['user-agent'] || '');
    let entry = null;
    if (UUID.test(id)) entry = register(id, browser);
    console.log(JSON.stringify({ id, host: HOST, browser, registered: Boolean(entry), label: entry && entry.label }));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>pickwise: ${esc(browser)} on ${esc(HOST)}</title>
<body style="font:20px system-ui;padding:40px;background:#111;color:#eee">
<h1>${esc(browser)} on ${esc(HOST)}</h1>
<p>deviceId: ${esc(id) || '(none)'}</p>
<p>${entry ? `Registered as <b>${esc(entry.label)}</b>.` : 'Not registered (no valid deviceId).'}</p>
<p>pickwise probe. You can close this tab.</p></body>`);
  });
  server.on('error', (e) => {
    console.error(`probe failed: ${e.code === 'EADDRINUSE' ? `port ${port} is in use (probe already running?)` : e.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () =>
    console.error(`pickwise probe on ${HOST} http://127.0.0.1:${port}/ for ${secs}s, registry ${REGISTRY}`)
  );
  setTimeout(() => process.exit(0), secs * 1000);
}

const [cmd = 'serve', a1, a2] = process.argv.slice(2);
if (cmd === 'serve') {
  serve(Number(a1) || 300, Number(a2) || 47831);
} else if (cmd === 'list') {
  const reg = load();
  console.log(`${HOST} (${REGISTRY})`);
  if (!reg.browsers.length) console.log('  (none registered)');
  for (const b of reg.browsers) console.log(`  ${b.label}  ${b.deviceId}  verified ${b.verified}`);
} else if (cmd === 'remove') {
  const reg = load();
  const before = reg.browsers.length;
  reg.browsers = reg.browsers.filter((b) => b.deviceId !== a1);
  save(reg);
  console.log(before === reg.browsers.length ? `not found: ${a1}` : `removed: ${a1}`);
} else {
  console.error('usage: browser-probe.js serve [seconds] [port] | list | remove <deviceId>');
  process.exit(2);
}
