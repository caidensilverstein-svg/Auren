#pragma once
#include <string>
#include <string_view>
#include <vector>
namespace base {
enum WhitespaceHandling { KEEP_WHITESPACE, TRIM_WHITESPACE };
enum SplitResult { SPLIT_WANT_ALL, SPLIT_WANT_NONEMPTY };
inline std::vector<std::string> SplitString(const std::string& in, std::string_view seps, WhitespaceHandling ws, SplitResult r) {
  std::vector<std::string> out; std::string cur;
  auto flush = [&] {
    if (ws == TRIM_WHITESPACE) { size_t a = cur.find_first_not_of(" \t\r\n"); size_t b = cur.find_last_not_of(" \t\r\n");
      cur = a == std::string::npos ? "" : cur.substr(a, b - a + 1); }
    if (r == SPLIT_WANT_ALL || !cur.empty()) {
      out.push_back(cur);
    }
    cur.clear();
  };
  for (char c : in) { if (seps.find(c) != std::string_view::npos) flush(); else cur += c; }
  flush(); return out; }
}  // namespace base
