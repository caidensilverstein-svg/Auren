#!/usr/bin/env python3
"""Add Chrome's on-device AI model component to the features Auren disables at startup.

usage: apply_features.py /path/to/src/brave      (the Brave tree, e.g. ~/brave-src/src/brave)

Found 2026-10-22 with the firewall's block log: a fresh profile still tried `update.googleapis.com/service/update2/json` for the
component app id ceofaddefefcbblgcgnibnonglccbfja, which is the optimization-guide on-device model installer
(chrome/browser/component_updater/optimization_guide_on_device_model_installer.cc). The firewall blocked it, but the attempt itself
should not be made. AppendAurenPrivacyOptions() already disables OptimizationHints and OptimizationGuideModelExecution; this adds
OptimizationGuideOnDeviceModel. Idempotent; the anchor must match exactly once.
"""
import os
import sys

p = os.path.join(sys.argv[1], "app/brave_main_delegate.cc")
s = open(p).read()
marker = '"OptimizationGuideOnDeviceModel,"'
if marker in s:
    print("skip   OptimizationGuideOnDeviceModel already disabled")
    sys.exit(0)
old = '''      "OptimizationHints,OptimizationGuideModelExecution,"
'''
new = '''      "OptimizationHints,OptimizationGuideModelExecution,"
      "OptimizationGuideOnDeviceModel,"
'''
assert s.count(old) == 1, s.count(old)
open(p, "w").write(s.replace(old, new))
print("edited app/brave_main_delegate.cc: + OptimizationGuideOnDeviceModel")
