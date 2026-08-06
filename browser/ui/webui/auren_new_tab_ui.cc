/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/ui/webui/auren_new_tab_ui.h"

#include <string>

#include "base/memory/ref_counted_memory.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "services/network/public/mojom/content_security_policy.mojom-shared.h"

namespace {

constexpr char kAurenNewTabHtml[] = R"(<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>New Tab</title>
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body {
    background: #0e0e0e;
    font-family: -apple-system, system-ui, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .wordmark {
    font-size: 40px;
    font-weight: 700;
    letter-spacing: 0.35em;
    color: #c9a84c;
    user-select: none;
  }
</style>
</head>
<body>
  <div class="wordmark">AUREN</div>
</body>
</html>
)";

constexpr char kFaviconSvg[] =
    R"(<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">)"
    R"(<rect width="100" height="100" fill="#0e0e0e"/>)"
    R"(<text x="50" y="72" font-size="80" text-anchor="middle" )"
    R"(fill="#c9a84c" font-family="serif">A</text></svg>)";

}  // namespace

AurenNewTabUI::AurenNewTabUI(content::WebUI* web_ui)
    : content::WebUIController(web_ui) {
  auto* source = content::WebUIDataSource::CreateAndAdd(
      Profile::FromWebUI(web_ui), "newtab");

  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::StyleSrc,
      "style-src 'self' 'unsafe-inline';");
  source->DisableTrustedTypesCSP();

  source->SetRequestFilter(
      base::BindRepeating([](const std::string&) { return true; }),
      base::BindRepeating([](const std::string& path,
                             content::WebUIDataSource::GotDataCallback cb) {
        if (path == "favicon.svg") {
          std::move(cb).Run(
              base::MakeRefCounted<base::RefCountedString>(kFaviconSvg));
        } else {
          std::move(cb).Run(
              base::MakeRefCounted<base::RefCountedString>(kAurenNewTabHtml));
        }
      }));
}

AurenNewTabUI::~AurenNewTabUI() = default;
