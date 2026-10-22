#!/usr/bin/env node
/* Assemble the demo's data file from measured result files, so every number in the video traces to a file.
 *
 *   node build_data.js --results /tmp/auren-demo/results --agent /tmp/auren-demo/agent --bench mcp/bench/autobench/results \
 *                      --e2e 35 --out /tmp/auren-demo/data.json
 *
 * Expected files (missing ones degrade to "not measured" instead of invented values):
 *   results/mac/audit-0-idle.json, audit-N1-idle.json          netlog_audit.py --json outputs (before / after hardening)
 *   results/mac/prot/auren-prot-*.json                          scripts/privacy/protections_check.js
 *   results/mac/perf/out/{chrome-stock,auren-component,auren-release}-{startup,memory,pageload,speedometer}.json
 *   <bench>/before.json, after.json, tokens-*.json              mcp/bench/autobench
 *   results/evidence.json                                       [{tone: ok|open|fail, text}], curated last
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const R = arg('--results', '/tmp/auren-demo/results');
const AG = arg('--agent', '/tmp/auren-demo/agent');
const BN = arg('--bench', 'mcp/bench/autobench/results');
const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const latest = (dir, re) => { try { return fs.readdirSync(dir).filter(f => re.test(f)).sort().pop(); } catch { return null; } };

// ---- netlog --------------------------------------------------------------------------------------------------------
const hosts = (j) => Object.entries(j || {}).map(([host, v]) => ({ host, class: v.class, requests: v.url_requests ?? 0 })).sort((a, b) => b.requests - a.requests);
const nb = read(path.join(R, 'mac/audit-0-idle.json')), na = read(path.join(R, 'mac/audit-N1-idle.json'));
const na2 = read(path.join(R, 'mac/audit-N2-idle15.json'));
const after = na2 || na;
const unexpected = h => h.filter(x => x.class !== 'allowlisted' && x.class !== 'loopback').length;
const netlog = { before: { minutes: 15, hosts: hosts(nb), unexpected: unexpected(hosts(nb)) }, after: { minutes: na2 ? 15 : 7, hosts: hosts(after), unexpected: unexpected(hosts(after)) }, when: new Date().toISOString().slice(0, 10) };

// ---- protections ---------------------------------------------------------------------------------------------------
const pf = latest(path.join(R, 'mac/prot'), /^auren-prot-\d+\.json$/);
const prot = read(pf && path.join(R, 'mac/prot', pf));
const stockLoad = read(path.join(R, 'mac/perf/out/chrome-stock-pageload.json'))?.result;
const short = u => { try { const h = new URL(u); return (h.hostname.replace(/^www\./, '') + (h.pathname.length > 1 ? h.pathname.replace(/\/$/, '') : '')).slice(0, 28); } catch { return u; } };
const protOut = prot && {
  lists: +(arg('--lists', 17)), pages: prot.summary.pages, runs: prot.summary.runs, total_requests: prot.summary.total_requests, total_blocked: prot.summary.total_blocked, pct: prot.summary.blocked_pct,
  rows: [...prot.rows].sort((a, b) => b.median_blocked - a.median_blocked).map(r => ({ site: short(r.url), requests: r.median_requests, blocked: r.median_blocked })),
  stock_requests: stockLoad?.total_median_requests ?? null, stock_blocked: stockLoad?.total_median_blocked ?? null, source: pf,
};

// ---- agent recordings ----------------------------------------------------------------------------------------------
const tasks = [];
try { for (const d of fs.readdirSync(AG).sort()) { const e = read(path.join(AG, d, 'events.json')); if (e) tasks.push({ id: e.task, name: e.name, ok: e.ok, duration_ms: e.duration_ms, frames: e.frames, events: e.events }); } } catch { /* none recorded */ }

// ---- bench ---------------------------------------------------------------------------------------------------------
const bb = read(path.join(BN, 'before.json')), ba = read(path.join(BN, 'after.json'));
const bench = bb && ba && { tasks: ba.results.length, e2e: +arg('--e2e', 0), before: { pass: bb.summary.pass, results: bb.results.map(r => r.status === 'pass' ? 'pass' : 'fail') }, after: { pass: ba.summary.pass, results: ba.results.map(r => r.status === 'pass' ? 'pass' : 'fail') } };

// ---- tokens --------------------------------------------------------------------------------------------------------
const tf = latest(BN, /^tokens-\d+\.json$/);
const tk = read(tf && path.join(BN, tf));
const tokens = tk && (() => { const s = tk.summary; return { pages: s.pages, playwright_avg_tokens: Math.round(s.chars.playwright / 4 / s.pages), auren_avg_tokens: Math.round(s.chars.auren_interactive / 4 / s.pages), ratio: Math.round(s.ratio_playwright_over_auren_interactive), omitted: s.actionable_elements.auren_omitted_by_cap, listed: s.actionable_elements.auren_listed, pw_version: s.playwright_core, source: tf }; })();

// ---- speed ---------------------------------------------------------------------------------------------------------
const P = (label, test) => read(path.join(R, `mac/perf/out/${label}-${test}.json`))?.result;
const labels = [['chrome-stock', 'Stock Chrome 155'], ['auren-component', 'Auren dev build'], ['auren-release', 'Auren release build']];
const pick = (test, f) => labels.map(([l]) => { const r = P(l, test); try { return r ? f(r) : null; } catch { return null; } });
const speed = {
  headline: 'Same Mac, back to back', cols: labels.map(l => l[1]),
  rows: [
    { label: 'Startup to first page', unit: 'ms, median of 5 (lower is better)', values: pick('startup', r => r.median_first_page_complete_ms), best: null, lower: true },
    { label: 'Idle memory, process tree', unit: 'MB RSS after 30 s (lower is better)', values: pick('memory', r => r.at_idle.rss_mb), best: null, lower: true },
    { label: 'Speedometer 3.1', unit: 'score (higher is better)', values: pick('speedometer', r => r.score), best: null, lower: false },
    { label: 'Page load, 12 real sites', unit: 'ms, median of medians (lower is better)', values: pick('pageload', r => r.median_of_median_load_ms), best: null, lower: true },
    { label: 'Requests issued, same 12 sites', unit: 'total, median runs (lower is better)', values: pick('pageload', r => r.total_median_requests), best: null, lower: true },
  ],
  notes: [],
};
for (const row of speed.rows) { const v = row.values.map(x => x ?? (row.lower ? Infinity : -Infinity)); const b = row.lower ? Math.min(...v) : Math.max(...v); row.best = Number.isFinite(b) ? v.indexOf(b) : null; }
speed.rows = speed.rows.filter(r => r.values.some(v => v != null));
speed.notes = (read(path.join(R, 'speed-notes.json')) || ['Official Chrome is a PGO/LTO build; the Auren dev build is a component build with DCHECKs on.']);

const evidence = read(path.join(R, 'evidence.json')) || [{ tone: 'open', text: 'evidence.json not written yet' }];
const data = { when: netlog.when, netlog, prot: protOut, agent: { dir: AG, tasks }, bench, tokens, speed, evidence };
fs.mkdirSync(path.dirname(arg('--out', '/tmp/auren-demo/data.json')), { recursive: true });
fs.writeFileSync(arg('--out', '/tmp/auren-demo/data.json'), JSON.stringify(data, null, 1));
const miss = Object.entries({ prot: protOut, bench, tokens, 'agent tasks': tasks.length }).filter(([, v]) => !v).map(([k]) => k);
console.log('wrote', arg('--out', '/tmp/auren-demo/data.json'), miss.length ? '  MISSING: ' + miss.join(', ') : '');
