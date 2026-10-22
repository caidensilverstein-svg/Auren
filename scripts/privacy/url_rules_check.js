#!/usr/bin/env node
/* Do the bundled redirect-tracker (debounce) and tracking-parameter (query filter) rules actually fire in a running browser?
 *
 *   node url_rules_check.js --cdp 127.0.0.1:9224 [--out result.json]
 *
 * Each case navigates and reports the final URL. A redirect-tracker link should end at its target without the tracker being
 * loaded; tracking parameters should be gone from an ordinary URL. Needs internet access to example.org. Zero dependencies.
 * Honest reading: "pass" means the final URL is what the rule predicts; a "fail" with the tracker URL means the rule did not fire.
 */
import fs from 'node:fs';
import { CDP, browserWsUrl } from '../fingerprint-audit/lib/cdp.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const hp = arg('--cdp', '127.0.0.1:9224');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = 'https://example.org/debounced';
const enc = encodeURIComponent;

const CASES = [
  { name: 'debounce: t.cfjump.com/?Url=', url: `https://t.cfjump.com/?Url=${enc(T)}`, expect: u => u.startsWith(T) },
  { name: 'debounce: r.bttn.io/?btn_url=', url: `https://r.bttn.io/x?btn_url=${enc(T)}`, expect: u => u.startsWith(T) },
  { name: 'debounce: trk.pmsrv.co/v2/trk?rurl=', url: `https://trk.pmsrv.co/v2/trk?rurl=${enc(T)}`, expect: u => u.startsWith(T) },
  { name: 'debounce: redir.tradedoubler.com/?_td_deeplink=', url: `https://redir.tradedoubler.com/x?_td_deeplink=${enc(T)}`, expect: u => u.startsWith(T) },
  { name: 'query filter: fbclid, gclid, mc_eid removed, other params kept', url: 'https://example.org/?fbclid=abc&gclid=def&mc_eid=ghi&keep=1', expect: u => /keep=1/.test(u) && !/fbclid|gclid|mc_eid/.test(u) },
  { name: 'control: ordinary URL untouched', url: 'https://example.org/?keep=1&page=2', expect: u => u === 'https://example.org/?keep=1&page=2' },
];

const bw = await browserWsUrl(hp);
const browser = await CDP.connect(bw.ws);
const rows = [];
for (const k of CASES) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const t = (await (await fetch(`http://${hp}/json/list`)).json()).find(x => x.id === targetId);
  const c = await CDP.connect(t.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${hp}`));
  await c.send('Page.enable');
  let loaded = false; c.on(m => { if (m.method === 'Page.loadEventFired' || m.method === 'Page.frameStoppedLoading') loaded = true; });
  await c.send('Page.navigate', { url: k.url }).catch(() => {});
  for (let i = 0; i < 80 && !loaded; i++) await sleep(250);
  await sleep(800);
  let finalUrl = '';
  try { finalUrl = (await c.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result.value; } catch (e) { finalUrl = 'error:' + e.message; }
  const ok = !!k.expect(finalUrl);
  rows.push({ name: k.name, start: k.url, final: finalUrl, pass: ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${k.name}\n      -> ${finalUrl}`);
  await browser.send('Target.closeTarget', { targetId }).catch(() => {}); c.close();
}
browser.close();
const pass = rows.filter(r => r.pass).length;
console.log(`${pass} of ${rows.length} cases as expected`);
if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify({ pass, total: rows.length, rows, when: new Date().toISOString() }, null, 1));
