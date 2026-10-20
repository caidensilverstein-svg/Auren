# Patch notes

Patches: `patches/privacy/fingerprint/brave/*.patch`, apply in `~/brave-src/src/brave` with `git apply` (order irrelevant, disjoint files). Regenerate with
`python3 patches/privacy/fingerprint/gen/make_patches.py --brave-root ~/brave-src/src/brave --out <dir>` (fails loudly if an anchor moved).
**Verification status of all of them: `git apply --check` passes, individually and together, against the Mac working tree (which already carries the telemetry agent's edits)
as of 2026-10-20. NOTHING was compiled or run** (build rule). C++ was reviewed against surrounding code and header signatures
(`ScreenInfo::depth`, `String(const char*)`, `String::Ascii`, `UserAgentMetadata::platform_version` confirmed present), but compile errors are possible.

| # | Files | Effect | Harness checks that must flip to PASS |
|---|---|---|---|
| 0001 | `brave_session_cache.h` (+`brave::auren_policy` constants), `navigator_base.cc`, `navigator_device_memory.cc`, `navigator_language.cc` | hardwareConcurrency=8, deviceMemory=8 when protection on (workers/iframes too); languages `[first, base]` | nav.hardwareConcurrency, nav.deviceMemory, nav.languages, consistency.worker_*/iframe_*_equal |
| 0002 | `dom_plugin_array.cc` | no fake/renamed/shuffled plugins | nav.plugins_standard_five, nav.plugin_names, consistency.plugins_* |
| 0003 | `speech_synthesis.cc` | empty voice list at every non-OFF level | speech.voices_hidden, class.speech |
| 0004 | `webgl_rendering_context_base.cc`, `webgl2_...cc`, `gpu_adapter.cc` | unmasked vendor/renderer constants; no `-1` limit perturbation; WebGPU vendor/arch scrubbed | webgl.renderer_target/vendor_target, webgl2.renderer_target, webgpu.info_*, class.webgl (limits no longer vary) |
| 0005 | `local_dom_window.cc`, `media_values.cc`, `brave_session_cache.cc`, `chrome_client_impl.cc` | outer*/screenX/Y/device-* = viewport; screen.* = viewport; colorDepth 24; avail origin 0 | screen.outer_equals_inner, window_origin_zero, avail_*_zero, colorDepth, screen_equals_inner, consistency.screen_matches_media_query |
| 0006 | `user_agent_utils.cc`, `brave_content_browser_client.cc` | brand `Google Chrome`; platformVersion `major.0.0` | uach.brand_*, uach.no_brave_auren_brand, uach.platformVersion_coarse, headers.no_brave_in_ch, consistency.brands_/fullVersionList_ |
| 0007 | `brave_reduce_language_network_delegate_helper.cc` | `Accept-Language: <first>,<base>;q=0.9` | headers.accept_language, consistency.accept_language_matches_navigator_languages |
| 0008 | `idl_member_installer.cc` | `Navigator.brave`/`WorkerNavigator.brave` never installed | nav.no_navigator_brave, consistency.no_navigator_brave/worker_no_navigator_brave |

Repo-source edits (not Brave-tree patches; need the usual sync to the Mac tree):
- `browser/ui/views/side_panel/auren/auren_side_panel_web_view.cc`: UA override removed (was `Chrome/138`). **Unverified: claude.ai / Google login in the panel after this change** - test manually.
- `browser/ui/webui/auren/*` + `auren_new_tab_ui.cc`: honest fingerprint indicator (checklist n/m + last measured audit, tooltip "not a uniqueness score"). Mojom field `fingerprint_score` replaced by `fingerprint_protections_{active,total,missing}`; BUILD.gn gains deps `//chrome/common:constants`, `//components/prefs`, `//third_party/blink/public/common`. Uncompiled; generated mojom must be rebuilt.

Known behavioural notes: with Shields off for a site (incl. the claude.ai panel) none of these apply. `0005` assumes `outerWidth()` (now = top innerWidth) is positive; zero-sized frames keep upstream screen rect.
Interaction with 0006: Brave's `GetUserAgentMetadata` DCHECKs 3 brands - unchanged (still Chromium, brand, GREASE).

Not patched (see open-risks): wallet provider globals, battery/USB/HID/Serial/Bluetooth/MIDI/sensors, performance.memory, canvas read-back limiting, letterboxing, WebGPU limits bucketing, timezone strict mode.
