/* Policy evaluator shared by Node (run.js) and the browser (in-page self-test).
 * UMD-lite: sets globalThis.AurenEval and module.exports.
 *
 * check = { id, path, op, value?, severity: 'fail'|'warn', desc?, when?: {path, op, value} }
 * path  = "<surface>.<key>[.<key|index>...]" resolved under result.surfaces[surface].data
 */
(function (root) {
  'use strict';
  function get(result, path) {
    const parts = path.split('.'); const s = result.surfaces && result.surfaces[parts[0]];
    let cur = s && s.data; for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
    return cur;
  }
  const str = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  let baseline = null;
  function test(op, actual, value, flags) {
    switch (op) {
      case 'eq': return JSON.stringify(actual) === JSON.stringify(value);
      case 'ne': return JSON.stringify(actual) !== JSON.stringify(value);
      case 'in': return Array.isArray(value) && value.some((v) => JSON.stringify(v) === JSON.stringify(actual));
      case 'notIn': return Array.isArray(value) && !value.some((v) => JSON.stringify(v) === JSON.stringify(actual));
      case 'match': return actual != null && new RegExp(value, flags || '').test(str(actual));
      case 'notMatch': return actual == null || !new RegExp(value, flags || '').test(str(actual));
      case 'truthy': return !!actual;
      case 'falsy': return !actual;
      case 'absent': return actual === undefined || actual === null;
      case 'present': return actual !== undefined && actual !== null;
      case 'gte': return typeof actual === 'number' && actual >= value;
      case 'lte': return typeof actual === 'number' && actual <= value;
      case 'lenEq': return actual != null && actual.length === value;
      case 'setEq': return Array.isArray(actual) && Array.isArray(value) && JSON.stringify([...actual].sort()) === JSON.stringify([...value].sort());
      case 'includesAll': return Array.isArray(actual) && value.every((v) => actual.some((a) => JSON.stringify(a) === JSON.stringify(v)));
      case 'noneMatch': return !Array.isArray(actual) || !actual.some((a) => new RegExp(value, flags || '').test(str(a)));
      case 'valuesNoneMatch': return actual == null || !Object.values(actual).some((a) => new RegExp(value, flags || '').test(str(a)));
      case 'valuesAll': return actual != null && Object.values(actual).every((a) => JSON.stringify(a) === JSON.stringify(value));
      case 'eqBaseline': return baseline ? JSON.stringify(actual) === JSON.stringify(get(baseline, value)) : true;
      case 'emptyArray': return Array.isArray(actual) && actual.length === 0;
      default: throw new Error('unknown op ' + op);
    }
  }
  function evalCheck(check, result) {
    let applicable = true;
    if (check.when) applicable = test(check.when.op, get(result, check.when.path), check.when.value, check.when.flags);
    if (!applicable) return { id: check.id, status: 'SKIP', severity: check.severity, desc: check.desc, surface: check.path.split('.')[0] };
    const actual = get(result, check.path);
    let ok; try { ok = test(check.op, actual, check.value, check.flags); } catch (e) { ok = false; }
    return { id: check.id, status: ok ? 'PASS' : (check.severity === 'warn' ? 'WARN' : 'FAIL'), severity: check.severity || 'fail', desc: check.desc, path: check.path, op: check.op, expected: check.value, actual: actual === undefined ? null : actual, surface: check.path.split('.')[0] };
  }
  function evalConsistency(spec, result) {
    const c = result.surfaces && result.surfaces.consistency && result.surfaces.consistency.data; const out = [];
    if (!c) return [{ id: 'consistency', status: 'FAIL', severity: 'fail', desc: 'consistency surface missing', surface: 'consistency' }];
    const required = spec.require === '*' ? c.checks.map((x) => x.id) : spec.require || [];
    const waive = new Set(spec.waive || []);
    const warnIds = new Set(spec.warnOnly || []);
    for (const id of required) {
      const k = c.checks.find((x) => x.id === id);
      if (!k) { out.push({ id: 'consistency.' + id, status: 'WARN', severity: 'warn', desc: 'check not found', surface: 'consistency' }); continue; }
      if (k.ok === null) { out.push({ id: 'consistency.' + id, status: 'SKIP', severity: 'warn', surface: 'consistency' }); continue; }
      if (waive.has(id)) continue;
      out.push({ id: 'consistency.' + id, status: k.ok ? 'PASS' : (warnIds.has(id) || spec.severity === 'warn' ? 'WARN' : 'FAIL'), severity: warnIds.has(id) ? 'warn' : (spec.severity || 'fail'), actual: k.detail, surface: 'consistency', desc: id });
    }
    return out;
  }
  const RANK = { FAIL: 3, WARN: 2, PASS: 1, SKIP: 0, INFO: 0 };
  const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);
  const api = { get, test, evalCheck, evalConsistency, worst, RANK, setBaseline: (b) => { baseline = b; } };
  root.AurenEval = api; if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
