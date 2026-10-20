/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/ui/webui/auren/auren_security_handler.h"

#include <utility>

#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/task/task_traits.h"
#include "base/task/thread_pool.h"
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
#include "chrome/common/pref_names.h"
#include "base/feature_list.h"
#include "components/content_settings/core/browser/cookie_settings.h"
#include "components/prefs/pref_service.h"
#include "content/public/browser/web_ui.h"
#include "net/dns/public/secure_dns_mode.h"
#include "third_party/blink/public/common/features.h"
#include "url/gurl.h"

#if BUILDFLAG(ENABLE_TOR)
#include "brave/components/tor/tor_launcher_factory.h"
#endif

namespace {

// Written by `node scripts/fingerprint-audit/run.js --write-profile-report <profile>`
// (or by the agent via the injected self-test). Absent file == "not measured".
constexpr base::FilePath::CharType kAuditFileName[] =
    FILE_PATH_LITERAL("auren-fingerprint-audit.json");

std::optional<base::DictValue> ReadAuditSummary(base::FilePath path) {
  std::string json;
  if (!base::ReadFileToString(path, &json) || json.size() > 256 * 1024) {
    return std::nullopt;
  }
  return base::JSONReader::ReadDict(json);
}

}  // namespace

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

  // Fingerprinting: a checklist of protections that can be verified from live
  // browser state. This is NOT a measure of how unique the browser is.
  int32_t fp_active = 0;
  int32_t fp_total = 0;
  std::string fp_missing;
  auto check = [&](bool ok, const char* name) {
    ++fp_total;
    if (ok) {
      ++fp_active;
    } else {
      if (!fp_missing.empty()) {
        fp_missing += ", ";
      }
      fp_missing += name;
    }
  };
  // 1. Shields fingerprinting protection on by default (farbling + uniform
  //    values of docs/privacy/fingerprinting/policy.md).
  check(brave_shields::GetFingerprintingControlType(map, empty) !=
            brave_shields::ALLOW,
        "Shields fingerprinting protection");
  // 2. Accept-Language / navigator.languages reduction.
  check(brave_shields::IsReduceLanguageEnabledForProfile(profile_->GetPrefs()),
        "language reduction");
  // 3. Screen / window size protection (screen.*, outer*, device-width).
  check(base::FeatureList::IsEnabled(
            blink::features::kBraveBlockScreenFingerprinting),
        "screen size protection");
  // 4. WebRTC must not expose local/public interface IPs.
  const std::string webrtc_policy =
      profile_->GetPrefs()->GetString(prefs::kWebRTCIPHandlingPolicy);
  check(webrtc_policy == "disable_non_proxied_udp" ||
            webrtc_policy == "default_public_interface_only",
        "WebRTC IP handling");

  const bool cookies_isolated =
      brave_shields::GetCookieControlType(
          map, CookieSettingsFactory::GetForProfile(profile_).get(), empty) !=
      brave_shields::ALLOW;

  auto state = auren::mojom::SecurityState::New();
  state->js_enabled = js_enabled;
  state->https_enforced = https_enforced;
  state->cookies_isolated = cookies_isolated;
  state->fingerprint_protections_active = fp_active;
  state->fingerprint_protections_total = fp_total;
  state->fingerprint_protections_missing = fp_missing;

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
  dict.Set("fp_active", s->fingerprint_protections_active);
  dict.Set("fp_total", s->fingerprint_protections_total);
  dict.Set("fp_missing", s->fingerprint_protections_missing);
  dict.Set("tor_active", s->tor_active);
  dict.Set("tor_exit_country", s->tor_exit_country);
  dict.Set("dns_active", s->dns_active);
  CallJavascriptFunction("onSecurityState", base::Value(std::move(dict)));

  // The measured audit result (if any) arrives separately.
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&ReadAuditSummary, profile_->GetPath().Append(kAuditFileName)),
      base::BindOnce(&AurenSecurityHandler::OnFingerprintAuditRead,
                     weak_factory_.GetWeakPtr()));
}

void AurenSecurityHandler::OnFingerprintAuditRead(
    std::optional<base::DictValue> summary) {
  if (!IsJavascriptAllowed()) {
    return;
  }
  base::DictValue out;
  out.Set("measured", summary.has_value());
  if (summary) {
    // Only forward the fields the page renders; never echo arbitrary file
    // content into the WebUI.
    if (const std::string* v = summary->FindString("date")) out.Set("date", *v);
    if (const std::string* v = summary->FindString("policy")) out.Set("policy", *v);
    if (const std::string* v = summary->FindString("browser")) out.Set("browser", *v);
    if (std::optional<int> v = summary->FindInt("fail")) out.Set("fail", *v);
    if (std::optional<int> v = summary->FindInt("warn")) out.Set("warn", *v);
    if (std::optional<int> v = summary->FindInt("pass")) out.Set("pass", *v);
  }
  CallJavascriptFunction("onFingerprintAudit", base::Value(std::move(out)));
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
