# User safety protections (MCP server)

What stops a confused, hijacked or runaway agent from hurting the person whose browser it drives.
Everything is enforced server-side in `mcp/index.js` and covered by `mcp/test/e2e.test.js`.

| protection | what it does | managed with |
|---|---|---|
| **Hidden-content filter** | Snapshots omit elements a person cannot see: `display:none`, `visibility:hidden`, opacity < 5%, zero size, font < 2px, off the page horizontally, `aria-hidden`/`hidden`/`inert` subtrees. The snapshot header reports `hidden_skipped="N"` so the agent knows something was left out. This defeats the common prompt-injection trick of hiding instructions in invisible text. | automatic |
| **Invisible Unicode stripped** | Zero-width, bidi-control and Unicode "tag" characters are removed from everything returned (snapshots, `read_section`, `browser_exec` reads). | automatic |
| **`form_submit` enforced** | Clicking a submit button in a form, or pressing Enter in a form field, needs the `form_submit` permission. (It was defined but never checked before.) | `auren-perm set form_submit allow\|ask\|deny` |
| **Sensitive fields** | Agent typing into password, `cc-*`/`one-time-code` autocomplete, and card/CVV/SSN-named fields is blocked. Denied by default, even under `trust_level: trusted`. | `auren-perm set sensitive_input allow` |
| **Per-site rules** | `deny`: no snapshots, navigation or actions on that host (and subdomains). `readonly`: reading is fine, clicking/typing/scripts/Enter are blocked. | `auren-perm domain <host> deny\|readonly\|allow\|remove` |
| **Panic switch** | Suspends every tool except `browser_get_permissions`, persisted across restarts. | `auren-perm panic on\|off` |
| **Rate limit** | At most `AUREN_MAX_ACTIONS_PER_MIN` (default 120) state-changing actions per minute (a `browser_exec` batch counts per step). | env var |
| **Audit log** | `~/.auren/audit.log` (mode 600, rotated at 5 MB): time, tool, outcome (`ok`/`denied`/`error`), arguments with typed values, script source and URL queries removed (only lengths are kept). | `auren-perm log [n]` |

Earlier layers (already shipped): out-of-band permission approval (the agent cannot grant itself access),
`http(s)`-only navigation, password values redacted in snapshots, query strings never stored in history.

## Known limits (be honest about these)
* Prompt injection is reduced, not solved: instructions in **visible** page text still reach the model.
  Treat all page content as untrusted data; the per-site rules and `ask` permissions are the backstop.
* Per-site rules are checked on navigation, snapshots and every click/fill/press, but not by
  `browser_find`, `browser_read_section` or `browser_execute_js` (the latter needs `js_execute` anyway).
* The sensitive-field check is heuristic (input type, autocomplete token, field name); a field named
  innocuously and typed as plain text will not be caught.
* The panic switch and rules live in `~/.auren/agent_permissions.json`; anyone with that file or the
  admin key can change them. Keep both mode 600.

Also fixed while here: `browser_read_section` had never worked (a template-string escape turned `\n` into a
real newline inside a regex literal, a syntax error in the page script, so it always answered `[no content]`).
