import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, canon, surfaceHash } from '../lib/analyze.js';

const run = (session, origin, repeat, data) => ({ session, origin, repeat, result: { surfaces: { s: { data } } } });
test('canon is key-order independent', () => { assert.equal(canon({ a: 1, b: [2, { d: 1, c: 2 }] }), canon({ b: [2, { c: 2, d: 1 }], a: 1 })); });
test('constant / per-site / per-session / per-site-session / unstable', () => {
  const mk = (f) => { const runs = []; for (const s of [0, 1]) for (const o of ['A', 'B']) for (const r of [0, 1]) runs.push(run(s, o, r, f(s, o, r))); return analyze(runs).surfaces.s.class; };
  assert.equal(mk(() => ({ v: 1 })), 'constant');
  assert.equal(mk((s, o) => ({ v: o })), 'per-site');
  assert.equal(mk((s) => ({ v: s })), 'per-session');
  assert.equal(mk((s, o) => ({ v: s + o })), 'per-site-session');
  assert.equal(mk((s, o, r) => ({ v: r })), 'unstable');
});
test('single sample cannot be classified', () => { assert.equal(analyze([run(0, 'A', 0, { v: 1 })]).surfaces.s.class, 'single-sample'); });
test('consistency surface hashes only failed ids', () => { assert.equal(surfaceHash('consistency', { failed: ['x'], checks: [1] }), surfaceHash('consistency', { failed: ['x'], checks: [2] })); });
