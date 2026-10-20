import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function launchBrowser({ browser, headless = false, extraArgs = [], port = 0, profileDir = null, keepProfile = false, log = false }) {
  const dir = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'auren-fp-profile-'));
  if (profileDir) { fs.rmSync(profileDir, { recursive: true, force: true }); fs.mkdirSync(profileDir, { recursive: true }); }
  const args = [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', '--ignore-certificate-errors', '--allow-insecure-localhost', 'about:blank', ...extraArgs];
  if (headless) args.unshift('--headless=new');
  const child = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-10000); if (log) process.stderr.write(d); });
  // DevToolsActivePort file gives the real port when port=0
  const file = path.join(dir, 'DevToolsActivePort'); let actual = null;
  for (let i = 0; i < 150 && !actual; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode !== null) throw new Error('browser exited early: ' + stderr.slice(-500));
    if (fs.existsSync(file)) { const [p, p2] = fs.readFileSync(file, 'utf8').split('\n'); if (p) actual = { port: +p, path: p2 }; }
  }
  if (!actual) { child.kill('SIGKILL'); throw new Error('DevToolsActivePort never appeared: ' + stderr.slice(-500)); }
  return {
    pid: child.pid, port: actual.port, dir,
    async close() { try { child.kill('SIGTERM'); } catch (e) { /* */ } await new Promise((r) => { const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* */ } r(); }, 4000); child.on('exit', () => { clearTimeout(t); r(); }); }); if (!keepProfile) try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ } },
  };
}
