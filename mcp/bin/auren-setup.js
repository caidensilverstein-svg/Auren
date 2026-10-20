#!/usr/bin/env node
// One-time / repeatable setup for the Auren MCP server:
//   1. makes sure AUREN_ADMIN_KEY exists in ~/.env (mode 600), generating one if not
//   2. writes a permission preset to ~/.auren/agent_permissions.json
//
// usage: node bin/auren-setup.js [open|standard|strict] [--rotate-key]
// default preset: open (most permissive). Restart auren-mcp afterwards if the
// admin key was newly created; permission changes apply immediately.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const PRESETS = {
  // Agent can do everything; the admin API/CLI and permission file still exist so you can tighten later.
  open: {
    trust_level: 'trusted',
    rules: { read: 'allow', navigation: 'allow', click: 'allow', fill: 'allow', js_execute: 'allow', form_submit: 'allow' },
  },
  // Browse, read and click freely; typing into fields, running JS and submitting forms need your approval.
  standard: {
    trust_level: 'inspection',
    rules: { read: 'allow', navigation: 'allow', click: 'allow', fill: 'ask', js_execute: 'ask', form_submit: 'ask' },
  },
  // Read-only by default; everything that changes state needs approval, arbitrary JS is blocked outright.
  strict: {
    trust_level: 'inspection',
    rules: { read: 'allow', navigation: 'ask', click: 'ask', fill: 'ask', js_execute: 'deny', form_submit: 'ask' },
  },
};

const args = process.argv.slice(2);
const preset = args.find(a => !a.startsWith('--')) ?? 'open';
if (!PRESETS[preset]) {
  console.error(`Unknown preset '${preset}'. Choose: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

const home = os.homedir();
const envPath = path.join(home, '.env');
let env = '';
try { env = fs.readFileSync(envPath, 'utf8'); } catch {}

let keyStatus = 'kept existing';
const has = /^\s*AUREN_ADMIN_KEY\s*=/m.test(env);
if (!has || args.includes('--rotate-key')) {
  const key = crypto.randomBytes(32).toString('hex');
  env = has ? env.replace(/^\s*AUREN_ADMIN_KEY\s*=.*$/m, `AUREN_ADMIN_KEY=${key}`)
            : env + (env && !env.endsWith('\n') ? '\n' : '') + `AUREN_ADMIN_KEY=${key}\n`;
  fs.writeFileSync(envPath, env, { mode: 0o600 });
  keyStatus = has ? 'rotated' : 'generated';
}
fs.chmodSync(envPath, 0o600);

const dir = path.join(home, '.auren');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const permsPath = path.join(dir, 'agent_permissions.json');
let current = {};
try { current = JSON.parse(fs.readFileSync(permsPath, 'utf8')); } catch {}
const next = { ...current, version: 1, ...PRESETS[preset], session_overrides: {} };
fs.writeFileSync(permsPath, JSON.stringify(next, null, 2), { mode: 0o600 });

console.log(`admin key: ${keyStatus} (in ${envPath}, mode 600; never printed)`);
console.log(`preset:    ${preset}  trust_level=${next.trust_level}`);
console.log(`rules:     ${JSON.stringify(next.rules)}`);
if (keyStatus !== 'kept existing') console.log('restart auren-mcp so it picks up the new admin key:  pm2 restart auren-mcp --update-env');
console.log('manage later with:  node bin/auren-perm.js list | set <action> <allow|ask|deny> | trust <inspection|trusted>');
