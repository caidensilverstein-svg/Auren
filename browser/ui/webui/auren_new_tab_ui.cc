/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/ui/webui/auren_new_tab_ui.h"

#include <memory>
#include <string>

#include "base/base64.h"
#include "base/memory/ref_counted_memory.h"
#include "brave/browser/ui/webui/auren/auren_security_handler.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "services/network/public/mojom/content_security_policy.mojom-shared.h"

namespace {

// Delimiter AUREN avoids premature termination on any )"-containing CSS/JS.
constexpr char kAurenNewTabHtml[] = R"AUREN(<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>New Tab</title>
<link rel="icon" type="image/png" href="favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://unpkg.com/lucide@latest"></script>
<style>
  :root {
    /* Typography */
    --font-sans: 'Inter', system-ui, sans-serif;
    --font-mono: 'DM Mono', 'Fira Code', monospace;
    --text-xs: 11px; --text-sm: 13px; --text-base: 15px; --text-lg: 17px; --text-xl: 20px;

    /* Colors - dark base */
    --bg-base: #0a0a0f;
    --bg-surface: #111118;
    --bg-elevated: #1a1a24;
    --border: rgba(255,255,255,0.08);
    --text-primary: rgba(255,255,255,0.92);
    --text-secondary: rgba(255,255,255,0.55);
    --text-muted: rgba(255,255,255,0.28);
    --accent: #6c63ff;
    --accent-hover: #7c74ff;

    /* Spacing */
    --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
    --space-6: 24px; --space-8: 32px; --space-12: 48px;

    /* Radius */
    --radius-sm: 6px; --radius-md: 10px; --radius-lg: 16px; --radius-xl: 24px;

    /* Elevation */
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.4);
    --shadow-md: 0 4px 16px rgba(0,0,0,0.5);
    --shadow-lg: 0 8px 32px rgba(0,0,0,0.6);

    /* Motion */
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    --duration-fast: 120ms; --duration-base: 200ms; --duration-slow: 350ms;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body {
    background: var(--bg-base);
    font-family: var(--font-sans);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .wordmark {
    font-size: 40px;
    font-weight: 700;
    letter-spacing: 0.35em;
    color: var(--accent);
    user-select: none;
  }
</style>
</head>
<body>
  <div class="wordmark">AUREN</div>

  <div id="security-bar" style="margin-top:var(--space-8);display:flex;align-items:flex-start;justify-content:center;gap:var(--space-6);white-space:nowrap;font-family:var(--font-mono);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-6) var(--space-8);background:var(--bg-surface);box-shadow:var(--shadow-md)">

    <!-- Toggle controls: Tor, DNS, JS -->
    <div style="display:flex;align-items:flex-start;gap:var(--space-6);flex-shrink:0">

      <!-- Tor toggle -->
      <button id="btn-tor" style="display:flex;flex-direction:column;align-items:center;gap:5px;background:none;border:none;cursor:pointer;padding:0;font-family:var(--font-mono)">
        <span style="display:flex;align-items:center;gap:6px">
          <span id="icon-tor" style="display:inline-flex;align-items:center;color:var(--accent)"><i data-lucide="route" style="width:14px;height:14px"></i></span>
          <span style="font-size:var(--text-xs);color:var(--text-secondary);letter-spacing:0.08em;text-transform:uppercase">Tor</span>
          <span id="val-tor" style="font-size:var(--text-sm);color:var(--accent);font-weight:500">DE</span>
        </span>
        <span id="track-tor" style="width:20px;height:11px;border-radius:9999px;position:relative;background:var(--accent);display:block;transition:background var(--duration-fast) var(--ease-out)">
          <span id="thumb-tor" style="position:absolute;top:1.5px;left:11px;width:8px;height:8px;border-radius:9999px;background:var(--accent-hover);transition:left var(--duration-fast) var(--ease-out)"></span>
        </span>
      </button>

      <!-- DNS toggle -->
      <button id="btn-dns" style="display:flex;flex-direction:column;align-items:center;gap:5px;background:none;border:none;cursor:pointer;padding:0;font-family:var(--font-mono)">
        <span style="display:flex;align-items:center;gap:6px">
          <span id="icon-dns" style="display:inline-flex;align-items:center;color:var(--accent)"><i data-lucide="server" style="width:14px;height:14px"></i></span>
          <span style="font-size:var(--text-xs);color:var(--text-secondary);letter-spacing:0.08em;text-transform:uppercase">DNS</span>
          <span id="val-dns" style="font-size:var(--text-sm);color:var(--accent);font-weight:500">On</span>
        </span>
        <span id="track-dns" style="width:20px;height:11px;border-radius:9999px;position:relative;background:var(--accent);display:block;transition:background var(--duration-fast) var(--ease-out)">
          <span id="thumb-dns" style="position:absolute;top:1.5px;left:11px;width:8px;height:8px;border-radius:9999px;background:var(--accent-hover);transition:left var(--duration-fast) var(--ease-out)"></span>
        </span>
      </button>

      <!-- JS toggle -->
      <button id="btn-js" style="display:flex;flex-direction:column;align-items:center;gap:5px;background:none;border:none;cursor:pointer;padding:0;font-family:var(--font-mono)">
        <span style="display:flex;align-items:center;gap:6px">
          <span id="icon-js" style="display:inline-flex;align-items:center;color:var(--accent)"><i data-lucide="braces" style="width:14px;height:14px"></i></span>
          <span style="font-size:var(--text-xs);color:var(--text-secondary);letter-spacing:0.08em;text-transform:uppercase">JS</span>
          <span id="val-js" style="font-size:var(--text-sm);color:var(--accent);font-weight:500">On</span>
        </span>
        <span id="track-js" style="width:20px;height:11px;border-radius:9999px;position:relative;background:var(--accent);display:block;transition:background var(--duration-fast) var(--ease-out)">
          <span id="thumb-js" style="position:absolute;top:1.5px;left:11px;width:8px;height:8px;border-radius:9999px;background:var(--accent-hover);transition:left var(--duration-fast) var(--ease-out)"></span>
        </span>
      </button>
    </div>

    <!-- Vertical divider -->
    <div style="width:1px;height:22px;background:var(--border);flex-shrink:0"></div>

    <!-- Passive indicators: Fingerprint, HTTPS, Cookies -->
    <div style="display:flex;align-items:center;gap:var(--space-6);flex-shrink:0;padding-top:2px">

      <div style="display:flex;align-items:center;gap:6px">
        <span id="icon-fingerprint" style="display:inline-flex;align-items:center;color:var(--accent)"><i data-lucide="fingerprint" style="width:16px;height:16px"></i></span>
        <span style="font-size:var(--text-xs);color:var(--text-secondary);letter-spacing:0.08em;text-transform:uppercase">Fingerprint</span>
        <span id="val-fingerprint" style="font-size:var(--text-base);color:var(--accent);font-weight:600">94/100</span>
      </div>

      <div style="display:flex;align-items:center;gap:6px">
        <span id="icon-https" style="display:inline-flex;align-items:center;color:var(--accent)"><i data-lucide="lock" style="width:14px;height:14px"></i></span>
        <span style="font-size:var(--text-xs);color:var(--text-secondary);letter-spacing:0.08em;text-transform:uppercase">HTTPS</span>
        <span id="val-https" style="font-size:var(--text-sm);color:var(--accent);font-weight:500">Enforced</span>
      </div>

      <div style="display:flex;align-items:center;gap:6px">
        <span id="icon-cookies" style="display:inline-flex;align-items:center;color:var(--accent)"><i data-lucide="cookie" style="width:14px;height:14px"></i></span>
        <span style="font-size:var(--text-xs);color:var(--text-secondary);letter-spacing:0.08em;text-transform:uppercase">Cookies</span>
        <span id="val-cookies" style="font-size:var(--text-sm);color:var(--accent);font-weight:500">Isolated</span>
      </div>
    </div>
  </div>

  <script>
    var ACCENT = '#6c63ff';
    var DANGER = '#c0392b';
    var TRACK_ON = '#6c63ff';
    var TRACK_OFF = 'rgba(255,255,255,0.28)';
    var THUMB_ON = '#7c74ff';
    var THUMB_OFF = '#1a1a24';

    var state = {
      tor:             { active: true, exitCountry: 'DE' },
      dns:             { active: true },
      js:              { active: true },
      fingerprintScore: 94,
      httpsEnforced:   true,
      cookiesIsolated: true
    };

    function applyToggle(prefix, active, label) {
      var c = active ? ACCENT : DANGER;
      document.getElementById('icon-' + prefix).style.color = c;
      var valEl = document.getElementById('val-' + prefix);
      valEl.textContent = label;
      valEl.style.color = c;
      document.getElementById('track-' + prefix).style.background =
          active ? TRACK_ON : TRACK_OFF;
      var thumbEl = document.getElementById('thumb-' + prefix);
      thumbEl.style.background = active ? THUMB_ON : THUMB_OFF;
      thumbEl.style.left = active ? '11px' : '1px';
    }

    function render() {
      applyToggle('tor', state.tor.active,
          state.tor.active ? (state.tor.exitCountry || 'On') : 'Off');
      applyToggle('dns', state.dns.active,
          state.dns.active ? 'On' : 'Off');
      applyToggle('js', state.js.active,
          state.js.active ? 'On' : 'Off');

      var fpC = state.fingerprintScore >= 80 ? ACCENT : DANGER;
      document.getElementById('icon-fingerprint').style.color = fpC;
      var fpEl = document.getElementById('val-fingerprint');
      fpEl.textContent = state.fingerprintScore + '/100';
      fpEl.style.color = fpC;

      var httpsC = state.httpsEnforced ? ACCENT : DANGER;
      document.getElementById('icon-https').style.color = httpsC;
      var httpsEl = document.getElementById('val-https');
      httpsEl.textContent = state.httpsEnforced ? 'Enforced' : 'Not enforced';
      httpsEl.style.color = httpsC;

      var cookieC = state.cookiesIsolated ? ACCENT : DANGER;
      document.getElementById('icon-cookies').style.color = cookieC;
      var cookieEl = document.getElementById('val-cookies');
      cookieEl.textContent = state.cookiesIsolated ? 'Isolated' : 'Off';
      cookieEl.style.color = cookieC;
    }

    // Called by C++ via CallJavascriptFunction("onSecurityState", state_dict).
    function onSecurityState(s) {
      state.tor.active       = !!s.tor_active;
      state.tor.exitCountry  = s.tor_exit_country || '';
      state.dns.active       = !!s.dns_active;
      state.js.active        = !!s.js_enabled;
      state.fingerprintScore = s.fingerprint_score || 0;
      state.httpsEnforced    = !!s.https_enforced;
      state.cookiesIsolated  = !!s.cookies_isolated;
      render();
    }

    document.getElementById('btn-tor').addEventListener('click', function() {
      state.tor.active = !state.tor.active;
      render();
    });

    document.getElementById('btn-dns').addEventListener('click', function() {
      state.dns.active = !state.dns.active;
      render();
    });

    document.getElementById('btn-js').addEventListener('click', function() {
      state.js.active = !state.js.active;
      render();
      if (window.chrome && chrome.send) {
        chrome.send('setJsEnabled', [state.js.active]);
      }
    });

    // Use load (not DOMContentLoaded) so the Lucide CDN script is ready.
    window.addEventListener('load', function() {
      if (window.lucide) { window.lucide.createIcons(); }
      render();
      if (window.chrome && chrome.send) {
        chrome.send('getSecurityState');
      }
    });
  </script>
</body>
</html>
)AUREN";

// Auren icon at 32x32, base64-encoded PNG (python3 base64.b64encode output).
constexpr char kFaviconPngBase64[] =
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAERl"
    "WElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAAB"
    "AAAAIKADAAQAAAABAAAAIAAAAACshmLzAAAHRUlEQVRYCZVXa2wc1RX+5rE763XW9u5i"
    "r0PiBxDygBJMHm1xQ8CO44o3DiE/eEUFCX4lKK36pyqlrZBoflSq+FEgQgIJARF/IEIt"
    "iIgiHgl5mBAJhyCZvLCTdYKdh707uzO7O9NzZvbsjLerVr3y7L3n3PP4zuPeGSuj798b"
    "twt2TI/Gmpf1NMcOH53u/ecn2VUF2xlsTxnDrgtA8f78Bf3+98EKQFUNrus656eL76Xb"
    "ovvuW9915JYV6YmD41lbdSK5ptyUpex/55epBDlPtsRSv3/x6K8++2r64ZlZu90uOSiX"
    "yYznXBAoTAZDCN+nx/eWHmoGQRT9RXQF0YiKjrQxOfTzzGs7t/ftPnb24mypqOb1KKIL"
    "yHnyyecOPL//6Mw95YoLXVNJSSMl34OizJ8FgfApSmH5IARAaC47LiayhcVv/ePMsxcu"
    "Frtfe65/57ET09Be/N2ajmd2fv303i+nHnMcBTo5VlXVe9gBrxvNzGv0MALm18++LLys"
    "/pA1+y7mrOzmu3qOq19QzT8/cuHRchnkLDAqBho5+X95YouD0Si7BauCvfuzT5z7sdih"
    "pZPxLZT6e9moRCsORJFpWcssMuFZ9sJz/ZppHkWrkswko4dUs+gMcsPVG2Ih4YXXNR6B"
    "cqiuLrUl80SmfpY94TPNmWafJyfzvWomZWwslR3PgPyElUSxfq9UqmBkeDn6rm8BNy7r"
    "yFOv04hm4HYFMZUblVRrUYQdhYGIcQ7WIs11a3qxbevPcNvKBDLJCCqhGMJ6jZx7PPpR"
    "qw/T3qhXZGY9j7PVfXUbnt0+AE11ENUcDK1pRdxQ6dKZLy+gfevBr2fTr5oHIthp4JA3"
    "xRDX3Ijq+AM5X5SJw7Isr5aZNg2397X8TztiKyzIWagNvlDqLxXZZD5Hv23rrehftRim"
    "WYBTKZO8Ctt2saI7hlVLm71+COvImmfJpuejenfNAyCRhpVkXbTKeGD4Bjxy/0qYhQJc"
    "x/G6WaW71FV0Aufi1hsTuGahUQMhDsWGBOfxgxI0vkZFiWfLLuPmFQvx26fX0U1WQoU6"
    "TtV0nD4PFNxWxOIJCk+HqrgYWtWKZEInGbY73zbbYhDcK7JDGahCqW6yUHiUyxWk2+L4"
    "044NSMQ1AmB71/XocROpJVuwevAJzJYSiBpxcqqQjIqN1JR0o9M94TsM2/PXdAirCAiA"
    "9876j9ozUm66SETDH3cM4aZlV8Eh56riYM/Hp6C09WP9bbdjcMMQOpcO4ORUmbKieZFf"
    "02ngjltaq5Ybg5AM6IIojJKdc51KFP36n/ZSBgx8euB7ylUFnx2axL8OX8b2bQO4cmUG"
    "Zn4OuZyJL7/NYeoqC51tnFEHqYSGhakozk5bBNoHIT0Q9ukDqMIRAWmeiK5i3+hpfHrw"
    "pKejKPwy0ZFOJ/HmW2/TGpibncMHH35EJ8HGweNzXo94dsimRp7FuQTIexI9A9WF4A1x"
    "HAZSoTLwS4oH7ytUvHw+j3Pnsvj7S7u80s3N5elYmhQmNSfJkCUSphKSTRli06OZX92i"
    "64vXjQVFKTw71Fm5vAlNKWFpdxzN2iwK5hyKRYt6xqn2Ene6b1NmdsxrocWjH1qVqm2G"
    "BesMFa0SMulm/HnHICbOzVD989i4OoGI5tL5918IYTv1joWWFPgAquiCzQBtgNqlC8jG"
    "8us68PpfN+PS5Tkc+WYSp7JFGFTIhwba0ULHlG9L0QnPYjsAxxz/hVQrQbA5P33MNwsl"
    "rFvbi10vjKCd3n673j7k3YQc9P6xK/RG1D0QnalIDQQ7qLcZ8HwftRLUC4ZpPo4P3b0S"
    "Lz1/P7oyBvZ8NIZj49N0IdGpIAunpyyMT5hob9GxZbAD13fxpRSqd6iMYpfbjgumU6dy"
    "xb3rsLbJMKuD67qhfwke39SHU2emqNkKeOPdb7zoRZ5PyqHjs/RK1ryj2X9jC31ylTFx"
    "nu4AAihy82fySgj0CzPF9+i8j8gmHzVey8yf6Ae+/oHug1PE941x2nXNl2OcnIXJHy28"
    "uXfKg00mSN9/xG79zBEbhmaqqTZjn0H/NMiZrRdkmjufm4uzwc7ZOPPDD3vmqnJaWYY/"
    "05gjMkTU1v53heos7U2cUDcPd492pIxshRzwOQ4LijLPwfCNBrS/ElnyQozGjkWGA1mU"
    "afruwTsWjakrr01NDv9i4asx+qTiWgaXSYCYXYiygAnTjXhhnfCanbc0686mDd0vG03G"
    "RW3jQO+CrXf2jI99f3nBmWyuz7I5x6zCTmWeH3W9c6F96QCsb8PX5bRzWdj5yODiv/3l"
    "12t3f/vdpaL25KYl2kzBdJ/avPzw5St29tKs1UX/NKRZgUz5WKqAmJZRY3lSwuU5kPGX"
    "3NBAk6E5S7qaxx6/77oXdv5m7e4j49OmZet5ZfSV1fHCgk4j4jrNy5clo9mpQmbPJ5M/"
    "OX3W7ClXKjHKQthXzVP1/VSjq+1To2VBB9yNRRVzWU/riZGBRcc47SdOzlrRq5ty9qVJ"
    "+9/xF2r5iWCRCAAAAABJRU5ErkJggg==";

}  // namespace

AurenNewTabUI::AurenNewTabUI(content::WebUI* web_ui)
    : content::WebUIController(web_ui) {
  auto* source = content::WebUIDataSource::CreateAndAdd(
      Profile::FromWebUI(web_ui), "newtab");

  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::StyleSrc,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;");
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::ScriptSrc,
      "script-src 'self' 'unsafe-inline' https://unpkg.com;");
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::FontSrc,
      "font-src 'self' https://fonts.gstatic.com;");
  source->DisableTrustedTypesCSP();

  source->SetRequestFilter(
      base::BindRepeating([](const std::string&) { return true; }),
      base::BindRepeating([](const std::string& path,
                             content::WebUIDataSource::GotDataCallback cb) {
        if (path == "favicon.png") {
          std::string decoded;
          base::Base64Decode(kFaviconPngBase64, &decoded);
          std::move(cb).Run(
              base::MakeRefCounted<base::RefCountedString>(std::move(decoded)));
        } else {
          std::move(cb).Run(
              base::MakeRefCounted<base::RefCountedString>(kAurenNewTabHtml));
        }
      }));

  web_ui->AddMessageHandler(std::make_unique<AurenSecurityHandler>());
}

AurenNewTabUI::~AurenNewTabUI() = default;
