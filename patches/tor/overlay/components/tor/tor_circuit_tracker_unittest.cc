/* Copyright (c) 2026 The Auren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "brave/components/tor/tor_circuit_tracker.h"

#include <string>

#include "testing/gtest/include/gtest/gtest.h"

// The sample lines below are real control-port output from tor 0.4.9.14.

namespace tor {

using Parsed = TorCircuitTracker::ParsedCircuit;

TEST(TorCircuitTrackerTest, ParsesGeneralThreeHopCircuit) {
  Parsed c;
  ASSERT_TRUE(TorCircuitTracker::ParseCircuitLine(
      "6 BUILT $616C915B1EA788FA1177EF6194608C0E13B28A96~magic848relay,"
      "$B83DC1558F0D34353BB992EF93AFEAFDB226A73E~mdfnet3,"
      "$F614B0185A2FB9C75B5B8B5666F819A846EDE661~DFRI109 "
      "BUILD_FLAGS=NEED_CAPACITY,NEED_UPTIME PURPOSE=CONFLUX_LINKED "
      "TIME_CREATED=2026-10-21T02:00:06.16",
      &c));
  EXPECT_EQ("6", c.id);
  EXPECT_EQ("BUILT", c.status);
  EXPECT_EQ("CONFLUX_LINKED", c.purpose);
  ASSERT_EQ(3u, c.path.size());
  EXPECT_EQ("616C915B1EA788FA1177EF6194608C0E13B28A96",
            c.path[0].fingerprint);
  EXPECT_EQ("magic848relay", c.path[0].nickname);
  EXPECT_EQ("DFRI109", c.path[2].nickname);
}

TEST(TorCircuitTrackerTest, ParsesInternalOneHopCircuit) {
  Parsed c;
  ASSERT_TRUE(TorCircuitTracker::ParseCircuitLine(
      "1 BUILT $D1D9999F87D1A11363708CD643A61915689A0CA0~sexyyred "
      "BUILD_FLAGS=ONEHOP_TUNNEL,IS_INTERNAL,NEED_CAPACITY PURPOSE=GENERAL "
      "TIME_CREATED=2026-10-21T01:59:55.119585",
      &c));
  EXPECT_EQ(1u, c.path.size());
  EXPECT_NE(std::string::npos, c.build_flags.find("IS_INTERNAL"));
  EXPECT_EQ("GENERAL", c.purpose);
}

TEST(TorCircuitTrackerTest, ParsesCircuitWithoutPathYet) {
  Parsed c;
  ASSERT_TRUE(TorCircuitTracker::ParseCircuitLine(
      "9 LAUNCHED BUILD_FLAGS=NEED_CAPACITY PURPOSE=GENERAL", &c));
  EXPECT_TRUE(c.path.empty());
  EXPECT_EQ("LAUNCHED", c.status);
}

TEST(TorCircuitTrackerTest, RejectsNonCircuitLines) {
  Parsed c;
  // The "250+circuit-status=" header line of the data reply.
  EXPECT_FALSE(TorCircuitTracker::ParseCircuitLine("circuit-status=", &c));
  EXPECT_FALSE(TorCircuitTracker::ParseCircuitLine("", &c));
  // A hop that is not a fingerprint must reject the whole line.
  EXPECT_FALSE(TorCircuitTracker::ParseCircuitLine(
      "3 BUILT $ZZZ~bad PURPOSE=GENERAL", &c));
}

TEST(TorCircuitTrackerTest, ParsesStreamLines) {
  std::string circuit;
  std::string target;
  ASSERT_TRUE(TorCircuitTracker::ParseStreamLine(
      "12 SUCCEEDED 6 example.com:443 PURPOSE=USER", &circuit, &target));
  EXPECT_EQ("6", circuit);
  EXPECT_EQ("example.com", target);

  ASSERT_TRUE(TorCircuitTracker::ParseStreamLine(
      "13 SUCCEEDED 7 [2001:db8::1]:443", &circuit, &target));
  EXPECT_EQ("[2001:db8::1]", target);

  // Not attached to a circuit yet.
  EXPECT_FALSE(
      TorCircuitTracker::ParseStreamLine("14 NEW 0 example.com:80", &circuit,
                                         &target));
  // Closed streams are not shown.
  EXPECT_FALSE(TorCircuitTracker::ParseStreamLine(
      "15 CLOSED 6 example.com:443", &circuit, &target));
  EXPECT_FALSE(TorCircuitTracker::ParseStreamLine("stream-status=", &circuit,
                                                  &target));
}

TEST(TorCircuitTrackerTest, ParsesRouterStatusLine) {
  std::string ip;
  uint16_t port = 0;
  ASSERT_TRUE(TorCircuitTracker::ParseRouterLine(
      "r sexyyred 0dmZn4fRoRNjcIzWQ6YZFWiaDKA 9meT5PTKKzLncZbcemg5z0AIeAI "
      "2038-01-01 00:00:00 96.9.98.77 443 0",
      &ip, &port));
  EXPECT_EQ("96.9.98.77", ip);
  EXPECT_EQ(443, port);

  EXPECT_FALSE(TorCircuitTracker::ParseRouterLine("s Fast Running V2Dir Valid",
                                                  &ip, &port));
  EXPECT_FALSE(TorCircuitTracker::ParseRouterLine(
      "r n id dg 2038-01-01 00:00:00 not-an-ip 443 0", &ip, &port));
  EXPECT_FALSE(TorCircuitTracker::ParseRouterLine(
      "r n id dg 2038-01-01 00:00:00 1.2.3.4 99999 0", &ip, &port));
}

}  // namespace tor
