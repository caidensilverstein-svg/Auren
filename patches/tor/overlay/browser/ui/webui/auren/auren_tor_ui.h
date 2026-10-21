/* Copyright (c) 2026 The Auren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_BROWSER_UI_WEBUI_AUREN_AUREN_TOR_UI_H_
#define BRAVE_BROWSER_UI_WEBUI_AUREN_AUREN_TOR_UI_H_

#include <string>

#include "base/memory/raw_ptr.h"
#include "base/values.h"
#include "brave/components/tor/tor_circuit_tracker.h"
#include "brave/components/tor/tor_launcher_observer.h"
#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/web_ui_message_handler.h"

// chrome://tor-circuit : shows the user which relays (guard, middle, exit)
// their Tor traffic goes through right now, their IP addresses and countries,
// and a session-only history of exit changes ("IP jumps").
class AurenTorUI : public content::WebUIController {
 public:
  explicit AurenTorUI(content::WebUI* web_ui);
  ~AurenTorUI() override;

  AurenTorUI(const AurenTorUI&) = delete;
  AurenTorUI& operator=(const AurenTorUI&) = delete;
};

class AurenTorHandler : public content::WebUIMessageHandler,
                        public tor::TorCircuitTracker::Observer,
                        public TorLauncherObserver {
 public:
  AurenTorHandler();
  ~AurenTorHandler() override;

  AurenTorHandler(const AurenTorHandler&) = delete;
  AurenTorHandler& operator=(const AurenTorHandler&) = delete;

  // content::WebUIMessageHandler:
  void RegisterMessages() override;
  void OnJavascriptDisallowed() override;

  // tor::TorCircuitTracker::Observer:
  void OnTorCircuitsChanged() override;

  // TorLauncherObserver:
  void OnTorInitializing(const std::string& percentage,
                         const std::string& summary) override;
  void OnTorCircuitEstablished(bool result) override;
  void OnTorLaunched(bool result, int64_t pid) override;

 private:
  void HandleGetTorState(const base::ListValue& args);
  void HandleNewIdentity(const base::ListValue& args);
  void HandleOpenTorWindow(const base::ListValue& args);

  base::DictValue BuildState() const;
  void PushState();

  std::string bootstrap_percent_;
  std::string bootstrap_summary_;
  bool observing_ = false;
};

#endif  // BRAVE_BROWSER_UI_WEBUI_AUREN_AUREN_TOR_UI_H_
