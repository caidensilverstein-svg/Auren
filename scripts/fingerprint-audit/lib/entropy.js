/* Uniqueness estimate. HONESTY NOTE: without a measured population this cannot produce real
 * "1 in N" numbers. Two modes:
 *   1. distribution mode (--reference file with `distributions`): bits = -log2 p(value), p from YOUR data.
 *   2. bound mode (default; reference/plausible-sets.json): bits <= log2(#plausible values) unless the
 *      observed value equals the policy `target`, in which case 0 is claimed *under the assumption that
 *      every Auren user reports the same target*. Counting argument only - never a measurement.
 * Per-attribute bits are summed; correlations are ignored, so the sum overestimates (upper bound).
 */
import { canon } from './analyze.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ev = require('./evaluate.cjs');

export function estimate(result, reference) {
  const rows = []; let total = 0; let counted = 0;
  for (const [path, spec] of Object.entries(reference.plausible || {})) {
    const actual = ev.get(result, path); if (actual === undefined) continue;
    const key = canon(actual); let bits; let basis;
    const dist = reference.distributions && reference.distributions[path];
    if (dist) { const p = dist[key] ?? (Math.min(...Object.values(dist)) / 2); bits = -Math.log2(p); basis = dist[key] !== undefined ? 'measured distribution' : 'unseen in reference (bounded by half the rarest)'; }
    else if (spec.target !== undefined && canon(spec.target) === key) { bits = 0; basis = 'equals policy target (assumes crowd adopts it)'; }
    else if (spec.size || spec.values) { const n = spec.size || spec.values.length; bits = Math.log2(n); basis = `upper bound: ${n} plausible values`; }
    else continue;
    rows.push({ path, value: actual, bits: +bits.toFixed(2), basis }); total += bits; counted++;
  }
  return { attributes: counted, upperBoundBits: +total.toFixed(2), rows, caveat: reference.meta && reference.meta.caveat };
}
