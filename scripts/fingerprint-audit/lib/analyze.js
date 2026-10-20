import { createHash } from 'node:crypto';

export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
export const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/* Which part of a surface participates in its hash.
 * `consistency` hashes only the failing ids (details contain window sizes etc.).
 * `headers` drops values that legitimately differ between navigation and fetch. */
export function hashable(name, data) {
  if (data == null) return null;
  if (name === 'consistency') return { failed: data.failed };
  return data;
}
export const surfaceHash = (name, data) => sha(canon(hashable(name, data)));

function flatten(v, prefix, out, depth = 0) {
  if (depth > 6 || v === null || typeof v !== 'object') { out[prefix] = v; return out; }
  if (Array.isArray(v) && v.length > 60) { out[prefix] = '[array len ' + v.length + ' #' + sha(canon(v)) + ']'; return out; }
  const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
  if (!keys.length) { out[prefix] = Array.isArray(v) ? [] : {}; return out; }
  for (const k of keys) flatten(v[k], prefix ? prefix + '.' + k : String(k), out, depth + 1);
  return out;
}
export function diffPaths(a, b, limit = 8) {
  const fa = flatten(a, '', {}), fb = flatten(b, '', {}); const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]); const d = [];
  for (const k of keys) { if (canon(fa[k]) !== canon(fb[k])) { d.push({ path: k, a: trunc(fa[k]), b: trunc(fb[k]) }); if (d.length >= limit) break; } }
  return d;
}
const trunc = (v) => { const s = JSON.stringify(v); return s && s.length > 90 ? s.slice(0, 87) + '...' : v; };

/* runs: [{ session, origin, repeat, result }] ; returns per-surface stats */
export function analyze(runs) {
  const sessions = [...new Set(runs.map((r) => r.session))]; const origins = [...new Set(runs.map((r) => r.origin))];
  const names = [...new Set(runs.flatMap((r) => Object.keys(r.result.surfaces)))];
  const out = {};
  for (const name of names) {
    const cell = {}; // cell[session][origin] = [hashes by repeat]
    const sample = {};
    for (const r of runs) {
      const s = r.result.surfaces[name]; if (!s) continue;
      const h = s.data == null ? 'ERR' : surfaceHash(name, s.data);
      ((cell[r.session] ||= {})[r.origin] ||= []).push(h);
      (sample[r.session] ||= {})[r.origin] ||= s.data;
    }
    let withinStable = true; let unstableExample = null;
    for (const s of sessions) for (const o of origins) { const hs = (cell[s] || {})[o] || []; if (new Set(hs).size > 1) { withinStable = false; if (!unstableExample) { const runsFor = runs.filter((r) => r.session === s && r.origin === o && r.result.surfaces[name]); unstableExample = diffPaths(runsFor[0].result.surfaces[name].data, runsFor.find((r, i) => i > 0 && surfaceHash(name, r.result.surfaces[name].data) !== hs[0])?.result.surfaces[name].data); } } }
    const first = (s, o) => ((cell[s] || {})[o] || [])[0];
    const originsKnown = origins.length >= 2; const sessionsKnown = sessions.length >= 2;
    let originsEqual = null, sessionsEqual = null;
    if (originsKnown) originsEqual = sessions.every((s) => new Set(origins.map((o) => first(s, o))).size === 1);
    if (sessionsKnown) sessionsEqual = origins.every((o) => new Set(sessions.map((s) => first(s, o))).size === 1);
    let klass;
    if (!withinStable) klass = 'unstable';
    else if (originsEqual === null || sessionsEqual === null) klass = 'single-sample';
    else if (originsEqual && sessionsEqual) klass = 'constant';
    else if (!originsEqual && sessionsEqual) klass = 'per-site';
    else if (originsEqual && !sessionsEqual) klass = 'per-session';
    else klass = 'per-site-session';
    const s0 = sessions[0], o0 = origins[0];
    const hash = first(s0, o0);
    let diffAcrossOrigins = null, diffAcrossSessions = null;
    if (originsKnown && !originsEqual) diffAcrossOrigins = diffPaths(sample[s0][origins[0]], sample[s0][origins[1]]);
    if (sessionsKnown && !sessionsEqual) diffAcrossSessions = diffPaths(sample[sessions[0]][o0], sample[sessions[1]][o0]);
    out[name] = { hash, class: klass, withinStable, originsEqual, sessionsEqual, unstableExample, diffAcrossOrigins, diffAcrossSessions, errors: runs.filter((r) => r.result.surfaces[name] && r.result.surfaces[name].error).length };
  }
  const stableNames = names.filter((n) => out[n].class !== 'unstable' && n !== 'consistency').sort();
  const combined = sha(stableNames.map((n) => n + ':' + out[n].hash).join('|'));
  const combinedAll = sha(names.sort().map((n) => n + ':' + out[n].hash).join('|'));
  return { sessions: sessions.length, origins: origins.length, runs: runs.length, surfaces: out, combinedStableHash: combined, combinedHashAll: combinedAll, unstableSurfaces: names.filter((n) => out[n].class === 'unstable') };
}
