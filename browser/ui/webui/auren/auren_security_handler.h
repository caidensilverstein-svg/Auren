/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_BROWSER_UI_WEBUI_AUREN_AUREN_SECURITY_HANDLER_H_
#define BRAVE_BROWSER_UI_WEBUI_AUREN_AUREN_SECURITY_HANDLER_H_

#include "base/memory/raw_ptr.h"
#include "base/values.h"
#include "brave/browser/ui/webui/auren/auren_security_handler.mojom.h"
#include "content/public/browser/web_ui_message_handler.h"
#include "mojo/public/cpp/bindings/receiver.h"

class Profile;

// WebUI message handler for the Auren NTP security bar. Implements the
// AurenSecurityHandler Mojo interface as the C++ contract; JS communicates
// via chrome.send() / CallJavascriptFunction since the embedded HTML page
// cannot load generated Mojo JS bindings.
class AurenSecurityHandler
    : public content::WebUIMessageHandler,
      public auren::mojom::AurenSecurityHandler {
 public:
  AurenSecurityHandler();
  ~AurenSecurityHandler() override;

  AurenSecurityHandler(const AurenSecurityHandler&) = delete;
  AurenSecurityHandler& operator=(const AurenSecurityHandler&) = delete;

  // content::WebUIMessageHandler:
  void RegisterMessages() override;

  // auren::mojom::AurenSecurityHandler:
  void GetSecurityState(GetSecurityStateCallback callback) override;
  void SetJavaScriptEnabled(bool enabled) override;
  void SetHttpsOnlyMode(bool enabled) override;

 private:
  auren::mojom::SecurityStatePtr BuildSecurityState() const;

  void HandleGetSecurityState(const base::ListValue& args);
  void HandleSetJsEnabled(const base::ListValue& args);
  void HandleSetHttpsOnly(const base::ListValue& args);

  raw_ptr<Profile> profile_ = nullptr;
  mojo::Receiver<auren::mojom::AurenSecurityHandler> receiver_{this};
};

#endif  // BRAVE_BROWSER_UI_WEBUI_AUREN_AUREN_SECURITY_HANDLER_H_
