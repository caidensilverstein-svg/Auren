// Host-test stand-ins for the few //base facilities tor_circuit_tracker uses.
// NOT Chromium code: only enough to compile and unit-test the tracker on a plain
// Linux toolchain. Behaviour is deliberately simple and single-threaded.
#ifndef AUREN_HOSTTEST_BASE_CORE_H_
#define AUREN_HOSTTEST_BASE_CORE_H_
#include <chrono>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#define FROM_HERE 0
#define DCHECK_CALLED_ON_VALID_SEQUENCE(x) ((void)0)
#define SEQUENCE_CHECKER(x)

namespace base {

template <typename Sig> class OnceCallback;
template <typename R, typename... A>
class OnceCallback<R(A...)> {
 public:
  OnceCallback() = default;
  template <typename F, typename = std::enable_if_t<
      std::is_invocable_v<F&, A...> &&
      !std::is_same_v<std::decay_t<F>, OnceCallback>>>
  OnceCallback(F f) : fn_(std::move(f)) {}
  R operator()(A... a) { auto f = std::move(fn_); fn_ = nullptr; return f(std::forward<A>(a)...); }
  explicit operator bool() const { return static_cast<bool>(fn_); }
 private:
  std::function<R(A...)> fn_;
};
using OnceClosure = OnceCallback<void()>;

template <typename T> class WeakPtr {
 public:
  WeakPtr() = default;
  WeakPtr(T* p, std::shared_ptr<bool> alive) : p_(p), alive_(std::move(alive)) {}
  T* get() const { return alive_ && *alive_ ? p_ : nullptr; }
  explicit operator bool() const { return get() != nullptr; }
 private:
  T* p_ = nullptr;
  std::shared_ptr<bool> alive_;
};
template <typename T> class WeakPtrFactory {
 public:
  explicit WeakPtrFactory(T* p) : p_(p), alive_(std::make_shared<bool>(true)) {}
  ~WeakPtrFactory() { *alive_ = false; }
  WeakPtr<T> GetWeakPtr() { return WeakPtr<T>(p_, alive_); }
 private:
  T* p_;
  std::shared_ptr<bool> alive_;
};

// BindOnce(&Class::Method, weak_ptr, bound...) : cancelled if the object died.
template <typename C, typename M, typename... B>
auto BindOnce(M C::*m, WeakPtr<C> w, B... b) {
  return [m, w, b...](auto&&... rest) mutable {
    if (C* c = w.get()) (c->*m)(b..., std::forward<decltype(rest)>(rest)...);
  };
}
template <typename F>
auto BindOnce(F f) { return f; }

struct DoNothingT {
  template <typename R, typename... A>
  operator OnceCallback<R(A...)>() const { return OnceCallback<R(A...)>([](A...) {}); }
};
inline DoNothingT DoNothing() { return {}; }

template <typename T> class raw_ptr_impl {};
}  // namespace base

template <typename T> class raw_ptr {
 public:
  raw_ptr() = default;
  raw_ptr(T* p) : p_(p) {}
  raw_ptr& operator=(T* p) { p_ = p; return *this; }
  T* operator->() const { return p_; }
  T& operator*() const { return *p_; }
  explicit operator bool() const { return p_ != nullptr; }
  bool operator==(std::nullptr_t) const { return p_ == nullptr; }
  T* get() const { return p_; }
 private:
  T* p_ = nullptr;
};
#endif
