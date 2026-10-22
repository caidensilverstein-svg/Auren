#!/usr/bin/env python3
"""Bundle ad/tracker/cookie-notice filter lists inside the app and load them into Brave's default adblock engine.

usage: apply.py /path/to/src/brave      (idempotent; run after patches/tor/apply.py is irrelevant, no ordering needed)

Why: Auren runs with the component updater off (docs/privacy/telemetry/05-decisions-and-tradeoffs.md item 1), so the
adblock engine never receives Brave's lists. This pins public lists in this repo (manifest.json, sha256), embeds them
as gzip resources in brave_components_static.pak, and adds one AdBlockFiltersProvider that feeds them to the default
engine. No request is made by the browser; updating a list is a reviewed change (fetch_lists.sh update).

Anchors were checked against brave-core v1.94.97 (Chromium 151.0.7922.47). Every edit asserts its anchor matches once.
Note: scriptlet/redirect *resources* normally come from a second component and are absent here, so rules that need them
(scriptlet injection, redirect=) are inert; network blocking and cosmetic hiding rules work.
"""
import json
import os
import re
import shutil
import subprocess
import sys

root = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
subprocess.run([os.path.join(here, "fetch_lists.sh"), "verify"], check=True, cwd=here)
manifest = json.load(open(os.path.join(here, "manifest.json")))


def ident(f, kind="list"):
    return "IDR_AUREN_%s_" % kind.upper() + re.sub(r"[^A-Z0-9]", "_", os.path.splitext(f)[0].upper())


def idr(f):
    return ident(f, next(o.get("kind", "list") for o in manifest["lists"] if o["file"] == f))


def edit(rel, old, new, marker):
    p = os.path.join(root, rel)
    s = open(p).read()
    if marker in s:
        print("skip  ", rel, "-", marker[:60])
        return
    assert s.count(old) == 1, (rel, old[:60], s.count(old))
    open(p, "w").write(s.replace(old, new))
    print("edited", rel, "-", marker[:60])


def write(rel, content):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if os.path.exists(p) and open(p).read() == content:
        print("skip  ", rel)
        return
    open(p, "w").write(content)
    print("wrote ", rel)


S = "components/brave_shields/content/browser/"
RES = "components/brave_shields/resources/protections/"

# --- the list files -------------------------------------------------------------------------------------------
os.makedirs(os.path.join(root, RES), exist_ok=True)
for o in manifest["lists"]:
    src, dst = os.path.join(here, "lists", o["file"]), os.path.join(root, RES, o["file"])
    if not os.path.exists(dst) or open(src, "rb").read() != open(dst, "rb").read():
        shutil.copyfile(src, dst)
        print("copied", RES + o["file"])

# --- resources: one gzip BINDATA include per file; the whole block is regenerated on every run so that a changed
# manifest (new lists, new data files) is picked up, unlike the anchored edits below which are applied once ----------
includes = "".join(
    f'      <include name="{ident(o["file"], o.get("kind", "list"))}" file="../brave_shields/resources/protections/{o["file"]}" '
    f'type="BINDATA" compress="gzip" />\n' for o in manifest["lists"])
GRD = os.path.join(root, "components/resources/brave_components_resources.grd")
BEGIN = "      <!-- Auren: bundled filter lists (patches/privacy/protections) -->\n"
END = "      <!-- WebUI adblock resources -->\n"
g = open(GRD).read()
assert g.count(END) == 1, "grd anchor moved"
head, rest = g.split(END)
if BEGIN in head:
    head = head[: head.index(BEGIN)]
block = BEGIN + includes + "\n"
new_g = head + block + END + rest
if new_g == g:
    print("skip   grd block unchanged")
else:
    open(GRD, "w").write(new_g)
    print("edited grd block (%d includes)" % len(manifest["lists"]))

# --- provider -----------------------------------------------------------------------------------------------------
HEADER = """// Copyright (c) 2026 The Auren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.
"""

write(S + "ad_block_bundled_filters_provider.h", HEADER + """
#ifndef BRAVE_COMPONENTS_BRAVE_SHIELDS_CONTENT_BROWSER_AD_BLOCK_BUNDLED_FILTERS_PROVIDER_H_
#define BRAVE_COMPONENTS_BRAVE_SHIELDS_CONTENT_BROWSER_AD_BLOCK_BUNDLED_FILTERS_PROVIDER_H_

#include <string>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "brave/components/brave_shields/core/browser/ad_block_filters_provider.h"
#include "brave/components/brave_shields/core/browser/ad_block_filters_provider_manager.h"
#include "brave/components/brave_shields/core/common/adblock/rs/src/lib.rs.h"
#include "third_party/rust/cxx/v1/cxx.h"

namespace brave_shields {

// Auren: serves the filter lists embedded in the application (see
// patches/privacy/protections) to the default adblock engine. Needs no
// component updater and makes no network request.
class AdBlockBundledFiltersProvider : public AdBlockFiltersProvider {
 public:
  explicit AdBlockBundledFiltersProvider(AdBlockFiltersProviderManager* manager);
  ~AdBlockBundledFiltersProvider() override;
  AdBlockBundledFiltersProvider(const AdBlockBundledFiltersProvider&) = delete;
  AdBlockBundledFiltersProvider& operator=(
      const AdBlockBundledFiltersProvider&) = delete;

  // AdBlockFiltersProvider
  void LoadFilterSet(
      base::OnceCallback<void(
          base::OnceCallback<void(rust::Box<adblock::FilterSet>*)>)>) override;
  std::string GetNameForDebugging() override;

 private:
  base::WeakPtrFactory<AdBlockBundledFiltersProvider> weak_factory_{this};
};

}  // namespace brave_shields

#endif  // BRAVE_COMPONENTS_BRAVE_SHIELDS_CONTENT_BROWSER_AD_BLOCK_BUNDLED_FILTERS_PROVIDER_H_
""")

ids = "".join(f"    {ident(o['file'])},\n" for o in manifest["lists"] if o.get("kind", "list") == "list")
write(S + "ad_block_bundled_filters_provider.cc", HEADER + """
#include "brave/components/brave_shields/content/browser/ad_block_bundled_filters_provider.h"

#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/task/thread_pool.h"
#include "components/grit/brave_components_resources.h"
#include "ui/base/resource/resource_bundle.h"

namespace brave_shields {

namespace {

constexpr int kBundledLists[] = {
""" + ids + """};

std::vector<std::string> ReadBundledLists() {
  std::vector<std::string> lists;
  auto& bundle = ui::ResourceBundle::GetSharedInstance();
  for (int id : kBundledLists) {
    // LoadDataResourceString() transparently inflates gzip resources.
    std::string list = bundle.LoadDataResourceString(id);
    if (list.empty()) {
      LOG(ERROR) << "AUREN_PROTECTIONS: bundled list " << id << " is empty";
      continue;
    }
    lists.push_back(std::move(list));
  }
  return lists;
}

void AddBundledLists(std::vector<std::string> lists,
                     rust::Box<adblock::FilterSet>* filter_set) {
  for (const std::string& list : lists) {
    (*filter_set)
        ->add_filter_list(std::vector<uint8_t>(list.begin(), list.end()));
  }
  LOG(ERROR) << "AUREN_PROTECTIONS: loaded " << lists.size()
             << " bundled filter lists";
}

void OnListsRead(
    base::OnceCallback<
        void(base::OnceCallback<void(rust::Box<adblock::FilterSet>*)>)> cb,
    std::vector<std::string> lists) {
  std::move(cb).Run(base::BindOnce(&AddBundledLists, std::move(lists)));
}

}  // namespace

AdBlockBundledFiltersProvider::AdBlockBundledFiltersProvider(
    AdBlockFiltersProviderManager* manager)
    : AdBlockFiltersProvider(true, manager) {
  NotifyObservers(engine_is_default_);
}

AdBlockBundledFiltersProvider::~AdBlockBundledFiltersProvider() = default;

std::string AdBlockBundledFiltersProvider::GetNameForDebugging() {
  return "AdBlockBundledFiltersProvider";
}

void AdBlockBundledFiltersProvider::LoadFilterSet(
    base::OnceCallback<
        void(base::OnceCallback<void(rust::Box<adblock::FilterSet>*)>)> cb) {
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&ReadBundledLists),
      base::BindOnce(&OnListsRead, std::move(cb)));
}

}  // namespace brave_shields
""")

# --- build + service wiring ---------------------------------------------------------------------------------------
edit(S + "BUILD.gn",
     '    "ad_block_custom_filter_reset_util.cc",\n',
     '    "ad_block_bundled_filters_provider.cc",\n    "ad_block_bundled_filters_provider.h",\n'
     '    "ad_block_custom_filter_reset_util.cc",\n',
     marker='"ad_block_bundled_filters_provider.cc"')
edit(S + "BUILD.gn",
     '    "//third_party/blink/public/mojom:mojom_platform_headers",\n    "//url",\n',
     '    "//third_party/blink/public/mojom:mojom_platform_headers",\n    "//ui/base",\n    "//url",\n',
     marker='    "//ui/base",')
edit(S + "ad_block_service.h",
     "class AdBlockLocalhostFiltersProvider;\n",
     "class AdBlockBundledFiltersProvider;\nclass AdBlockLocalhostFiltersProvider;\n",
     marker="class AdBlockBundledFiltersProvider;")
edit(S + "ad_block_service.h",
     "  std::unique_ptr<AdBlockLocalhostFiltersProvider> localhost_filters_provider_\n"
     "      GUARDED_BY_CONTEXT(sequence_checker_);\n",
     "  std::unique_ptr<AdBlockLocalhostFiltersProvider> localhost_filters_provider_\n"
     "      GUARDED_BY_CONTEXT(sequence_checker_);\n"
     "  std::unique_ptr<AdBlockBundledFiltersProvider> bundled_filters_provider_\n"
     "      GUARDED_BY_CONTEXT(sequence_checker_);\n",
     marker="bundled_filters_provider_")
edit(S + "ad_block_service.cc",
     '#include "brave/components/brave_shields/content/browser/ad_block_custom_filters_provider.h"\n',
     '#include "brave/components/brave_shields/content/browser/ad_block_bundled_filters_provider.h"\n'
     '#include "brave/components/brave_shields/content/browser/ad_block_custom_filters_provider.h"\n',
     marker="ad_block_bundled_filters_provider.h")
edit(S + "ad_block_service.cc",
     "  custom_filters_provider_ = std::make_unique<AdBlockCustomFiltersProvider>(\n"
     "      local_state_, filters_provider_manager_.get());\n",
     "  custom_filters_provider_ = std::make_unique<AdBlockCustomFiltersProvider>(\n"
     "      local_state_, filters_provider_manager_.get());\n"
     "  // Auren: lists shipped inside the app; no component updater needed.\n"
     "  bundled_filters_provider_ = std::make_unique<AdBlockBundledFiltersProvider>(\n"
     "      filters_provider_manager_.get());\n",
     marker="bundled_filters_provider_ = std::make_unique")

# --- data that Brave normally receives as components: debounce rules, URL cleaning, query filter -------------------
# The component updater is off, so these would stay empty. Each hook loads the bundled copy through the same parser
# the component path uses (DebounceComponentInstaller::OnDATFileDataReady, URLSanitizerComponentInstaller::
# OnRawConfigReady, QueryFilterData::PopulateDataFromComponent).
RB_INC = '#include "components/grit/brave_components_resources.h"\n#include "ui/base/resource/resource_bundle.h"\n'
GRIT_DEP = '"//brave/components/resources:static_resources_grit",'

D = "components/debounce/core/browser/"
edit(D + "debounce_component_installer.cc",
     '#include "brave/components/brave_component_updater/browser/local_data_files_service.h"\n',
     '#include "brave/components/brave_component_updater/browser/local_data_files_service.h"\n' + RB_INC,
     marker='#include "ui/base/resource/resource_bundle.h"')
edit(D + "debounce_component_installer.cc",
     "    : LocalDataFilesObserver(local_data_files_service) {}\n",
     "    : LocalDataFilesObserver(local_data_files_service) {\n"
     "  // Auren: rules shipped inside the app (no component updater). Observers added later read rules() on demand.\n"
     "  OnDATFileDataReady(ui::ResourceBundle::GetSharedInstance().LoadDataResourceString(\n"
     "      " + idr("debounce.json") + "));\n"
     "}\n",
     marker="OnDATFileDataReady(ui::ResourceBundle::GetSharedInstance()")
edit(D + "BUILD.gn", '    "//brave/components/debounce/core/common",\n',
     '    "//brave/components/debounce/core/common",\n    ' + GRIT_DEP + '\n', marker=GRIT_DEP)

U = "components/url_sanitizer/core/browser/"
edit(U + "url_sanitizer_component_installer.cc",
     "using brave_component_updater::LocalDataFilesObserver;\n",
     RB_INC + "\nusing brave_component_updater::LocalDataFilesObserver;\n",
     marker='#include "ui/base/resource/resource_bundle.h"')
edit(U + "url_sanitizer_component_installer.cc",
     "    : LocalDataFilesObserver(local_data_files_service) {}\n",
     "    : LocalDataFilesObserver(local_data_files_service) {\n"
     "  // Auren: URL-cleaning rules shipped inside the app (no component updater). AddObserver() replays current_config_.\n"
     "  auto& rb = ui::ResourceBundle::GetSharedInstance();\n"
     "  RawConfig config;\n"
     "  config.matchers = rb.LoadDataResourceString(" + idr("clean-urls.json") + ");\n"
     "  config.permissions = rb.LoadDataResourceString(" + idr("clean-urls-permissions.json") + ");\n"
     "  OnRawConfigReady(std::move(config));\n"
     "}\n",
     marker="OnRawConfigReady(std::move(config));\n}")
edit(U + "BUILD.gn", '    "//brave/components/brave_component_updater/browser",\n    "//brave/extensions:common",\n    "//components/keyed_service/core",\n    "//net",\n    "//url",\n  ]\n}\n\nsource_set("unit_tests")',
     '    "//brave/components/brave_component_updater/browser",\n    "//brave/extensions:common",\n    ' + GRIT_DEP + '\n    "//components/keyed_service/core",\n    "//net",\n    "//ui/base",\n    "//url",\n  ]\n}\n\nsource_set("unit_tests")',
     marker=GRIT_DEP)

Q = "components/query_filter/browser/"
edit(Q + "query_filter_component_installer.cc",
     '#include "components/component_updater/component_updater_service.h"\n',
     '#include "components/component_updater/component_updater_service.h"\n' + RB_INC,
     marker='#include "ui/base/resource/resource_bundle.h"')
edit(Q + "query_filter_component_installer.cc",
     """      !cus) {
    return;
  }

  auto installer = base::MakeRefCounted<component_updater::ComponentInstaller>(""",
     """      !cus) {
    return;
  }

  // Auren: query-filter rules shipped inside the app (no component updater).
  OnQueryFilterFileRead(base::Version("1.0.0"),
                        ui::ResourceBundle::GetSharedInstance().LoadDataResourceString(
                            """ + idr("query-filter.json") + """));

  auto installer = base::MakeRefCounted<component_updater::ComponentInstaller>(""",
     marker="Auren: query-filter rules shipped inside the app")
edit(Q + "BUILD.gn", '    "//brave/components/query_filter/common/internal",\n    "//components/url_pattern_index",\n',
     '    "//brave/components/query_filter/common/internal",\n    ' + GRIT_DEP + '\n    "//components/url_pattern_index",\n    "//ui/base",\n',
     marker=GRIT_DEP)
print("done")
