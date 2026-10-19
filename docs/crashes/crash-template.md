
## Template for Future Crashes

```markdown
## CRASH-XX — [Short Title]

**Severity:** 🔴 P0 / 🟡 P1 / 🟢 P2
**Type:** EXC_CRASH (SIGABRT) / EXC_BAD_ACCESS / other
**First Seen:** [Date]
**Incident ID:** [From crash report header]
**Process Uptime at Crash:** [Elapsed time]

### What Happened
[1–2 sentence summary]

### Crash Stack (key frames)
[Relevant frames only]

### Root Cause
[What the code was doing, why it failed, Auren-specific or upstream]

### Triggering Conditions
[What page, what action, reproducible?]

### Fix Options
[A, B, C]

### Fix Applied
[What was done, commit SHA, files changed]

### Files to Investigate
[Source paths]
```
