/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/ui/views/side_panel/auren/auren_side_panel_web_view.h"

#include "brave/browser/brave_shields/brave_shields_settings_service_factory.h"
#include "brave/components/brave_shields/core/browser/brave_shields_settings_service.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/common/user_agent/user_agent_metadata.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/page_transition_types.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/geometry/size.h"
#include "ui/views/focus/focus_manager.h"
#include "url/gurl.h"

namespace {
constexpr char kClaudeAIURL[] = "https://claude.ai";
constexpr char kChromeUserAgent[] =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36";
}  // namespace

BEGIN_METADATA(AurenSidePanelWebView)
END_METADATA

AurenSidePanelWebView::AurenSidePanelWebView(Profile* profile)
    : views::WebView(profile) {
  SetPreferredSize(gfx::Size(380, 0));
  AddAccelerator(ui::Accelerator(ui::VKEY_V, ui::EF_COMMAND_DOWN));
  AddAccelerator(ui::Accelerator(ui::VKEY_C, ui::EF_COMMAND_DOWN));
  AddAccelerator(ui::Accelerator(ui::VKEY_X, ui::EF_COMMAND_DOWN));
  AddAccelerator(ui::Accelerator(ui::VKEY_A, ui::EF_COMMAND_DOWN));
  LoadClaudeAI();
}

bool AurenSidePanelWebView::AcceleratorPressed(
    const ui::Accelerator& accelerator) {
  // Only handle the accelerator when focus is within this panel.
  views::FocusManager* fm = GetFocusManager();
  if (!fm || !Contains(fm->GetFocusedView())) {
    return false;
  }

  if (!owned_web_contents_) {
    return false;
  }

  if (accelerator.modifiers() != ui::EF_COMMAND_DOWN) {
    return false;
  }

  switch (accelerator.key_code()) {
    case ui::VKEY_V:
      owned_web_contents_->Paste();
      return true;
    case ui::VKEY_C:
      owned_web_contents_->Copy();
      return true;
    case ui::VKEY_X:
      owned_web_contents_->Cut();
      return true;
    case ui::VKEY_A:
      owned_web_contents_->SelectAll();
      return true;
    default:
      break;
  }
  return views::WebView::AcceleratorPressed(accelerator);
}

AurenSidePanelWebView::~AurenSidePanelWebView() = default;

void AurenSidePanelWebView::LoadClaudeAI() {
  // Exempt claude.ai from Brave Shields so auth cookies and login flows are
  // not blocked by ad/tracker blocking or fingerprint protection.
  Profile* profile = Profile::FromBrowserContext(GetBrowserContext());
  if (auto* shields =
          BraveShieldsSettingsServiceFactory::GetForProfile(profile)) {
    shields->SetBraveShieldsEnabled(false, GURL(kClaudeAIURL));
  }

  content::WebContents::CreateParams params(GetBrowserContext());
  owned_web_contents_ = content::WebContents::Create(params);
  SetWebContents(owned_web_contents_.get());

  blink::UserAgentOverride ua_override;
  ua_override.ua_string_override = kChromeUserAgent;
  owned_web_contents_->SetUserAgentOverride(ua_override, false);

  content::NavigationController::LoadURLParams load_params{GURL(kClaudeAIURL)};
  load_params.transition_type = ui::PAGE_TRANSITION_AUTO_TOPLEVEL;
  load_params.override_user_agent =
      content::NavigationController::UA_OVERRIDE_TRUE;
  owned_web_contents_->GetController().LoadURLWithParams(load_params);
}
