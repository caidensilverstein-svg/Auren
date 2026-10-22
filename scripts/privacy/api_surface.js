#!/usr/bin/env node
/* Which tracking- and fingerprint-relevant web APIs does a browser expose, and what headers does a site receive?
 *
 *   node api_surface.js --cdp 127.0.0.1:9224 [--label auren] [--out result.json]
 *   node api_surface.js --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --label chrome
 *   node api_surface.js --compare a.json b.json            (side-by-side table; rows that differ are marked)
 *
 * Serves a page and an echo endpoint on loopback (localhost is a secure context, so secure-only APIs are testable),
 * navigates to it, probes with Runtime.evaluate, and records the request headers the server saw. Zero dependencies,
 * Node >= 22. "present" means the property/constructor exists; it does not prove the API works or is permitted.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CDP, browserWsUrl } from '../fingerprint-audit/lib/cdp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (argv.includes('--compare')) {
  const [a, b] = argv.slice(argv.indexOf('--compare') + 1).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  const keys = [...new Set([...Object.keys(a.apis), ...Object.keys(b.apis)])];
  let diff = 0;
  console.log(`${'surface'.padEnd(46)} ${a.label.padEnd(14)} ${b.label}`);
  for (const k of keys) {
    const x = JSON.stringify(a.apis[k]), y = JSON.stringify(b.apis[k]);
    const d = x !== y; if (d) diff++;
    console.log(`${(d ? '* ' : '  ') + k.padEnd(44)} ${String(x).padEnd(14)} ${y}`);
  }
  console.log(`\n${diff} of ${keys.length} surfaces differ`);
  for (const h of new Set([...Object.keys(a.headers), ...Object.keys(b.headers)])) {
    if (a.headers[h] !== b.headers[h]) console.log(`header ${h}: ${a.label}=${a.headers[h] ?? '-'}  ${b.label}=${b.headers[h] ?? '-'}`);
  }
  process.exit(0);
}

// ---- probes: each is a JS expression evaluated in the page; result must be JSON-able ---------------------------
const has = (obj, prop) => `(${obj} !== undefined && ${JSON.stringify(prop)} in ${obj})`;
const PROBES = {
  // Privacy Sandbox / ad tech
  'topics: document.browsingTopics': `typeof document.browsingTopics === 'function'`,
  'protected audience: joinAdInterestGroup': `typeof navigator.joinAdInterestGroup === 'function'`,
  'protected audience: runAdAuction': `typeof navigator.runAdAuction === 'function'`,
  'shared storage: window.sharedStorage': `typeof window.sharedStorage !== 'undefined'`,
  'fenced frames: HTMLFencedFrameElement': `typeof window.HTMLFencedFrameElement !== 'undefined'`,
  'attribution: anchor attributionSrc': `'attributionSrc' in HTMLAnchorElement.prototype`,
  'private state tokens: document.hasPrivateToken': `typeof document.hasPrivateToken === 'function'`,
  'FLoC: document.interestCohort': `typeof document.interestCohort === 'function'`,
  'cookie deprecation label': `typeof navigator.cookieDeprecationLabel !== 'undefined'`,
  'storage access: requestStorageAccess': `typeof document.requestStorageAccess === 'function'`,
  // hardware / device
  'bluetooth': `'bluetooth' in navigator`, 'usb': `'usb' in navigator`, 'hid': `'hid' in navigator`, 'serial': `'serial' in navigator`,
  'nfc: NDEFReader': `typeof window.NDEFReader !== 'undefined'`, 'midi: requestMIDIAccess': `typeof navigator.requestMIDIAccess === 'function'`,
  'battery: getBattery': `typeof navigator.getBattery === 'function'`, 'network information: connection': `'connection' in navigator`,
  'device memory': `navigator.deviceMemory`, 'hardwareConcurrency': `navigator.hardwareConcurrency`,
  'sensors: Accelerometer': `typeof window.Accelerometer !== 'undefined'`, 'sensors: AmbientLightSensor': `typeof window.AmbientLightSensor !== 'undefined'`,
  'sensors: DeviceMotionEvent': `typeof window.DeviceMotionEvent !== 'undefined'`,
  'webxr: navigator.xr': `'xr' in navigator`, 'webgpu: navigator.gpu': `'gpu' in navigator`,
  'local fonts: queryLocalFonts': `typeof window.queryLocalFonts === 'function'`, 'screen details: getScreenDetails': `typeof window.getScreenDetails === 'function'`,
  'keyboard layout: navigator.keyboard': `'keyboard' in navigator`, 'idle detection: IdleDetector': `typeof window.IdleDetector !== 'undefined'`,
  'wake lock': `'wakeLock' in navigator`, 'media devices': `!!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices)`,
  'storage estimate': `!!(navigator.storage && navigator.storage.estimate)`, 'userAgentData': `'userAgentData' in navigator`,
  'userAgentData brands': `navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand).join('|') : null`,
  'performance.memory': `typeof performance.memory !== 'undefined'`,
  'brave: navigator.brave': `'brave' in navigator`,
  // tracking channels
  'sendBeacon': `typeof navigator.sendBeacon === 'function'`, 'anchor ping attribute': `'ping' in HTMLAnchorElement.prototype`,
  'WebTransport': `typeof window.WebTransport !== 'undefined'`, 'RTCPeerConnection': `typeof window.RTCPeerConnection !== 'undefined'`,
  'cookieStore': `typeof window.cookieStore !== 'undefined'`, 'Notification': `typeof window.Notification !== 'undefined'`,
  'PushManager': `typeof window.PushManager !== 'undefined'`, 'BackgroundFetch': `typeof window.BackgroundFetchManager !== 'undefined'`,
  'PeriodicSync': `typeof window.PeriodicSyncManager !== 'undefined'`, 'ReportingObserver': `typeof window.ReportingObserver !== 'undefined'`,
  'PaymentRequest': `typeof window.PaymentRequest !== 'undefined'`, 'WebAuthn: PublicKeyCredential': `typeof window.PublicKeyCredential !== 'undefined'`,
  'doNotTrack': `navigator.doNotTrack`, 'globalPrivacyControl': `navigator.globalPrivacyControl`,
  'languages': `navigator.languages.join(',')`, 'platform': `navigator.platform`,
  'timezone': `Intl.DateTimeFormat().resolvedOptions().timeZone`,
  'plugins length': `navigator.plugins.length`, 'speech voices': `speechSynthesis.getVoices().length`,
};

// ---- harness ------------------------------------------------------------------------------------------------------
const seen = [];                       // headers of every request the loopback server received
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  if (req.url.startsWith('/echo')) { res.setHeader('access-control-allow-origin', '*'); res.end('ok'); return; }
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><meta charset="utf-8"><title>surface</title><body>surface<script>fetch('http://other.localhost:'+location.port+'/echo?x=1').catch(()=>{})</script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let hostPort = arg('--cdp'), proc = null, profile = null;
if (!hostPort) {
  const bin = arg('--browser'); if (!bin) { console.error('usage: --cdp host:port | --browser <binary>'); process.exit(2); }
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-')); const cport = 20000 + Math.floor(Math.random() * 20000);
  proc = spawn(bin, [`--user-data-dir=${profile}`, `--remote-debugging-port=${cport}`, '--no-first-run', '--no-default-browser-check', ...(argv.includes('--headless') ? ['--headless=new'] : []), 'about:blank'], { stdio: 'ignore' });
  hostPort = `127.0.0.1:${cport}`;
  for (let i = 0; i < 400; i++) { try { if ((await fetch(`http://${hostPort}/json/version`)).ok) break; } catch {} await sleep(50); }
}
const bw = await browserWsUrl(hostPort);
const browser = await CDP.connect(bw.ws);
const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
const t = (await (await fetch(`http://${hostPort}/json/list`)).json()).find(x => x.id === targetId);
const c = await CDP.connect(t.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${hostPort}`));
await c.send('Page.enable');
const loaded = new Promise(r => c.on(m => m.method === 'Page.loadEventFired' && r()));
await c.send('Page.navigate', { url: `http://localhost:${port}/` });
await Promise.race([loaded, sleep(15000)]); await sleep(800);

const apis = {};
for (const [name, expr] of Object.entries(PROBES)) {
  try {
    const r = await c.send('Runtime.evaluate', { expression: `(()=>{try{return ${expr}}catch(e){return 'error:'+e.message}})()`, returnByValue: true });
    apis[name] = r.result.value === undefined ? null : r.result.value;
  } catch (e) { apis[name] = 'error:' + e.message; }
}
const ua = (await c.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })).result.value;
const pick = h => ({ 'sec-gpc': h['sec-gpc'], dnt: h.dnt, 'sec-ch-ua': h['sec-ch-ua'], 'sec-ch-ua-platform': h['sec-ch-ua-platform'], 'sec-ch-ua-mobile': h['sec-ch-ua-mobile'], 'accept-language': h['accept-language'], 'user-agent': h['user-agent'] });
const nav = seen.find(s => s.url === '/');
const beacon = seen.find(s => s.url.startsWith('/echo'));
const headers = {};
for (const [k, v] of Object.entries(pick(nav?.headers || {}))) if (v !== undefined) headers['nav ' + k] = v;
if (beacon) { headers['cross-origin fetch referer'] = beacon.headers.referer ?? '(none)'; headers['cross-origin fetch origin'] = beacon.headers.origin ?? '(none)'; }
const result = { label: arg('--label', 'browser'), ua, when: new Date().toISOString(), apis, headers };
if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify(result, null, 1));
const present = Object.entries(apis).filter(([, v]) => v === true).length;
console.log(`${result.label}: ${present} of ${Object.keys(apis).length} probed surfaces report true`);
console.log(JSON.stringify({ ua, headers }, null, 1));
await browser.send('Target.closeTarget', { targetId }).catch(() => {});
browser.close(); c.close(); server.close();
if (proc) { proc.kill('SIGTERM'); await sleep(1200); proc.kill('SIGKILL'); fs.rmSync(profile, { recursive: true, force: true }); }
process.exit(0);
