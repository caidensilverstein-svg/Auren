#pragma once
#include <arpa/inet.h>
#include <string>
namespace net {
class IPAddress { public:
  bool AssignFromIPLiteral(const std::string& s) { unsigned char b[16]; return inet_pton(AF_INET, s.c_str(), b) == 1 || inet_pton(AF_INET6, s.c_str(), b) == 1; } };
}  // namespace net
