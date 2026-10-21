// Host-only tests of the tracker's state machine against a scripted fake control port.
// (The parser tests live in patches/tor/overlay/components/tor/tor_circuit_tracker_unittest.cc
// and are also run here.)
#include <map>
#include <string>
#include <vector>

#include "base/timer/timer.h"
#include "brave/components/tor/tor_circuit_tracker.h"
#include "brave/components/tor/tor_control.h"
#include "gtest/gtest.h"

namespace tor {
namespace {

const char kG[] = "616C915B1EA788FA1177EF6194608C0E13B28A96";
const char kM[] = "B83DC1558F0D34353BB992EF93AFEAFDB226A73E";
const char kE[] = "F614B0185A2FB9C75B5B8B5666F819A846EDE661";
const char kE2[] = "D1D9999F87D1A11363708CD643A61915689A0CA0";

std::string Hop(const char* fp, const char* nick) { return std::string("$") + fp + "~" + nick; }

struct Fixture {
  TorControl control;
  TorCircuitTracker tracker;
  std::vector<std::string> circuits;  // lines for GETINFO circuit-status
  std::vector<std::string> streams;
  std::map<std::string, std::string> router_ip;  // fingerprint -> ip (missing => unknown)
  std::map<std::string, std::string> country;    // ip -> cc
  int notifications = 0;

  struct Obs : TorCircuitTracker::Observer {
    int* n; explicit Obs(int* n) : n(n) {}
    void OnTorCircuitsChanged() override { ++*n; }
  } obs{&notifications};

  Fixture() {
    tracker.AddObserver(&obs);
    control.responder = [this](const std::string& cmd) -> std::pair<bool, std::vector<std::string>> {
      if (cmd == "GETINFO circuit-status") return {false, circuits};
      if (cmd == "GETINFO stream-status") return {false, streams};
      const std::string ns = "GETINFO ns/id/";
      if (cmd.rfind(ns, 0) == 0) {
        auto it = router_ip.find(cmd.substr(ns.size()));
        if (it == router_ip.end()) return {true, {}};
        return {false, {"r nick id dg 2038-01-01 00:00:00 " + it->second + " 9001 0", "s Fast Running"}};
      }
      const std::string ic = "GETINFO ip-to-country/";
      if (cmd.rfind(ic, 0) == 0) {
        std::string ip = cmd.substr(ic.size());
        return {false, {"ip-to-country/" + ip + "=" + (country.count(ip) ? country[ip] : "??")}};
      }
      return {true, {}};
    };
    tracker.Start(&control);
  }
  ~Fixture() { tracker.RemoveObserver(&obs); }

  // One full refresh: debounce fires, commands are answered until quiet.
  void Refresh() {
    tracker.OnTorEvent(TorControlEvent::CIRC);
    base::OneShotTimer::FireAll();
    control.Pump();
    // A refresh requested while one was in flight is rescheduled.
    base::OneShotTimer::FireAll();
    control.Pump();
  }
};

TEST(TorCircuitTrackerState, IdleSparesAreCollapsedAndNeverEnterHistory) {
  Fixture f;
  f.router_ip = {{kG, "10.0.0.1"}, {kM, "10.0.0.2"}, {kE, "10.0.0.3"}};
  f.country = {{"10.0.0.1", "DE"}, {"10.0.0.3", "NO"}};
  for (int i = 2; i <= 6; ++i) {
    f.circuits.push_back(std::to_string(i) + " BUILT " + Hop(kG, "g") + "," + Hop(kM, "m") + "," +
                         Hop(kE, "e") + " BUILD_FLAGS=NEED_CAPACITY PURPOSE=GENERAL");
  }
  f.Refresh();
  const auto& s = f.tracker.snapshot();
  EXPECT_TRUE(s.running);
  ASSERT_EQ(1u, s.circuits.size());
  EXPECT_EQ(4, s.spare_count);
  EXPECT_TRUE(s.history.empty());
  EXPECT_EQ("10.0.0.1", s.circuits[0].hops[0].ip);
  EXPECT_EQ("de", s.circuits[0].hops[0].country);
  EXPECT_EQ("no", s.circuits[0].hops[2].country);
  EXPECT_EQ("", s.circuits[0].hops[1].country);  // ?? is not a country
  EXPECT_EQ(9001, s.circuits[0].hops[2].or_port);
}

TEST(TorCircuitTrackerState, InternalOneHopAndNonGeneralCircuitsAreHidden) {
  Fixture f;
  f.router_ip = {{kG, "10.0.0.1"}, {kM, "10.0.0.2"}, {kE, "10.0.0.3"}};
  f.circuits = {
      "1 BUILT " + Hop(kG, "g") + " BUILD_FLAGS=ONEHOP_TUNNEL,IS_INTERNAL PURPOSE=GENERAL",
      "2 BUILT " + Hop(kG, "g") + "," + Hop(kM, "m") + " BUILD_FLAGS=IS_INTERNAL PURPOSE=GENERAL",
      "3 BUILT " + Hop(kG, "g") + "," + Hop(kM, "m") + "," + Hop(kE, "e") + " PURPOSE=HS_CLIENT_REND",
      "4 EXTENDED " + Hop(kG, "g") + "," + Hop(kM, "m") + " PURPOSE=GENERAL",
  };
  f.Refresh();
  EXPECT_TRUE(f.tracker.snapshot().circuits.empty());
  EXPECT_EQ(0, f.tracker.snapshot().spare_count);
}

TEST(TorCircuitTrackerState, ActiveCircuitShownWithSitesAndIpJumpsRecorded) {
  Fixture f;
  f.router_ip = {{kG, "10.0.0.1"}, {kM, "10.0.0.2"}, {kE, "10.0.0.3"}, {kE2, "10.0.0.9"}};
  f.country = {{"10.0.0.3", "NO"}, {"10.0.0.9", "NL"}};
  f.circuits = {"6 BUILT " + Hop(kG, "g") + "," + Hop(kM, "m") + "," + Hop(kE, "e") + " PURPOSE=GENERAL",
                "7 BUILT " + Hop(kG, "g") + "," + Hop(kM, "m") + "," + Hop(kE, "e") + " PURPOSE=GENERAL"};
  f.streams = {"12 SUCCEEDED 6 example.com:443 PURPOSE=USER", "13 SUCCEEDED 6 example.org:443",
               "14 SUCCEEDED 6 example.com:80"};
  f.Refresh();
  {
    const auto& s = f.tracker.snapshot();
    ASSERT_EQ(1u, s.circuits.size());
    EXPECT_EQ("6", s.circuits[0].id);
    EXPECT_EQ((std::vector<std::string>{"example.com", "example.org"}), s.circuits[0].targets);
    EXPECT_EQ(1, s.spare_count);
    ASSERT_EQ(1u, s.history.size());
    EXPECT_EQ(kE, s.history[0].exit.fingerprint);
    EXPECT_EQ("10.0.0.3", s.history[0].exit.ip);
    EXPECT_EQ("no", s.history[0].exit.country);
    EXPECT_EQ(kG, s.history[0].guard.fingerprint);
  }
  // Same path again: no new history row.
  f.Refresh();
  EXPECT_EQ(1u, f.tracker.snapshot().history.size());

  // New identity: a different exit carries the stream -> second row, newest first.
  f.circuits = {"8 BUILT " + Hop(kG, "g") + "," + Hop(kM, "m") + "," + Hop(kE2, "e2") + " PURPOSE=GENERAL"};
  f.streams = {"20 SUCCEEDED 8 example.com:443"};
  f.tracker.NewIdentity();
  EXPECT_EQ("SIGNAL NEWNYM", f.control.sent.back());
  f.Refresh();
  const auto& s = f.tracker.snapshot();
  ASSERT_EQ(2u, s.history.size());
  EXPECT_EQ(kE2, s.history[0].exit.fingerprint);
  EXPECT_EQ("nl", s.history[0].exit.country);
  EXPECT_EQ(kE, s.history[1].exit.fingerprint);
}

TEST(TorCircuitTrackerState, LastUsedCircuitStaysVisibleWhenTrafficStops) {
  Fixture f;
  f.router_ip = {{kG, "10.0.0.1"}, {kM, "10.0.0.2"}, {kE, "10.0.0.3"}, {kE2, "10.0.0.9"}};
  f.circuits = {"5 BUILT " + Hop(kG, "g") + "," + Hop(kM, "m") + "," + Hop(kE2, "e2") + " PURPOSE=GENERAL",
                "6 BUILT " + Hop(kG, "g") + "," + Hop(kM, "m") + "," + Hop(kE, "e") + " PURPOSE=GENERAL"};
  f.streams = {"12 SUCCEEDED 6 example.com:443"};
  f.Refresh();
  f.streams.clear();
  f.Refresh();
  const auto& s = f.tracker.snapshot();
  ASSERT_EQ(1u, s.circuits.size());
  EXPECT_EQ("6", s.circuits[0].id);   // not the first spare (5)
  EXPECT_TRUE(s.circuits[0].targets.empty());
  EXPECT_EQ(1u, s.history.size());    // going idle is not a jump
}

TEST(TorCircuitTrackerState, UnresolvedRelayIsRetriedOnTheNextRefresh) {
  Fixture f;
  f.circuits = {"6 BUILT " + Hop(kG, "g") + "," + Hop(kM, "m") + "," + Hop(kE, "e") + " PURPOSE=GENERAL"};
  f.streams = {"12 SUCCEEDED 6 example.com:443"};
  f.Refresh();  // consensus not loaded: ns/id answers with an error
  EXPECT_EQ("", f.tracker.snapshot().circuits[0].hops[0].ip);
  f.router_ip = {{kG, "10.0.0.1"}, {kM, "10.0.0.2"}, {kE, "10.0.0.3"}};
  f.country = {{"10.0.0.3", "SE"}};
  f.Refresh();
  const auto& s = f.tracker.snapshot();
  EXPECT_EQ("10.0.0.3", s.circuits[0].hops[2].ip);
  EXPECT_EQ("se", s.circuits[0].hops[2].country);
  // The history row, created before the address was known, is filled in.
  ASSERT_EQ(1u, s.history.size());
  EXPECT_EQ("10.0.0.3", s.history[0].exit.ip);
}

TEST(TorCircuitTrackerState, StopClearsCircuitsButKeepsSessionHistory) {
  Fixture f;
  f.router_ip = {{kG, "10.0.0.1"}, {kM, "10.0.0.2"}, {kE, "10.0.0.3"}};
  f.circuits = {"6 BUILT " + Hop(kG, "g") + "," + Hop(kM, "m") + "," + Hop(kE, "e") + " PURPOSE=GENERAL"};
  f.streams = {"12 SUCCEEDED 6 example.com:443"};
  f.Refresh();
  f.tracker.Stop();
  const auto& s = f.tracker.snapshot();
  EXPECT_FALSE(s.running);
  EXPECT_TRUE(s.circuits.empty());
  EXPECT_EQ(1u, s.history.size());
  // Events after Stop are ignored and send nothing.
  size_t before = f.control.sent.size();
  f.tracker.OnTorEvent(TorControlEvent::CIRC);
  f.tracker.NewIdentity();
  base::OneShotTimer::FireAll();
  EXPECT_EQ(before, f.control.sent.size());
}

TEST(TorCircuitTrackerState, HistoryIsBounded) {
  Fixture f;
  f.router_ip = {{kG, "10.0.0.1"}, {kM, "10.0.0.2"}};
  // 60 distinct exits, built from 60 distinct fake fingerprints.
  for (int i = 0; i < 60; ++i) {
    char fp[41]; snprintf(fp, sizeof fp, "%040X", 0xA000 + i);
    f.router_ip[fp] = "10.1.0." + std::to_string(i + 1);
    f.circuits = {std::to_string(100 + i) + " BUILT " + Hop(kG, "g") + "," + Hop(kM, "m") + "," + Hop(fp, "x") + " PURPOSE=GENERAL"};
    f.streams = {"1 SUCCEEDED " + std::to_string(100 + i) + " example.com:443"};
    f.Refresh();
  }
  EXPECT_EQ(50u, f.tracker.snapshot().history.size());
}

TEST(TorCircuitTrackerState, DestroyedTrackerIgnoresLateReplies) {
  auto control = std::make_unique<TorControl>();
  control->responder = [](const std::string&) { return std::make_pair(false, std::vector<std::string>{}); };
  {
    TorCircuitTracker tracker;
    tracker.Start(control.get());
    base::OneShotTimer::FireAll();   // sends GETINFO circuit-status
  }                                  // tracker destroyed with a reply pending
  control->Pump();                   // must not touch the dead tracker
  SUCCEED();
}

}  // namespace
}  // namespace tor
