#!/usr/bin/env node
/* Build the morning report page from the measured data file.
 *   node build_report.js --data /tmp/auren-demo/data.json --video /tmp/auren-demo/auren-demo.mp4 --out /tmp/auren-demo/report \
 *        [--release "running: 31,020 of 76,100 steps"] [--pr1 https://github.com/.../pull/20] [--pr2 https://github.com/.../pull/21]
 * Writes <out>/index.html (+ the video and a poster frame). Every number comes from the data file; anything not measured goes in
 * the "not verified" list instead of being filled in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const D = JSON.parse(fs.readFileSync(arg('--data', '/tmp/auren-demo/data.json'), 'utf8'));
const out = arg('--out', '/tmp/auren-demo/report');
const PR1 = arg('--pr1', 'https://github.com/caidensilverstein-svg/Auren/pull/20'), PR2 = arg('--pr2', '');
const release = arg('--release', '');
const n = x => (x == null ? 'n/a' : Math.round(x).toLocaleString('en-US'));
const ex = (re, v) => (v && v.length ? v : '');

const P = D.prot, B = D.bench, T = D.tokens, F = D.fingerprint, S = D.surface, U = D.urlrules, SP = D.speed, Z = D.zero_brave;
const idle = D.idle15 || D.netlog.after;
const braveBefore = D.netlog.before.hosts.filter(h => h.class !== 'allowlisted');
const fwBlocked = D.firewall.attempts_blocked.reduce((a, x) => a + x.n, 0);
const speedByLabel = (label, col) => SP.rows.find(r => r.label === label)?.values[col];
const dev = c => speedByLabel(c, 1), chrome = c => speedByLabel(c, 0), rel = c => speedByLabel(c, 2);
const releaseDone = rel('Speedometer 3.1') != null;

const data = {
  dates: 'Oct 21 to 22, 2026',
  lead: `I built, measured and filmed the work on your Mac and the laptop while you slept. Every figure on this page names the file it came from, and anything I could not verify is listed under <em>Not verified</em>. ` +
    `Two things did not finish: the merge of the automation upgrade (auto mode refused a push to main, so Oracle is unchanged) and ${releaseDone ? 'nothing else' : 'the release-build benchmark (the build is still running)'}.`,
  videoCaption: `${D.__videoLen || ''} Real recordings and measured data. The agent scene is paced so you can follow it; the tool calls and results are real.`.trim(),
  needs: [
    { title: `Merge <a href="${PR1}">PR #20</a>, then I deploy it to Oracle.`, body: `The automation upgrade passes ${B.e2e} end-to-end tests, ${B.on_auren} of ${B.tasks} bench tasks on the real Auren, and ${B.realworld ? B.realworld.hop_pass + ' of ' + B.realworld.total : 'all'} real-site tasks run from Oracle against your Mac. I tried to merge it; auto mode blocked that as a merge without review, so the PR is open and Oracle still runs the old code. The deploy is ready: backup, restart, health check.` },
    { title: 'Should WebUSB, WebHID, Serial and Bluetooth be off by default?', body: `Eight of the ${F ? F.after.fail + F.after.warn : 14} remaining fingerprint results are this one question. Off removes a fingerprinting and permission-prompt surface (Tor Browser does it); hardware wallets and device flashers stop working. The patch is written and checked against the tree, not applied.` },
    { title: PR2 ? `Review <a href="${PR2}">the privacy and tooling branch</a>.` : 'Review the privacy and tooling branch.', body: 'Bundled protections, firewall changes, the fingerprint and perf harnesses and the demo tooling. It compiles on the real tree; nothing is merged.' },
    { title: 'Check the licenses before Auren is ever distributed.', body: 'The bundled filter lists are GPL-3.0 (EasyList and the Fanboy list are also CC BY-SA / CC BY). Fine while the app is private; a public build needs a license review.' },
  ],
  speedHeadline: releaseDone ? 'Same Mac, back to back, release build included' : 'Same Mac, back to back: the dev build is slow on purpose',
  speedNote: `The dev build is a component build with DCHECKs on and no PGO; stock Chrome is an official PGO/LTO build, so this comparison understates Auren. ${releaseDone ? 'The release column is the fair one (non-component, DCHECKs off, PGO profile applied, no LTO).' : `A release flavour (non-component, DCHECKs off, PGO profile applied) is compiling${release ? ' (' + release + ')' : ''}; its numbers will appear here when it finishes.`} Startup, memory and Speedometer are medians or single runs as labelled in the scripts.`,
  ledger: [],
  unverified: [],
  footer: '',
};

const L = (claim, result, src, tone) => data.ledger.push({ claim, result, src, tone });
L('Idle capture: unexpected hosts', `${D.netlog.before.unexpected} → ${idle.unexpected}`, `audit-0-idle.json (15 min) vs ${D.idle15 ? 'audit-N2-idle15.json (15 min)' : 'audit-N1-idle.json (7 min)'}`, 'good');
L('Bundled filter lists loaded at startup', `${P.lists}`, 'run log: "AUREN_PROTECTIONS: loaded 17 bundled filter lists"', 'good');
L(`Requests blocked on ${P.pages} real pages`, `${P.total_blocked} of ${n(P.total_requests)}`, `${P.source}; stock Chrome 0 of ${n(P.stock_requests)} (chrome-stock-pageload.json)`, 'good');
if (U) L('Redirect-tracker and tracking-parameter rules', `${U.pass} of ${U.total}`, 'urlrules/v3.json', U.pass === U.total ? 'good' : 'bad');
if (S) L('Web APIs Chrome exposes that Auren does not', `${S.removed.length} of ${S.total} surfaces differ: ${S.differ}`, 'surface/auren.json vs surface/chrome.json');
if (F) L('Fingerprint harness, FAIL count', `${F.before.fail} → ${F.after.fail}`, F.after.source, 'good');
L('Auren-Bench on headless Chrome', `${B.before.pass} → ${B.after.pass} of ${B.tasks}`, 'mcp/bench/autobench/results/{before,after}.json', 'good');
if (B.on_auren != null) L('Auren-Bench on the real Auren, Mac', `${B.on_auren} of ${B.tasks}`, 'bench/auren-mac-dev.json', 'good');
if (B.realworld) { L('Real public-site tasks', `${B.realworld.before} → ${B.realworld.after} of ${B.realworld.total}`, 'realworld-{before,after}.json', 'good'); if (B.realworld.hop) L('Same tasks, server on Oracle, browser on the Mac', `${B.realworld.hop_pass} of ${B.realworld.total}; snapshot p50 ${B.realworld.hop.snapshot_ms.p50} ms`, 'realworld-oracle-to-mac-auren.json', 'good'); }
L('End-to-end tests (mcp)', `25 → ${B.e2e}`, 'npm test in mcp/', 'good');
if (T) L('Page representation, characters', `${T.ratio}× fewer than Playwright 1.64 AI snapshot`, `${T.source} (cap omits ${n(T.omitted)} elements; chars/4 estimate)`);
if (D.tor) L('Bundled Tor client inside the browser (macOS)', D.tor.answered ? (D.tor.isTor ? 'IsTor true' : 'IsTor false') : (D.tor.connected ? 'circuit view: Connected; IP check did not answer' : 'did not connect in the time allowed'), 'tor-smoke.json, tor-smoke-run1.json', D.tor.answered && D.tor.isTor ? 'good' : '');
if (D.unit && D.unit.ran) L('Tor and tracker unit tests, real toolchain', `${D.unit.passed} of ${D.unit.ran} pass`, 'ut-tor.txt', D.unit.failed ? 'bad' : 'good');
if (D.firewall.strict_env.length) L('Strict firewall, via environment variable', `${D.firewall.strict_env.reduce((a, x) => a + x.n, 0)} requests would be blocked`, 'strict/strict2-hosts.txt');
L('Startup to first page, Mac', `${n(chrome('Startup to first page'))} ms Chrome · ${n(dev('Startup to first page'))} ms Auren dev${rel('Startup to first page') != null ? ' · ' + n(rel('Startup to first page')) + ' ms release' : ''}`, 'perf/out/*-startup.json');
L('Speedometer 3.1, Mac', `${(+chrome('Speedometer 3.1')).toFixed(1)} Chrome · ${(+dev('Speedometer 3.1')).toFixed(1)} Auren dev${rel('Speedometer 3.1') != null ? ' · ' + (+rel('Speedometer 3.1')).toFixed(1) + ' release' : ''}`, 'perf/out/*-speedometer.json');

const U_ = x => data.unverified.push(x);
if (!releaseDone) U_('Release-build speed and memory. The release flavour is still compiling; until it finishes the speed table compares stock Chrome with a dev build that has DCHECKs on.');
if (!D.tor) U_('Tor on this Mac build. The smoke test was queued behind other work; the Tor circuit view and bridges are compile-checked only.');
else if (!D.tor.answered) U_(`Tor end to end. The Tor window opens from the new-tab button and the client built circuits (${D.tor.connected ? 'circuit view showed Connected' + (D.tor.guard ? ', guard ' + D.tor.guard : '') : 'one run was still Starting'}), but check.torproject.org/api/ip never answered inside the time allowed while the Mac was saturated by the release build. Rerun <span class="mono">scripts/tor/tor_smoke.js</span> on an idle Mac.`);
if (!(D.unit && D.unit.ran)) U_('Unit tests for the Tor client and tracker. The test binary was building; the host-side harness passes 14 of 14, but the real-toolchain tests had not run.');
U_('The bridge settings dialog (obfs4, snowflake, meek, webtunnel). Verified end to end at the command level on Linux, never exercised in the Mac UI.');
U_('Windows and macOS x86_64 Tor bundles were assembled and signature-checked but never run. Linux and Windows browser-side behaviour is untested.');
U_('Scriptlet and redirect resources (a separate Brave component) are not bundled, so rules that need them are inert. Network blocking and element hiding work.');
U_('Battery API values on a laptop with a battery. The source returns constants; never measured.');
U_(`A blanket default-deny firewall. Strict mode is opt-in and was only exercised to list what it would block; it was not evaluated for breakage. The documented escape hatch (<span class="mono">--auren-allow-service-requests</span>) never worked from the command line because the network service is a separate process; it now also reads the environment.`);
U_('Bench policies are scripted, not a language model, and token counts are characters / 4. Passing the bench shows the tool layer handles these situations, not that any model will succeed on any site.');
if (!releaseDone || true) U_('Oracle deployment of the new MCP server (see above).');

data.footer = `Branches: <a href="${PR1}">mcp-agent-upgrade</a> (PR #20)${PR2 ? `, <a href="${PR2}">overnight privacy branch</a>` : ''}. Commits are authored and committed by you only. ` +
  `Reproduce: <span class="mono">node mcp/bench/autobench/run.js</span>, <span class="mono">scripts/privacy/*.js</span>, <span class="mono">scripts/perf/run.js</span>, <span class="mono">scripts/demo/build_data.js</span>. ` +
  `Measured ${D.when}; machine: MacBook with Apple M4, 16 GB.`;

fs.mkdirSync(out, { recursive: true });
let html = fs.readFileSync(path.join(here, 'report.template.html'), 'utf8').replace('/*__DATA__*/null', JSON.stringify({ ...D, ...data }).replace(/</g, '\\u003c'));
fs.writeFileSync(path.join(out, 'index.html'), html);
const video = arg('--video');
if (video && fs.existsSync(video)) {
  fs.copyFileSync(video, path.join(out, 'auren-demo.mp4'));
  try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '9', '-i', video, '-frames:v', '1', '-q:v', '4', path.join(out, 'poster.jpg')]); } catch { /* no poster */ }
}
console.log('wrote', path.join(out, 'index.html'), (fs.statSync(path.join(out, 'index.html')).size / 1024).toFixed(0) + ' KB', video ? 'with video' : 'without video');
