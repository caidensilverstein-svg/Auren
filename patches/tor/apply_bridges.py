#!/usr/bin/env python3
"""Make Tor bridges (obfs4, meek, webtunnel, snowflake) use the lyrebird that ships in the bundled tor.

usage: apply_bridges.py /path/to/src/brave      (run after apply.py)

Brave already has the whole bridge feature: Settings > Tor has a bridges dialog (built-in obfs4 or snowflake,
a requested set, or user-provided lines) and BridgesConfig is applied through TorControl::SetupBridges. The
transports themselves are a second Brave component fetched from Brave's component server, referenced by paths
relative to the profile. Auren instead runs the transports from the bundle (lyrebird serves all of them, as in
Tor Browser), so choosing bridges makes no request to Brave's servers and needs no second download.

Anchors were checked against brave-core v1.94.97 (Chromium 151.0.7922.47), the version the Mac tree is based
on; every edit asserts its anchor matches exactly once and is skipped if already applied, like apply.py.
Not compiled: see docs/privacy/tor.md.
"""
import os
import sys

root = sys.argv[1]


def edit(rel, old, new, marker=None):
    p = os.path.join(root, rel)
    s = open(p).read()
    marker = marker or new.strip().splitlines()[0]
    if marker in s:
        print("skip  ", rel, "-", marker[:50])
        return
    assert s.count(old) == 1, (rel, old[:60], s.count(old))
    open(p, "w").write(s.replace(old, new))
    print("edited", rel, "-", marker[:50])


T = "components/tor/"

# --- constants: where a transport path is relative to --------------------------------------------------------
edit(T + "constants.h",
     "base::FilePath GetBundledTorDir();\n",
     """base::FilePath GetBundledTorDir();

// Auren: a pluggable transport path reported by the transport updater is either a component path (relative to
// the component directory, reached from tor's working directory as "../../<path>") or, for the transports in
// the bundled tor, starts with kBundledInstallDirName and is relative to tor's own working directory (the
// bundle). Returns the path as tor should be given it.
bool IsBundledPluggableTransportPath(const base::FilePath& path);
base::FilePath ResolvePluggableTransportPath(const base::FilePath& path);
""",
     marker="IsBundledPluggableTransportPath(const base::FilePath& path);")

edit(T + "constants.cc",
     "#include <string>\n",
     "#include <string>\n#include <vector>\n",
     marker="#include <vector>")

edit(T + "constants.cc",
     "base::FilePath GetBundledTorDir() {",
     """bool IsBundledPluggableTransportPath(const base::FilePath& path) {
  const std::vector<base::FilePath::StringType> parts = path.GetComponents();
  return !parts.empty() &&
         base::FilePath(parts[0]).MaybeAsASCII() == kBundledInstallDirName;
}

base::FilePath ResolvePluggableTransportPath(const base::FilePath& path) {
  if (!IsBundledPluggableTransportPath(path)) {
    return base::FilePath::FromASCII("../../").Append(path);
  }
  const std::vector<base::FilePath::StringType> parts = path.GetComponents();
  base::FilePath resolved;
  for (size_t i = 1; i < parts.size(); ++i) {
    resolved = resolved.Append(parts[i]);
  }
  return resolved;
}

base::FilePath GetBundledTorDir() {""",
     marker="bool IsBundledPluggableTransportPath(const base::FilePath& path) {")

# --- transport updater: serve lyrebird from the bundle ---------------------------------------------------------
U = T + "brave_tor_pluggable_transport_updater"
edit(U + ".h",
     "  void OnInitialized(const base::FilePath& install_dir, bool succeeded);\n",
     """  void OnInitialized(const base::FilePath& install_dir, bool succeeded);
  // Auren: lyrebird from the bundled tor, or empty when there is no bundle.
  void OnBundledLyrebirdFound(const base::FilePath& lyrebird);
""",
     marker="void OnBundledLyrebirdFound(")

edit(U + ".cc",
     '#include "build/build_config.h"\n',
     '#include "brave/components/tor/constants.h"\n#include "build/build_config.h"\n',
     marker='#include "brave/components/tor/constants.h"')

edit(U + ".cc",
     "bool Initialize(const base::FilePath& install_dir) {",
     """#if BUILDFLAG(IS_WIN)
constexpr base::FilePath::CharType kLyrebirdFilename[] =
    FILE_PATH_LITERAL("lyrebird.exe");
#else
constexpr base::FilePath::CharType kLyrebirdFilename[] =
    FILE_PATH_LITERAL("lyrebird");
#endif

// Auren: the bundled tor ships lyrebird, which serves obfs4, meek, webtunnel and
// snowflake. Blocking; runs on the component task runner.
base::FilePath FindBundledLyrebird(const base::FilePath& bundle) {
  if (bundle.empty()) {
    return base::FilePath();
  }
  const base::FilePath lyrebird =
      bundle.Append(FILE_PATH_LITERAL("pluggable_transports"))
          .Append(kLyrebirdFilename);
  return base::PathExists(lyrebird) ? lyrebird : base::FilePath();
}

bool Initialize(const base::FilePath& install_dir) {""",
     marker="base::FilePath FindBundledLyrebird(")

edit(U + ".cc",
     """  BraveComponent::Register(kComponentName, kTorPluggableTransportComponentId,
                           kComponentBase64PublicKey);
  registered_ = true;
  is_ready_ = false;
}
""",
     """  registered_ = true;
  is_ready_ = false;
  // Auren: prefer the transports bundled with the app; only fall back to
  // Brave's component server when the bundle is missing.
  GetTaskRunner()->PostTaskAndReplyWithResult(
      FROM_HERE, base::BindOnce(&FindBundledLyrebird, GetBundledTorDir()),
      base::BindOnce(&BraveTorPluggableTransportUpdater::OnBundledLyrebirdFound,
                     weak_ptr_factory_.GetWeakPtr()));
}

void BraveTorPluggableTransportUpdater::OnBundledLyrebirdFound(
    const base::FilePath& lyrebird) {
  if (!registered_) {
    return;  // Unregister() ran in the meantime.
  }
  if (lyrebird.empty()) {
    BraveComponent::Register(kComponentName, kTorPluggableTransportComponentId,
                             kComponentBase64PublicKey);
    return;
  }
  // Relative to the bundle (tor's working directory) under the bundled
  // sentinel; see ResolvePluggableTransportPath().
  const base::FilePath relative =
      base::FilePath::FromASCII(kBundledInstallDirName)
          .Append(FILE_PATH_LITERAL("pluggable_transports"))
          .Append(lyrebird.BaseName());
  snowflake_path_ = relative;
  obfs4_path_ = relative;
  is_ready_ = true;
  for (auto& observer : observers_) {
    observer.OnPluggableTransportReady(true);
  }
}
""",
     marker="void BraveTorPluggableTransportUpdater::OnBundledLyrebirdFound(")

# --- control port: how tor is told to run them ------------------------------------------------------------------
C = T + "tor_control.cc"
edit(C,
     '#include "base/files/file_path.h"\n',
     '#include "base/files/file_path.h"\n#include "brave/components/tor/constants.h"\n',
     marker='#include "brave/components/tor/constants.h"')
edit(C,
     """  const auto snowflake_path =
      base::FilePath::FromASCII("../../").Append(snowflake);
  const auto obfs4_path = base::FilePath::FromASCII("../../").Append(obfs4);
""",
     """  const auto snowflake_path = ResolvePluggableTransportPath(snowflake);
  const auto obfs4_path = ResolvePluggableTransportPath(obfs4);
  const bool bundled = IsBundledPluggableTransportPath(snowflake);
""",
     marker="const bool bundled = IsBundledPluggableTransportPath(snowflake);")

edit(C,
     """  const std::string snowflake_setup = absl::StrFormat(
      kSnowflakeConfigCmd,
      snowflake_path.NormalizePathSeparatorsTo(FILE_PATH_LITERAL('/'))
          .AsUTF8Unsafe());
  const std::string obfs4_setup = absl::StrFormat(
      kObfs4ConfigCmd,
      obfs4_path.NormalizePathSeparatorsTo(FILE_PATH_LITERAL('/'))
          .AsUTF8Unsafe());
""",
     """  // Auren: lyrebird takes the snowflake broker, front and STUN servers from the
  // bridge line itself (the built-in lines carry url=, fronts= and ice=), so
  // it is started without the command line flags the standalone
  // snowflake-client needs.
  constexpr const char kBundledObfs4ConfigCmd[] =
      "ClientTransportPlugin=\\"meek_lite,obfs2,obfs3,obfs4,scramblesuit,"
      "webtunnel exec %s\\"";
  constexpr const char kBundledSnowflakeConfigCmd[] =
      "ClientTransportPlugin=\\"snowflake exec %s\\"";

  const std::string snowflake_arg =
      snowflake_path.NormalizePathSeparatorsTo(FILE_PATH_LITERAL('/'))
          .AsUTF8Unsafe();
  const std::string obfs4_arg =
      obfs4_path.NormalizePathSeparatorsTo(FILE_PATH_LITERAL('/'))
          .AsUTF8Unsafe();
  const std::string snowflake_setup =
      bundled ? absl::StrFormat(kBundledSnowflakeConfigCmd, snowflake_arg)
              : absl::StrFormat(kSnowflakeConfigCmd, snowflake_arg);
  const std::string obfs4_setup =
      bundled ? absl::StrFormat(kBundledObfs4ConfigCmd, obfs4_arg)
              : absl::StrFormat(kObfs4ConfigCmd, obfs4_arg);
""",
     marker="constexpr const char kBundledObfs4ConfigCmd[]")

# --- profile service: its debug-only sanity check must use the same path rule -----------------------------------
P = T + "tor_profile_service_impl.cc"
edit(P,
     """  const auto snowflake_path = base::FilePath::FromASCII("../../").Append(
      tor_pluggable_transport_updater_->GetSnowflakeExecutable());
  const auto obfs4_path = base::FilePath::FromASCII("../../").Append(
      tor_pluggable_transport_updater_->GetObfs4Executable());
""",
     """  const auto snowflake_path = ResolvePluggableTransportPath(
      tor_pluggable_transport_updater_->GetSnowflakeExecutable());
  const auto obfs4_path = ResolvePluggableTransportPath(
      tor_pluggable_transport_updater_->GetObfs4Executable());
""",
     marker="const auto snowflake_path = ResolvePluggableTransportPath(")
edit(P,
     '#include "brave/components/tor/tor_constants.h"\n',
     '#include "brave/components/tor/constants.h"\n#include "brave/components/tor/tor_constants.h"\n',
     marker='#include "brave/components/tor/constants.h"')
