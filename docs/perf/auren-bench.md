# Auren-Bench and the automation layer (2026-10-22)

Auren's job in the stack is to be the browser an agent can drive reliably and cheaply. This documents how that is measured, what
the first measurement found, and what was changed because of it. Everything is reproducible: `node mcp/bench/autobench/run.js`.

## Method

`mcp/bench/autobench` serves a small mini-web on `*.localhost` hosts (shop, bank, order grid, wizard with async validation, shadow DOM
widgets, same-origin and cross-origin iframes, cookie banner plus native `confirm()`, infinite scroll, SPA with delayed content,
popup tab, hover menu, custom listbox, range slider, file input, a list that re-renders under you). 17 tasks drive the **real MCP
server** over HTTP with the MCP SDK client, exactly as an agent would, using only public tools. Success is checked on the
**fixture server** (`POST /__done`), so a task passes only if the page reached the goal state, whatever any tool claimed.

Policies are scripted, not an LLM: they locate things by visible name, read results, and re-observe when a page is async. That
measures the tool layer (can the right element be found, acted on and observed), not model skill. A task that only passes through
`browser_execute_js` is reported `js-only`: it is a gap in the tools even though raw JavaScript can paper over it.

Baseline = the server as of `080892d` (before this work), run with the same runner. Headless Chrome on the laptop.

## Result

| | pass | only via raw JS | fail |
|---|---:|---:|---:|
| before (`080892d`) | 2 | 3 | 12 |
| after | 17 | 0 | 0 |

Per task (tool calls, response characters and wall time are for the *after* run):

| id | task | before | after | calls | response chars | ms |
|---|---|---|---|---:|---:|---:|
| T01 | Shop: search, cheapest mug to cart, checkout | pass | pass | 7 | 3526 | 814 |
| T02 | Shop: in-stock filter, sort by price, add 3rd item | FAIL | pass | 8 | 4479 | 833 |
| T03 | Bank: log in, read balance, log out | FAIL | pass | 7 | 1723 | 838 |
| T04 | Grid: sum late-order quantities over 5 pages, submit | FAIL | pass | 13 | 6973 | 1035 |
| T05 | Wizard: 3 steps with async validation | FAIL | pass | 14 | 4363 | 1656 |
| T06 | Shadow DOM: fill and save inside a web component | js-only | pass | 3 | 805 | 516 |
| T07 | Iframe (same origin): apply a coupon | js-only | pass | 3 | 1024 | 574 |
| T08 | Iframe (cross origin): click Pay now | FAIL | pass | 2 | 672 | 513 |
| T09 | Overlays: dismiss cookie banner, confirm a native dialog | FAIL | pass | 4 | 934 | 549 |
| T10 | Feed: scroll an infinite list to Post 47 and open it | FAIL | pass | 10 | 12725 | 705 |
| T11 | SPA: client route with delayed content, download | pass | pass | 7 | 2521 | 1346 |
| T12 | Popup tab: read a code in a new tab, come back, verify | FAIL | pass | 9 | 1986 | 1906 |
| T13 | Hover menu: open a submenu and choose Pricing | js-only | pass | 3 | 1307 | 558 |
| T14 | Custom listbox: pick Norway | FAIL | pass | 3 | 1222 | 549 |
| T15 | Range slider: set volume to 7 | FAIL | pass | 2 | 770 | 447 |
| T16 | File upload: attach a file | FAIL | pass | 2 | 832 | 455 |
| T17 | Re-rendering list: tick three items from one snapshot (one batch) | FAIL | pass | 3 | 782 | 578 |

## What the benchmark found, and the fix

1. **Labelled controls had no names.** `<label>Username <input></label>` came back as `<inp eid="inp-1"></inp>`, and `browser_act find="Username"`
   could not find it (it only matched the element's own text/placeholder). Selects read as the concatenation of their options
   ("NamePrice"); checkboxes as their value ("on"). Fix: real accessible names (aria-labelledby, aria-label, `<label>` wrapping or `for=`,
   placeholder, title, alt, value, selected option) in one page-side library (`mcp/lib/pagelib.js`).
2. **Six identical "Add to cart" buttons were indistinguishable.** Fix: when a name is not unique, the snapshot adds the row's own text as
   `ctx="Red Mug $9"`.
3. **Shadow DOM and iframes were invisible**, and custom widgets (`role=combobox`, `tabindex`, `onclick` divs) were not listed.
   Fix: the library walks open shadow roots and same-origin iframes in document order, and knows ARIA/custom controls. Cross-origin
   iframes (separate processes) get their own CDP sessions (auto-attach); clicks are translated through the frame owner's content quad.
4. **A native `alert/confirm/prompt` hung the call** (the click never acknowledges). Fix: the click returns `<dialog type=... message=...>`,
   other tools report the open dialog instead of hanging, `browser_dialog` answers it.
5. **Links to `#fragment` waited the full 15 s for a load event that never comes** (SPA navigation, tabs, menus). Fix: fragment-only links and
   `target=` links get a real click; popups are reported as `<new_tab id=...>`.
6. **Hover menus, file inputs**: new `browser_hover` (and `exec` op) and `browser_upload`. Upload sends a local file to a website, so it has its
   own `file_upload` permission, denied until the user allows it.
7. **Stale eids**: after a re-render the old eid pointed at nothing. Now an eid is relocated by kind, name and row context, only when that is
   unambiguous; otherwise the call fails loudly.
8. **The snapshot cap showed the first 30 elements, not the ones on screen.** Now on-screen elements are taken first, and every response says how
   many were omitted.
9. Smaller: `select` accepts option text; `contenteditable` fill; `browser_execute_js` returning `undefined` no longer breaks MCP result
   validation; `scrollIntoView(nearest)` so centring does not move the page under the pointer and close the hover menu the agent just opened;
   a click reports when another element covers its target.

Each of these has a regression test in `mcp/test/e2e.test.js` (now 35 tests, all passing, including the original 25 safety/permission tests).

## Context cost against Playwright

`node mcp/bench/tokens.js --pw <dir with playwright-core>` loads the same real pages in the same Chrome and measures what each tool hands the
model: Auren's `browser_navigate` view, and Playwright 1.64.1's `page.ariaSnapshot({mode: 'ai'})` (the view Playwright MCP gives an
agent, every node carrying a `[ref=eN]`). Tokens are estimated as characters / 4.

| page | Auren chars | Auren elements | Playwright chars | Playwright refs |
|---|---:|---|---:|---:|
| en.wikipedia.org/wiki/Web_browser | 7,430 | 64 (+418 omitted) | 134,983 | 993 |
| news.ycombinator.com/ | 3,798 | 30 (+201 omitted) | 49,371 | 620 |
| github.com/microsoft/playwright | 6,860 | 62 (+91 omitted) | 74,010 | 856 |
| developer.mozilla.org/en-US/docs/Web/API/Fetch_API | 7,533 | 61 (+279 omitted) | 123,717 | 1,778 |
| www.bbc.com/news | 7,550 | 61 (+23 omitted) | 48,900 | 523 |
| www.theguardian.com/international | 7,519 | 45 (+137 omitted) | 149,538 | 1,537 |
| stackoverflow.com/questions/11227809/why-is-processing-a-s | excluded (bot wall, error or timeout) | | | |
| www.reddit.com/r/programming/ | 772 | 6 (+0 omitted) | 1,253 | 18 |

Across the 7 pages that served real content: Auren 41,462 characters, Playwright 581,772
(**14x**). **This is not a like-for-like information comparison.** Auren's default view is bounded (30 actionable
elements per region, 7.5k characters, on-screen first) and listed 329 elements while omitting
1149 more; it tells the agent how many it omitted and `browser_find` / `region=` expand any part. Playwright dumps every node,
text included. The number answers "what does the model read to look at a page", not "which tool shows more".

## Limits, stated plainly

* Scripted policies, deterministic fixtures: no model in the loop, no real-world site drift. Passing 17/17 shows the tool layer handles these
  situations; it does not predict success on arbitrary sites.
* Closed shadow roots and shadow DOM inside cross-origin frames are not pierced. Drag-and-drop, canvas and `<select>` popups driven by native UI are not covered.
* Headless Chrome numbers (the laptop) and Auren-on-Mac numbers are in separate files; do not mix them.
* Token counts are estimates (characters / 4), not a Claude tokenizer.
