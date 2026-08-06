/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_BROWSER_UI_WEBUI_AUREN_NEW_TAB_UI_H_
#define BRAVE_BROWSER_UI_WEBUI_AUREN_NEW_TAB_UI_H_

#include "content/public/browser/web_ui_controller.h"

// Minimal new tab page for Auren. Replaces the Brave NTP with a clean dark
// page until a full custom NTP is built.
class AurenNewTabUI : public content::WebUIController {
 public:
  explicit AurenNewTabUI(content::WebUI* web_ui);
  ~AurenNewTabUI() override;

  AurenNewTabUI(const AurenNewTabUI&) = delete;
  AurenNewTabUI& operator=(const AurenNewTabUI&) = delete;
};

#endif  // BRAVE_BROWSER_UI_WEBUI_AUREN_NEW_TAB_UI_H_
