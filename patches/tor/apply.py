#!/usr/bin/env python3
"""Apply the Auren Tor changes to a brave-core checkout.

usage: apply.py /path/to/src/brave

Copies patches/tor/overlay/* into the tree and edits the existing files in
place. Every edit asserts that its anchor text matches exactly once, and is
skipped if it has already been applied, so the script is safe to re-run.
"""
import os
import shutil
import sys

root = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))


def path(rel):
    return os.path.join(root, rel)


def edit(rel, old, new, marker=None):
    p = path(rel)
    s = open(p).read()
    marker = marker or new.strip().splitlines()[0]
    if marker in s:
        print("skip  ", rel, "-", marker[:50])
        return
    assert s.count(old) == 1, (rel, old[:60], s.count(old))
    open(p, "w").write(s.replace(old, new))
    print("edited", rel, "-", marker[:50])


# --- new files ---------------------------------------------------------------
overlay = os.path.join(here, "overlay")
for base, _, files in os.walk(overlay):
    for f in files:
        src = os.path.join(base, f)
        rel = os.path.relpath(src, overlay)
        dst = path(rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        print("copied", rel)

T = "components/tor/"

# --- TorControl: data replies + generic command -----------------------------
edit(T + "tor_control.h",
     "  void SetupPluggableTransport(const base::FilePath& snowflake,",
     """  // Auren: runs one control command and collects every reply line, including
  // the body of "250+" data replies. Only call with fixed, validated
  // commands; |callback| runs on the calling sequence.
  void RunCommand(
      const std::string& cmd,
      base::OnceCallback<void(bool error, std::vector<std::string> lines)>
          callback);

  void SetupPluggableTransport(const base::FilePath& snowflake,""",
     marker="void RunCommand(")
edit(T + "tor_control.h",
     "  void GetCircuitEstablishedLine(",
     """  void CollectLine(std::vector<std::string>* lines,
                   const std::string& status,
                   const std::string& reply);
  void RunCommandDone(
      std::unique_ptr<std::vector<std::string>> lines,
      base::OnceCallback<void(bool error, std::vector<std::string> lines)>
          callback,
      bool error,
      const std::string& status,
      const std::string& reply);
  void GetCircuitEstablishedLine(""",
     marker="void CollectLine(")
edit(T + "tor_control.h",
     "  bool read_cr_;    // true if we have parsed a CR\n",
     "  bool read_cr_;    // true if we have parsed a CR\n"
     "  bool in_data_ = false;  // inside the body of a \"250+\" data reply\n",
     marker="bool in_data_")

edit(T + "tor_control.cc",
     '#include "brave/components/tor/tor_control.h"\n',
     '#include "brave/components/tor/tor_control.h"\n\n'
     '#include "base/task/bind_post_task.h"\n',
     marker='#include "base/task/bind_post_task.h"')

edit(T + "tor_control.cc",
     "void TorControl::SetupPluggableTransport(\n",
     """// RunCommand(cmd, callback)
//
//      Auren: send one command and hand back all of its reply lines. Data
//      replies ("250+key=" ... ".") contribute their body lines; "250-"
//      lines contribute "key=value".
//
void TorControl::RunCommand(
    const std::string& cmd,
    base::OnceCallback<void(bool error, std::vector<std::string> lines)>
        callback) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(owner_sequence_checker_);
  auto lines = std::make_unique<std::vector<std::string>>();
  std::vector<std::string>* lines_p = lines.get();
  io_task_runner_->PostTask(
      FROM_HERE,
      base::BindOnce(
          &TorControl::DoCmd, weak_ptr_factory_.GetWeakPtr(), cmd,
          base::BindRepeating(&TorControl::CollectLine,
                              weak_ptr_factory_.GetWeakPtr(), lines_p),
          base::BindOnce(&TorControl::RunCommandDone,
                         weak_ptr_factory_.GetWeakPtr(), std::move(lines),
                         base::BindPostTaskToCurrentDefault(
                             std::move(callback)))));
}

void TorControl::CollectLine(std::vector<std::string>* lines,
                             const std::string& status,
                             const std::string& reply) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(io_sequence_checker_);
  constexpr size_t kMaxLines = 20000;
  if ((status == "250" || status == "DATA") && lines->size() < kMaxLines) {
    lines->push_back(reply);
  }
}

void TorControl::RunCommandDone(
    std::unique_ptr<std::vector<std::string>> lines,
    base::OnceCallback<void(bool error, std::vector<std::string> lines)>
        callback,
    bool error,
    const std::string& status,
    const std::string& reply) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(io_sequence_checker_);
  if (error || status != "250" || reply != "OK") {
    std::move(callback).Run(true, {});
    return;
  }
  std::move(callback).Run(false, std::move(*lines));
}

void TorControl::SetupPluggableTransport(
""",
     marker="// RunCommand(cmd, callback)")

edit(T + "tor_control.cc",
     """bool TorControl::ReadLine(std::string_view line) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(io_sequence_checker_);
""",
     """bool TorControl::ReadLine(std::string_view line) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(io_sequence_checker_);

  // Auren: body of a "250+" data reply, terminated by a lone ".".
  if (in_data_) {
    if (line == ".") {
      in_data_ = false;
      return true;
    }
    // Undo dot-stuffing.
    if (line.starts_with("..")) {
      line.remove_prefix(1);
    }
    if (!cmdq_.empty()) {
      cmdq_.front().first.Run("DATA", std::string(line));
    }
    return true;
  }
""",
     marker="// Auren: body of a \"250+\" data reply")

edit(T + "tor_control.cc",
     """      case '+':
        VLOG(2) << "tor: NYI: control data reply";
        // XXX Just ignore it for now.
        return true;
""",
     """      case '+':
        // Auren: start of a data reply; the body follows until a lone ".".
        in_data_ = true;
        NotifyTorRawMid(status, reply);
        if (!cmdq_.empty()) {
          cmdq_.front().first.Run(status, reply);
        }
        return true;
""",
     marker="// Auren: start of a data reply")

edit(T + "tor_control.cc",
     "  reading_ = false;\n  readiobuf_.reset();\n  read_start_ = 0u;\n  read_cr_ = false;\n",
     "  reading_ = false;\n  readiobuf_.reset();\n  read_start_ = 0u;\n  read_cr_ = false;\n"
     "  in_data_ = false;\n",
     marker="read_cr_ = false;\n  in_data_ = false;")

# --- TorLauncherFactory ------------------------------------------------------
edit(T + "tor_launcher_factory.h",
     '#include "brave/components/tor/tor_control.h"\n',
     '#include "brave/components/tor/tor_circuit_tracker.h"\n'
     '#include "brave/components/tor/tor_control.h"\n',
     marker='#include "brave/components/tor/tor_circuit_tracker.h"')
edit(T + "tor_launcher_factory.h",
     "  static TorLauncherFactory* GetInstance();\n",
     "  static TorLauncherFactory* GetInstance();\n\n"
     "  // Auren: live guard / middle / exit view of the tor client's circuits.\n"
     "  tor::TorCircuitTracker* GetCircuitTracker() {\n"
     "    return circuit_tracker_.get();\n"
     "  }\n",
     marker="tor::TorCircuitTracker* GetCircuitTracker()")
edit(T + "tor_launcher_factory.h",
     "  std::unique_ptr<tor::TorControl, base::OnTaskRunnerDeleter> control_;\n",
     "  std::unique_ptr<tor::TorControl, base::OnTaskRunnerDeleter> control_;\n"
     "  std::unique_ptr<tor::TorCircuitTracker> circuit_tracker_ =\n"
     "      std::make_unique<tor::TorCircuitTracker>();\n",
     marker="circuit_tracker_ =")

edit(T + "tor_launcher_factory.cc",
     "  control_->Subscribe(tor::TorControlEvent::ERR, base::DoNothing());\n",
     "  control_->Subscribe(tor::TorControlEvent::ERR, base::DoNothing());\n"
     "  // Auren: circuit visibility for the user.\n"
     "  control_->Subscribe(tor::TorControlEvent::CIRC, base::DoNothing());\n"
     "  control_->Subscribe(tor::TorControlEvent::GUARD, base::DoNothing());\n"
     "  circuit_tracker_->Start(control_.get());\n",
     marker="circuit_tracker_->Start(")
edit(T + "tor_launcher_factory.cc",
     "  for (auto& observer : observers_) {\n    observer.OnTorControlEvent(raw_event);\n  }\n",
     "  for (auto& observer : observers_) {\n    observer.OnTorControlEvent(raw_event);\n  }\n"
     "  circuit_tracker_->OnTorEvent(event);\n",
     marker="circuit_tracker_->OnTorEvent(")
edit(T + "tor_launcher_factory.cc",
     "void TorLauncherFactory::KillTorProcess() {\n  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);\n",
     "void TorLauncherFactory::KillTorProcess() {\n  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);\n"
     "  circuit_tracker_->Stop();\n",
     marker="circuit_tracker_->Stop();")

edit(T + "tor_launcher_factory.cc",
     '  VLOG(2) << "TOR CONTROL: Closed!";\n',
     '  VLOG(2) << "TOR CONTROL: Closed!";\n  circuit_tracker_->Stop();\n',
     marker="TOR CONTROL: Closed!\";\n  circuit_tracker_->Stop")

# --- build -------------------------------------------------------------------
edit(T + "BUILD.gn",
     '    "tor_control.cc",\n',
     '    "tor_circuit_tracker.cc",\n    "tor_circuit_tracker.h",\n    "tor_control.cc",\n',
     marker='"tor_circuit_tracker.cc"')


# --- bundled tor client ------------------------------------------------------
U = T + "brave_tor_client_updater"
edit(U + ".h",
     "  void RemoveObsoleteFiles();\n",
     "  void RemoveObsoleteFiles();\n\n"
     "  // Auren: called with the install dir of the tor client shipped inside the\n"
     "  // app, or an empty path when there is none (then the component is used).\n"
     "  void OnBundledTorInstalled(base::FilePath install_dir);\n",
     marker="void OnBundledTorInstalled(")

edit(U + ".cc",
     '#include "base/files/file_util.h"\n',
     '#include "base/files/file_util.h"\n'
     '#include "base/functional/bind.h"\n'
     '#include "base/strings/string_util.h"\n',
     marker='#include "base/strings/string_util.h"')
edit(U + ".cc",
     '#include "build/build_config.h"\n',
     '#include "build/build_config.h"\n'
     '#if BUILDFLAG(IS_MAC)\n#include "base/apple/bundle_locations.h"\n#endif\n',
     marker='#include "base/apple/bundle_locations.h"')

# accept the bundled client's file name as well as Brave's component name
edit(U + ".cc",
     '"tor-\\\\d+\\\\.\\\\d+\\\\.\\\\d+\\\\.\\\\d+-\\\\w+(-\\\\w+)?-brave-\\\\d+"',
     '"tor-\\\\d+\\\\.\\\\d+\\\\.\\\\d+\\\\.\\\\d+-\\\\w+(-\\\\w+)?-(brave|auren)-\\\\d+"',
     marker="(brave|auren)")

edit(U + ".cc",
     "base::FilePath InitTorPath(const base::FilePath& install_dir) {\n",
     r"""// Auren: the tor client ships inside the app (the Tor Project's expert
// bundle, assembled by scripts/tor/make_bundle.sh) so that no component
// server is contacted to obtain it.
base::FilePath BundledTorDir() {
  const base::CommandLine& command_line =
      *base::CommandLine::ForCurrentProcess();
  if (command_line.HasSwitch("auren-tor-bundle")) {
    return command_line.GetSwitchValuePath("auren-tor-bundle");
  }
#if BUILDFLAG(IS_MAC)
  return base::apple::OuterBundlePath()
      .Append(FILE_PATH_LITERAL("Contents"))
      .Append(FILE_PATH_LITERAL("Resources"))
      .Append(FILE_PATH_LITERAL("tor-bundle"));
#else
  return base::FilePath();
#endif
}

// Copies the bundle to <tor client dir>/auren-tor-<VERSION> unless that
// already exists, and returns the directory (empty if there is no usable
// bundle). Blocking; runs on the updater's task runner.
base::FilePath InstallBundledTor(const base::FilePath& bundle,
                                 const base::FilePath& client_dir) {
  if (bundle.empty() || !base::DirectoryExists(bundle)) {
    return base::FilePath();
  }
  std::string version;
  if (!base::ReadFileToString(bundle.AppendASCII("VERSION"), &version)) {
    return base::FilePath();
  }
  base::TrimWhitespaceASCII(version, base::TRIM_ALL, &version);
  // The version becomes part of a directory name.
  if (version.empty() || version.size() > 32 ||
      !std::ranges::all_of(version, [](char c) {
        return base::IsAsciiAlphaNumeric(c) || c == '.' || c == '-';
      })) {
    return base::FilePath();
  }
  const base::FilePath dest = client_dir.AppendASCII("auren-tor-" + version);
  if (!base::DirectoryExists(dest)) {
    const base::FilePath tmp = dest.AddExtensionASCII("tmp");
    base::DeletePathRecursively(tmp);
    if (!base::CreateDirectory(client_dir) ||
        !base::CopyDirectory(bundle, tmp, /*recursive=*/true) ||
        !base::Move(tmp, dest)) {
      LOG(ERROR) << "Failed to install the bundled Tor client to "
                 << dest.value();
      base::DeletePathRecursively(tmp);
      return base::FilePath();
    }
  }
  return dest;
}

base::FilePath InitTorPath(const base::FilePath& install_dir) {
""",
     marker="base::FilePath BundledTorDir()")

edit(U + ".cc",
     """  BraveComponent::Register(kTorClientComponentName, kTorClientComponentId,
                           kTorClientComponentBase64PublicKey);
  registered_ = true;
}
""",
     """  registered_ = true;
  // Auren: prefer the tor client bundled with the app; only fall back to the
  // component server when the bundle is missing.
  task_runner_->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(&InstallBundledTor, BundledTorDir(),
                     GetTorClientDirectory()),
      base::BindOnce(&BraveTorClientUpdater::OnBundledTorInstalled,
                     weak_ptr_factory_.GetWeakPtr()));
}

void BraveTorClientUpdater::OnBundledTorInstalled(
    base::FilePath install_dir) {
  if (install_dir.empty()) {
    BraveComponent::Register(kTorClientComponentName, kTorClientComponentId,
                             kTorClientComponentBase64PublicKey);
    return;
  }
  install_dir_ = install_dir;
  OnComponentReady(kTorClientComponentId, install_dir, std::string());
}
""",
     marker="void BraveTorClientUpdater::OnBundledTorInstalled(")


# --- chrome://tor-circuit page + NTP wiring ----------------------------------
B = "browser/ui/"
edit("components/constants/webui_url_constants.h",
     'inline constexpr char kTorInternalsHost[] = "tor-internals";\n',
     'inline constexpr char kTorInternalsHost[] = "tor-internals";\n'
     'inline constexpr char kTorCircuitHost[] = "tor-circuit";\n',
     marker="kTorCircuitHost[]")
edit("chromium_src/chrome/common/webui_url_constants.cc",
     "BRAVE_WALLET_WEBUI_HOSTS kTorInternalsHost, kSkusInternalsHost,     \\\n",
     "BRAVE_WALLET_WEBUI_HOSTS kTorInternalsHost, kTorCircuitHost,       \\\n"
     "      kSkusInternalsHost,                                                \\\n",
     marker="kTorCircuitHost,")

F = B + "webui/brave_web_ui_controller_factory.cc"
edit(F,
     '#include "brave/browser/ui/webui/auren_new_tab_ui.h"\n',
     '#include "brave/browser/ui/webui/auren_new_tab_ui.h"\n'
     '#if BUILDFLAG(ENABLE_TOR)\n#include "brave/browser/ui/webui/auren/auren_tor_ui.h"\n#endif\n',
     marker='auren/auren_tor_ui.h')
edit(F,
     "    return new TorInternalsUI(web_ui, url.host());\n",
     "    return new TorInternalsUI(web_ui, url.host());\n"
     "  } else if (host == kTorCircuitHost) {\n"
     "    return new AurenTorUI(web_ui);\n",
     marker="return new AurenTorUI(web_ui);")
edit(F,
     "      url.host() == kTorInternalsHost ||\n",
     "      url.host() == kTorInternalsHost || url.host() == kTorCircuitHost ||\n",
     marker="url.host() == kTorCircuitHost")

edit(B + "BUILD.gn",
     '        "//brave/components/tor/resources",\n      ]\n    }\n',
     '        "//brave/components/tor/resources",\n      ]\n'
     '      sources += [\n        "webui/auren/auren_tor_ui.cc",\n        "webui/auren/auren_tor_ui.h",\n      ]\n    }\n',
     marker='"webui/auren/auren_tor_ui.cc"')

H = B + "webui/auren/auren_security_handler"
edit(H + ".h",
     "  void HandleSetHttpsOnly(const base::ListValue& args);\n",
     "  void HandleSetHttpsOnly(const base::ListValue& args);\n"
     "  // Tor: opens a Tor window when Tor is off, or the circuit page when it\n"
     "  // is connected.\n"
     "  void HandleOpenTor(const base::ListValue& args);\n",
     marker="void HandleOpenTor(")
edit(H + ".cc",
     '#include "base/base64.h"\n' if False else '#include "chrome/browser/content_settings/cookie_settings_factory.h"\n',
     '#include "base/strings/string_util.h"\n'
     '#include "brave/browser/ui/browser_commands.h"\n'
     '#include "chrome/browser/content_settings/cookie_settings_factory.h"\n'
     '#include "content/public/browser/web_contents.h"\n'
     '#include "ui/base/page_transition_types.h"\n'
     '#include "ui/base/window_open_disposition.h"\n',
     marker='#include "ui/base/window_open_disposition.h"')
edit(H + ".cc",
     '  web_ui()->RegisterMessageCallback(\n      "setHttpsOnly",',
     '  web_ui()->RegisterMessageCallback(\n'
     '      "openTor", base::BindRepeating(&AurenSecurityHandler::HandleOpenTor,\n'
     '                                     base::Unretained(this)));\n'
     '  web_ui()->RegisterMessageCallback(\n      "setHttpsOnly",',
     marker='"openTor", base::BindRepeating')
edit(H + ".cc",
     '  state->tor_exit_country = "";\n',
     '  state->tor_exit_country = "";\n'
     '#if BUILDFLAG(ENABLE_TOR)\n'
     '  {\n'
     '    // Exit country of the circuit currently carrying traffic, from the\n'
     '    // tracker (tor\'s own GeoIP file; nothing leaves the machine).\n'
     '    const auto& circuits = TorLauncherFactory::GetInstance()\n'
     '                               ->GetCircuitTracker()\n'
     '                               ->snapshot()\n'
     '                               .circuits;\n'
     '    if (!circuits.empty() && !circuits.front().hops.empty()) {\n'
     '      state->tor_exit_country =\n'
     '          base::ToUpperASCII(circuits.front().hops.back().country);\n'
     '    }\n'
     '  }\n'
     '#endif\n',
     marker="Exit country of the circuit currently carrying traffic")
edit(H + ".cc",
     "void AurenSecurityHandler::HandleGetSecurityState(",
     """void AurenSecurityHandler::HandleOpenTor(const base::ListValue& args) {
#if BUILDFLAG(ENABLE_TOR)
  if (TorLauncherFactory::GetInstance()->IsTorConnected()) {
    web_ui()->GetWebContents()->OpenURL(
        content::OpenURLParams(GURL("chrome://tor-circuit/"),
                               content::Referrer(),
                               WindowOpenDisposition::NEW_FOREGROUND_TAB,
                               ui::PAGE_TRANSITION_LINK, false),
        /*navigation_handle_callback=*/{});
  } else {
    brave::NewOffTheRecordWindowTor(profile_->GetOriginalProfile());
  }
#endif
}

void AurenSecurityHandler::HandleGetSecurityState(""",
     marker="void AurenSecurityHandler::HandleOpenTor(")

edit(B + "webui/auren_new_tab_ui.cc",
     """    document.getElementById('btn-tor').addEventListener('click', function() {
      state.tor.active = !state.tor.active;
      render();
    });
""",
     """    document.getElementById('btn-tor').addEventListener('click', function() {
      // Opens a Tor window, or the circuit page when Tor is already connected.
      if (window.chrome && chrome.send) {
        chrome.send('openTor');
      }
    });
""",
     marker="chrome.send('openTor')")

edit(T + "BUILD.gn",
     '    "tor_control_unittest.cc",\n',
     '    "tor_circuit_tracker_unittest.cc",\n    "tor_control_unittest.cc",\n',
     marker='"tor_circuit_tracker_unittest.cc"')

print("done")
