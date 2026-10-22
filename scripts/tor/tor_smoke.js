#!/usr/bin/env node
/* Tor smoke test against a running Auren (CDP) that was started with AUREN_TOR_BUNDLE=<bundle dir> (or with the bundle inside the app).
 *
 *   node tor_smoke.js --cdp 127.0.0.1:9228 [--out result.json] [--wait 150]
 *
 * 1. a normal window asks check.torproject.org/api/ip      -> expect IsTor:false  (control)
 * 2. the new-tab page's Tor button (chrome.send('openTor')) -> a Tor window opens
 * 3. the Tor window asks the same API until it answers     -> expect IsTor:true and a different IP
 * 4. chrome://tor-circuit in the Tor window                  -> reports the circuit text
 * Zero dependencies, Node >= 22. Needs internet access. The Tor client bootstrap can take up to a minute.
 */
import fs from 'node:fs';
import { CDP, browserWsUrl } from '../fingerprint-audit/lib/cdp.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const hp = arg('--cdp', '127.0.0.1:9228');
const waitS = +arg('--wait', 150);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = async () => (await (await fetch(`http://${hp}/json/list`)).json()).filter(t => t.type === 'page');
const connect = async t => { const c = await CDP.connect(t.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${hp}`)); await c.send('Page.enable'); return c; };
const evalIn = async (c, expr, ms = 20000) => (await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, undefined, ms)).result.value;
async function fetchIp(c) {
  try { return JSON.parse(await evalIn(c, `fetch('https://check.torproject.org/api/ip',{cache:'no-store'}).then(r=>r.text())`, 30000)); } catch (e) { return { error: String(e.message).slice(0, 80) }; }
}

const out = { when: new Date().toISOString(), steps: [] };
const log = (name, data) => { out.steps.push({ name, ...data }); console.log(name.padEnd(34), JSON.stringify(data)); };

const before = await list();
const normal = before[0];
let c = await connect(normal);
await c.send('Page.navigate', { url: 'https://check.torproject.org/' }); await sleep(4000);
const control = await fetchIp(c);
log('normal window (control)', control);

// the new-tab page hosts the Tor button; open one if the first tab is something else
let ntp = before.find(t => /^chrome:\/\/newtab|^chrome-search:/.test(t.url));
let nc = c;
if (!ntp) { await c.send('Page.navigate', { url: 'chrome://newtab' }); await sleep(3000); ntp = (await list()).find(t => t.id === normal.id); }
const known = new Set((await list()).map(t => t.id));
const opened = await evalIn(nc, `(() => { try { chrome.send('openTor'); return 'sent'; } catch (e) { return 'chrome.send failed: ' + e.message; } })()`);
log('open Tor window', { result: opened });

let torTab = null; const t0 = Date.now();
for (let i = 0; i < 40 && !torTab; i++) { await sleep(1000); torTab = (await list()).find(t => !known.has(t.id)); }
log('Tor window appeared', { appeared: !!torTab, seconds: Math.round((Date.now() - t0) / 1000) });

if (torTab) {
  const tc = await connect(torTab);
  let ans = null; const b0 = Date.now();
  for (let i = 0; i < waitS / 5 && !(ans && ans.IsTor !== undefined); i++) {
    await tc.send('Page.navigate', { url: 'https://check.torproject.org/' }).catch(() => {}); await sleep(5000);
    ans = await fetchIp(tc);
  }
  log('Tor window: check.torproject.org', { ...ans, seconds_to_answer: Math.round((Date.now() - b0) / 1000) });
  out.isTor = ans?.IsTor === true;
  out.control_isTor = control?.IsTor === true;
  out.ip_differs = !!(ans?.IP && control?.IP && ans.IP !== control.IP);
  await tc.send('Page.navigate', { url: 'chrome://tor-circuit' }).catch(() => {}); await sleep(5000);
  const circuit = await evalIn(tc, 'document.body ? document.body.innerText.slice(0, 600) : ""').catch(() => '');
  log('chrome://tor-circuit', { text: String(circuit).replace(/\s+/g, ' ').slice(0, 300) });
  tc.close();
}
c.close();
console.log(`\nTor window answered IsTor=${out.isTor}; control IsTor=${out.control_isTor}; IPs differ=${out.ip_differs}`);
if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify(out, null, 1));
process.exit(out.isTor && !out.control_isTor ? 0 : 1);
