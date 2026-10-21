#pragma once
#include <algorithm>
#include <vector>
namespace base {
template <typename T> class ObserverList {
 public:
  class Unchecked {
   public:
    void AddObserver(T* o) { v_.push_back(o); }
    void RemoveObserver(T* o) { v_.erase(std::remove(v_.begin(), v_.end(), o), v_.end()); }
    struct It {
      typename std::vector<T*>::iterator i;
      T& operator*() const { return **i; }
      It& operator++() { ++i; return *this; }
      bool operator!=(const It& o) const { return i != o.i; }
    };
    It begin() { snap_ = v_; return {snap_.begin()}; }
    It end() { return {snap_.end()}; }
   private:
    std::vector<T*> v_, snap_;
  };
};
}  // namespace base
