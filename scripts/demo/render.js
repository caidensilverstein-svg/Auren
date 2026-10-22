#!/usr/bin/env node
/* Render the demo video frames from scenes.html with data from a JSON file, then (optionally) encode with ffmpeg.
 *
 *   node render.js --data /tmp/auren-demo/data.json --out /tmp/auren-demo/frames --mp4 /tmp/auren-demo/auren.mp4
 *   node render.js --data data.json --still 21000 --png /tmp/still.png        (one frame, for review)
 *   node render.js --data data.json --list                                     (scene timeline)
 *
 * 1280x720, 30 fps. Frames are JPEG screenshots of headless Chrome. All numbers on screen come from the data file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CDP } from '../fingerprint-audit/lib/cdp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fps = +arg('--fps', 30);
const data = JSON.parse(fs.readFileSync(arg('--data'), 'utf8'));

const port = 30000 + Math.floor(Math.random() * 20000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-render-'));
const chrome = spawn(process.env.CHROME_BIN || 'google-chrome-stable', ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--allow-file-access-from-files', '--force-device-scale-factor=1',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} await sleep(100); }
const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page');
const c = await CDP.connect(t.webSocketDebuggerUrl);
await c.send('Page.enable');
await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
const loaded = new Promise(r => c.on(m => m.method === 'Page.loadEventFired' && r()));
await c.send('Page.navigate', { url: 'file://' + path.join(here, 'scenes.html') });
await loaded;
const ev = async expr => { const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails)); return r.result.value; };
await ev(`setData(${JSON.stringify(data)})`);

const total = await ev('totalMs()');
if (argv.includes('--list')) { console.log(JSON.stringify(await ev('timeline()'), null, 1), 'total', total); }
else if (arg('--still')) {
  await ev(`draw(${+arg('--still')})`);
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(arg('--png', '/tmp/still.png'), Buffer.from(shot.data, 'base64'));
  console.log('wrote', arg('--png', '/tmp/still.png'));
} else {
  const out = arg('--out', '/tmp/auren-demo/frames');
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const n = Math.floor(total / 1000 * fps); const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await ev(`draw(${Math.round(i * 1000 / fps)})`);
    const shot = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    fs.writeFileSync(path.join(out, String(i).padStart(6, '0') + '.jpg'), Buffer.from(shot.data, 'base64'));
    if (i % 150 === 0) console.log(`frame ${i}/${n}  ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  console.log(`rendered ${n} frames (${(total / 1000).toFixed(1)} s)`);
  if (arg('--mp4')) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(out, '%06d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', arg('--crf', '27'),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', arg('--mp4')], { stdio: 'inherit' });
    console.log('encoded', arg('--mp4'), (fs.statSync(arg('--mp4')).size / 1048576).toFixed(1) + ' MB');
  }
}
c.close(); chrome.kill('SIGKILL'); fs.rmSync(profile, { recursive: true, force: true });
process.exit(0);
