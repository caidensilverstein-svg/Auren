// How much does each tool put in the model's context to describe the same page?
//   node bench/tokens.js --pw /path/to/dir/with/playwright-core [--json out.json] [--urls file]
// Compares, on real public pages loaded in the same headless Chrome:
//   auren interactive : what browser_navigate returns (actionable elements only; 30 per region, 7.5k char cap)
//   auren full        : browser_snapshot mode=full (actionable elements + headings + text blocks)
//   playwright        : Playwright's AI snapshot, page.ariaSnapshot({mode:'ai'}) (every node carries a [ref=eN]); this is
//                       the view Playwright MCP gives an agent. Older versions fall back to _snapshotForAI / ariaSnapshot.
//   dom               : document.documentElement.outerHTML, for scale
// Tokens are estimated as chars/4 (no public Claude tokenizer offline); the ratios, not the absolute numbers, matter.
// The tools do NOT carry the same information (Playwright's dump includes all page text; Auren's interactive view does
// not), so read this as "cost of the view an agent normally works from", with `full` as the like-for-like column.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { startHarness, findChrome } from './autobench/harness.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const pwDir = arg('--pw');
if (!pwDir) { console.error('--pw <dir containing node_modules/playwright-core> is required'); process.exit(2); }
const require = createRequire(pwDir.replace(/\/?$/, '/'));
const { chromium } = require('playwright-core');
const pwVersion = require('playwright-core/package.json').version;

const URLS = (arg('--urls') ? fs.readFileSync(arg('--urls'), 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')) : [
  'https://en.wikipedia.org/wiki/Web_browser',
  'https://news.ycombinator.com/',
  'https://github.com/microsoft/playwright',
  'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
  'https://www.bbc.com/news',
  'https://www.theguardian.com/international',
  'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array',
  'https://www.reddit.com/r/programming/',
]);

const H = await startHarness();
const browser = await chromium.launch({ executablePath: findChrome() === 'google-chrome-stable' ? '/usr/bin/google-chrome-stable' : findChrome(), headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();

const rows = [];
for (const url of URLS) {
  const row = { url };
  try {
    await H.newTab();
    const nav = await H.call('browser_navigate', { url });
    row.auren_interactive = nav.length; row.auren_items = (nav.match(/ eid="/g) || []).length;
    row.auren_more = [...nav.matchAll(/<!-- (\d+) more/g)].reduce((a, m) => a + Number(m[1]), 0);
    await new Promise(r => setTimeout(r, 1500));
    row.auren_full = (await H.call('browser_snapshot', { mode: 'full', max_items: 60 })).length;
    row.dom = Number(JSON.parse(await H.call('browser_execute_js', { code: 'document.documentElement.outerHTML.length' })));
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(1500);
    const snap = await page.ariaSnapshot({ mode: 'ai' }).catch(() => page._snapshotForAI ? page._snapshotForAI() : page.locator('body').ariaSnapshot());
    const ps = typeof snap === 'string' ? snap : snap.full ?? JSON.stringify(snap);
    row.playwright = ps.length; row.playwright_refs = (ps.match(/\[ref=/g) || []).length;
  } catch (e) { row.error = String(e.message).slice(0, 100); }
  rows.push(row);
  console.log(JSON.stringify(row));
}
await browser.close(); await H.close();

// pages that served a bot wall / error page (tiny DOM) say nothing about either tool
const ok = rows.filter(r => r.auren_interactive && r.playwright && r.dom > 5000);
const sum = k => ok.reduce((a, r) => a + r[k], 0);
const summary = {
  playwright_core: pwVersion, pages: ok.length, tokens_est: 'chars/4',
  chars: { auren_interactive: sum('auren_interactive'), auren_full: sum('auren_full'), playwright: sum('playwright'), dom: sum('dom') },
  ratio_playwright_over_auren_interactive: +(sum('playwright') / sum('auren_interactive')).toFixed(1),
  ratio_playwright_over_auren_full: +(sum('playwright') / sum('auren_full')).toFixed(2),
  actionable_elements: { auren_listed: sum('auren_items'), auren_omitted_by_cap: sum('auren_more'), playwright_refs: sum('playwright_refs') },
  chars_per_element: { auren: +(sum('auren_interactive') / Math.max(1, sum('auren_items'))).toFixed(1), playwright: +(sum('playwright') / Math.max(1, sum('playwright_refs'))).toFixed(1) },
  excluded_pages: rows.length - ok.length,
};
console.log('\n' + JSON.stringify(summary, null, 1));
if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify({ summary, rows, when: new Date().toISOString() }, null, 1));
process.exit(0);
