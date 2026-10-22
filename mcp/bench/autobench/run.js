// Auren-Bench: 17 deterministic browsing tasks over a local mini-web, driven through the real MCP server.
// usage: node bench/autobench/run.js [--only T01,T06] [--json out.json] [--cdp host:port] [--md out.md] [--label before]
//   --cdp attaches to an already running browser (e.g. Auren) instead of launching headless Chrome.
// Result per task: pass | js-only (needed browser_execute_js, i.e. the tools have a gap) | FAIL, plus tool calls,
// response size (chars; tokens are estimated as chars/4, an approximation) and wall time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness } from './harness.js';
import { TASKS } from './tasks.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
const label = arg('--label', 'run');

const uploadFile = path.join(os.tmpdir(), 'autobench-upload.txt');
fs.writeFileSync(uploadFile, 'hello from auren-bench\n');

const H = await startHarness({ cdp: arg('--cdp') });
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms: ${what}`)), ms))]);

const freshTab = () => H.newTab();

function makeA() {
  const call = (name, args) => withTimeout(H.call(name, args), 20000, name);
  return {
    call, uploadFile, has: n => H.tools.includes(n), url: H.url,
    go: url => call('browser_navigate', { url }),
    act: (find, action = 'click', value) => call('browser_act', { find, action, ...(value !== undefined ? { value } : {}) }),
    click: eid => call('browser_click', { eid }),
    fill: (eid, value) => call('browser_fill', { eid, value }),
    snap: (a = {}) => call('browser_snapshot', a),
    read: region => call('browser_read_section', { region }),
    js: code => call('browser_execute_js', { code }),
  };
}

async function attempt(task, useJs) {
  await H.reset();
  await freshTab();
  H.meter.calls = 0; H.meter.chars = 0; H.meter.ms = 0; H.meter.log = [];
  const t0 = performance.now();
  let error = null;
  try {
    const A = makeA();
    // the JS fallback is what an agent tries after the tools failed: it starts from the same page, so load it first
    if (useJs) await A.go(A.url(task.site));
    await withTimeout(useJs ? task.js(A) : task.run(A), 60000, 'task');
    await new Promise(r => setTimeout(r, 250));           // let the page's final report reach the server
  } catch (e) { error = String(e.message || e).slice(0, 160); }
  const state = await H.state();
  let ok = false;
  try { ok = !!task.check(state); } catch { ok = false; }
  return { ok, error, calls: H.meter.calls, chars: H.meter.chars, ms: Math.round(performance.now() - t0), tools: H.meter.log.map(l => l.name) };
}

const results = [];
for (const task of TASKS) {
  if (only && !only.has(task.id)) continue;
  let r = await attempt(task, false);
  let status = r.ok ? 'pass' : 'FAIL';
  let jsr = null;
  if (!r.ok && task.js) {
    jsr = await attempt(task, true);
    if (jsr.ok) status = 'js-only';
  }
  results.push({ id: task.id, name: task.name, status, ...r, js_attempt: jsr && { ok: jsr.ok, calls: jsr.calls, error: jsr.error } });
  console.log(`${task.id} ${status.padEnd(7)} calls=${String(r.calls).padStart(2)} resp=${String(r.chars).padStart(6)}ch ${String(r.ms).padStart(5)}ms  ${task.name}${r.error ? '  !! ' + r.error : ''}`);
}

const passed = results.filter(r => r.status === 'pass');
const sum = (a, k) => a.reduce((x, r) => x + r[k], 0);
const summary = {
  label, tasks: results.length, pass: passed.length, js_only: results.filter(r => r.status === 'js-only').length,
  fail: results.filter(r => r.status === 'FAIL').length,
  passed_calls: sum(passed, 'calls'), passed_resp_chars: sum(passed, 'chars'), passed_est_tokens: Math.round(sum(passed, 'chars') / 4), passed_ms: sum(passed, 'ms'),
  tools: H.tools.length, node: process.version, when: new Date().toISOString(),
};
console.log(`\n${label}: ${summary.pass}/${summary.tasks} pass, ${summary.js_only} js-only, ${summary.fail} fail | passed tasks: ${summary.passed_calls} calls, ~${summary.passed_est_tokens} response tokens (chars/4), ${summary.passed_ms} ms`);
if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify({ summary, results }, null, 1));
if (arg('--md')) {
  const rows = results.map(r => `| ${r.id} | ${r.name} | ${r.status} | ${r.calls} | ${r.chars} | ${r.ms} |`).join('\n');
  fs.writeFileSync(arg('--md'), `| id | task | result | tool calls | response chars | ms |\n|---|---|---|---:|---:|---:|\n${rows}\n`);
}
await H.close();
process.exit(0);
