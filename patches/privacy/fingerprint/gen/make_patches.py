#!/usr/bin/env python3
"""Regenerates patches/privacy/fingerprint/brave/*.patch from declarative edits.

Why a generator: the patches must apply to the *exact* working tree of the Mac
build (which already carries Auren/telemetry modifications). Hand-written unified
diffs drift; this script reads the real files, applies exact-match edits, fails
loudly when an anchor is missing or ambiguous, and emits `git apply`-able diffs.

Usage (read-only for the tree; writes only to --out and a temp dir):
    python3 make_patches.py --brave-root ~/brave-src/src/brave --out /tmp/fp-patches
    (cd ~/brave-src/src/brave && git apply --check /tmp/fp-patches/*.patch)

Edit ops:
    ("replace", old, new[, count])   exact substring replace; `count` occurrences expected (default 1)
    ("between", start, end, new)     replace from the line containing `start` up to (not including) the
                                     first line containing `end` that follows it
"""
import argparse
import difflib
import os
import re
import sys
import tempfile

P = []  # list of (patch_name, description, {path: [ops]})

# ---------------------------------------------------------------------------
# 0001: policy constants + navigator numeric values + languages
# ---------------------------------------------------------------------------
P.append(("0001-policy-constants-and-navigator-values",
          "Auren fingerprint policy constants; constant hardwareConcurrency/deviceMemory; "
          "languages = [first, base] (matches Accept-Language).",
          {
              "third_party/blink/renderer/core/farbling/brave_session_cache.h": [
                  ("replace", "using blink::Supplement;\n",
                   """using blink::Supplement;

// Auren fingerprint policy constants (docs/privacy/fingerprinting/policy.md).
// They are reported whenever Shields fingerprinting protection is not OFF for
// the context, instead of per-site random values.
namespace auren_policy {
inline constexpr unsigned kHardwareConcurrency = 8;
inline constexpr float kDeviceMemoryGb = 8.0f;
inline constexpr char kWebGlUnmaskedVendor[] = "Google Inc. (Apple)";
inline constexpr char kWebGlUnmaskedRenderer[] =
    "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)";
}  // namespace auren_policy
"""),
              ],
              "chromium_src/third_party/blink/renderer/core/execution_context/navigator_base.cc": [
                  ("between", "void ApplyBraveHardwareConcurrencyOverride(blink::ExecutionContext* context,",
                   "}  // namespace blink::probe",
                   """void ApplyBraveHardwareConcurrencyOverride(blink::ExecutionContext* context,
                                           unsigned int* hardware_concurrency) {
  // Auren: one constant, identical in every context (main thread, workers,
  // iframes) instead of a per-site random value. Random values below the real
  // core count (3 or 9 on a 10-core Mac) are numbers no real machine reports
  // and are trivially detectable.
  if (brave::GetBraveFarblingLevelFor(
          context, ContentSettingsType::BRAVE_WEBCOMPAT_HARDWARE_CONCURRENCY,
          BraveFarblingLevel::OFF) != BraveFarblingLevel::OFF) {
    *hardware_concurrency = brave::auren_policy::kHardwareConcurrency;
  }
}
"""),
              ],
              "chromium_src/third_party/blink/renderer/core/frame/navigator_device_memory.cc": [
                  ("between", "float FarbleDeviceMemory(blink::ExecutionContext* context) {",
                   "}  // namespace brave",
                   """float FarbleDeviceMemory(blink::ExecutionContext* context) {
  const float true_value =
      blink::ApproximatedDeviceMemory::GetApproximatedDeviceMemory();
  // Auren: constant policy value whenever fingerprinting protection is on.
  if (brave::GetBraveFarblingLevelFor(
          context, ContentSettingsType::BRAVE_WEBCOMPAT_DEVICE_MEMORY,
          BraveFarblingLevel::OFF) == BraveFarblingLevel::OFF) {
    return true_value;
  }
  return brave::auren_policy::kDeviceMemoryGb;
}
"""),
              ],
              "chromium_src/third_party/blink/renderer/core/frame/navigator_language.cc": [
                  ("between", "void NavigatorLanguage::EnsureUpdatedLanguage() {", "}  // namespace blink",
                   """void NavigatorLanguage::EnsureUpdatedLanguage() {
  NavigatorLanguage_ChromiumImpl::EnsureUpdatedLanguage();
  BraveFarblingLevel farbling_level = brave::GetBraveFarblingLevelFor(
      execution_context_, ContentSettingsType::BRAVE_WEBCOMPAT_LANGUAGE,
      BraveFarblingLevel::OFF);
  // If Brave Shields are down or anti-fingerprinting is off for this site,
  // do nothing.
  if (farbling_level == BraveFarblingLevel::OFF)
    return;
  if (farbling_level == BraveFarblingLevel::MAXIMUM) {
    // If anti-fingerprinting is at maximum, override the entire language list
    // regardless of locale or other settings.
    languages_.clear();
    languages_.push_back("en-US");
    languages_.push_back("en");
  } else {
    // Auren: [first language, its base language] - exactly what the
    // Accept-Language header carries (see
    // brave_reduce_language_network_delegate_helper.cc) and what stock Chrome
    // reports for a one-language profile ("en-US" -> ["en-US", "en"]).
    // (Note: this method requires a non-empty list, which the upstream code
    // guarantees.)
    languages_.Shrink(1);
    const std::string first = languages_[0].Utf8();
    const size_t dash = first.find('-');
    if (dash != std::string::npos && dash > 0) {
      languages_.push_back(String(first.substr(0, dash).c_str()));
    }
  }
}
"""),
              ],
          }))

# ---------------------------------------------------------------------------
P.append(("0002-plugins-standard-list",
          "navigator.plugins: stop adding fake plugins / renaming / shuffling; report Chrome's real PDF list.",
          {
              "chromium_src/third_party/blink/renderer/modules/plugins/dom_plugin_array.cc": [
                  ("between", "void FarblePlugins(blink::LocalDOMWindow* window,", "}  // namespace brave",
                   """void FarblePlugins(blink::LocalDOMWindow* window,
                   HeapVector<Member<DOMPlugin>>& dom_plugins) {
  // Auren: deliberately a no-op. Stock Chrome reports the five built-in PDF
  // plugins and every Chrome user shares that list; random fake plugins,
  // renamed PDF plugins and a shuffled order produce lists that exist in no
  // real browser and are trivially detectable (see harness check
  // consistency.plugins_are_chrome_standard_five).
  (void)window;
  (void)dom_plugins;
}
"""),
              ],
          }))

# ---------------------------------------------------------------------------
P.append(("0003-speech-voices-hidden",
          "speechSynthesis.getVoices(): empty list whenever protection is on (no real + fake voice mix).",
          {
              "chromium_src/third_party/blink/renderer/modules/speech/speech_synthesis.cc": [
                  ("replace", "  if (farbling_level == BraveFarblingLevel::MAXIMUM) {",
                   "  // Auren: hide the installed-voice list (181 entries on macOS 26: a high-entropy\n"
                   "  // OS/language fingerprint) at every non-OFF level.\n"
                   "  if (farbling_level != BraveFarblingLevel::OFF) {"),
              ],
          }))

# ---------------------------------------------------------------------------
P.append(("0004-webgl-webgpu-uniform-values",
          "WebGL unmasked vendor/renderer = fixed policy pair; no impossible WebGL2 limit perturbation; "
          "WebGPU adapter vendor/architecture scrubbed at BALANCED too.",
          {
              "chromium_src/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc": [
                  ("between", "  switch (level) {", "    default:",
                   """  switch (level) {
    case BraveFarblingLevel::OFF:
      return original_script_value;
    case BraveFarblingLevel::BALANCED:
    case BraveFarblingLevel::MAXIMUM:
      // Auren: one fixed, plausible ANGLE/Metal pair for every user instead of
      // the real GPU string, the literal "Brave", or a random 8-char string.
      (void)kUnmaskedVendorWebGL;
      (void)kUnmaskedRendererWebGL;
      return blink::WebGLAny(
          script_state,
          blink::String(type == WebGLDebugRendererInfoType::VENDOR
                            ? brave::auren_policy::kWebGlUnmaskedVendor
                            : brave::auren_policy::kWebGlUnmaskedRenderer));
"""),
              ],
              "chromium_src/third_party/blink/renderer/modules/webgl/webgl2_rendering_context_base.cc": [
                  ("replace", "      value = value - 1;",
                   "      // Auren: deliberately unmodified. Reporting 31 for a limit the GPU\n"
                   "      // reports as 32 (varying per site) is an impossible value.", 2),
              ],
              "chromium_src/third_party/blink/renderer/modules/webgpu/gpu_adapter.cc": [
                  ("between", "      case BraveFarblingLevel::BALANCED:", "      case BraveFarblingLevel::MAXIMUM:",
                   """      case BraveFarblingLevel::BALANCED:
        // Auren: scrub vendor/architecture/device unconditionally (upstream only
        // does so behind kWebGLBalancedFingerprintingProtection, off by default).
        return String();
"""),
              ],
          }))

# ---------------------------------------------------------------------------
P.append(("0005-screen-viewport-consistency",
          "window.outer*/screenX/Y, matchMedia(device-*), screen.* all equal the viewport (no random 0..8 offsets, "
          "no menu-bar geometry); colorDepth 24.",
          {
              "chromium_src/third_party/blink/renderer/core/frame/local_dom_window.cc": [
                  ("replace", "top_window->innerWidth(), 0, 8)", "top_window->innerWidth(), 0, 0)"),
                  ("replace", "top_window->innerHeight(), 0, 8)", "top_window->innerHeight(), 0, 0)"),
                  ("replace", "brave::FarbleKey::kWindowScreenX, 0, 0, 8)", "brave::FarbleKey::kWindowScreenX, 0, 0, 0)"),
                  ("replace", "brave::FarbleKey::kWindowScreenY, 0, 0, 8)", "brave::FarbleKey::kWindowScreenY, 0, 0, 0)"),
              ],
              "chromium_src/third_party/blink/renderer/core/css/media_values.cc": [
                  ("replace", "CalculateViewportWidth(top_frame), 0, 8)", "CalculateViewportWidth(top_frame), 0, 0)"),
                  ("replace", "CalculateViewportHeight(top_frame), 0, 8)", "CalculateViewportHeight(top_frame), 0, 0)"),
              ],
              "third_party/blink/renderer/core/farbling/brave_session_cache.cc": [
                  ("replace", "return FarbleInteger(context, key, zoom_factor * client_coordinate, 0, 8);",
                   "return FarbleInteger(context, key, zoom_factor * client_coordinate, 0, 0);"),
              ],
              "chromium_src/third_party/blink/renderer/core/page/chrome_client_impl.cc": [
                  ("replace", "  screen_info.available_rect = screen_info.rect;",
                   """  // Auren: report the viewport (which every page can read anyway through
  // innerWidth/innerHeight) instead of a bucketed screen so that screen.*,
  // outer*, and matchMedia(device-width/height) agree; no display size,
  // menu-bar or dock geometry leaks.
  if (outerWidth > 0 && outerHeight > 0) {
    screen_info.rect = gfx::Rect(outerWidth, outerHeight);
  }
  screen_info.depth = 24;
  screen_info.depth_per_component = 8;
  screen_info.available_rect = screen_info.rect;"""),
              ],
          }))

# ---------------------------------------------------------------------------
P.append(("0006-uach-brand-and-platform-version",
          "UA-CH brand list: 'Google Chrome' instead of 'Brave' (JS + Sec-CH-UA header share one source); "
          "platformVersion reduced to major.0.0.",
          {
              "chromium_src/components/embedder_support/user_agent_utils.cc": [
                  ("replace", 'constexpr char kBraveBrandNameForCHUA[] = "Brave";',
                   '// Auren: do not announce the Brave brand; blend into the Chrome brand list.\n'
                   'constexpr char kBraveBrandNameForCHUA[] = "Google Chrome";'),
              ],
              "browser/brave_content_browser_client.cc": [
                  ("replace",
                   '      base::StrCat({base::NumberToString(version.components()[0]), ".0.0.0"});\n  return metadata;\n}',
                   '      base::StrCat({base::NumberToString(version.components()[0]), ".0.0.0"});\n'
                   '  // Auren: platformVersion reduced to the OS major version ("26.6.2" -> "26.0.0").\n'
                   '  base::Version platform_version(metadata.platform_version);\n'
                   '  if (platform_version.IsValid()) {\n'
                   '    metadata.platform_version = base::StrCat(\n'
                   '        {base::NumberToString(platform_version.components()[0]), ".0.0"});\n'
                   '  }\n'
                   '  return metadata;\n}'),
              ],
          }))

# ---------------------------------------------------------------------------
P.append(("0007-accept-language-fixed-q",
          "Accept-Language: fixed ';q=0.9' (stock Chrome shape) instead of a random q per site/session.",
          {
              "browser/net/brave_reduce_language_network_delegate_helper.cc": [
                  ("between", "  // Add a fake q value after the language code.", "  return accept_language_string;",
                   """  // Auren: fixed q-value, identical to stock Chrome ("en-US,en;q=0.9"). A random q
  // per site/session (upstream Brave) is itself a signal and disagrees with
  // navigator.languages.
  accept_language_string += ";q=0.9";
"""),
              ],
          }))

# ---------------------------------------------------------------------------
P.append(("0008-remove-navigator-brave",
          "Do not install Navigator.brave / WorkerNavigator.brave (brave.isBrave()).",
          {
              "chromium_src/third_party/blink/renderer/platform/bindings/idl_member_installer.cc": [
                  ("replace", "  return kConnection == config.property_name;\n}",
                   "  return kConnection == config.property_name;\n}\n\n"
                   "// Auren: never expose navigator.brave / WorkerNavigator.brave (brand leak).\n"
                   "bool IsBraveConfig(const IDLMemberInstaller::AttributeConfig& config) {\n"
                   "  constexpr std::string_view kBrave = \"brave\";\n"
                   "  return kBrave == config.property_name;\n}"),
                  ("replace", "if (!connection_attribute_enabled && IsConnectionConfig(config)) {",
                   "if ((!connection_attribute_enabled && IsConnectionConfig(config)) ||\n        IsBraveConfig(config)) {", 2),
              ],
          }))


def apply_ops(text, ops, path):
    for op in ops:
        kind = op[0]
        if kind == "replace":
            old, new = op[1], op[2]
            count = op[3] if len(op) > 3 else 1
            n = text.count(old)
            if n != count:
                raise SystemExit(f"[{path}] anchor occurs {n}x (expected {count}): {old[:80]!r}")
            text = text.replace(old, new)
        elif kind == "between":
            start, end, new = op[1], op[2], op[3]
            if text.count(start) != 1:
                raise SystemExit(f"[{path}] start anchor occurs {text.count(start)}x: {start[:80]!r}")
            si = text.index(start)
            si = text.rfind("\n", 0, si) + 1  # beginning of that line
            ei = text.find(end, si + len(start))
            if ei < 0:
                raise SystemExit(f"[{path}] end anchor missing after start: {end[:80]!r}")
            ei = text.rfind("\n", 0, ei) + 1
            text = text[:si] + new + text[ei:]
        else:
            raise SystemExit("bad op " + kind)
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--brave-root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default=None)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    for name, desc, files in P:
        if a.only and a.only not in name:
            continue
        chunks = []
        for path, ops in files.items():
            src = os.path.join(a.brave_root, path)
            with open(src, encoding="utf-8") as f:
                old = f.read()
            new = apply_ops(old, ops, path)
            if new == old:
                raise SystemExit(f"[{path}] edit produced no change")
            diff = difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True),
                                        fromfile="a/" + path, tofile="b/" + path, n=3)
            body = "".join(diff)
            if not old.endswith("\n") or not new.endswith("\n"):
                raise SystemExit(f"[{path}] file lacks trailing newline; not supported by this generator")
            chunks.append(f"diff --git a/{path} b/{path}\n" + body)
        header = "# " + name + "\n# " + "\n# ".join(re.findall(r".{1,100}(?:\s|$)", desc)) + "\n# Apply in the brave/ repo root: git apply <this file>\n\n"
        with open(os.path.join(a.out, name + ".patch"), "w", encoding="utf-8") as f:
            f.write(header + "".join(chunks))
        print("wrote", name, len(files), "file(s)")


if __name__ == "__main__":
    main()
