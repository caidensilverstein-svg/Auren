#pragma once
#include <cstdlib>
#include <string>
namespace base {
inline bool StringToUint(const std::string& s, unsigned* out) {
  if (s.empty() || s.size() > 10) return false;
  for (char c : s) if (c < '0' || c > '9') return false;
  unsigned long long v = std::strtoull(s.c_str(), nullptr, 10);
  if (v > 0xFFFFFFFFull) {
    return false;
  }
  *out = static_cast<unsigned>(v);
  return true;
}
}  // namespace base
