/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/ui/webui/auren/auren_security_handler.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/values.h"
#include "brave/components/brave_shields/core/browser/brave_shields_utils.h"
#include "brave/components/brave_shields/core/common/brave_shields_settings_values.h"
#include "chrome/browser/content_settings/cookie_settings_factory.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "components/content_settings/core/browser/cookie_settings.h"
#include "content/public/browser/web_ui.h"
#include "url/gurl.h"

AurenSecurityHandler::AurenSecurityHandler() = default;
AurenSecurityHandler::~AurenSecurityHandler() = default;

void AurenSecurityHandler::RegisterMessages() {
  profile_ = Profile::FromWebUI(web_ui());
  web_ui()->RegisterMessageCallback(
      "getSecurityState",
      base::BindRepeating(&AurenSecurityHandler::HandleGetSecurityState,
                          base::Unretained(this)));
  web_ui()->RegisterMessageCallback(
      "setJsEnabled",
      base::BindRepeating(&AurenSecurityHandler::HandleSetJsEnabled,
                          base::Unretained(this)));
  web_ui()->RegisterMessageCallback(
      "setHttpsOnly",
      base::BindRepeating(&AurenSecurityHandler::HandleSetHttpsOnly,
                          base::Unretained(this)));
}

auren::mojom::SecurityStatePtr AurenSecurityHandler::BuildSecurityState()
    const {
  auto* map = HostContentSettingsMapFactory::GetForProfile(profile_);
  const GURL empty;

  const bool js_enabled =
      brave_shields::GetNoScriptControlType(map, empty) ==
      brave_shields::ALLOW;
  const bool https_enforced =
      brave_shields::GetHttpsUpgradeControlType(map, empty) ==
      brave_shields::BLOCK;

  const brave_shields::ControlType fp =
      brave_shields::GetFingerprintingControlType(map, empty);
  const int32_t fp_score =
      (fp == brave_shields::BLOCK)
          ? 100
          : (fp == brave_shields::BLOCK_THIRD_PARTY) ? 66 : 0;

  const bool cookies_isolated =
      brave_shields::GetCookieControlType(
          map, CookieSettingsFactory::GetForProfile(profile_).get(), empty) !=
      brave_shields::ALLOW;

  auto state = auren::mojom::SecurityState::New();
  state->js_enabled = js_enabled;
  state->https_enforced = https_enforced;
  state->cookies_isolated = cookies_isolated;
  state->fingerprint_score = fp_score;
  state->tor_active = false;        // TODO: wire to Arti when implemented
  state->tor_exit_country = "";     // TODO: wire to Arti when implemented
  state->dns_active = false;        // TODO: wire to WireGuard DNS config
  return state;
}

void AurenSecurityHandler::GetSecurityState(GetSecurityStateCallback callback) {
  std::move(callback).Run(BuildSecurityState());
}

void AurenSecurityHandler::SetJavaScriptEnabled(bool enabled) {
  auto* map = HostContentSettingsMapFactory::GetForProfile(profile_);
  brave_shields::SetNoScriptControlType(
      map, enabled ? brave_shields::ALLOW : brave_shields::BLOCK, GURL());
}

void AurenSecurityHandler::SetHttpsOnlyMode(bool enabled) {
  auto* map = HostContentSettingsMapFactory::GetForProfile(profile_);
  brave_shields::SetHttpsUpgradeControlType(
      map, enabled ? brave_shields::BLOCK : brave_shields::ALLOW, GURL());
}

void AurenSecurityHandler::HandleGetSecurityState(
    const base::ListValue& args) {
  AllowJavascript();
  auto s = BuildSecurityState();
  base::DictValue dict;
  dict.Set("js_enabled", s->js_enabled);
  dict.Set("https_enforced", s->https_enforced);
  dict.Set("cookies_isolated", s->cookies_isolated);
  dict.Set("fingerprint_score", s->fingerprint_score);
  dict.Set("tor_active", s->tor_active);
  dict.Set("tor_exit_country", s->tor_exit_country);
  dict.Set("dns_active", s->dns_active);
  CallJavascriptFunction("onSecurityState", base::Value(std::move(dict)));
}

void AurenSecurityHandler::HandleSetJsEnabled(const base::ListValue& args) {
  if (args.size() > 0 && args[0].is_bool()) {
    SetJavaScriptEnabled(args[0].GetBool());
  }
}

void AurenSecurityHandler::HandleSetHttpsOnly(const base::ListValue& args) {
  if (args.size() > 0 && args[0].is_bool()) {
    SetHttpsOnlyMode(args[0].GetBool());
  }
}
