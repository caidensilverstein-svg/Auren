#pragma once
#include <cstdint>
namespace base {
class TimeDelta { public: constexpr TimeDelta() = default; constexpr explicit TimeDelta(int64_t ms) : ms_(ms) {} int64_t ms_ = 0; };
constexpr TimeDelta Milliseconds(int64_t ms) { return TimeDelta(ms); }
class Time { public: static Time Now() { Time t; t.tick_ = ++counter_; return t; } int64_t tick_ = 0; static inline int64_t counter_ = 0; };
}  // namespace base
