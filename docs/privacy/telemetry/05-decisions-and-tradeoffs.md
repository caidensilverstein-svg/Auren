# 05 Decisions and trade-offs

1. **Component updater off => no adblock filter lists, no Tor client download, no CRL set /
   cert-transparency list refresh, no NTP/HTTPS-upgrade data.** Shields (JS, cookies,
   fingerprinting) are code, not components, and keep working. Chosen because the update
   server is Brave's and receives a request per component per start. Follow-up: ship a
   pinned filter list inside the app or add a user-driven "import list" path.
2. **Safe Browsing off by default.** Real protection loss against phishing/malware pages; the
   only SB backend left was Brave's proxy of Google's lists. Re-enable in Settings.
   Compile-time removal (`safe_browsing_mode=0`) deferred: big rebuild, compile risk.
3. **Search suggestions off, default engine DuckDuckGo** (new profiles). Suggestions leaked
   every keystroke. An existing profile keeps its stored engine; set it in Settings.
4. **Firewall is a denylist, not an allowlist**: browser-process favicon/image fetches go to
   arbitrary user-visited hosts, so only known vendor domains are blocked. Side effects: Google
   favicons, Google-engine suggestions, Chrome Web Store installs and Google sign-in *by the
   browser process* are blocked (page-level Google sign-in in claude.ai works).
5. **DoH left on automatic**: it only upgrades to the operator already used by the system
   resolver; allowlisted as transport. Set `dns_over_https.mode=off` to remove entirely.
6. **`chrome://` kept as the internal scheme.** A `brave://` -> `auren://` rename touches 16
   C++ files + 76 resource files; deferred. Brave's address-bar rewriting of `chrome://` to
   `brave://` (`omnibox_text_util.cc`, `localized_error.cc`, `brave_browser.cc` target URL) is
   listed in 04 as deferred.
7. **Profile dir/keychain names unchanged** (`BraveSoftware/Brave-Browser-Development`,
   "Brave Safe Storage"): changing them would orphan the real profile's cookies and passwords.
   Migration recipe: quit Auren, `mv` the dir to `~/Library/Application Support/Auren` and
   export/import the keychain item before shipping the rename.
8. **Only English strings were rewritten**; other locales still say Brave but are not built into
   the used locale.
9. **Existing-profile caveat**: pref-default changes (SB, translate, P3A, suggestions) do not
   override values already persisted in an old profile. Verified runs use fresh profiles.
