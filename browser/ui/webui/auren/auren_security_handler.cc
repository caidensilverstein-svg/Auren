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
#include "brave/components/tor/buildflags/buildflags.h"
#include "chrome/browser/content_settings/cookie_settings_factory.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "chrome/browser/net/secure_dns_config.h"
#include "chrome/browser/net/stub_resolver_config_reader.h"
#include "chrome/browser/net/system_network_context_manager.h"
#include "chrome/browser/profiles/profile.h"
#include "components/content_settings/core/browser/cookie_settings.h"
#include "content/public/browser/web_ui.h"
#include "net/dns/public/secure_dns_mode.h"
#include "url/gurl.h"

#if BUILDFLAG(ENABLE_TOR)
#include "brave/components/tor/tor_launcher_factory.h"
#endif

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

#if BUILDFLAG(ENABLE_TOR)
  // AurenNewTabUI (the only place this handler is attached) is never
  // constructed for a Tor profile - see the DCHECK in
  // brave_web_ui_controller_factory.cc - so profile_->IsTor() here would
  // always be false, i.e. exactly the hardcoded stub this replaces. The
  // meaningful live signal from a regular-window NTP is whether the Tor
  // client itself currently has a circuit established, which answers
  // "is Tor available to route a private window right now" and is a
  // process-wide signal, not tied to this profile.
  state->tor_active = TorLauncherFactory::GetInstance()->IsTorConnected();
#else
  state->tor_active = false;
#endif
  // No clean synchronous API exposes the current Tor circuit's exit country
  // (that lives in Arti's circuit state, not TorProfileService); leave
  // unset rather than guessing.
  state->tor_exit_country = "";

  // DNS is considered "active" (DoH engaged) when the resolver mode is
  // anything other than the plain system resolver.
  SecureDnsConfig dns_config =
      SystemNetworkContextManager::GetStubResolverConfigReader()
          ->GetSecureDnsConfiguration(/*force_check_parental_controls_for_automatic_mode=*/false);
  state->dns_active = dns_config.mode() != net::SecureDnsMode::kOff;

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
