#!/usr/bin/env node
/* Auren fingerprint audit CLI. See docs/privacy/fingerprinting/harness.md
 *
 *   node run.js --browser /path/to/chrome [--headless] [--sessions 3] [--repeats 2]
 *   node run.js --cdp 127.0.0.1:9225 [--sessions 2]            # attach to a running browser
 *   node run.js --serve                                        # just serve the test page for manual use
 *   node run.js --reanalyze out/x/raw.json --policy auren-mac-v1
 * Exit code: 0 ok, 1 policy FAIL (or WARN with --fail-on warn), 2 harness error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers } from './lib/server.js';
import { CDP, browserWsUrl } from './lib/cdp.js';
import { launchBrowser } from './lib/launch.js';
import { analyze } from './lib/analyze.js';
import { evaluatePolicy, markdown } from './lib/report.js';
import { estimate } from './lib/entropy.js';
import { buildSelftest } from './lib/selftest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const log = (...a) => console.error('[fp-audit]', ...a);

function loadPolicy(p) {
  const file = fs.existsSync(p) ? p : path.join(here, 'policy', p.endsWith('.json') ? p : p + '.json');
  return { name: path.basename(file, '.json'), policy: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

async function runPage(cdp, url, { contextId, timeoutMs = 90000 }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', ...(contextId ? { browserContextId: contextId } : {}) });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    const t0 = Date.now(); let done = false;
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 400));
      try { const r = await cdp.send('Runtime.evaluate', { expression: 'window.__fpDone === true', returnByValue: true }, sessionId); if (r.result && r.result.value === true) { done = true; break; } } catch (e) { /* navigation in flight */ }
    }
    if (!done) throw new Error('collector timeout for ' + url);
    const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__fpResult || {error: window.__fpError})', returnByValue: true }, sessionId);
    const res = JSON.parse(r.result.value); if (res.error) throw new Error('collector error: ' + res.error);
    return res;
  } finally { try { await cdp.send('Target.closeTarget', { targetId }); } catch (e) { /* */ } }
}

/* Compact, diff-friendly summary that is small enough to commit as a baseline. */
function summarize(report, first) {
  const S = first.surfaces; const d = (n) => (S[n] && S[n].data) || {};
  const gl = d('webgl').webgl || {}; const gl2 = d('webgl').webgl2 || {};
  return {
    meta: report.meta, totals: report.evaluation.totals, combinedStableHash: report.analysis.combinedStableHash,
    surfaces: Object.fromEntries(Object.entries(report.analysis.surfaces).map(([k, v]) => [k, { class: v.class, stableOnReload: v.withinStable, sameAcrossSites: v.originsEqual, sameAcrossSessions: v.sessionsEqual, verdict: report.evaluation.verdicts[k] || 'INFO' }])),
    notPassing: report.evaluation.checks.filter((c) => c.status === 'FAIL' || c.status === 'WARN').map((c) => ({ status: c.status, id: c.id, expected: c.expected === undefined ? null : c.expected, actual: typeof c.actual === 'string' && c.actual.length > 160 ? c.actual.slice(0, 157) + '...' : (JSON.stringify(c.actual) || '').length > 200 ? (JSON.stringify(c.actual) || '').slice(0, 197) + '...' : c.actual })),
    values: {
      userAgent: d('navigator').userAgent, platform: d('navigator').platform, languages: d('navigator').languages, hardwareConcurrency: d('navigator').hardwareConcurrency, deviceMemory: d('navigator').deviceMemory,
      pluginNames: (d('navigator').plugins || []).map((p) => p.name), brands: d('userAgentData').brands, platformVersion: d('userAgentData').high && d('userAgentData').high.platformVersion,
      screen: { width: d('screen').width, height: d('screen').height, availTop: d('screen').availTop, colorDepth: d('screen').colorDepth, dpr: d('screen').devicePixelRatio },
      webglUnmasked: [gl.unmaskedVendor, gl.unmaskedRenderer], webgl2Limits: gl2.params && { MAX_UNIFORM_BUFFER_BINDINGS: gl2.params.MAX_UNIFORM_BUFFER_BINDINGS, MAX_FRAGMENT_UNIFORM_BLOCKS: gl2.params.MAX_FRAGMENT_UNIFORM_BLOCKS },
      webgpuInfo: d('webgpu').info, fontsDetected: (d('fonts').detectedByWidth || []).length, speechVoices: d('speech').count, battery: d('hardware').batteryApi,
      acceptLanguage: d('headers').fetchHeaders && d('headers').fetchHeaders['accept-language'], secChUa: d('headers').fetchHeaders && d('headers').fetchHeaders['sec-ch-ua'],
      tls: d('headers').tls && { ja4: d('headers').tls.ja4, ja3Sorted: d('headers').tls.ja3Sorted, h2Settings: d('headers').tls.h2 && d('headers').tls.h2.remoteSettings, h2PseudoOrder: d('headers').tls.h2 && d('headers').tls.h2.pseudoOrder },
      headerOrder: d('headers').fetchHeaderOrder, performanceMemoryLimit: d('timing').performanceMemoryLimit, storageQuota: d('storage').quota,
    },
    measurements: report.metrics, entropyUpperBoundBits: report.entropy && report.entropy.upperBoundBits,
    consistencyFailed: (d('consistency') || {}).failed,
  };
}

async function main() {
  const label = opt('label', 'run');
  const { name: policyName, policy } = loadPolicy(opt('policy', 'auren-mac-v1'));
  const outRoot = opt('out', path.join(here, 'out'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(outRoot, `${label}-${stamp}`); fs.mkdirSync(outDir, { recursive: true });
  const reference = JSON.parse(fs.readFileSync(opt('reference', path.join(here, 'reference', 'plausible-sets.json')), 'utf8'));
  const baseline = opt('baseline') ? JSON.parse(fs.readFileSync(opt('baseline'), 'utf8')) : null;

  if (opt('build-selftest')) { // node run.js --build-selftest dist/selftest.js [--policy auren-mac-v1]
    fs.mkdirSync(path.dirname(path.resolve(opt('build-selftest'))), { recursive: true });
    fs.writeFileSync(opt('build-selftest'), buildSelftest(policy, policyName)); console.log('wrote', opt('build-selftest')); return;
  }
  let raw;
  if (opt('reanalyze')) {
    raw = JSON.parse(fs.readFileSync(opt('reanalyze'), 'utf8'));
  } else {
    const servers = await startServers({ port: +opt('port', 0), tlsPort: +opt('tls-port', 0), outDir, tls: !flag('no-tls'), log: flag('verbose') });
    log(`server http :${servers.httpPort}  tls :${servers.tlsPort}${servers.tlsError ? ' (tls unavailable: ' + servers.tlsError + ')' : ''}`);
    if (flag('serve')) { console.log(`open http://site-a.localhost:${servers.httpPort}/?tls=${servers.tlsPort}   (Ctrl-C to stop)`); return new Promise(() => { }); }
    const hostA = opt('host-a', 'site-a.localhost'), hostB = opt('host-b', 'site-b.localhost');
    const origins = opt('origins') ? opt('origins').split(',') : [`http://${hostA}:${servers.httpPort}`, `http://${hostB}:${servers.httpPort}`];
    const urlFor = (o) => `${o}/?${servers.tlsPort ? 'tls=' + servers.tlsPort : ''}`;
    const sessions = +opt('sessions', 3), repeats = +opt('repeats', 2);
    raw = { meta: { label, policy: policyName, date: new Date().toISOString(), sessions, repeats, origins: origins.length, originUrls: origins, mode: opt('cdp') ? 'cdp' : 'launch' }, runs: [] };
    let launched = null; let cdp; let versionInfo;
    try {
      const doSession = async (s, cdpConn, contextId) => {
        for (const [oi, o] of origins.entries()) for (let k = 0; k < repeats; k++) {
          log(`session ${s} origin ${oi} repeat ${k}`);
          const result = await runPage(cdpConn, urlFor(o), { contextId });
          raw.runs.push({ session: s, origin: o, repeat: k, result });
        }
      };
      if (opt('cdp')) {
        const { ws, version } = await browserWsUrl(opt('cdp')); versionInfo = version; cdp = await CDP.connect(ws);
        for (let s = 0; s < sessions; s++) {
          const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: false });
          try { await doSession(s, cdp, browserContextId); } finally { try { await cdp.send('Target.disposeBrowserContext', { browserContextId }); } catch (e) { /* */ } }
        }
      } else {
        const bin = opt('browser'); if (!bin) throw new Error('need --browser <path> or --cdp host:port');
        const extra = (opt('args', '') || '').split(' ').filter(Boolean);
        for (let s = 0; s < sessions; s++) {
          launched = await launchBrowser({ browser: bin, headless: flag('headless'), extraArgs: extra, log: flag('verbose'), port: +opt('browser-port', 0), profileDir: opt('profile-root') ? path.join(opt('profile-root'), 's' + s) : null });
          const { ws, version } = await browserWsUrl('127.0.0.1:' + launched.port); versionInfo = version; cdp = await CDP.connect(ws);
          try { await doSession(s, cdp, null); } finally { cdp.close(); await launched.close(); launched = null; }
        }
      }
      raw.meta.browserVersion = versionInfo && versionInfo.Browser; raw.meta.userAgent = versionInfo && versionInfo['User-Agent']; raw.meta.protocol = versionInfo && versionInfo['Protocol-Version'];
    } finally { if (launched) await launched.close(); if (cdp) cdp.close(); await servers.close(); }
  }
  fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify(raw));
  const analysis = analyze(raw.runs);
  const first = raw.runs[0].result;
  const evaluation = evaluatePolicy(policy, analysis, first, baseline && baseline.runs ? baseline.runs[0].result : baseline);
  const entropy = estimate(first, reference);
  const c2 = first.surfaces.canvas2d && first.surfaces.canvas2d.data || {};
  const metrics = {
    'canvas noise on uniform fill (diff pixels / 4096)': c2.noiseUniformFill && c2.noiseUniformFill.diffPx,
    'WWW25 majority-vote attack: bytes that differ between two marker-varied canvases (>0 = noise is content-keyed)': c2.voteCanvasesDifferBytes,
    'WWW25 majority-vote attack: bytes the vote removed vs a single read (>0 = noise stripped)': c2.voteRecoveredVsSingleDiffBytes,
    'perf.now min delta (ms)': first.surfaces.timing && first.surfaces.timing.volatile && first.surfaces.timing.volatile.perfNowMinDeltaMs,
    'collection duration (ms)': first.durationMs,
  };
  // cross-site vote-hash linkability
  const voteHashes = new Set(raw.runs.filter((r) => r.repeat === 0).map((r) => r.result.surfaces.canvas2d && r.result.surfaces.canvas2d.data && r.result.surfaces.canvas2d.data.voteRecoveredHash)); metrics['distinct vote-recovered canvas hashes across all sites/sessions'] = voteHashes.size;
  const report = { meta: { ...raw.meta, policy: policyName }, analysis, evaluation, entropy, metrics };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(outDir, 'report.md'), markdown(report));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summarize(report, first), null, 1));
  console.log(markdown(report));
  console.log(`\nartifacts: ${outDir}`);
  if (opt('write-profile-report')) { // consumed by the NTP security bar (AurenSecurityHandler)
    const dest = path.join(opt('write-profile-report'), 'auren-fingerprint-audit.json');
    fs.writeFileSync(dest, JSON.stringify({ date: raw.meta.date, policy: policyName, browser: raw.meta.browserVersion, fail: evaluation.totals.FAIL, warn: evaluation.totals.WARN, pass: evaluation.totals.PASS, combinedStableHash: analysis.combinedStableHash }, null, 1));
    console.log('wrote', dest);
  }
  const failOn = opt('fail-on', 'fail');
  const code = failOn === 'never' ? 0 : (evaluation.totals.FAIL > 0 || (failOn === 'warn' && evaluation.totals.WARN > 0)) ? 1 : 0;
  process.exit(code);
}
main().catch((e) => { console.error('[fp-audit] ERROR', e && e.stack || e); process.exit(2); });
