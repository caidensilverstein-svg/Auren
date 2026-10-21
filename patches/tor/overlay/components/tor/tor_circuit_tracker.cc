/* Copyright (c) 2026 The Auren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "brave/components/tor/tor_circuit_tracker.h"

#include <algorithm>
#include <utility>

#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "brave/components/tor/tor_control.h"
#include "brave/components/tor/tor_control_event.h"
#include "net/base/ip_address.h"

namespace tor {

namespace {

constexpr size_t kMaxHistory = 50;
constexpr size_t kMaxRelayCache = 2000;
constexpr size_t kMaxTargetsPerCircuit = 6;
constexpr base::TimeDelta kRefreshDebounce = base::Milliseconds(400);

// A relay fingerprint is 40 hex digits. Anything else is never put in a
// control command.
bool IsFingerprint(const std::string& s) {
  return s.size() == 40 && std::ranges::all_of(s, [](char c) {
           return base::IsHexDigit(c);
         });
}

// Parses one "$FINGERPRINT~nickname" hop (also "=" for named relays).
bool ParseHop(const std::string& hop, TorRelayInfo* out) {
  if (hop.size() < 41 || hop[0] != '$') {
    return false;
  }
  std::string fp = base::ToUpperASCII(hop.substr(1, 40));
  if (!IsFingerprint(fp)) {
    return false;
  }
  out->fingerprint = fp;
  if (hop.size() > 42 && (hop[41] == '~' || hop[41] == '=')) {
    out->nickname = hop.substr(42);
  }
  return true;
}

std::vector<std::string> Tokens(const std::string& line) {
  return base::SplitString(line, " ", base::TRIM_WHITESPACE,
                           base::SPLIT_WANT_NONEMPTY);
}

// Strips a trailing ":port" from a stream target; keeps bracketed IPv6.
std::string HostOfTarget(const std::string& target) {
  if (!target.empty() && target[0] == '[') {
    const size_t end = target.find(']');
    return end == std::string::npos ? target : target.substr(0, end + 1);
  }
  const size_t colon = target.rfind(':');
  return colon == std::string::npos ? target : target.substr(0, colon);
}

}  // namespace

TorRelayInfo::TorRelayInfo() = default;
TorRelayInfo::TorRelayInfo(const TorRelayInfo&) = default;
TorRelayInfo& TorRelayInfo::operator=(const TorRelayInfo&) = default;
TorRelayInfo::~TorRelayInfo() = default;

TorCircuitInfo::TorCircuitInfo() = default;
TorCircuitInfo::TorCircuitInfo(const TorCircuitInfo&) = default;
TorCircuitInfo& TorCircuitInfo::operator=(const TorCircuitInfo&) = default;
TorCircuitInfo::~TorCircuitInfo() = default;

TorPathChange::TorPathChange() = default;
TorPathChange::TorPathChange(const TorPathChange&) = default;
TorPathChange& TorPathChange::operator=(const TorPathChange&) = default;
TorPathChange::~TorPathChange() = default;

TorCircuitSnapshot::TorCircuitSnapshot() = default;
TorCircuitSnapshot::TorCircuitSnapshot(const TorCircuitSnapshot&) = default;
TorCircuitSnapshot& TorCircuitSnapshot::operator=(
    const TorCircuitSnapshot&) = default;
TorCircuitSnapshot::~TorCircuitSnapshot() = default;

TorCircuitTracker::ParsedCircuit::ParsedCircuit() = default;
TorCircuitTracker::ParsedCircuit::ParsedCircuit(const ParsedCircuit&) = default;
TorCircuitTracker::ParsedCircuit::~ParsedCircuit() = default;

TorCircuitTracker::TorCircuitTracker() = default;

TorCircuitTracker::~TorCircuitTracker() = default;

// static
bool TorCircuitTracker::ParseCircuitLine(const std::string& line,
                                         ParsedCircuit* out) {
  // "<id> <status> [<$fp~nick,$fp~nick,...>] KEY=VALUE ..."
  const std::vector<std::string> tokens = Tokens(line);
  if (tokens.size() < 2 || tokens[0].find('=') != std::string::npos) {
    return false;
  }
  ParsedCircuit parsed;
  parsed.id = tokens[0];
  parsed.status = tokens[1];
  size_t i = 2;
  if (i < tokens.size() && !tokens[i].empty() && tokens[i][0] == '$') {
    for (const std::string& hop_str : base::SplitString(
             tokens[i], ",", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
      TorRelayInfo relay;
      if (!ParseHop(hop_str, &relay)) {
        return false;
      }
      parsed.path.push_back(std::move(relay));
    }
    ++i;
  }
  for (; i < tokens.size(); ++i) {
    const size_t eq = tokens[i].find('=');
    if (eq == std::string::npos) {
      continue;
    }
    const std::string key = tokens[i].substr(0, eq);
    const std::string value = tokens[i].substr(eq + 1);
    if (key == "PURPOSE") {
      parsed.purpose = value;
    } else if (key == "BUILD_FLAGS") {
      parsed.build_flags = value;
    }
  }
  *out = std::move(parsed);
  return true;
}

// static
bool TorCircuitTracker::ParseStreamLine(const std::string& line,
                                        std::string* circuit_id,
                                        std::string* target) {
  // "<id> <status> <circuit id> <target> ..."
  const std::vector<std::string> tokens = Tokens(line);
  if (tokens.size() < 4 || tokens[2] == "0") {
    return false;
  }
  if (tokens[1] != "SUCCEEDED" && tokens[1] != "SENTCONNECT" &&
      tokens[1] != "SENTRESOLVE" && tokens[1] != "NEW") {
    return false;
  }
  *circuit_id = tokens[2];
  *target = HostOfTarget(tokens[3]);
  return !target->empty();
}

// static
bool TorCircuitTracker::ParseRouterLine(const std::string& line,
                                        std::string* ip,
                                        uint16_t* or_port) {
  // "r <nick> <id> <digest> <date> <time> <ip> <orport> <dirport>"
  const std::vector<std::string> tokens = Tokens(line);
  if (tokens.size() < 8 || tokens[0] != "r") {
    return false;
  }
  net::IPAddress address;
  if (!address.AssignFromIPLiteral(tokens[6])) {
    return false;
  }
  unsigned port = 0;
  if (!base::StringToUint(tokens[7], &port) || port > 65535) {
    return false;
  }
  *ip = tokens[6];
  *or_port = static_cast<uint16_t>(port);
  return true;
}

void TorCircuitTracker::Start(TorControl* control) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  control_ = control;
  snapshot_.running = true;
  ScheduleRefresh();
  Notify();
}

void TorCircuitTracker::Stop() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  debounce_.Stop();
  control_ = nullptr;
  refresh_in_flight_ = false;
  refresh_again_ = false;
  resolving_ = false;
  resolve_queue_.clear();
  parsed_.clear();
  targets_by_circuit_.clear();
  snapshot_.running = false;
  snapshot_.circuits.clear();
  // The path history is kept for the session so users can still see where
  // they exited before Tor was stopped. It is never persisted.
  Notify();
}

void TorCircuitTracker::OnTorEvent(TorControlEvent event) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (event == TorControlEvent::CIRC || event == TorControlEvent::STREAM ||
      event == TorControlEvent::GUARD) {
    ScheduleRefresh();
  }
}

void TorCircuitTracker::NewIdentity() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (!control_) {
    return;
  }
  control_->RunCommand("SIGNAL NEWNYM", base::DoNothing());
  ScheduleRefresh();
}

void TorCircuitTracker::AddObserver(Observer* observer) {
  observers_.AddObserver(observer);
}

void TorCircuitTracker::RemoveObserver(Observer* observer) {
  observers_.RemoveObserver(observer);
}

void TorCircuitTracker::ScheduleRefresh() {
  if (!control_ || debounce_.IsRunning()) {
    return;
  }
  debounce_.Start(FROM_HERE, kRefreshDebounce,
                  base::BindOnce(&TorCircuitTracker::Refresh,
                                 weak_ptr_factory_.GetWeakPtr()));
}

void TorCircuitTracker::Refresh() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (!control_) {
    return;
  }
  if (refresh_in_flight_) {
    refresh_again_ = true;
    return;
  }
  refresh_in_flight_ = true;
  control_->RunCommand("GETINFO circuit-status",
                       base::BindOnce(&TorCircuitTracker::OnCircuitStatus,
                                      weak_ptr_factory_.GetWeakPtr()));
}

void TorCircuitTracker::OnCircuitStatus(bool error,
                                        std::vector<std::string> lines) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (error || !control_) {
    refresh_in_flight_ = false;
    return;
  }
  parsed_.clear();
  for (const std::string& line : lines) {
    ParsedCircuit parsed;
    if (ParseCircuitLine(line, &parsed)) {
      parsed_.push_back(std::move(parsed));
    }
  }
  control_->RunCommand("GETINFO stream-status",
                       base::BindOnce(&TorCircuitTracker::OnStreamStatus,
                                      weak_ptr_factory_.GetWeakPtr()));
}

void TorCircuitTracker::OnStreamStatus(bool error,
                                       std::vector<std::string> lines) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  refresh_in_flight_ = false;
  if (error || !control_) {
    return;
  }
  targets_by_circuit_.clear();
  for (const std::string& line : lines) {
    std::string circuit_id;
    std::string target;
    if (!ParseStreamLine(line, &circuit_id, &target)) {
      continue;
    }
    std::vector<std::string>& targets = targets_by_circuit_[circuit_id];
    if (targets.size() < kMaxTargetsPerCircuit &&
        std::ranges::find(targets, target) == targets.end()) {
      targets.push_back(target);
    }
  }

  // Queue every relay on a displayed circuit that has not been looked up yet.
  if (relay_cache_.size() > kMaxRelayCache) {
    relay_cache_.clear();
  }
  for (const ParsedCircuit& circuit : parsed_) {
    for (const TorRelayInfo& relay : circuit.path) {
      if (relay_cache_.emplace(relay.fingerprint, relay).second) {
        resolve_queue_.push_back(relay.fingerprint);
      }
    }
  }
  Rebuild();
  Notify();
  ResolveNext();

  if (refresh_again_) {
    refresh_again_ = false;
    ScheduleRefresh();
  }
}

void TorCircuitTracker::ResolveNext() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (resolving_ || resolve_queue_.empty() || !control_) {
    return;
  }
  resolving_ = true;
  const std::string fingerprint = resolve_queue_.front();
  control_->RunCommand("GETINFO ns/id/" + fingerprint,
                       base::BindOnce(&TorCircuitTracker::OnRouterStatus,
                                      weak_ptr_factory_.GetWeakPtr(),
                                      fingerprint));
}

void TorCircuitTracker::OnRouterStatus(std::string fingerprint,
                                       bool error,
                                       std::vector<std::string> lines) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  std::string ip;
  uint16_t or_port = 0;
  if (!error && control_) {
    for (const std::string& line : lines) {
      if (ParseRouterLine(line, &ip, &or_port)) {
        break;
      }
      ip.clear();
    }
  }
  if (ip.empty()) {
    // Not in the consensus (anymore); leave the placeholder and move on.
    if (!resolve_queue_.empty()) {
      resolve_queue_.pop_front();
    }
    resolving_ = false;
    ResolveNext();
    return;
  }
  TorRelayInfo& relay = relay_cache_[fingerprint];
  relay.ip = ip;
  relay.or_port = or_port;
  control_->RunCommand("GETINFO ip-to-country/" + ip,
                       base::BindOnce(&TorCircuitTracker::OnCountry,
                                      weak_ptr_factory_.GetWeakPtr(),
                                      fingerprint));
}

void TorCircuitTracker::OnCountry(std::string fingerprint,
                                  bool error,
                                  std::vector<std::string> lines) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (!error) {
    for (const std::string& line : lines) {
      const size_t eq = line.find('=');
      if (line.starts_with("ip-to-country/") && eq != std::string::npos) {
        const std::string country = base::ToLowerASCII(line.substr(eq + 1));
        if (country.size() == 2 && country != "??") {
          relay_cache_[fingerprint].country = country;
        }
        break;
      }
    }
  }
  if (!resolve_queue_.empty()) {
    resolve_queue_.pop_front();
  }
  resolving_ = false;
  Rebuild();
  Notify();
  ResolveNext();
}

void TorCircuitTracker::Rebuild() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  auto fill = [this](TorRelayInfo* relay) {
    auto it = relay_cache_.find(relay->fingerprint);
    if (it != relay_cache_.end()) {
      if (relay->nickname.empty()) {
        relay->nickname = it->second.nickname;
      }
      relay->ip = it->second.ip;
      relay->or_port = it->second.or_port;
      relay->country = it->second.country;
    }
  };

  std::vector<TorCircuitInfo> circuits;
  for (const ParsedCircuit& parsed : parsed_) {
    // Only circuits that can carry the browser's traffic: built, a general or
    // conflux purpose, not internal / one-hop directory tunnels.
    if (parsed.status != "BUILT" ||
        (parsed.purpose != "GENERAL" && parsed.purpose != "CONFLUX_LINKED") ||
        parsed.build_flags.find("IS_INTERNAL") != std::string::npos ||
        parsed.build_flags.find("ONEHOP_TUNNEL") != std::string::npos ||
        parsed.path.size() < 2) {
      continue;
    }
    TorCircuitInfo info;
    info.id = parsed.id;
    info.purpose = parsed.purpose;
    info.hops = parsed.path;
    for (TorRelayInfo& hop : info.hops) {
      fill(&hop);
    }
    auto targets = targets_by_circuit_.find(parsed.id);
    if (targets != targets_by_circuit_.end()) {
      info.targets = targets->second;
    }
    circuits.push_back(std::move(info));
  }
  // Circuits that are carrying streams first.
  std::stable_sort(circuits.begin(), circuits.end(),
                   [](const TorCircuitInfo& a, const TorCircuitInfo& b) {
                     return a.targets.size() > b.targets.size();
                   });
  snapshot_.circuits = std::move(circuits);

  // Remember each change of the (guard, exit) pair that is carrying traffic,
  // i.e. the "IP jumps". Idle pre-built circuits are only used when nothing
  // is carrying a stream yet.
  std::vector<std::string> keys;
  const TorCircuitInfo* first = nullptr;
  for (const TorCircuitInfo& c : snapshot_.circuits) {
    if (c.hops.empty() || (!snapshot_.circuits.front().targets.empty() &&
                           c.targets.empty())) {
      continue;
    }
    if (!first) {
      first = &c;
    }
    keys.push_back(c.hops.front().fingerprint + ">" +
                   c.hops.back().fingerprint);
  }
  std::ranges::sort(keys);
  std::string key = base::JoinString(keys, "|");
  if (first && !key.empty() && key != last_path_key_) {
    last_path_key_ = key;
    TorPathChange change;
    change.when = base::Time::Now();
    change.guard = first->hops.front();
    change.exit = first->hops.back();
    snapshot_.history.insert(snapshot_.history.begin(), std::move(change));
    if (snapshot_.history.size() > kMaxHistory) {
      snapshot_.history.resize(kMaxHistory);
    }
  }
  // Addresses resolve after the path was first seen; keep history in sync.
  for (TorPathChange& change : snapshot_.history) {
    if (change.exit.ip.empty()) {
      fill(&change.exit);
    }
    if (change.guard.ip.empty()) {
      fill(&change.guard);
    }
  }
}

void TorCircuitTracker::Notify() {
  for (Observer& observer : observers_) {
    observer.OnTorCircuitsChanged();
  }
}

}  // namespace tor
