#!/usr/bin/env node
/* Count the requests Auren's bundled filter lists block on real pages. Attaches to a running browser over CDP.
 *
 *   node protections_check.js --cdp 127.0.0.1:9224 [--urls file] [--runs 2] [--out result.json]
 *
 * "Blocked" = Network.loadingFailed with net::ERR_BLOCKED_BY_CLIENT (what the adblock engine returns). The same URL list
 * run against stock Chrome (scripts/perf/run.js pageload) gives the no-protection baseline. Zero dependencies, Node >= 22.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, browserWsUrl } from '../fingerprint-audit/lib/cdp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const hp = arg('--cdp', '127.0.0.1:9224');
const runs = +arg('--runs', 2);
const urls = fs.readFileSync(arg('--urls', path.join(here, '..', 'perf', 'urls.txt')), 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const host = u => { try { return new URL(u).hostname; } catch { return ''; } };
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };

const bw = await browserWsUrl(hp);
const browser = await CDP.connect(bw.ws);
const out = [];
for (const url of urls) {
  const samples = [];
  for (let r = 0; r < runs; r++) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const list = await (await fetch(`http://${hp}/json/list`)).json();
    const t = list.find(x => x.id === targetId);
    const c = await CDP.connect(t.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${hp}`));
    const urlOf = new Map(); let total = 0; const blocked = []; const failed = [];
    c.on(m => {
      if (m.method === 'Network.requestWillBeSent') { total++; urlOf.set(m.params.requestId, m.params.request.url); }
      if (m.method === 'Network.loadingFailed') {
        const u = urlOf.get(m.params.requestId) || '';
        if (/BLOCKED_BY_CLIENT/.test(m.params.errorText || '') || m.params.blockedReason) blocked.push(u); else failed.push(u);
      }
    });
    await c.send('Page.enable'); await c.send('Network.enable'); await c.send('Network.setCacheDisabled', { cacheDisabled: true });
    let loaded = true;
    const loadP = new Promise(res => c.on(m => m.method === 'Page.loadEventFired' && res()));
    await c.send('Page.navigate', { url });
    await Promise.race([loadP, sleep(30000).then(() => { loaded = false; })]);
    await sleep(3000);
    samples.push({ total, blocked: blocked.length, failed: failed.length, loaded, blockedUrls: blocked });
    await browser.send('Target.closeTarget', { targetId }); c.close();
  }
  const hosts = {};
  for (const s of samples) for (const u of s.blockedUrls) hosts[host(u)] = (hosts[host(u)] || 0) + 1;
  const topHosts = Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h, n]) => `${h}(${n})`);
  const row = { url, median_requests: median(samples.map(s => s.total)), median_blocked: median(samples.map(s => s.blocked)), loaded: samples.every(s => s.loaded), top_blocked_hosts: topHosts, sample_blocked: samples[0].blockedUrls.slice(0, 5) };
  out.push(row);
  console.log(`${String(row.median_blocked).padStart(4)} blocked / ${String(row.median_requests).padStart(4)} requests  ${url}  ${topHosts.slice(0, 3).join(' ')}`);
}
browser.close();
const sum = k => out.reduce((a, r) => a + r[k], 0);
const summary = { pages: out.length, runs, total_requests: sum('median_requests'), total_blocked: sum('median_blocked'), blocked_pct: +(100 * sum('median_blocked') / Math.max(1, sum('median_requests'))).toFixed(1) };
console.log(JSON.stringify(summary));
if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify({ summary, rows: out, when: new Date().toISOString(), cdp: hp }, null, 1));
