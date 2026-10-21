#include <algorithm>
#pragma once
#include <vector>
#include "base/functional_core.h"
#include "base/time/time.h"
namespace base {
// Never fires by itself; tests call OneShotTimer::FireAll().
class OneShotTimer {
 public:
  OneShotTimer() { all().push_back(this); }
  ~OneShotTimer() { auto& v = all(); v.erase(std::remove(v.begin(), v.end(), this), v.end()); }
  void Start(int, TimeDelta, OnceClosure task) { task_ = std::move(task); running_ = true; }
  void Stop() { running_ = false; task_ = OnceClosure(); }
  bool IsRunning() const { return running_; }
  static void FireAll() {
    for (OneShotTimer* t : std::vector<OneShotTimer*>(all())) {
      if (t->running_) { t->running_ = false; OnceClosure c = std::move(t->task_); c(); }
    }
  }
 private:
  static std::vector<OneShotTimer*>& all() { static std::vector<OneShotTimer*> v; return v; }
  OnceClosure task_;
  bool running_ = false;
};
}  // namespace base
