# Optional fingerprint patches

Not part of the default set (`../brave/*.patch`) because each one is a **policy decision with a trade-off**, not
a plain bug fix. Apply on purpose, in `~/brave-src/src/brave`: `git apply --check <patch> && git apply <patch>`.

## 0009-disable-usb-hid-serial-bluetooth.patch

Starts every renderer with `--disable-blink-features=WebUSB,WebHID,Serial,WebBluetooth` (their worker variants
depend on them and go too). Implements the policy row "battery, WebUSB/HID/Serial/Bluetooth/MIDI, sensors:
should be absent" (`docs/privacy/fingerprinting/policy.md`) for the four device-pairing APIs.

* **For:** these APIs have no use for passive browsing and reveal nothing unless the user grants a device, but
  their presence is another bit of the API surface.
* **Against:** stock Chrome has them, so *removing* them makes Auren differ from the Chrome crowd it otherwise
  imitates (UA, brands, screen, ...). It also breaks sites that flash or pair devices (WebUSB flashers, Web
  Serial consoles, some hardware dashboards).
* The harness check `hardware.*` should flip from "present" to "absent" for these four after a build.
* A user-supplied `--disable-blink-features` on the browser wins (it is propagated to renderers after this runs).

Not included on purpose: MIDI (permission-gated, not behind a runtime feature), the Generic Sensor classes
(exposed unconditionally, as in stock Chrome), Local Font Access (permission-gated).

Apply-checked against brave-core v1.94.97 (Chromium 151.0.7922.47) with and without fingerprint patch 0006
(same file, different hunk). Not compiled.
