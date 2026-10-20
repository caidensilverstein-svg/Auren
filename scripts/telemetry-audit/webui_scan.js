#!/usr/bin/env node
// Scan internal WebUI pages of a running Auren (CDP) for leftover "Brave"
// branding and outbound links / resource loads.
// Usage: node webui_scan.js PORT [url ...]   (default page list below)
// Output: one JSON line per page: {url, title, brave:[snippets], google:[..], hosts:[..], resources:[..]}
const port = process.argv[2] || '9224';
const pages = process.argv.length > 3 ? process.argv.slice(3) : [
  'chrome://version', 'chrome://settings', 'chrome://settings/help', 'chrome://settings/privacy',
  'chrome://settings/search', 'chrome://settings/appearance', 'chrome://settings/getStarted',
  'chrome://settings/system', 'chrome://settings/downloads', 'chrome://settings/content',
  'chrome://settings/cookies', 'chrome://settings/security', 'chrome://settings/braveSync',
  'chrome://settings/shields', 'chrome://settings/extensions', 'chrome://settings/braveAIChat',
  'chrome://newtab', 'chrome://welcome', 'chrome://history', 'chrome://bookmarks',
  'chrome://extensions', 'chrome://downloads', 'chrome://credits', 'chrome://about',
  'chrome://flags', 'chrome://gpu', 'chrome://components', 'chrome://net-export',
  'chrome://sync-internals', 'chrome://crashes', 'chrome://management', 'chrome://inspect'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}, sessionId) => new Promise((res) => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const expr = `(() => {
    const out = {text: [], hrefs: new Set()};
    const walk = (root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        if (n.nodeType === 3) { const pn = n.parentNode && n.parentNode.nodeName; if (pn === 'STYLE' || pn === 'SCRIPT') continue; const t = n.textContent.trim(); if (t) out.text.push(t); }
        else {
          if (n.shadowRoot) walk(n.shadowRoot);
          for (const a of ['href','src','srcset','action']) { const v = n.getAttribute && n.getAttribute(a); if (v && /^https?:/.test(v)) out.hrefs.add(v.split('?')[0]); }
          for (const a of ['placeholder','aria-label','title','label','alt']) { const v = n.getAttribute && n.getAttribute(a); if (v) out.text.push(v); }
        }
      }
    };
    walk(document);
    const all = out.text.join(' | ');
    const grab = (re) => { const r = []; let m; const rx = new RegExp(re, 'gi'); while ((m = rx.exec(all)) && r.length < 12) r.push(all.slice(Math.max(0,m.index-30), m.index+50)); return r; };
    return JSON.stringify({title: document.title, brave: grab('brave'), google: grab('google|chrome(?!://)|chromium'),
      nbrave: (all.match(/brave/gi)||[]).length, ngoogle: (all.match(/google|chromium/gi)||[]).length,
      hosts: [...new Set([...out.hrefs].map(h => { try { return new URL(h).host } catch(e) { return h } }))],
      resources: performance.getEntriesByType('resource').map(x => x.name).filter(n => /^https?:/.test(n)) });
  })()`;
  for (const u of pages) {
    const t = await send('Target.createTarget', { url: 'about:blank' });
    const a = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
    const sid = a.result.sessionId;
    await send('Page.navigate', { url: u }, sid);
    await sleep(3500);
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
    let val = r.result && r.result.result && r.result.result.value;
    console.log(JSON.stringify({ url: u, data: val ? JSON.parse(val) : (r.result && r.result.exceptionDetails ? 'ERR' : null) }));
    await send('Target.closeTarget', { targetId: t.result.targetId });
  }
  ws.close();
})().catch((e) => { console.error(e); process.exit(1); });
