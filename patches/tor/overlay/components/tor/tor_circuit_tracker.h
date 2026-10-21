/* Copyright (c) 2026 The Auren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_COMPONENTS_TOR_TOR_CIRCUIT_TRACKER_H_
#define BRAVE_COMPONENTS_TOR_TOR_CIRCUIT_TRACKER_H_

#include <cstdint>
#include <deque>
#include <map>
#include <string>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/observer_list.h"
#include "base/observer_list_types.h"
#include "base/sequence_checker.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "brave/components/tor/tor_control_event.h"

namespace tor {

class TorControl;

// One relay on a circuit. |ip| / |country| stay empty until resolved; the
// country comes from tor's own bundled GeoIP file (no external lookup).
struct TorRelayInfo {
  TorRelayInfo();
  TorRelayInfo(const TorRelayInfo&);
  TorRelayInfo& operator=(const TorRelayInfo&);
  ~TorRelayInfo();

  std::string fingerprint;  // 40 upper-case hex characters.
  std::string nickname;
  std::string ip;
  uint16_t or_port = 0;
  std::string country;  // Lower-case ISO 3166 code, or empty.
};

struct TorCircuitInfo {
  TorCircuitInfo();
  TorCircuitInfo(const TorCircuitInfo&);
  TorCircuitInfo& operator=(const TorCircuitInfo&);
  ~TorCircuitInfo();

  std::string id;
  std::string purpose;
  // Guard first, exit last.
  std::vector<TorRelayInfo> hops;
  // Destinations of streams currently attached to this circuit.
  std::vector<std::string> targets;
};

// A change of the (guard, exit) pair used for general traffic. Held in memory
// only; never written to disk.
struct TorPathChange {
  TorPathChange();
  TorPathChange(const TorPathChange&);
  TorPathChange& operator=(const TorPathChange&);
  ~TorPathChange();

  base::Time when;
  TorRelayInfo guard;
  TorRelayInfo exit;
};

struct TorCircuitSnapshot {
  TorCircuitSnapshot();
  TorCircuitSnapshot(const TorCircuitSnapshot&);
  TorCircuitSnapshot& operator=(const TorCircuitSnapshot&);
  ~TorCircuitSnapshot();

  bool running = false;
  // Circuits carrying traffic now; when none is, the last circuit that did
  // (marked by having no targets), or else the next spare one.
  std::vector<TorCircuitInfo> circuits;
  // Built general circuits that are not shown (tor keeps spares ready).
  int spare_count = 0;
  // Newest first.
  std::vector<TorPathChange> history;
};

// Follows the tor client's circuits through the control port and keeps a
// snapshot of which relays (guard / middle / exit) the browser's traffic
// currently uses. Everything is local: relay addresses come from the tor
// consensus the client already downloaded and countries from its GeoIP file.
class TorCircuitTracker {
 public:
  // Not a CheckedObserver: implementers (the chrome://tor-circuit handler)
  // also observe the launcher factory, and two CheckedObserver bases are
  // ambiguous. Observers must remove themselves before destruction.
  class Observer {
   public:
    virtual ~Observer() = default;
    virtual void OnTorCircuitsChanged() {}
  };

  TorCircuitTracker();
  TorCircuitTracker(const TorCircuitTracker&) = delete;
  TorCircuitTracker& operator=(const TorCircuitTracker&) = delete;
  ~TorCircuitTracker();

  // |control| must outlive the tracker's running period (until Stop()).
  void Start(TorControl* control);
  void Stop();

  // Called for CIRC / STREAM / GUARD events from the control port.
  void OnTorEvent(TorControlEvent event);

  // Asks tor for fresh circuits for every site (SIGNAL NEWNYM).
  void NewIdentity();

  const TorCircuitSnapshot& snapshot() const { return snapshot_; }

  void AddObserver(Observer* observer);
  void RemoveObserver(Observer* observer);

  // Exposed for unit tests.
  struct ParsedCircuit {
    ParsedCircuit();
    ParsedCircuit(const ParsedCircuit&);
    ~ParsedCircuit();
    std::string id;
    std::string status;
    std::string purpose;
    std::string build_flags;
    std::vector<TorRelayInfo> path;
  };
  static bool ParseCircuitLine(const std::string& line, ParsedCircuit* out);
  static bool ParseStreamLine(const std::string& line,
                              std::string* circuit_id,
                              std::string* target);
  static bool ParseRouterLine(const std::string& line,
                              std::string* ip,
                              uint16_t* or_port);

 private:
  void ScheduleRefresh();
  void Refresh();
  void OnCircuitStatus(bool error, std::vector<std::string> lines);
  void OnStreamStatus(bool error, std::vector<std::string> lines);
  void ResolveNext();
  void OnRouterStatus(std::string fingerprint,
                      bool error,
                      std::vector<std::string> lines);
  void OnCountry(std::string fingerprint,
                 bool error,
                 std::vector<std::string> lines);
  void Rebuild();
  void Notify();

  SEQUENCE_CHECKER(sequence_checker_);

  raw_ptr<TorControl> control_ = nullptr;
  bool refresh_in_flight_ = false;
  bool refresh_again_ = false;
  base::OneShotTimer debounce_;

  std::vector<ParsedCircuit> parsed_;
  std::map<std::string, std::vector<std::string>> targets_by_circuit_;
  std::map<std::string, TorRelayInfo> relay_cache_;
  std::deque<std::string> resolve_queue_;
  bool resolving_ = false;

  TorCircuitSnapshot snapshot_;
  std::string last_path_key_;
  bool has_last_used_ = false;
  TorCircuitInfo last_used_;

  base::ObserverList<Observer>::Unchecked observers_;
  base::WeakPtrFactory<TorCircuitTracker> weak_ptr_factory_{this};
};

}  // namespace tor

#endif  // BRAVE_COMPONENTS_TOR_TOR_CIRCUIT_TRACKER_H_
