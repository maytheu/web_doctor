# Build task: "Agentic Web Doctor" scaffold

You are implementing a new project from scratch in the current working directory (an empty folder). Write the code directly. Do not create planning documents. Do not ask questions; make reasonable decisions and finish.

## Product

Agentic Web Doctor: a conformance auditor for Open Agentic Web sites (the Cognizant/MIT NANDA "Open Agentic Web Challenge" spec). Given a site base URL, it fetches and validates the site's published agent artifacts, produces a structured conformance report, serves a polished report UI, and emits an embeddable SVG status badge.

Zero runtime dependencies. Node.js >= 22, ESM, plain JavaScript. No TypeScript, no bundler, no frameworks, no CDN assets, no external fonts. All UI must work offline.

## Hard requirements

1. `node --test` must pass.
2. Do not make outbound network calls in tests. Tests spin up a local fixture HTTP server instead.
3. `node bin/doctor.mjs --help` must work.
4. `node bin/doctor.mjs <fixture-url>` must audit a fixture and exit with a meaningful code.
5. `node server.mjs` must serve the report UI and APIs. Verify it with curl before finishing.
6. No secrets, no telemetry, no analytics.
7. Keep the code readable and small. No dead code, no speculative abstractions.

## Files to create

```
package.json                # name "agentic-web-doctor", type module, bin: { "agentic-web-doctor": "./bin/doctor.mjs" }, scripts: test, start
bin/doctor.mjs              # CLI entry
src/audit.mjs               # auditSite() orchestration, scoring, report shape
src/fetch.mjs               # fetchText with timeout, size limit, content-type, SSRF guard
src/checks.mjs              # individual check functions
src/badge.mjs               # renderBadge(report) -> SVG string
src/version.mjs             # SCHEMA_VERSION, CHECK CATALOG constants
server.mjs                  # static server + /api/audit + /api/badge + /api/health
public/index.html
public/app.js
public/styles.css
fixtures/good/agent-manifest.json
fixtures/good/assistant.network.json
fixtures/good/links.json
fixtures/broken-front-man/agent-manifest.json
fixtures/broken-front-man/assistant.network.json
fixtures/broken-front-man/links.json
fixtures/dangling-ref/agent-manifest.json
fixtures/dangling-ref/assistant.network.json
fixtures/dangling-ref/links.json
fixtures/bad-peer/agent-manifest.json
fixtures/bad-peer/assistant.network.json
fixtures/bad-peer/links.json
fixtures/secret-leak/agent-manifest.json
fixtures/secret-leak/assistant.network.json
fixtures/secret-leak/links.json
test/helpers/fixture-server.mjs
test/audit.test.mjs
test/badge.test.mjs
test/fetch-security.test.mjs
test/server.test.mjs
README.md
.gitignore
LICENSE                   # MIT
```

## Auditor behavior

`auditSite(baseUrl, options)` in `src/audit.mjs`:

- Normalize baseUrl (strip trailing slash; require http/https; loopback allowed).
- Fetch `<base>/agent-manifest.json`.
- For each network entry in the manifest (audit the first, and validate all), resolve `hocon` relative to the base URL (or absolute URL), fetch it, validate it.
- Fetch `<base>/links.json` (optional; missing is a pass with a note, malformed is an error).
- Run all checks, collect results, compute score and status.

Report shape (stable, documented in README):

```json
{
  "schemaVersion": 1,
  "baseUrl": "https://example.com",
  "generatedAt": "ISO-8601",
  "durationMs": 123,
  "status": "conformant | warnings | non-conformant",
  "score": 0,
  "summary": { "pass": 0, "warn": 0, "error": 0, "skip": 0 },
  "checks": [
    {
      "id": "manifest.fetch",
      "category": "manifest | network | links | peers | hosting | inference | actions | security",
      "title": "Short human title",
      "severity": "error | warn | info",
      "status": "pass | warn | error | skip",
      "message": "What was found, specific and factual",
      "hint": "How to fix it (only when not pass)",
      "evidence": "optional short string (URL, header value, agent name)"
    }
  ]
}
```

Checks to implement (stable ids, do not rename):

- `manifest.fetch` — 200, JSON parse, content-type contains json. error on failure.
- `manifest.required` — `networks` is a non-empty array; each entry has string `name`, string `front_man`, string `hocon`; names unique. error.
- `manifest.cors` — `access-control-allow-origin` is `*` or echoes a plausible caller origin. error if header absent (explain that peers cannot fetch it). Loopback-hosted sites may pass with a note? No: still error, CORS is required for cross-origin peer loading; but for the local fixture, the test server must send CORS.
- `network.fetch` — 200, JSON. error.
- `network.tools` — `tools` is a non-empty array. error.
- `network.duplicates` — agent `name` values unique and non-empty. error.
- `network.agent.fields` — each agent has `function.description` (non-empty string) and `tools` (array); agents with `instructions` must have string instructions; `function.parameters`, if present, must be an object with `type: "object"`. error for missing description/tools; warn for suspiciously short (<20 chars) descriptions.
- `network.front_man` — manifest `front_man` matches exactly one agent name. error.
- `network.refs` — every string entry in any agent's `tools` must be either a local agent name or an absolute http(s) peer-network URL. Every object entry must have a string `url` (MCP descriptor) and optional `tools` array of strings. error listing each unresolved reference.
- `links.fetch` — optional. missing => skip (not error) with message "no links.json published"; malformed JSON => error; wrong shape => error.
- `links.valid` — `version` is 1; `networks` is an object mapping a published network name to an object of symbolic -> absolute http(s) URL. error. Every network key must exist in the manifest networks (warn if not).
- `peers.allowed` — collect peer origins from absolute peer URLs in `tools` and in `links.json`; each must be listed in `manifest.allowed_peers` or covered by `manifest.peer_policy` (`mode: "open"` allows all). error for each denied origin.
- `hosting.https` — http is error unless loopback (127.0.0.1/localhost/[::1]); https passes.
- `inference.configured` — manifest has `llm_router.base_url` (string) or `llm_router.byok_router`; warn if neither, since BYOK UI needs a router.
- `actions.module` — if `manifest.actions` exists: `module` is a string, `agentTools` is a non-empty array of strings, and the module URL fetches successfully. Missing actions => skip.
- `secrets.scan` — scan manifest and network JSON text for obvious credential patterns (`sk-` followed by 16+ chars, `AIza`, `api_key` assigned a value, `Bearer ` followed by 20+ chars). error if found (published artifacts are public). Keep it simple, no false positives on the word "key" alone.
- `budget.limits` — if network has `max_execution_seconds`, pass; else warn recommending an execution bound.

Scoring: start at 100; subtract 15 per error and 4 per warn; floor at 0. Status: `non-conformant` if any error, else `warnings` if any warn, else `conformant`.

Severity of each check is fixed by the catalog above; `status` is the outcome. `skip` does not affect score.

## Fetch/security layer

`src/fetch.mjs`:
- `fetchText(url, { timeoutMs = 8000, maxBytes = 2 * 1024 * 1024, allowPrivate = false })`
- http/https only. Follow up to 3 redirects, re-validating each hop.
- Abort on timeout; reject bodies over maxBytes (stream or content-length check).
- SSRF guard: reject hostnames resolving to or literal private/loopback/link-local/CGNAT ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, ::1, fc00::/7, fe80::/10) unless `allowPrivate` is true. Literal IPs and `localhost` must be blocked by default. DNS resolution check is optional; literal-IP + hostname-denylist is acceptable, document the limitation.
- Error messages must never include request headers or keys.

CLI flags: `--json`, `--badge <path>`, `--fail-on <warn|error>` (default error), `--allow-private`, `--timeout <ms>`, `-h/--help`, `--version`.
Default output: human-readable summary (status, score, base URL, one line per check with status icon in text like PASS/WARN/ERROR/SKIP, hint indented).
Exit codes: 0 if status is conformant; 1 if warnings and `--fail-on warn`; 1 if errors and default; 2 on usage/network/internal errors. Keep it consistent and documented.

## Server (`server.mjs`)

- `node server.mjs [--port 8787] [--allow-private]`
- Serve `public/` statically with correct content types, deny path traversal, set `Cache-Control: no-store` for HTML.
- `GET /api/health` -> `{ "ok": true }`
- `GET /api/audit?url=...` -> JSON report (400 on missing/invalid url, 502 on upstream failure with `{error}`). CORS `*` on `/api/*`.
- `GET /api/badge?url=...` -> `image/svg+xml`, `Cache-Control: no-store`, computed from a fresh audit.
- Default port 8787; print the listening URL.
- No dependencies.

## Badge (`src/badge.mjs`)

Flat SVG, height 20, rounded 3px, label "agentic web" dark gray (#3c3f44), message by status: conformant (#1f7a3d), warnings (#b7791f), non-conformant (#b42318). Include a `<title>` element for accessibility. Width computed from text length (approx 7px per char + padding). Deterministic output. Warnings message should show the warning count, e.g. `2 warnings`.

## UI (`public/`)

Single page, vanilla JS. Requirements:
- Hero: product name, one-line pitch ("Audit any Open Agentic Web site before your agent loads it."), URL input with placeholder `example.com`, "Run audit" button, and a small note that the badge can be embedded.
- On submit: `GET /api/audit?url=`. Show loading state (button disabled, aria-busy).
- Result: big status banner (color-coded), score, pass/warn/error/skip counts, elapsed ms, "Copy JSON" and "Download JSON" buttons.
- Checks grouped by category with a category header and count. Each check row: status chip, title, id in monospace, message, hint (when present), evidence (when present, monospace, truncated).
- Filters: All / Errors / Warnings / Passes.
- Badge section: preview of the SVG from `/api/badge?url=`, plus a copyable Markdown snippet and HTML snippet.
- Error state: readable message, keep the previous report if any.
- Accessibility: labels, `aria-live="polite"` on results, visible focus rings, semantic headings, keyboard-submittable form.
- Visuals: dark theme by default with a light theme toggle persisted in localStorage. Use CSS variables, system font stack, max-width ~980px, card-based layout, subtle borders. No emojis.
- No inline event handlers; app.js is a module.

## Fixtures

Build realistic 3-agent networks (front desk coordinator -> menu specialist + orders specialist). All fixtures must be served with CORS `*` and correct content types by `test/helpers/fixture-server.mjs`, which takes a directory and returns a server + base URL.

- `good`: fully conformant. Manifest has `allowed_peers: ["https://peer.example"]`, `llm_router.base_url`, `peer_policy` closed; network has `max_execution_seconds`; links.json version 1 with empty networks object or a valid mapping.
- `broken-front-man`: `front_man` names a nonexistent agent.
- `dangling-ref`: one agent's `tools` contains `"missing_agent"`.
- `bad-peer`: network references `https://evil.example/agents/x` while allowed_peers does not include it.
- `secret-leak`: an instruction string contains a fake key like `sk-test-abcdefghijklmnopqrstuvwxyz`.

Keep fixture networks small (2–3 agents) but valid JSON Schema parameters.

## Tests

`test/audit.test.mjs`
- good fixture -> status conformant, score 100, no errors.
- broken-front-man -> `network.front_man` is error and status non-conformant.
- dangling-ref -> `network.refs` error mentions `missing_agent`.
- bad-peer -> `peers.allowed` error mentions the origin.
- secret-leak -> `secrets.scan` error.
- CORS behavior: a server variant without CORS headers -> `manifest.cors` error. (Add an option to the fixture server to omit CORS.)
- `links.fetch` missing -> skip, not error (serve a fixture dir with no links.json; the fixture server can return 404).

`test/badge.test.mjs`
- conformant/warnings/non-conformant produce expected color and message; output starts with `<svg`, contains `<title>`.

`test/fetch-security.test.mjs`
- blocks `http://127.0.0.1/...`, `http://localhost/...`, `http://10.0.0.1/`, `http://169.254.169.254/latest/meta-data/` when allowPrivate is false.
- allows loopback when allowPrivate is true (against the fixture server).
- rejects `file://`.

`test/server.test.mjs`
- start server on port 0 (support `--port 0` for ephemeral; export a `createServer` function from server.mjs and only listen when run as main).
- `/api/health` 200.
- `/api/audit` against a fixture URL returns the report JSON.
- `/api/audit` without url -> 400.
- `/api/badge` returns `image/svg+xml`.
- static `/` returns HTML.
- path traversal `/../package.json` does not leak (404).

### Coverage status

`npm test` covers every automatable layer: unit checks and badge/ledger helpers; fixture-driven engine cases including the 20 s audit budget; fetch guardrails, including a public-looking hop that redirects to a private range and is rejected before the target is contacted; server and CLI contracts; agent runtime (tool declaration, round cap, consent, BYOK containment, peers); headless-browser E2E (report UI, exhaustive Tab order, reduced motion, hostile strings, ledger, recent audits, runtime consent/peer/receipt); self-audit plus the §6.7 guardrail instructions; and the zero-dependency package check.

Manual only:
- Visual QA across browsers, zoom levels and OS themes.
- Deployed no-telemetry/network review confirming no analytics or third-party requests.
- Demo video of the end-to-end flow.

## README

Document: what it is, why (Open Agentic Web conformance), quick start (`npm test`, `node server.mjs`, `node bin/doctor.mjs <url>`), check catalog table (id, severity, meaning), report schema, badge embed snippet, security notes (SSRF guard limitation), and a short "Roadmap" section listing: artifact hash ledger + re-consent diff, headless peer-load simulation, GitHub Action. Keep the roadmap to bullet points; do not implement it.

## Finish

Run `node --test` and fix failures until green. Then run `node bin/doctor.mjs` against a locally served good fixture and against a broken fixture; confirm exit codes. Start the server on a spare port, curl `/api/health`, `/api/audit?url=<fixture>`, `/api/badge?url=<fixture>`, and `/`, then stop it. In your final message summarize: files created, test results, the three curl results, and anything intentionally left for the roadmap.
