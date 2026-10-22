# Browser performance harness and first measurements (2026-10-22)

`scripts/perf/run.js` (zero dependencies, Node >= 22) measures any Chromium binary through its debugging port, each run on a fresh throwaway profile:

| test | what it records |
|---|---|
| `startup` | spawn to CDP up, and to the first page `readyState=complete`; median of N runs |
| `memory` | resident memory summed over the whole process tree after 30 s idle, by process type; and with one page open. Summed RSS overcounts shared pages: compare builds on the same machine only |
| `pageload` | 12 real sites (`urls.txt`), N runs each, cache disabled: load time, LCP, requests, blocked requests, bytes. A hung or crashed page is recorded as an error, not a crash of the harness |
| `speedometer`, `jetstream` | the public benchmarks, started and read over CDP |

## What was measured (same Mac, back to back, Apple M4 / 16 GB)

| | stock Chrome 155 (official PGO/LTO build) | Auren **dev** build |
|---|---:|---:|
| startup to first page (median of 5) | 366 ms | 1,660 ms |
| idle memory, process tree | 1,287 MB (11 processes) | 1,555 MB (9 processes) |
| Speedometer 3.1 | 56.5 | 9.7 |
| 12-site page load, median of medians | 854 ms | 2,315 ms |
| requests issued on those sites | 2,062 | 890 (72 blocked) |
| bytes transferred | 65.1 MB | 41.3 MB |

**Read this table with the build in mind.** The Auren dev build is a component build (every library a separate dylib), has `dcheck_always_on = true`
(Brave's default for non-official builds), and no PGO or LTO. It exists to iterate quickly, and its speed says nothing about what Auren can do:
Speedometer 6x slower and startup 4.5x slower are what DCHECKs plus a component build typically cost. The requests/bytes rows are more meaningful:
the same pages issue less than half the requests and move about 37% fewer bytes, because blocked trackers also stop the requests they would have made
(live pages vary between runs, so treat the exact ratios loosely).

A release flavour was queued the same night for the fair comparison: `out/auren-fast` with `is_component_build=false`, `dcheck_always_on=false`,
no symbols, the Chromium PGO profile applied (`tools/update_pgo_profiles.py`), `enable_sparkle=false` and `v8_builtins_profiling_log_file=""` (both
needed because the corresponding hook-downloaded files are absent). It is about 75,000 build steps. LTO and `is_official_build` are deliberately off
(hours of extra link time, and the disk for a second output directory is limited). When it finishes, rerun `run.js ... --label auren-release all`;
the report page and the demo video read `perf/out/auren-release-*.json` automatically.

## Stability finding

`nytimes.com` crashed the renderer in the dev build during the page-load run (the harness now records `renderer crashed` instead of dying with a CDP
timeout, which is what the first attempt did). Three isolated visits to the same page afterwards, with logging on, produced no crash and no FATAL.
At the time of the failed run the Mac was running a 75,000-step release build, a unit-test build and several browsers at once and reported about
66 MB of free memory, so a memory-pressure kill is the likely explanation. **Unconfirmed**: a crash dump was not captured. Rerun page load on an idle Mac
before treating it as a bug or as noise.

## Reproduce

```
node scripts/perf/run.js --browser <binary> --label <name> startup --runs 5
node scripts/perf/run.js --browser <binary> --label <name> memory --idle 30
node scripts/perf/run.js --browser <binary> --label <name> pageload --runs 2
node scripts/perf/run.js --browser <binary> --label <name> speedometer
node scripts/perf/run.js --report scripts/perf/out/*.json
```
