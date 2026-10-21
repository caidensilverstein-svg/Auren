#pragma once
// Fake control port: commands are queued and answered by the test's responder
// when Pump() is called, so the tracker's async sequencing is exercised.
#include <deque>
#include <functional>
#include <string>
#include <utility>
#include <vector>
#include "base/functional_core.h"
namespace tor {
class TorControl {
 public:
  using Cb = base::OnceCallback<void(bool, std::vector<std::string>)>;
  using Responder = std::function<std::pair<bool, std::vector<std::string>>(const std::string&)>;
  void RunCommand(const std::string& cmd, Cb cb) { sent.push_back(cmd); q_.emplace_back(cmd, std::move(cb)); }
  void Pump() {
    while (!q_.empty()) { auto [cmd, cb] = std::move(q_.front()); q_.pop_front();
      auto r = responder(cmd); cb(r.first, std::move(r.second)); }
  }
  Responder responder;
  std::vector<std::string> sent;
 private:
  std::deque<std::pair<std::string, Cb>> q_;
};
}  // namespace tor
