/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/ui/webui/auren_new_tab_ui.h"

#include <memory>
#include <string>

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
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<script src="https://unpkg.com/lucide@latest"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body {
    background: #0e0e0e;
    font-family: -apple-system, system-ui, sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .wordmark {
    font-size: 40px;
    font-weight: 700;
    letter-spacing: 0.35em;
    color: #c9a84c;
    user-select: none;
  }
</style>
</head>
<body>
  <div class="wordmark">AUREN</div>

  <div id="security-bar" style="margin-top:32px;display:flex;align-items:flex-start;justify-content:center;gap:20px;white-space:nowrap;font-family:'SF Mono','Consolas',monospace;border:1px solid #c9a84c;border-radius:2px;padding:24px 32px">

    <!-- Toggle controls: Tor, DNS, JS -->
    <div style="display:flex;align-items:flex-start;gap:20px;flex-shrink:0">

      <!-- Tor toggle -->
      <button id="btn-tor" style="display:flex;flex-direction:column;align-items:center;gap:5px;background:none;border:none;cursor:pointer;padding:0;font-family:'SF Mono','Consolas',monospace">
        <span style="display:flex;align-items:center;gap:6px">
          <span id="icon-tor" style="display:inline-flex;align-items:center;color:#c9a84c"><i data-lucide="route" style="width:14px;height:14px"></i></span>
          <span style="font-size:11px;color:#5a5a5a;letter-spacing:0.08em;text-transform:uppercase">Tor</span>
          <span id="val-tor" style="font-size:13px;color:#c9a84c;font-weight:500">DE</span>
        </span>
        <span id="track-tor" style="width:20px;height:11px;border-radius:9999px;position:relative;background:#c9a84c;display:block;transition:background 150ms cubic-bezier(0.4,0,0.2,1)">
          <span id="thumb-tor" style="position:absolute;top:1.5px;left:11px;width:8px;height:8px;border-radius:9999px;background:#ddc06a;transition:left 150ms cubic-bezier(0.4,0,0.2,1)"></span>
        </span>
      </button>

      <!-- DNS toggle -->
      <button id="btn-dns" style="display:flex;flex-direction:column;align-items:center;gap:5px;background:none;border:none;cursor:pointer;padding:0;font-family:'SF Mono','Consolas',monospace">
        <span style="display:flex;align-items:center;gap:6px">
          <span id="icon-dns" style="display:inline-flex;align-items:center;color:#c9a84c"><i data-lucide="server" style="width:14px;height:14px"></i></span>
          <span style="font-size:11px;color:#5a5a5a;letter-spacing:0.08em;text-transform:uppercase">DNS</span>
          <span id="val-dns" style="font-size:13px;color:#c9a84c;font-weight:500">On</span>
        </span>
        <span id="track-dns" style="width:20px;height:11px;border-radius:9999px;position:relative;background:#c9a84c;display:block;transition:background 150ms cubic-bezier(0.4,0,0.2,1)">
          <span id="thumb-dns" style="position:absolute;top:1.5px;left:11px;width:8px;height:8px;border-radius:9999px;background:#ddc06a;transition:left 150ms cubic-bezier(0.4,0,0.2,1)"></span>
        </span>
      </button>

      <!-- JS toggle -->
      <button id="btn-js" style="display:flex;flex-direction:column;align-items:center;gap:5px;background:none;border:none;cursor:pointer;padding:0;font-family:'SF Mono','Consolas',monospace">
        <span style="display:flex;align-items:center;gap:6px">
          <span id="icon-js" style="display:inline-flex;align-items:center;color:#c9a84c"><i data-lucide="braces" style="width:14px;height:14px"></i></span>
          <span style="font-size:11px;color:#5a5a5a;letter-spacing:0.08em;text-transform:uppercase">JS</span>
          <span id="val-js" style="font-size:13px;color:#c9a84c;font-weight:500">On</span>
        </span>
        <span id="track-js" style="width:20px;height:11px;border-radius:9999px;position:relative;background:#c9a84c;display:block;transition:background 150ms cubic-bezier(0.4,0,0.2,1)">
          <span id="thumb-js" style="position:absolute;top:1.5px;left:11px;width:8px;height:8px;border-radius:9999px;background:#ddc06a;transition:left 150ms cubic-bezier(0.4,0,0.2,1)"></span>
        </span>
      </button>
    </div>

    <!-- Vertical divider -->
    <div style="width:1px;height:22px;background:#2a2a2a;flex-shrink:0"></div>

    <!-- Passive indicators: Fingerprint, HTTPS, Cookies -->
    <div style="display:flex;align-items:center;gap:20px;flex-shrink:0;padding-top:2px">

      <div style="display:flex;align-items:center;gap:6px">
        <span id="icon-fingerprint" style="display:inline-flex;align-items:center;color:#c9a84c"><i data-lucide="fingerprint" style="width:16px;height:16px"></i></span>
        <span style="font-size:11px;color:#5a5a5a;letter-spacing:0.08em;text-transform:uppercase">Fingerprint</span>
        <span id="val-fingerprint" style="font-size:15px;color:#c9a84c;font-weight:600">94/100</span>
      </div>

      <div style="display:flex;align-items:center;gap:6px">
        <span id="icon-https" style="display:inline-flex;align-items:center;color:#c9a84c"><i data-lucide="lock" style="width:14px;height:14px"></i></span>
        <span style="font-size:11px;color:#5a5a5a;letter-spacing:0.08em;text-transform:uppercase">HTTPS</span>
        <span id="val-https" style="font-size:13px;color:#c9a84c;font-weight:500">Enforced</span>
      </div>

      <div style="display:flex;align-items:center;gap:6px">
        <span id="icon-cookies" style="display:inline-flex;align-items:center;color:#c9a84c"><i data-lucide="cookie" style="width:14px;height:14px"></i></span>
        <span style="font-size:11px;color:#5a5a5a;letter-spacing:0.08em;text-transform:uppercase">Cookies</span>
        <span id="val-cookies" style="font-size:13px;color:#c9a84c;font-weight:500">Isolated</span>
      </div>
    </div>
  </div>

  <script>
    var GOLD = '#c9a84c';
    var DANGER = '#c0392b';
    var TRACK_ON = '#c9a84c';
    var TRACK_OFF = '#5a5a5a';
    var THUMB_ON = '#ddc06a';
    var THUMB_OFF = '#3a3a3a';

    var state = {
      tor:             { active: true, exitCountry: 'DE' },
      dns:             { active: true },
      js:              { active: true },
      fingerprintScore: 94,
      httpsEnforced:   true,
      cookiesIsolated: true
    };

    function applyToggle(prefix, active, label) {
      var c = active ? GOLD : DANGER;
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

      var fpC = state.fingerprintScore >= 80 ? GOLD : DANGER;
      document.getElementById('icon-fingerprint').style.color = fpC;
      var fpEl = document.getElementById('val-fingerprint');
      fpEl.textContent = state.fingerprintScore + '/100';
      fpEl.style.color = fpC;

      var httpsC = state.httpsEnforced ? GOLD : DANGER;
      document.getElementById('icon-https').style.color = httpsC;
      var httpsEl = document.getElementById('val-https');
      httpsEl.textContent = state.httpsEnforced ? 'Enforced' : 'Not enforced';
      httpsEl.style.color = httpsC;

      var cookieC = state.cookiesIsolated ? GOLD : DANGER;
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

constexpr char kFaviconSvg[] =
    R"(<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">)"
    R"(<rect width="100" height="100" fill="#0e0e0e"/>)"
    R"(<text x="50" y="72" font-size="80" text-anchor="middle" )"
    R"(fill="#c9a84c" font-family="serif">A</text></svg>)";

}  // namespace

AurenNewTabUI::AurenNewTabUI(content::WebUI* web_ui)
    : content::WebUIController(web_ui) {
  auto* source = content::WebUIDataSource::CreateAndAdd(
      Profile::FromWebUI(web_ui), "newtab");

  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::StyleSrc,
      "style-src 'self' 'unsafe-inline';");
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::ScriptSrc,
      "script-src 'self' 'unsafe-inline' https://unpkg.com;");
  source->DisableTrustedTypesCSP();

  source->SetRequestFilter(
      base::BindRepeating([](const std::string&) { return true; }),
      base::BindRepeating([](const std::string& path,
                             content::WebUIDataSource::GotDataCallback cb) {
        if (path == "favicon.svg") {
          std::move(cb).Run(
              base::MakeRefCounted<base::RefCountedString>(kFaviconSvg));
        } else {
          std::move(cb).Run(
              base::MakeRefCounted<base::RefCountedString>(kAurenNewTabHtml));
        }
      }));

  web_ui->AddMessageHandler(std::make_unique<AurenSecurityHandler>());
}

AurenNewTabUI::~AurenNewTabUI() = default;
