import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const E = createRequire(import.meta.url)('../lib/evaluate.cjs');
const result = { surfaces: { navigator: { data: { hardwareConcurrency: 8, plugins: [{ name: 'PDF Viewer' }, { name: 'aB3dE5gH' }], list: [1, 2] } }, consistency: { data: { checks: [{ id: 'a', ok: true }, { id: 'b', ok: false, detail: 'x' }, { id: 'c', ok: null }] } } } };
test('ops', () => {
  const c = (op, path, value, extra = {}) => E.evalCheck({ id: 't', path, op, value, severity: 'fail', ...extra }, result).status;
  assert.equal(c('eq', 'navigator.hardwareConcurrency', 8), 'PASS');
  assert.equal(c('eq', 'navigator.hardwareConcurrency', 4), 'FAIL');
  assert.equal(c('noneMatch', 'navigator.plugins', '"name":"[A-Za-z0-9]{6,9}"'), 'FAIL');
  assert.equal(c('absent', 'navigator.nothing'), 'PASS');
  assert.equal(c('eq', 'navigator.hardwareConcurrency', 4, { severity: 'warn' }), 'WARN');
  assert.equal(c('eq', 'navigator.hardwareConcurrency', 4, { when: { path: 'navigator.nothing', op: 'present' } }), 'SKIP');
  assert.equal(c('match', 'navigator.hardwareConcurrency', '^8$'), 'PASS');
});
test('consistency evaluation', () => {
  const r = E.evalConsistency({ require: '*', severity: 'fail' }, result);
  assert.deepEqual(r.map((x) => x.status), ['PASS', 'FAIL', 'SKIP']);
  assert.equal(E.evalConsistency({ require: '*', severity: 'fail', warnOnly: ['b'] }, result)[1].status, 'WARN');
});
