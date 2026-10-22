#!/usr/bin/env node
/* Record real Auren-Bench tasks for the demo video: the page is screencast over CDP while the real MCP tools drive it,
 * and every tool call is logged with a timestamp. Nothing is simulated; the only change from a normal run is a pause
 * after each call so the result is watchable (stated in the video).
 *
 *   node record_agent.js --out /tmp/auren-demo/agent [--tasks T01,T06,T08,T09,T13] [--pace 900] [--cdp host:port]
 *
 * Output per task: <out>/<task>/frames/NNNNN.jpg, <out>/<task>/events.json ({t_ms, name, args, summary, ok}).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, browserWsUrl } from '../fingerprint-audit/lib/cdp.js';
import { startHarness } from '../../mcp/bench/autobench/harness.js';
import { TASKS } from '../../mcp/bench/autobench/tasks.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const out = arg('--out', '/tmp/auren-demo/agent');
const pace = +arg('--pace', 900);
const want = (arg('--tasks', 'T01,T06,T08,T09,T13')).split(',');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const H = await startHarness({ cdp: arg('--cdp') });
const cdpHostPort = arg('--cdp') || `127.0.0.1:${H.cdpPort}`;

async function attachScreencast(dir) {
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  const bw = await browserWsUrl(cdpHostPort);
  const pages = (await (await fetch(`http://${cdpHostPort}/json/list`)).json()).filter(t => t.type === 'page');
  const c = await CDP.connect(pages[0].webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${cdpHostPort}`));
  await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 414, deviceScaleFactor: 1, mobile: false });
  const frames = []; const t0 = performance.now(); let n = 0;
  c.on(m => {
    if (m.method !== 'Page.screencastFrame') return;
    const file = `frames/${String(n++).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(m.params.data, 'base64'));
    frames.push({ t_ms: Math.round(performance.now() - t0), file });
    c.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
  });
  await c.send('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: 700, maxHeight: 414, everyNthFrame: 1 });
  return { c, frames, t0, async stop() { await c.send('Page.stopScreencast').catch(() => {}); c.close(); } };
}


// what the agent learned from a response, in one human line
function summarize(name, text) {
  const un = x => x.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  let m;
  if ((m = text.match(/<dialog type="([^"]+)" message="([^"]*)"/))) return `dialog (${m[1]}): "${un(m[2])}" - waiting for an answer`;
  if (/<dialog_closed/.test(text)) return 'dialog answered; page unblocked';
  if ((m = text.match(/<new_tab[^>]*url="([^"]*)"/))) return `opened a new tab: ${un(m[1]).replace(/^https?:\/\//, '').slice(0, 40)}`;
  if ((m = text.match(/<error[^>]*>([^<]*)/))) return 'error: ' + un(m[1]).slice(0, 80);
  if ((m = text.match(/<permission_denied>([^<]*)/))) return 'denied: ' + un(m[1]).slice(0, 70);
  if ((m = text.match(/<results count="(\d+)"/))) return `${m[1]} match${m[1] === '1' ? '' : 'es'}`;
  if ((m = text.match(/<state [^>]*title="([^"]*)"/))) { const n = (text.match(/ eid="/g) || []).length; return `page "${un(m[1])}" - ${n} actionable element${n === 1 ? '' : 's'}${/<diff/.test(text) ? ' (changes only)' : ''}`; }
  if (name === 'browser_get_tabs') return `${(text.match(/"id"/g) || []).length} tabs`;
  return un(text.replace(/\s+/g, ' ')).slice(0, 80);
}

const results = [];
for (const task of TASKS) {
  if (!want.includes(task.id)) continue;
  const dir = path.join(out, task.id);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  await H.reset(); await H.newTab();
  const rec = await attachScreencast(dir);
  const events = [];
  const A = (() => {
    const call = async (name, args) => {
      const t_ms = Math.round(performance.now() - rec.t0);
      const text = await H.call(name, args);
      const summary = summarize(name, text);
      events.push({ t_ms, done_ms: Math.round(performance.now() - rec.t0), name, args, summary, chars: text.length, ok: !/<error|permission_denied/.test(text.slice(0, 200)) });
      await sleep(pace);
      return text;
    };
    return {
      call, uploadFile: '/tmp/autobench-upload.txt', has: n => H.tools.includes(n), url: H.url,
      go: url => call('browser_navigate', { url }), act: (find, action = 'click', value) => call('browser_act', { find, action, ...(value !== undefined ? { value } : {}) }),
      click: eid => call('browser_click', { eid }), fill: (eid, value) => call('browser_fill', { eid, value }), snap: (a = {}) => call('browser_snapshot', a),
      read: region => call('browser_read_section', { region }), js: code => call('browser_execute_js', { code }),
    };
  })();
  await sleep(600);
  try { await task.run(A); } catch (e) { events.push({ t_ms: Math.round(performance.now() - rec.t0), name: 'error', summary: String(e.message).slice(0, 120), ok: false }); }
  await sleep(1200);
  const state = await H.state();
  const ok = !!task.check(state);
  await rec.stop();
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify({ task: task.id, name: task.name, ok, duration_ms: Math.round(performance.now() - rec.t0), frames: rec.frames, events }, null, 1));
  console.log(`${task.id} ${ok ? 'pass' : 'FAIL'} ${rec.frames.length} frames, ${events.length} calls  ${task.name}`);
  results.push({ id: task.id, ok });
}
await H.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
