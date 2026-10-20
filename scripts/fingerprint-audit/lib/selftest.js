/* Builds a single self-contained JS string that can be injected into ANY http(s) page
 * (CDP Runtime.evaluate with awaitPromise:true, or the MCP browser_execute_js tool) to run the
 * in-browser subset of the audit against the page's own origin - i.e. with Shields/farbling
 * applied exactly as a visited site would see it. No server, no network.
 *
 * Differences from the full run: no request-header / TLS surfaces (they need the echo server),
 * the worker is created from a Blob (inherits the page origin), no cross-session/cross-site
 * statistics (single sample). Returns { date, policy, browser, pass, warn, fail, failing[], warnings[] }.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const SELFTEST_SURFACES = ['navigator', 'userAgentData', 'screen', 'mediaQueries', 'intl', 'canvas2d', 'webgl', 'webgpu', 'audio', 'fonts', 'geometry', 'speech', 'mediaDevices', 'webrtc', 'hardware', 'timing', 'automation', 'blockers', 'consistency'];

export function buildSelftest(policy, policyName) {
  const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');
  const checks = policy.checks.filter((c) => SELFTEST_SURFACES.includes(c.path.split('.')[0]));
  return `(async () => {
  ${read('collect.js')}
  const module = { exports: {} };
  (function () { ${read('evaluate.cjs')} }).call(globalThis);
  const E = globalThis.AurenEval;
  const workerSrc = ${JSON.stringify(read('worker.js'))};
  const workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
  const result = await window.FPAudit.collect({ only: ${JSON.stringify(SELFTEST_SURFACES)}, workerUrl });
  const checks = ${JSON.stringify(checks)};
  const out = checks.map((c) => E.evalCheck(c, result));
  const cons = E.evalConsistency(${JSON.stringify(policy.consistency || { require: [] })}, result);
  const all = out.concat(cons);
  const n = (s) => all.filter((x) => x.status === s).length;
  return { date: new Date().toISOString(), policy: ${JSON.stringify(policyName)}, browser: navigator.userAgent, pass: n('PASS'), warn: n('WARN'), fail: n('FAIL'),
    failing: all.filter((x) => x.status === 'FAIL').map((x) => x.id), warnings: all.filter((x) => x.status === 'WARN').map((x) => x.id), note: 'subset self-test, single sample, no header/TLS surfaces' };
})()`;
}
