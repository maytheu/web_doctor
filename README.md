# Agentic Web Doctor

Conformance auditor and trust surface for Open Agentic Web sites. Given a site base URL, it fetches the published agent artifacts, runs a fixed catalog of structural, hosting, policy, and security checks, and returns a deterministic report plus an embeddable SVG status badge.

The Open Agentic Web MVP profile defines how sites publish agent manifests, networks, and link maps, but ships no official validator. Agentic Web Doctor turns that profile into executable checks with stable IDs and fix hints, so publishers can verify conformance before a runtime fails and reviewers can inspect a peer before loading its instructions.

Structural conformance only — a passing report is not a security certification.

## Quick start

Requires Node.js >= 22. No dependencies, no build step.

```sh
npm test                          # unit and fixture tests (parallel, no browser)
npm run test:browser              # headless Chrome/Edge E2E (sequential)
npm run test:all                  # both
node server.mjs                   # report UI + APIs on http://localhost:8787
npm run demo:peer                 # demo peer fixture on http://127.0.0.1:8788
node bin/doctor.mjs https://example.com
```

`demo:peer` is a second origin for the bundled runtime: the published manifest pre-approves `http://127.0.0.1:8788` and `links.json` maps the `demo_peer` symbol to its network there. Replace both with a deployed peer origin before publishing a real site.

Auditing a local fixture (loopback requires `--allow-private`):

```sh
node scripts/serve-fixture.mjs fixtures/good
# prints e.g. http://127.0.0.1:54321
node bin/doctor.mjs http://127.0.0.1:54321 --allow-private
```

## CLI

```
agentic-web-doctor <url> [--json] [--report <report.json>] [--badge <file.svg>]
                         [--fail-on warn|error] [--allow-private] [--timeout <ms>]
                         [--ledger <path>] [--pin <sha256>] [-h|--help] [--version]
```

| Exit | Meaning |
|---|---|
| 0 | Conformant, or warnings when `--fail-on` is `error` (default) |
| 1 | Errors, or warnings with `--fail-on warn`, or `--pin` mismatch |
| 2 | Usage error, or no artifact could be fetched (blocked URL, DNS failure or timeout) |

`--json` prints only the report object. `--report` writes the report JSON to a file while the human-readable summary stays in the log. `--badge` writes the deterministic SVG. `--allow-private` disables the private-address guard for loopback development.

The URL may omit the scheme: `example.com` is normalized to `https://example.com` (a `host:port` pair is kept), while any scheme other than http/https is rejected. Bare loopback hosts (`localhost`, `*.localhost`, `127.x.x.x`, `[::1]`) default to `http://` instead.

`--ledger <path>` compares the fetched artifact hashes against a local JSON ledger and updates it after the audit. Each entry stores `sha256`, `bytes`, `firstSeen`, `lastSeen`, `networkNames`, and `frontMans` — never artifact content. A changed artifact is reported by `integrity.changed` as a warning; a changed `front_man` is an error so the peer must be re-consented. The file is created on first use; delete it (or call `reset()` from `src/ledger.mjs`) to forget the baseline. Suggested path: `~/.agentic-web-doctor/ledger.json`.

## GitHub Action

```yaml
steps:
  - uses: actions/setup-node@v4
    with:
      node-version: 22
  - uses: <owner>/agentic-web-doctor@main
    with:
      url: https://example.com
```

The action runs the CLI with `--fail-on error`, writes the JSON report, annotates error and warning checks in the log, appends a summary table to the job summary, and exposes the result as outputs. Node.js 22 or newer must be available on the runner.

| Input | Default | Meaning |
|---|---|---|
| `url` | required | Site to audit |
| `fail-on` | `error` | `error` fails on errors only; `warn` also fails on warnings |
| `timeout` | `8000` | Per-request timeout in milliseconds |
| `allow-private` | `false` | Allow loopback and private targets (local development only) |
| `report-path` | file under `RUNNER_TEMP` | Where to write the JSON report |

Outputs: `status`, `score`, `errors`, `warnings`, `report` (path), and `exit-code`. Outputs are written even when the audit fails, so a later step can consume the report.

## Check catalog

Severity is fixed per check; `status` is the outcome (`pass`, `warn`, `error`, `skip`).

| ID | Category | Severity | Meaning |
|---|---|---|---|
| `manifest.fetch` | publication | error | Manifest returns 200 JSON with a JSON content type |
| `manifest.required` | publication | error | `networks` is non-empty; each entry has string `name`, `front_man`, `hocon`; names unique |
| `manifest.cors` | publication | error | `Access-Control-Allow-Origin` is `*` or a plausible caller origin |
| `hosting.https` | publication | error | Site is HTTPS (loopback HTTP exempt) |
| `links.fetch` | publication | error | `links.json` is fetchable; missing file is a skip, malformed is an error |
| `links.valid` | publication | error | `version: 1`; network map shape valid; URLs absolute http(s) |
| `network.fetch` | network | error | Every network artifact returns 200 JSON |
| `network.cors` | network | error | Network artifacts are CORS-readable |
| `network.tools` | network | error | Network declares a non-empty `tools` array |
| `network.duplicates` | network | error | Agent names are unique and non-empty |
| `network.front_man` | network | error | Manifest `front_man` matches exactly one agent |
| `network.agent.fields` | network | error/warn | Each agent has `function.description`; omitted `tools` is a warning (defaults to none); `instructions` (at most 20,000 characters) and `parameters` well formed when present |
| `network.descriptions` | network | warn | Descriptions are at least 20 characters |
| `network.refs` | network | error | Every string tool is a local agent or absolute http(s) URL; descriptor objects have a string `url` |
| `network.budget` | execution | warn | Network declares `max_execution_seconds` |
| `network.agent_count` | execution | warn/error | Network has at most 50 agents; more than 200 is an error |
| `peers.allowed` | composition | error | Every peer origin is in `allowed_peers` or covered by `peer_policy.mode: "open"` |
| `actions.module` | composition | error | Declared actions module fetches; `agentTools` is a non-empty string array |
| `inference.configured` | inference | warn | `llm_router.base_url` or `byok_router` is present |
| `inference.router_https` | inference | warn | Router URL is HTTPS (loopback exempt) |
| `security.secrets` | security | error | No `sk-…`, `AIza…`, `Bearer …`, or assigned `api_key` in artifacts; evidence is masked |
| `security.script_vectors` | security | warn | Instructions contain no `<script`, `javascript:`, or inline event handlers |
| `integrity.changed` | security | warn | Artifacts unchanged since the last ledger audit; a changed `front_man` is an error |

Scoring: `score = max(0, 100 - 15 * errors - 4 * warnings)`. `skip` affects neither score nor status. Status is `non-conformant` if any error, else `warnings` if any warning, else `conformant`.

## Report schema

```json
{
  "schemaVersion": 1,
  "specProfile": "mvp-0.2",
  "baseUrl": "https://example.com",
  "generatedAt": "2026-11-19T10:00:00.000Z",
  "durationMs": 142,
  "status": "conformant",
  "score": 100,
  "summary": { "pass": 21, "warn": 0, "error": 0, "skip": 2 },
  "artifacts": [
    { "kind": "manifest", "url": "https://example.com/agent-manifest.json", "status": 200, "bytes": 812, "sha256": "…" }
  ],
  "checks": [
    {
      "id": "manifest.cors",
      "category": "publication",
      "title": "Manifest is CORS-readable",
      "severity": "error",
      "status": "pass",
      "message": "Access-Control-Allow-Origin: *",
      "evidence": "https://example.com/agent-manifest.json"
    }
  ]
}
```

Checks may also include `hint` (warn/error only) and `details` (one entry per offending item). Reports are deterministic apart from `generatedAt` and `durationMs`.

## Server API

| Method | Path | Response |
|---|---|---|
| GET | `/api/health` | `{ ok, version, specProfile }` |
| GET | `/api/audit?url=` | 200 report; 400 invalid or missing URL; 429 rate limit; 502 upstream failure |

A bare hostname in `url` is normalized to `https://` (loopback hosts to `http://`); explicit http/https URLs and `host:port` pairs are accepted, and other schemes are rejected.
| GET | `/api/badge?url=&label=&pin=` | SVG (300 s cache); neutral "unavailable" badge on audit failure |
| GET | `/api/catalog` | Static check catalog |

`/api/health`, `/api/badge`, and `/api/catalog` send `Access-Control-Allow-Origin: *` so badges stay embeddable and peers can read the published artifacts. `/api/audit` deliberately omits CORS headers: the report UI and site runtime call it same-origin, and keeping reports unreadable to other origins prevents the server from being used as a cross-site DNS/SSRF oracle. HTML is served with `Cache-Control: no-store` and a restrictive CSP. Static paths are resolved strictly inside `public/`; traversal attempts return 404.

`node server.mjs [--port 8787] [--allow-private] [--trust-proxy <hops>]`

Rate limits are keyed by the socket address. Behind a reverse proxy, pass `--trust-proxy` with the number of trusted proxy hops (typically `1`) to key limits by the forwarded client address from `X-Forwarded-For`, falling back to `X-Real-IP`. Only enable it when every proxy in front of the server overwrites or appends those headers; otherwise a client can spoof the rate-limit key.

## Badge embed

```md
[![agentic web](https://doctor.example/api/badge?url=https%3A%2F%2Fexample.com)](https://doctor.example/?url=https%3A%2F%2Fexample.com)
```

Messages: `conformant`, `N warnings`, `N errors`, and `changed` when `?pin=<manifest sha256>` no longer matches. Colors: conformant `#1f7a3d`, warnings `#b7791f`, non-conformant `#b42318`, changed `#6b21a8`.

## Site actions

`public/actions/doctor-actions.js` exports the four actions declared in `manifest.actions.agentTools`. Each handler calls the same-origin API and returns a compact result for the model:

| Action | Input | Output |
|---|---|---|
| `run_audit` | `{ url }` | status, score, summary, artifact count, and up to 8 non-pass findings |
| `get_last_report` | `{}` | summary of the last audit in the session, or `available: false` |
| `explain_check` | `{ check_id }` | catalog entry with category, severity, and fix guidance |
| `propose_badge` | `{ url, label? }` | Markdown and HTML snippets |

`run_audit` contacts the audited origin, so the bundled runtime gates it behind a consent card naming the origin and purpose. Actions return errors as thrown `Error`s with the API message.

## Agent runtime and BYOK

`public/runtime/index.js` is the bundled zero-dependency browser runtime, and `public/site.js` boots it:

```js
boot({ mount: '#agent-panel', manifest: '/agent-manifest.json', actions: '/actions/doctor-actions.js' });
```

The runtime loads the first network in the manifest, resolves its front man, imports the declared actions module, and runs an OpenAI-compatible tool loop against the manifest's router. Actions are exposed to the model as `website_run_audit`, `website_get_last_report`, and so on. `run_audit` of a new origin shows a consent card naming the origin; allow and deny decisions are remembered for the session. Modules under `/runtime/*` are served with `Access-Control-Allow-Origin: *`.

Peers declared in `links.json` for the loaded network appear as `peer_<symbol>` tools. A peer load checks `deny_origins` and `allowed_peers` first, then asks for consent, then fetches the peer manifest and network with CORS checks. The router call sends only the peer front man's description and the explicit request — never the conversation, site instructions, or the key. Peers are not added to the network's `tools` array because `network.refs` only accepts local agent names or absolute URLs.

Router settings live in `localStorage` under an origin-namespaced key (`awd.byok.<origin>`) with a remove control. The key is attached only as `Authorization: Bearer …` on router requests. It is never written into manifest, network or peer fetches, prompts, action arguments, activity events, reports, logs, or badge URLs, and router error messages are redacted. Router URLs must be HTTPS; loopback HTTP is allowed for development.

`public/receipt.js` converts runtime activity into the privacy receipt side panel: router host, key sent to peer sites, `sly_data` forwarded, origins contacted, consent decisions, and the last audit's server-side artifact count. Values the runtime cannot observe are labeled `not observable` rather than guessed.

## Browser history

`public/ledger.js` keeps an artifact-hash ledger in IndexedDB (`agentic-web-doctor` / `artifact-ledger`), keyed by the audited site's `baseUrl`. The first audit of an origin saves a baseline; later audits compare each artifact's `sha256` and the status banner reports changed, added, and removed artifacts. Only URLs, hashes, byte counts, and timestamps are stored — never artifact content. History is per browser profile; blocked or unavailable IndexedDB simply hides the note.

## Peer-load simulation

`src/peer-sim.mjs` loads a symbolic peer headlessly:

1. Fetch the site manifest and `links.json`; resolve the peer URL for the declared network.
2. Fail closed unless the peer origin is in `allowed_peers` (or `peer_policy.mode` is `open`).
3. Ask for consent through a callback and remember allowed or denied decisions for the session.
4. Fetch the peer manifest and network with CORS checks, then run the peer front man through the caller's router with the BYOK key attached only to the router request.

The returned receipt records `keySentToPeer`, `slyDataForwarded`, contacted origins, the consent decision, and peer artifact hashes. `assertPrivacyReceipt()` rejects receipts that leak the key, forward private context, omit the key from the router call, or embed the key. `npm run simulate:peer` runs the full flow against the demo-peer fixture and a mock router; use `npm run simulate:peer -- --deny` to demonstrate a denied consent.

## Deployment

GitHub hosts the source. The audit API, badge, and same-origin site actions need a running Node process, so GitHub Pages alone cannot serve a working deployment.

`render.yaml` defines two services:

- `agentic-web-doctor` — Node web service, start `node server.mjs --port $PORT --trust-proxy 1`, health check `/api/health`.
- `agentic-web-doctor-peer` — static `fixtures/demo-peer` with `Access-Control-Allow-Origin: *` for the peer-load demo.

1. Push the repository, then create a Render Blueprint from it.
2. If Render renames either service, copy the peer's public origin and run:
   `node scripts/set-peer-origin.mjs https://<peer-host>`
3. Commit the updated `public/agent-manifest.json` and `public/links.json`, then redeploy.
4. Verify:

```bash
curl https://<app>/api/health
node bin/doctor.mjs https://<app>; echo "exit=$?"
curl -I https://<app>/agent-manifest.json   # Access-Control-Allow-Origin: *
```

Never pass `--allow-private` on a public deployment. `--trust-proxy 1` is correct for one platform proxy hop; raise it only if you add another proxy. The demo peer fixture also ships a `_headers` file, so Netlify or Cloudflare Pages can host it instead of the static Render service.

## Security notes

- **SSRF guard.** The fetcher rejects literal private/loopback/link-local/CGNAT addresses and `localhost`-style hostnames, resolves public hostnames via `dns.lookup` and rejects any private answer, pins the validated address with a custom `lookup`, and re-validates every redirect hop. Non-standard ports and URLs with embedded credentials are rejected. `--allow-private` (loopback development only) bypasses these guards; never enable it on a public deployment.
- **Limit:** validation happens at request time; it is structural, not a penetration test. DNS answers can change between resolution and connection for hostnames, which the pinned lookup mitigates but does not eliminate. Run with `--allow-private` disabled in production.
- Timeouts (8 s default per request) and a 2 MB body cap apply to every fetch; redirects are capped at 3 and the whole audit stops at 20 s.
- Error messages never include request headers or credentials.
- Secret findings are masked in evidence. Audits are read-only; no artifact content is stored server-side.
- BYOK keys are stored only in this browser and sent only to the configured router. The page CSP permits HTTPS connection targets so a custom provider can be used; the runtime itself sends the key nowhere else.

## Fixtures and tests

`npm test` runs the unit and fixture suites entirely against local fixture servers — no outbound network calls — with test files in parallel. It discovers every `test/*.test.mjs` except the `browser*` files. Those drive the installed Chrome/Edge headlessly and are split into `npm run test:browser`, which discovers the `browser*` files and runs them sequentially because parallel browser sessions contend for the same DevTools endpoint; they are skipped when no browser is found. `npm run test:all` runs both.

| Fixture | Purpose |
|---|---|
| `good` | Fully conformant 3-agent network |
| `warn-only` | Missing execution budget; `warnings`, score 96 |
| `broken-front-man` | `front_man` names a nonexistent agent |
| `dangling-ref` | Agent tools reference a missing local agent |
| `bad-peer` | Peer origin not listed in `allowed_peers` |
| `secret-leak` | Fake credential in published instructions |
| `no-cors` | Same artifacts served without CORS headers |
| `no-links` | No `links.json`; `links.fetch` is a skip |
| `missing-manifest` | No manifest; `manifest.fetch` errors and dependents skip |
| `demo-peer` | Second-origin 2-agent network loaded by the runtime and the peer simulation |

Test files: `audit` (fixture matrix, report contract, network cap, 50 ms budget case and a full 20 s budget run), `checks` (per-check synthetic contexts), `badge`, `fetch-security` (including a public-looking redirect to a private range that is blocked before the target is contacted), `server`, `cli`, `action`, `ledger`, `actions`, `web-ledger`, `peer-sim`, `runtime` (BYOK, router loop, consent, receipt), `runtime-peer` (consent-gated peer loads, key and private-context isolation), `runtime-assets`, `self-audit` (including the published guardrail instructions), `package` (zero dependencies, Node >= 22), `browser` (a real headless Chrome session driving BYOK settings, audit consent allow/deny/remember, the four actions, the demo peer load, and the privacy receipt), `browser-report` (the report UI in the same headless session).

`test/browser.test.mjs` launches headless Chrome (or Edge) over the DevTools protocol against the local server. When no browser is found the browser E2E files are skipped; set `CHROME_PATH` to point at a specific binary. It binds the demo peer on `127.0.0.1:8788` because the published `links.json` fixes that origin, and skips only the peer step if the port is already in use. `browser-report` reuses the same harness for the report UI: theme persistence, the confirming state, the status banner, filters, keyboard operation with an exhaustive Tab-order traversal, reduced motion, copy/download, the badge preview and snippets, the browser ledger and its reset, recent audits, and hostile-string rendering.

The server publishes the Doctor's own artifacts — `/agent-manifest.json`, `/networks/doctor_audit_assistant.network.json`, `/links.json`, the `/actions/doctor-actions.js` module, and `/runtime/*` — with `Access-Control-Allow-Origin: *` on the JSON artifacts and runtime modules. `test/self-audit.test.mjs` boots the local server and audits it, asserting `conformant` with zero errors and zero warnings, `actions.module` passing, and four hashed artifacts. This is the CI stand-in for the deployed self-audit gate.

Manual checks (not part of `npm test`):
- Visual QA across browsers, zoom levels and OS themes.
- Network review of a deployed instance to confirm no analytics or third-party requests.
- A recorded demo video of the end-to-end flow.

## Roadmap

- Signed manifests and a public transparency log

## License

MIT.
