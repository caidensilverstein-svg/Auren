# Fingerprint patches

Apply order does not matter (disjoint files); each is also standalone.
```
cd ~/brave-src/src/brave
git apply --check ~/path/Auren/patches/privacy/fingerprint/brave/*.patch && git apply ~/path/Auren/patches/privacy/fingerprint/brave/*.patch
```
Files touched, effects and the harness checks that verify each: `docs/privacy/fingerprinting/patch-notes.md`. Policy: `docs/privacy/fingerprinting/policy.md`.
Test after build: `node scripts/fingerprint-audit/run.js --browser <Auren binary> --browser-port 9225 --profile-root ~/auren-audit/fp-profile --label post`.
Regenerate patches: `python3 gen/make_patches.py --brave-root ~/brave-src/src/brave --out /tmp/p`.
Status: apply-checked against the Mac tree on 2026-10-20; not compiled. Repo-source changes (side panel UA, security bar) are in `browser/`.
