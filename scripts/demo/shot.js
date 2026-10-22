#!/usr/bin/env node
/* Full-page screenshot of a local HTML file at a given width (for reviewing the report page).
 *   node shot.js --file /tmp/auren-demo/report/index.html --width 1280 --out /tmp/shot.png [--dark]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CDP } from '../fingerprint-audit/lib/cdp.js';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = 30000 + Math.floor(Math.random() * 20000), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome-stable', ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} await sleep(100); }
const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page');
const c = await CDP.connect(t.webSocketDebuggerUrl);
await c.send('Page.enable');
const w = +arg('--width', 1280);
await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 });
if (argv.includes('--dark')) await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
else await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
const loaded = new Promise(r => c.on(m => m.method === 'Page.loadEventFired' && r()));
await c.send('Page.navigate', { url: 'file://' + path.resolve(arg('--file')) });
await Promise.race([loaded, sleep(20000)]); await sleep(1800);
const dims = (await c.send('Runtime.evaluate', { expression: 'JSON.stringify({h:document.documentElement.scrollHeight,sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth})', returnByValue: true })).result.value;
const { h, sw, cw } = JSON.parse(dims);
const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(h, +arg('--maxh', 6000)), scale: 1 } });
fs.writeFileSync(arg('--out', '/tmp/shot.png'), Buffer.from(shot.data, 'base64'));
console.log('wrote', arg('--out', '/tmp/shot.png'), `height ${h}px; horizontal overflow: ${sw > cw ? 'YES (' + sw + ' > ' + cw + ')' : 'none'}`);
c.close(); chrome.kill('SIGKILL'); fs.rmSync(profile, { recursive: true, force: true });
process.exit(0);
