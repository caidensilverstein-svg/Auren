import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('./evaluate.cjs');

export function evaluatePolicy(policy, analysis, firstResult, baseline) {
  E.setBaseline(baseline || null);
  const checks = [];
  for (const c of policy.checks || []) checks.push(E.evalCheck(c, firstResult));
  if (policy.consistency && (policy.consistency.require === '*' || (policy.consistency.require || []).length)) checks.push(...E.evalConsistency(policy.consistency, firstResult));
  // surface-class expectations
  const sc = policy.surfaceClass || {}; const def = (sc.default || {}).allow || null;
  for (const [name, a] of Object.entries(analysis.surfaces)) {
    const spec = sc[name] || sc.default; const allow = (spec && spec.allow) || def; if (!allow) continue;
    const ok = allow.includes(a.class) || (a.class === 'single-sample' && !allow.includes('unstable'));
    checks.push({ id: `class.${name}`, surface: name, status: ok ? 'PASS' : ((spec.severity === 'warn') ? 'WARN' : 'FAIL'), severity: spec.severity || 'fail', desc: `behaviour class '${a.class}' must be one of ${allow.join('/')}`, actual: a.class, expected: allow, detail: a.unstableExample || a.diffAcrossOrigins || a.diffAcrossSessions || null });
  }
  const verdicts = {}; const totals = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
  for (const c of checks) { totals[c.status] = (totals[c.status] || 0) + 1; verdicts[c.surface] = E.worst(verdicts[c.surface] || 'SKIP', c.status); }
  return { checks, verdicts, totals };
}

const fmt = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s === undefined ? 'undefined' : (s.length > 110 ? s.slice(0, 107) + '...' : s); };
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function markdown({ meta, analysis, evaluation, entropy, metrics }) {
  const L = [];
  L.push(`# Fingerprint audit: ${meta.label}`, '');
  L.push(`- Browser: \`${meta.browserVersion || 'unknown'}\` (${meta.userAgent || ''})`);
  L.push(`- Policy: \`${meta.policy}\`   Run: ${meta.date}   Sessions x origins x repeats: ${meta.sessions} x ${meta.origins} x ${meta.repeats}`);
  L.push(`- Origins: ${meta.originUrls.join(' , ')}`);
  L.push(`- Combined hash of stable surfaces: \`${analysis.combinedStableHash}\`   (all surfaces: \`${analysis.combinedHashAll}\`)`);
  if (analysis.unstableSurfaces.length) L.push(`- UNSTABLE surfaces (change on reload within one session): ${analysis.unstableSurfaces.join(', ')}`);
  L.push(`- Checks: **${evaluation.totals.FAIL} FAIL**, ${evaluation.totals.WARN} WARN, ${evaluation.totals.PASS} PASS, ${evaluation.totals.SKIP} skipped`, '');
  L.push('## Surfaces', '', '| surface | behaviour class | stable on reload | same across sites | same across sessions | hash | verdict |', '|---|---|---|---|---|---|---|');
  for (const [n, a] of Object.entries(analysis.surfaces).sort()) L.push(`| ${n} | ${a.class} | ${a.withinStable ? 'yes' : '**NO**'} | ${a.originsEqual === null ? 'n/a' : a.originsEqual ? 'yes' : 'no'} | ${a.sessionsEqual === null ? 'n/a' : a.sessionsEqual ? 'yes' : 'no'} | \`${a.hash}\` | ${evaluation.verdicts[n] || 'INFO'} |`);
  L.push('', 'Class meaning: constant = identical across sites and sessions (uniformity); per-site = differs by site, stable across sessions; per-session = same on all sites but changes per session; per-site-session = farbling-style; unstable = changes on reload (always a bug or a tell).', '');
  const bad = evaluation.checks.filter((c) => c.status === 'FAIL' || c.status === 'WARN');
  L.push('## Failures and warnings', '');
  if (!bad.length) L.push('None.'); else {
    L.push('| status | check | expected | actual |', '|---|---|---|---|');
    for (const c of bad.sort((a, b) => (a.status < b.status ? 1 : -1))) L.push(`| ${c.status} | ${esc(c.id)}${c.desc ? ' - ' + esc(c.desc) : ''} | ${esc(c.op ? c.op + ' ' + fmt(c.expected) : fmt(c.expected ?? ''))} | ${esc(fmt(c.actual))} |`);
  }
  L.push('', '## Cross-site / cross-session differences (what actually varies)', '');
  let any = false;
  for (const [n, a] of Object.entries(analysis.surfaces)) {
    for (const [lab, d] of [['across sites', a.diffAcrossOrigins], ['across sessions', a.diffAcrossSessions], ['on reload (UNSTABLE)', a.unstableExample]]) if (d && d.length) { any = true; L.push(`- **${n}** ${lab}: ` + d.slice(0, 4).map((x) => `\`${x.path}\` ${fmt(x.a)} -> ${fmt(x.b)}`).join('; ')); }
  }
  if (!any) L.push('Nothing varies.');
  if (metrics && Object.keys(metrics).length) { L.push('', '## Measurements (not pass/fail)', ''); for (const [k, v] of Object.entries(metrics)) L.push(`- ${k}: ${fmt(v)}`); }
  if (entropy) {
    L.push('', '## Uniqueness estimate (upper bound; see docs for limits)', '', `Attributes counted: ${entropy.attributes}; sum of per-attribute bits (correlation ignored): **${entropy.upperBoundBits}**`, '', '| attribute | value | bits | basis |', '|---|---|---|---|');
    for (const r of entropy.rows) L.push(`| ${r.path} | ${esc(fmt(r.value))} | ${r.bits} | ${esc(r.basis)} |`);
    if (entropy.caveat) L.push('', `> ${entropy.caveat}`);
  }
  return L.join('\n') + '\n';
}
