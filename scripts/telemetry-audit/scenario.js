#!/usr/bin/env node
// Drive a running Auren (CDP) through a user scenario: NTP, then a few
// ordinary sites.  Usage: node scenario.js PORT [dwell-seconds]
// Needs Node >= 22 (global WebSocket/fetch).
const port = process.argv[2] || '9224';
const dwell = (parseInt(process.argv[3] || '20', 10)) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}, sessionId) => new Promise((res) => {
    const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
  const urls = process.env.SCENARIO_URLS ? process.env.SCENARIO_URLS.split(',') : ['chrome://newtab/', 'https://example.com/', 'https://en.wikipedia.org/wiki/Privacy',
    'https://duckduckgo.com/?q=weather', 'https://www.mozilla.org/en-US/'];
  const t = await send('Target.createTarget', { url: 'about:blank' });
  const targetId = t.result.targetId;
  const a = await send('Target.attachToTarget', { targetId, flatten: true });
  const sid = a.result.sessionId;
  await send('Page.enable', {}, sid);
  for (const u of urls) {
    const r = await send('Page.navigate', { url: u }, sid);
    console.log('navigate', u, JSON.stringify(r.result || r.error));
    await sleep(dwell);
    if (u.startsWith('chrome://')) {
      // Resource-timing of the internal page: must be empty (no CDN/font loads)
      // even if the network layer would have blocked them.
      const e = await send('Runtime.evaluate', { returnByValue: true, expression:
        'JSON.stringify({title:document.title,resources:performance.getEntriesByType("resource").map(x=>x.name)})' }, sid);
      console.log('internal-page', u, e.result && e.result.result && e.result.result.value);
    }
  }
  const tg = await send('Target.getTargets');
  console.log('targets:', tg.result.targetInfos.map((x) => x.type + ' ' + x.url).join('\n  '));
  ws.close();
})().catch((e) => { console.error(e); process.exit(1); });
