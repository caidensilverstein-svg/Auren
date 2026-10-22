#!/usr/bin/env node
/* Auren perf harness. Zero dependencies, Node >= 22. Works on any Chromium binary (Auren, stock Chrome, Brave).
 *
 *   node run.js --browser <binary> --label auren startup  [--runs 5]
 *   node run.js --browser <binary> --label auren memory   [--idle 30]
 *   node run.js --browser <binary> --label auren pageload [--runs 3] [--urls urls.txt]
 *   node run.js --browser <binary> --label auren speedometer | jetstream
 *   node run.js --browser <binary> --label auren all        (startup, memory, pageload, speedometer)
 *   node run.js --report out/*.json                           (side-by-side table of saved results)
 *
 * Every run uses a fresh throwaway profile and a private debugging port. Results are written to out/<label>-<test>.json
 * with the machine, binary and flags recorded, medians over runs, and the raw samples. Numbers from different machines
 * or build types (component vs release, DCHECK on/off) are not comparable; the report prints those fields next to them.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, browserWsUrl } from '../fingerprint-audit/lib/cdp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = k => argv.includes(k);
const cmds = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--') || ['all', 'startup', 'memory', 'pageload', 'speedometer', 'jetstream', 'motionmark'].includes(a));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const round = (x, d = 1) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d;

const outDir = flag('--out', path.join(here, 'out'));
const label = flag('--label', 'run');
const binary = flag('--browser');
const extra = (flag('--flags', '') || '').split(' ').filter(Boolean);
const headless = has('--headless');

function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-profile-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', ...(headless ? ['--headless=new'] : []), ...extra, 'about:blank'];
  const t0 = performance.now();
  const proc = spawn(binary, args, { stdio: 'ignore' });
  return { proc, port, profile, t0, args, stop: async () => { try { proc.kill('SIGTERM'); } catch {} await sleep(1500); try { proc.kill('SIGKILL'); } catch {} fs.rmSync(profile, { recursive: true, force: true }); } };
}
async function waitCdp(b, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${b.port}/json/version`); if (r.ok) return performance.now() - b.t0; } catch {} await sleep(25); }
  throw new Error('browser never exposed CDP');
}
async function pageTarget(b) {
  for (let i = 0; i < 200; i++) { const l = await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json(); const p = l.find(t => t.type === 'page'); if (p) return p; await sleep(25); }
  throw new Error('no page target');
}
async function attach(b, target) { const c = await CDP.connect(target.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${b.port}`)); await c.send('Page.enable'); return c; }
const evalIn = async (c, expr, timeoutMs = 20000) => (await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, undefined, timeoutMs)).result.value;

function treeStats(rootPid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command=']).toString().trim().split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: +m[1], ppid: +m[2], rssKB: +m[3], cmd: m[4] }));
  const kids = new Map(); for (const r of rows) (kids.get(r.ppid) || kids.set(r.ppid, []).get(r.ppid)).push(r);
  const out = []; const walk = pid => { const me = rows.find(r => r.pid === pid); if (me) out.push(me); for (const k of kids.get(pid) || []) walk(k.pid); };
  walk(rootPid);
  const type = r => (r.cmd.match(/--type=([a-z-]+)/) || [, 'browser'])[1];
  const byType = {}; for (const r of out) { byType[type(r)] ??= { n: 0, mb: 0 }; byType[type(r)].n++; byType[type(r)].mb += r.rssKB / 1024; }
  for (const v of Object.values(byType)) v.mb = round(v.mb);
  return { processes: out.length, rss_mb: round(out.reduce((a, r) => a + r.rssKB, 0) / 1024), by_type: byType };
}

const tests = {
  async startup() {
    const runs = +flag('--runs', 5), samples = [];
    for (let i = 0; i < runs; i++) {
      const b = launch();
      try {
        const cdpMs = await waitCdp(b);
        const t = await pageTarget(b); const c = await attach(b, t);
        for (let k = 0; k < 400; k++) { if (await evalIn(c, 'document.readyState') === 'complete') break; await sleep(25); }
        const readyMs = performance.now() - b.t0;
        await sleep(500);
        samples.push({ cdp_ms: round(cdpMs), first_page_complete_ms: round(readyMs), url: await evalIn(c, 'location.href') });
        c.close();
      } finally { await b.stop(); }
      await sleep(1500);
    }
    return { median_cdp_ms: round(median(samples.map(s => s.cdp_ms))), median_first_page_complete_ms: round(median(samples.map(s => s.first_page_complete_ms))), samples };
  },
  async memory() {
    const idle = +flag('--idle', 30);
    const b = launch();
    try {
      await waitCdp(b); await sleep(idle * 1000);
      const idleStats = treeStats(b.proc.pid);
      const t = await pageTarget(b); const c = await attach(b, t);
      await c.send('Page.navigate', { url: 'https://example.com/' }); await sleep(4000);
      c.close();
      return { idle_seconds: idle, at_idle: idleStats, with_one_page: treeStats(b.proc.pid), note: 'RSS sums over the process tree overcount shared pages; use for A/B on the same machine only' };
    } finally { await b.stop(); }
  },
  async pageload() {
    const runs = +flag('--runs', 3);
    const urls = fs.readFileSync(flag('--urls', path.join(here, 'urls.txt')), 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    const b = launch(); const per = [];
    try {
      await waitCdp(b);
      const bw = await browserWsUrl(`127.0.0.1:${b.port}`);
      for (const url of urls) {
        const samples = [];
        for (let r = 0; r < runs; r++) {
          const browser = await CDP.connect(bw.ws);
          const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
          const list = await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json();
          const c = await attach(b, list.find(t => t.id === targetId));
          let total = 0, failed = 0, blocked = 0, bytes = 0, crashed = false; const reqIds = new Set(); const blockedHosts = new Set();
          c.on(m => {
            if (m.method === 'Inspector.targetCrashed') crashed = true;
            if (m.method === 'Network.requestWillBeSent') { total++; reqIds.add(m.params.requestId); }
            if (m.method === 'Network.loadingFailed') { failed++; if (m.params.blockedReason || /BLOCKED_BY_CLIENT/.test(m.params.errorText || '')) blocked++; }
            if (m.method === 'Network.loadingFinished') bytes += m.params.encodedDataLength || 0;
          });
          await c.send('Network.enable'); await c.send('Network.setCacheDisabled', { cacheDisabled: true });
          const t0 = performance.now(); let loaded = true;
          const loadP = new Promise(res => c.on(m => m.method === 'Page.loadEventFired' && res()));
          await c.send('Page.navigate', { url });
          await Promise.race([loadP, sleep(30000).then(() => { loaded = false; })]);
          const loadMs = performance.now() - t0;
          await sleep(2500);                               // late ads/trackers fire after load
          let lcp = 0, error = null;
          try { lcp = await evalIn(c, `new Promise(r=>{try{let v=0;new PerformanceObserver(l=>{for(const e of l.getEntries())v=e.startTime}).observe({type:'largest-contentful-paint',buffered:true});setTimeout(()=>r(v),50)}catch(e){r(0)}})`); }
          catch (e) { error = crashed ? 'renderer crashed' : 'page unresponsive: ' + e.message; console.error(`!! ${url}: ${error}`); }
          samples.push({ load_ms: round(loadMs), lcp_ms: round(lcp), requests: total, blocked, failed, mb: round(bytes / 1048576, 2), loaded, crashed, ...(error ? { error } : {}) });
          await browser.send('Target.closeTarget', { targetId }); browser.close(); c.close();
        }
        per.push({ url, errors: samples.filter(x => x.error).length, median_load_ms: round(median(samples.map(s => s.load_ms))), median_lcp_ms: round(median(samples.map(s => s.lcp_ms))), median_requests: median(samples.map(s => s.requests)), median_blocked: median(samples.map(s => s.blocked)), median_mb: round(median(samples.map(s => s.mb)), 2), samples });
      }
    } finally { await b.stop(); }
    const sum = k => per.reduce((a, p) => a + p[k], 0);
    return { urls: per.length, runs, total_median_requests: sum('median_requests'), total_median_blocked: sum('median_blocked'), total_median_mb: round(sum('median_mb'), 1), median_of_median_load_ms: round(median(per.map(p => p.median_load_ms))), per_url: per };
  },
  async speedometer() { return benchmark('https://browserbench.org/Speedometer3.1/?startAutomatically', `(()=>{const e=document.querySelector('#result-number');const d=document.querySelector('#summary.valid, .valid');return e&&e.textContent.trim()&&d?e.textContent.trim():null})()`, 'score'); },
  async jetstream() { return benchmark('https://browserbench.org/JetStream/?startDelay=1', `(()=>{const e=document.querySelector('#result-summary .score, #result-summary .result-score, .summary .score');const done=document.querySelector('#result-summary')&&!document.querySelector('#status-bar:not(.hidden)');return e&&e.textContent.trim()&&done?e.textContent.trim():null})()`, 'score'); },
};

async function benchmark(url, doneExpr, field) {
  const b = launch();
  try {
    await waitCdp(b); const t = await pageTarget(b); const c = await attach(b, t);
    await c.send('Page.navigate', { url });
    const t0 = Date.now(); let v = null;
    while (Date.now() - t0 < 15 * 60 * 1000) { await sleep(3000); try { v = await evalIn(c, doneExpr); } catch {} if (v) break; }
    const ua = await evalIn(c, 'navigator.userAgent');
    c.close();
    return { [field]: v == null ? null : Number(String(v).replace(/[^0-9.]/g, '')), raw: v, seconds: round((Date.now() - t0) / 1000), url, ua };
  } finally { await b.stop(); }
}

function machine() {
  return { host: os.hostname(), os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, mem_gb: round(os.totalmem() / 2 ** 30, 0), node: process.version };
}

if (has('--report')) {
  const files = argv.slice(argv.indexOf('--report') + 1).filter(f => f.endsWith('.json'));
  for (const f of files) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); const { samples, per_url, ...flat } = j.result; console.log(`${path.basename(f).padEnd(34)} ${JSON.stringify(flat).slice(0, 200)}`); }
  process.exit(0);
}
if (!binary) { console.error('usage: run.js --browser <binary> --label <name> startup|memory|pageload|speedometer|jetstream|all'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const todo = cmds.includes('all') ? ['startup', 'memory', 'pageload', 'speedometer'] : cmds.filter(c => tests[c]);
for (const name of todo) {
  console.log(`== ${label}: ${name}`);
  const result = await tests[name]();
  const rec = { label, test: name, when: new Date().toISOString(), binary, flags: extra, machine: machine(), result };
  fs.writeFileSync(path.join(outDir, `${label}-${name}.json`), JSON.stringify(rec, null, 1));
  const { samples, per_url, ...flat } = result; console.log(JSON.stringify(flat, null, 1));
}
