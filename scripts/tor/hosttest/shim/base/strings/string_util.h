#pragma once
#include <algorithm>
#include <cctype>
#include <string>
#include <vector>
namespace base {
inline bool IsHexDigit(char c) { return std::isxdigit(static_cast<unsigned char>(c)) != 0; }
inline std::string ToUpperASCII(std::string s) { for (auto& c : s) c = std::toupper(static_cast<unsigned char>(c)); return s; }
inline std::string ToLowerASCII(std::string s) { for (auto& c : s) c = std::tolower(static_cast<unsigned char>(c)); return s; }
inline std::string JoinString(const std::vector<std::string>& v, const std::string& sep) {
  std::string out; for (size_t i = 0; i < v.size(); ++i) { if (i) out += sep; out += v[i]; } return out; }
}  // namespace base
