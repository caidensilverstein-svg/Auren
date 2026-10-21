/* Copyright (c) 2026 The Auren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "brave/browser/ui/webui/auren/auren_tor_ui.h"

#include <memory>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/memory/ref_counted_memory.h"
#include "base/time/time.h"
#include "brave/browser/ui/browser_commands.h"
#include "brave/components/tor/tor_launcher_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "services/network/public/mojom/content_security_policy.mojom-shared.h"

namespace {

// Everything below the <script> only ever writes relay-controlled strings
// (nicknames) with textContent, never innerHTML.
constexpr char kAurenTorHtml[] = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tor circuit</title>
<style>
  :root {
    --bg: #0a0a0f; --surface: #111118; --elevated: #1a1a24; --border: #25252f;
    --text: #e8e8e6; --muted: #8a8a99; --accent: #c9a84c; --accent-hover: #d9bd6a;
    --danger: #c0392b;
    --mono: ui-monospace, "SF Mono", Menlo, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--sans); }
  main { max-width: 1040px; margin: 0 auto; padding: 32px 24px 64px; }
  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
  h1 { font-size: 22px; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); margin: 0; font-weight: 600; }
  .pill { font: 12px var(--mono); padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .pill.on { color: var(--accent); border-color: var(--accent); }
  .pill.err { color: var(--danger); border-color: var(--danger); }
  .spacer { flex: 1; }
  button { font: 13px var(--sans); color: var(--text); background: var(--elevated); border: 1px solid var(--border);
           border-radius: 8px; padding: 7px 14px; cursor: pointer; }
  button:hover { border-color: var(--accent); color: var(--accent-hover); }
  button.primary { background: var(--accent); color: #111; border-color: var(--accent); font-weight: 600; }
  button.primary:hover { background: var(--accent-hover); color: #111; }
  p.sub { color: var(--muted); margin: 4px 0 24px; max-width: 70ch; }
  section { margin-top: 28px; }
  h2 { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); font-weight: 500; margin: 0 0 12px; }
  .circuit { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
  .path { display: flex; align-items: stretch; gap: 0; flex-wrap: wrap; }
  .node { flex: 1 1 150px; min-width: 150px; background: var(--elevated); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .node.you, .node.site { flex: 0 1 120px; min-width: 100px; display: flex; flex-direction: column; justify-content: center; }
  .node.guard { border-color: #4a4330; } .node.exit { border-color: var(--accent); }
  .arrow { align-self: center; color: var(--muted); padding: 0 8px; font-family: var(--mono); }
  .role { font: 11px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
  .node.exit .role, .node.guard .role { color: var(--accent); }
  .nick { font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; }
  .ip { font: 12px var(--mono); color: var(--text); margin-top: 2px; overflow-wrap: anywhere; }
  .meta { font: 11px var(--mono); color: var(--muted); margin-top: 2px; }
  .targets { margin-top: 10px; font: 12px var(--mono); color: var(--muted); overflow-wrap: anywhere; }
  .targets b { color: var(--text); font-weight: 500; }
  table { width: 100%; border-collapse: collapse; font: 12px var(--mono); }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  .empty { color: var(--muted); padding: 16px; border: 1px dashed var(--border); border-radius: 12px; }
  footer { margin-top: 36px; color: var(--muted); font-size: 12px; max-width: 80ch; }
</style></head>
<body><main>
  <header>
    <h1>Tor circuit</h1>
    <span id="pill" class="pill">Tor not running</span>
    <span class="spacer"></span>
    <button id="btn-window" class="primary">Open Tor window</button>
    <button id="btn-new">New circuits</button>
  </header>
  <p class="sub" id="sub">Where your Tor traffic goes right now: your guard, the middle relay(s) and the exit that websites see.</p>

  <section>
    <h2>Current path</h2>
    <div id="circuits"></div>
  </section>

  <section>
    <h2>IP jumps this session</h2>
    <div id="history"></div>
  </section>

  <footer>
    Relay addresses come from the consensus your own Tor client downloaded and
    countries from its local GeoIP file. This page makes no network requests, and the
    history is kept in memory only: it is gone when you quit Auren.
  </footer>
</main>
<script>
(function () {
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function flag(cc) {
    if (!cc || cc.length !== 2) return '';
    var a = cc.toLowerCase().charCodeAt(0) - 97, b = cc.toLowerCase().charCodeAt(1) - 97;
    if (a < 0 || a > 25 || b < 0 || b > 25) return '';
    return String.fromCodePoint(0x1F1E6 + a, 0x1F1E6 + b);
  }
  function where(r) { return r.country ? flag(r.country) + ' ' + r.country.toUpperCase() : 'country unknown'; }
  function addr(r) { return r.ip ? (r.ip.indexOf(':') >= 0 ? '[' + r.ip + ']' : r.ip) + (r.port ? ':' + r.port : '') : 'address resolving…'; }

  function relayNode(r) {
    var n = el('div', 'node ' + r.role);
    n.appendChild(el('div', 'role', r.role));
    n.appendChild(el('div', 'nick', r.nickname || 'unnamed relay'));
    n.appendChild(el('div', 'ip', addr(r)));
    n.appendChild(el('div', 'meta', where(r)));
    n.appendChild(el('div', 'meta', r.fingerprint ? r.fingerprint.slice(0, 8) + '…' : ''));
    return n;
  }
  function plain(cls, label, sub) {
    var n = el('div', 'node ' + cls);
    n.appendChild(el('div', 'role', label));
    if (sub) n.appendChild(el('div', 'meta', sub));
    return n;
  }
  function arrow() { return el('div', 'arrow', '→'); }

  function renderCircuits(list, running) {
    var host = document.getElementById('circuits');
    host.textContent = '';
    if (!list.length) {
      host.appendChild(el('div', 'empty', running
          ? 'No circuit carrying traffic yet. Open a Tor window and visit a site.'
          : 'Tor is not running. Open a Tor window to start it.'));
      return;
    }
    list.forEach(function (c) {
      var box = el('div', 'circuit');
      var path = el('div', 'path');
      path.appendChild(plain('you', 'You', 'this device'));
      c.hops.forEach(function (h) { path.appendChild(arrow()); path.appendChild(relayNode(h)); });
      path.appendChild(arrow());
      path.appendChild(plain('site', 'Website', c.targets.length ? c.targets.length + ' open' : 'idle'));
      box.appendChild(path);
      if (c.targets.length) {
        var t = el('div', 'targets');
        t.appendChild(document.createTextNode('carrying: '));
        c.targets.forEach(function (x, i) {
          if (i) t.appendChild(document.createTextNode(', '));
          t.appendChild(el('b', '', x));
        });
        box.appendChild(t);
      }
      host.appendChild(box);
    });
  }

  function renderHistory(list) {
    var host = document.getElementById('history');
    host.textContent = '';
    if (!list.length) {
      host.appendChild(el('div', 'empty', 'Nothing yet. A new line appears each time your exit changes.'));
      return;
    }
    var t = el('table');
    var head = el('tr');
    ['Time', 'Exit IP', 'Exit country', 'Exit relay', 'Guard IP'].forEach(function (h) { head.appendChild(el('th', '', h)); });
    t.appendChild(head);
    list.forEach(function (c) {
      var tr = el('tr');
      tr.appendChild(el('td', '', new Date(c.time_ms).toLocaleTimeString()));
      tr.appendChild(el('td', '', c.exit.ip || '…'));
      tr.appendChild(el('td', '', where(c.exit)));
      tr.appendChild(el('td', '', c.exit.nickname || ''));
      tr.appendChild(el('td', '', c.guard.ip || '…'));
      t.appendChild(tr);
    });
    host.appendChild(t);
  }

  window.onTorState = function (s) {
    var pill = document.getElementById('pill');
    pill.className = 'pill';
    if (s.connected) { pill.textContent = 'Connected' + (s.version ? ' · Tor ' + s.version : ''); pill.classList.add('on'); }
    else if (s.running && s.bootstrap_percent) { pill.textContent = 'Connecting… ' + s.bootstrap_percent + '%'; }
    else if (s.running) { pill.textContent = 'Starting…'; }
    else { pill.textContent = 'Tor not running'; }
    renderCircuits(s.circuits || [], !!s.running);
    renderHistory(s.history || []);
  };

  document.getElementById('btn-window').addEventListener('click', function () { chrome.send('openTorWindow'); });
  document.getElementById('btn-new').addEventListener('click', function () { chrome.send('newTorIdentity'); });
  chrome.send('getTorState');
})();
</script></body></html>
)HTML";

base::DictValue RelayToDict(const tor::TorRelayInfo& relay,
                            const char* role) {
  base::DictValue dict;
  dict.Set("role", role);
  dict.Set("nickname", relay.nickname);
  dict.Set("fingerprint", relay.fingerprint);
  dict.Set("ip", relay.ip);
  dict.Set("port", static_cast<int>(relay.or_port));
  dict.Set("country", relay.country);
  return dict;
}

}  // namespace

AurenTorUI::AurenTorUI(content::WebUI* web_ui)
    : content::WebUIController(web_ui) {
  auto* source = content::WebUIDataSource::CreateAndAdd(
      Profile::FromWebUI(web_ui), "tor-circuit");
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::StyleSrc,
      "style-src 'self' 'unsafe-inline';");
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::ScriptSrc,
      "script-src 'self' 'unsafe-inline';");
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::FontSrc, "font-src 'none';");
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::ImgSrc, "img-src 'none';");
  // The page never fetches anything; all data arrives through chrome.send.
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::ConnectSrc, "connect-src 'none';");
  source->DisableTrustedTypesCSP();
  source->SetRequestFilter(
      base::BindRepeating([](const std::string&) { return true; }),
      base::BindRepeating([](const std::string&,
                             content::WebUIDataSource::GotDataCallback cb) {
        std::move(cb).Run(
            base::MakeRefCounted<base::RefCountedString>(kAurenTorHtml));
      }));
  web_ui->AddMessageHandler(std::make_unique<AurenTorHandler>());
}

AurenTorUI::~AurenTorUI() = default;

AurenTorHandler::AurenTorHandler() = default;

AurenTorHandler::~AurenTorHandler() {
  OnJavascriptDisallowed();
}

void AurenTorHandler::RegisterMessages() {
  web_ui()->RegisterMessageCallback(
      "getTorState", base::BindRepeating(&AurenTorHandler::HandleGetTorState,
                                         base::Unretained(this)));
  web_ui()->RegisterMessageCallback(
      "newTorIdentity",
      base::BindRepeating(&AurenTorHandler::HandleNewIdentity,
                          base::Unretained(this)));
  web_ui()->RegisterMessageCallback(
      "openTorWindow",
      base::BindRepeating(&AurenTorHandler::HandleOpenTorWindow,
                          base::Unretained(this)));
}

void AurenTorHandler::OnJavascriptDisallowed() {
  if (!observing_) {
    return;
  }
  observing_ = false;
  auto* factory = tor::TorLauncherFactory::GetInstance();
  factory->GetCircuitTracker()->RemoveObserver(this);
  factory->RemoveObserver(this);
}

void AurenTorHandler::HandleGetTorState(const base::ListValue& args) {
  AllowJavascript();
  if (!observing_) {
    observing_ = true;
    auto* factory = tor::TorLauncherFactory::GetInstance();
    factory->GetCircuitTracker()->AddObserver(this);
    factory->AddObserver(this);
  }
  PushState();
}

void AurenTorHandler::HandleNewIdentity(const base::ListValue& args) {
  tor::TorLauncherFactory::GetInstance()->GetCircuitTracker()->NewIdentity();
}

void AurenTorHandler::HandleOpenTorWindow(const base::ListValue& args) {
  brave::NewOffTheRecordWindowTor(
      Profile::FromWebUI(web_ui())->GetOriginalProfile());
}

void AurenTorHandler::OnTorCircuitsChanged() {
  PushState();
}

void AurenTorHandler::OnTorInitializing(const std::string& percentage,
                                        const std::string& summary) {
  bootstrap_percent_ = percentage;
  bootstrap_summary_ = summary;
  PushState();
}

void AurenTorHandler::OnTorCircuitEstablished(bool result) {
  PushState();
}

void AurenTorHandler::OnTorLaunched(bool result, int64_t pid) {
  PushState();
}

base::DictValue AurenTorHandler::BuildState() const {
  auto* factory = tor::TorLauncherFactory::GetInstance();
  const tor::TorCircuitSnapshot& snapshot =
      factory->GetCircuitTracker()->snapshot();

  base::DictValue state;
  state.Set("running", snapshot.running || factory->GetTorPid() >= 0);
  state.Set("connected", factory->IsTorConnected());
  state.Set("version", factory->GetTorVersion());
  state.Set("bootstrap_percent", bootstrap_percent_);
  state.Set("bootstrap_summary", bootstrap_summary_);

  base::ListValue circuits;
  for (const tor::TorCircuitInfo& circuit : snapshot.circuits) {
    base::DictValue c;
    c.Set("id", circuit.id);
    c.Set("purpose", circuit.purpose);
    base::ListValue hops;
    for (size_t i = 0; i < circuit.hops.size(); ++i) {
      const char* role = i == 0 ? "guard"
                         : i + 1 == circuit.hops.size() ? "exit"
                                                        : "middle";
      hops.Append(RelayToDict(circuit.hops[i], role));
    }
    c.Set("hops", std::move(hops));
    base::ListValue targets;
    for (const std::string& target : circuit.targets) {
      targets.Append(target);
    }
    c.Set("targets", std::move(targets));
    circuits.Append(std::move(c));
  }
  state.Set("circuits", std::move(circuits));

  base::ListValue history;
  for (const tor::TorPathChange& change : snapshot.history) {
    base::DictValue h;
    h.Set("time_ms", change.when.InMillisecondsFSinceUnixEpoch());
    h.Set("guard", RelayToDict(change.guard, "guard"));
    h.Set("exit", RelayToDict(change.exit, "exit"));
    history.Append(std::move(h));
  }
  state.Set("history", std::move(history));
  return state;
}

void AurenTorHandler::PushState() {
  if (!IsJavascriptAllowed()) {
    return;
  }
  CallJavascriptFunction("onTorState", base::Value(BuildState()));
}
