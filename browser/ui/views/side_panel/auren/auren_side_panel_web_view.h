/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_BROWSER_UI_VIEWS_SIDE_PANEL_AUREN_AUREN_SIDE_PANEL_WEB_VIEW_H_
#define BRAVE_BROWSER_UI_VIEWS_SIDE_PANEL_AUREN_AUREN_SIDE_PANEL_WEB_VIEW_H_

#include <memory>

#include "ui/base/accelerators/accelerator.h"
#include "ui/views/controls/webview/webview.h"

class Profile;

namespace content {
class WebContents;
}  // namespace content

// Permanent side panel view that loads claude.ai in an owned WebContents.
// Follows the AIChatMovableSidePanelWebView pattern: plain views::WebView
// owning its WebContents directly, no WebUI registration needed.
class AurenSidePanelWebView : public views::WebView {
  METADATA_HEADER(AurenSidePanelWebView, views::WebView)

 public:
  explicit AurenSidePanelWebView(Profile* profile);
  ~AurenSidePanelWebView() override;

  AurenSidePanelWebView(const AurenSidePanelWebView&) = delete;
  AurenSidePanelWebView& operator=(const AurenSidePanelWebView&) = delete;

  bool AcceleratorPressed(const ui::Accelerator& accelerator) override;

 private:
  void LoadClaudeAI();

  std::unique_ptr<content::WebContents> owned_web_contents_;
};

#endif  // BRAVE_BROWSER_UI_VIEWS_SIDE_PANEL_AUREN_AUREN_SIDE_PANEL_WEB_VIEW_H_
