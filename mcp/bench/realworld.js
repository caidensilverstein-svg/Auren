// Real-site smoke tests for the automation layer: no fixtures, no logins, public pages only. Each task uses only the public
// tools (navigate / act / find / read) addressing things by visible name, and is judged by the final URL or text read back.
// Live sites change and rate-limit, so treat a single failure as a lead, not a verdict. Run against two server versions to compare:
//   node bench/realworld.js [--label after] [--json out.json]
import fs from 'node:fs';
import { startHarness } from './autobench/harness.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const H = await startHarness({ cdp: arg('--cdp') });
const href = async () => JSON.parse(await H.call('browser_execute_js', { code: 'location.href' }));
const act = (find, action = 'click', value) => H.call('browser_act', { find, action, ...(value !== undefined ? { value } : {}) });
const settle = () => sleep(1800);

const TASKS = [
  { name: 'example.org: follow the "Learn more" link to iana.org', run: async () => { await H.call('browser_navigate', { url: 'https://example.org/' }); await act('Learn more'); await settle(); }, check: async () => /iana\.org/.test(await href()) },
  { name: 'wikipedia: search for "Alan Turing", open the article', run: async () => {
      await H.call('browser_navigate', { url: 'https://en.wikipedia.org/wiki/Main_Page' });
      let r = await act('Search Wikipedia', 'fill', 'Alan Turing');
      if (/Cannot fill|not found/.test(r)) { await act('Search Wikipedia'); await sleep(600); await act('Search Wikipedia', 'fill', 'Alan Turing'); }   // the box is behind an icon at this width
      await H.call('browser_exec', { steps: [{ op: 'press', key: 'Enter' }], final_snapshot: false }); await settle();
    }, check: async () => /wiki\/Alan_Turing|search=Alan\+Turing|search=Alan%20Turing/.test(await href()) },
  { name: 'hacker news: open the comments of the first story', run: async () => {
      await H.call('browser_navigate', { url: 'https://news.ycombinator.com/' });
      const found = await H.call('browser_find', { query: 'comments' });
      const eid = found.match(/<lnk eid="([^"]+)"[^>]*>\d+\s+comments?<\/lnk>/)?.[1]; if (eid) await H.call('browser_click', { eid }); await settle();
    }, check: async () => /news\.ycombinator\.com\/item\?id=/.test(await href()) },
  { name: 'github: open microsoft/playwright, go to Issues', run: async () => { await H.call('browser_navigate', { url: 'https://github.com/microsoft/playwright' }); await act('Issues'); await settle(); }, check: async () => /microsoft\/playwright\/issues/.test(await href()) },
  { name: 'mdn: open the Fetch API page, jump to a section link', run: async () => { await H.call('browser_navigate', { url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API' }); await settle(); const r = await H.call('browser_read_section', { region: 'main', max_chars: 600 }); H.note = r.slice(0, 40); }, check: async () => /Fetch/i.test(H.note || '') },
  { name: 'duckduckgo: type a query into the search box and submit', run: async () => {
      await H.call('browser_navigate', { url: 'https://duckduckgo.com/' });
      await act('Search', 'fill', 'auren browser'); await H.call('browser_exec', { steps: [{ op: 'press', key: 'Enter' }], final_snapshot: false }); await settle();
    }, check: async () => /q=auren/.test(await href()) },
];

const rows = [];
for (const t of TASKS) {
  let ok = false, error = null; const t0 = performance.now(); H.meter.calls = 0; H.meter.chars = 0;
  try { await H.newTab(); H.note = ''; await Promise.race([t.run(), sleep(60000).then(() => { throw new Error('timeout 60s'); })]); ok = await t.check(); }
  catch (e) { error = String(e.message).slice(0, 100); }
  rows.push({ name: t.name, ok, error, calls: H.meter.calls, chars: H.meter.chars, ms: Math.round(performance.now() - t0) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(H.meter.calls).padStart(2)} calls ${String(Math.round(performance.now() - t0)).padStart(6)} ms  ${t.name}${error ? '  !! ' + error : ''}`);
}
// latency over whatever link sits between the MCP server and the browser (the Oracle -> Mac WireGuard hop when run on Oracle)
let hop = null;
if (argv.includes('--hop')) {
  await H.newTab(); await H.call('browser_navigate', { url: 'https://example.org/' });
  const times = (n, fn) => Promise.resolve().then(async () => { const a = []; for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); a.push(performance.now() - t); } a.sort((x, y) => x - y); return { p50: Math.round(a[Math.floor(n * 0.5)]), p95: Math.round(a[Math.min(n - 1, Math.floor(n * 0.95))]) }; });
  hop = { get_tabs_ms: await times(20, () => H.call('browser_get_tabs')), snapshot_ms: await times(20, () => H.call('browser_snapshot')), find_ms: await times(20, () => H.call('browser_find', { query: 'More information' })) };
  console.log('latency (ms, p50/p95):', JSON.stringify(hop));
}
const pass = rows.filter(r => r.ok).length;
console.log(`${arg('--label', 'run')}: ${pass}/${rows.length} real-site tasks passed`);
if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify({ label: arg('--label', 'run'), pass, total: rows.length, rows, hop, cdp: arg('--cdp') || 'local headless chrome', when: new Date().toISOString() }, null, 1));
await H.close(); process.exit(0);
