#!/usr/bin/env node
/* Visit a list of URLs in a running browser over CDP, one new tab each, and wait. Used to provoke browser-process traffic
 * (settings pages, history, new tab, a couple of real sites) while a log or netlog is being collected.
 *
 *   node nav_pages.js --cdp 127.0.0.1:9227 --urls chrome://settings/searchEngines,chrome://history,https://example.org/ [--wait 6000]
 * Zero dependencies, Node >= 22.
 */
import { CDP, browserWsUrl } from '../fingerprint-audit/lib/cdp.js';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const hp = arg('--cdp', '127.0.0.1:9227'), wait = +arg('--wait', 6000);
const urls = arg('--urls', 'chrome://newtab').split(',').filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bw = await browserWsUrl(hp);
const browser = await CDP.connect(bw.ws);
for (const url of urls) {
  const { targetId } = await browser.send('Target.createTarget', { url });
  await sleep(wait);
  console.log('visited', url);
  await browser.send('Target.closeTarget', { targetId }).catch(() => {});
}
browser.close();
