---
name: laurel-proxy
description: Use when working with Laurel Proxy, intercepting HTTP/HTTPS/HTTP2 traffic, debugging API calls, inspecting network requests, or when the user mentions laurel-proxy, proxy traffic, captured requests, or network debugging. Also use when the user asks to start/stop a proxy, view traffic, configure HTTPS interception, simulate slow/throttled network conditions, inspect/replay WebSocket connections, debug HTTP/2 exchanges, or debug why an API call is failing. Trigger even when the user just says "capture traffic", "inspect requests", "what is my app sending", "debug this API", "throttle my network", "inspect websocket messages", or "is this request using http2".
version: 1.4.0
---

# Laurel Proxy

Laurel Proxy is an HTTP/HTTPS intercepting proxy with a CLI and web UI. It captures traffic, stores it in SQLite, and makes it queryable. Works on **macOS** and **Linux**.

Install: `npm install -g laurel-proxy`
Run without installing: `npx laurel-proxy`

## Quick Start — One Command

The fastest way to capture and inspect traffic. This single command starts the proxy, enables the macOS system proxy, and opens a live interactive TUI:

```bash
laurel-proxy requests --tail
laurel-proxy requests --host api.example.com --tail
laurel-proxy requests --status 500 --tail
laurel-proxy requests --host stripe.com --method POST --tail
```

`--tail` automatically:
1. Starts the proxy if it isn't running
2. Enables the macOS system proxy (routes all traffic through Laurel Proxy)
3. Opens an interactive terminal TUI
4. On quit (Ctrl+C), disables the system proxy and stops the proxy

For raw JSON streaming instead of the TUI: `laurel-proxy requests --format json --tail`

## CLI Commands

### `laurel-proxy` (interactive mode)

Running with no arguments launches a terminal menu with access to all features: start/stop proxy, view requests, clear traffic, open web UI, trust CA, enable system proxy, quit.

### `laurel-proxy start [options]`

Start the proxy server in the foreground.

| Option | Default | Description |
|---|---|---|
| `--port <number>` | `8080` | Proxy listening port |
| `--ui-port <number>` | `8081` | Web UI and API port |
| `--db-path <path>` | `~/.laurel-proxy/data.db` | SQLite database location |

### `laurel-proxy stop [--ui-port <number>]`

Stop the running proxy. Sends a graceful shutdown request via the API, falls back to SIGTERM via PID file.

### `laurel-proxy status [--ui-port <number>]`

Show proxy status: running state, proxy port, request count, database size.

### `laurel-proxy requests [options]`

Query captured requests. Default output is a human-readable table.

| Option | Default | Description |
|---|---|---|
| `--host <pattern>` | | Substring match on hostname |
| `--status <code>` | | Exact HTTP status code |
| `--method <method>` | | HTTP method (GET, POST, etc.) |
| `--search <pattern>` | | Substring match on full URL |
| `--kind <kind>` | | Filter by traffic kind: `http` or `websocket` |
| `--client-protocol <p>` | | Filter by client-hop wire protocol: `http/1.1` or `h2` |
| `--origin-protocol <p>` | | Filter by origin-hop wire protocol: `http/1.1` or `h2` |
| `--since <time>` | | After timestamp (Unix ms or ISO date) |
| `--until <time>` | | Before timestamp (Unix ms or ISO date) |
| `--limit <n>` | `100` | Max results |
| `--format <fmt>` | `table` | `table`, `json`, or `agent` |
| `--failed` | | Shortcut: only 4xx/5xx responses (statusMin=400) |
| `--last-hour` | | Shortcut: requests from the last hour |
| `--last-day` | | Shortcut: requests from the last 24 hours |
| `--slow <ms>` | | Shortcut: requests slower than threshold (e.g. `--slow 500`) |
| `--tail` | | Real-time interactive TUI (auto-starts proxy + system proxy) |
| `--ui-port <number>` | `8081` | API port (used with `--tail`) |
| `--db-path <path>` | `~/.laurel-proxy/data.db` | Database location |

```bash
laurel-proxy requests --host api.example.com --method POST
laurel-proxy requests --status 500 --limit 20
laurel-proxy requests --search "/api/v2" --since "2024-01-15T00:00:00Z"
laurel-proxy requests --format json --host stripe.com | jq '.data[].url'
laurel-proxy requests --kind websocket --format agent   # find WebSocket connections
laurel-proxy requests --client-protocol h2 --origin-protocol http/1.1 --format agent  # mixed-hops h2 exchanges
```

### `laurel-proxy request <id> [options]`

Show full details of a single captured request: URL, method, status, duration, headers, and bodies.

| Option | Default | Description |
|---|---|---|
| `--format <fmt>` | `json` | `json`, `table`, or `agent` |
| `--db-path <path>` | `~/.laurel-proxy/data.db` | Database location |

```bash
laurel-proxy request a1b2c3d4-e5f6-7890-abcd-ef1234567890
laurel-proxy request <uuid> --format table
```

### `laurel-proxy clear [--ui-port <number>]`

Delete all captured traffic from the database.

### `laurel-proxy trust-ca`

Install and trust the Laurel Proxy CA certificate for HTTPS interception. On macOS, adds to the System Keychain (prompts for sudo). Must start the proxy first to generate the CA.

### `laurel-proxy uninstall-ca`

Remove the CA certificate from the system trust store.

### `laurel-proxy proxy-on [--port <number>] [--service <name>]`

Configure Laurel Proxy as the macOS system-wide HTTP/HTTPS proxy. Auto-detects the active network service (Wi-Fi, Ethernet).

### `laurel-proxy proxy-off [--service <name>]`

Remove Laurel Proxy from system proxy settings.

### `laurel-proxy replay <id> [options]`

Resend a previously captured request. Useful for reproducing issues or testing fixes.

| Option | Default | Description |
|---|---|---|
| `--method <method>` | (original) | Override HTTP method |
| `--url <url>` | (original) | Override URL |
| `--header <header...>` | (original) | Override/add header (format: "Key: Value") |
| `--body <body>` | (original) | Override body (raw string) |
| `--diff` | off | Show diff between original and replay response |
| `--format <format>` | `json` | Output format (json\|table\|agent) |
| `--db-path <path>` | (config) | Database path |

```bash
# Replay a captured request
laurel-proxy replay a1b2c3d4-e5f6-7890-abcd-ef1234567890

# Replay with diff to see if a fix worked
laurel-proxy replay a1b2c3d4 --diff

# Replay with diff in agent format (best for LLM consumption)
laurel-proxy replay a1b2c3d4 --diff --format agent
```

**Diff output** shows whether the replay status improved, regressed, changed, or stayed the same compared to the original captured response. Exit codes: 0 = replay is 2xx, 1 = replay is 4xx/5xx, 2 = connection failure.

### `laurel-proxy throttle <preset|off> [options]`

Simulate slower network conditions on traffic passing through the proxy.

| Option | Default | Description |
|---|---|---|
| `--down <kbps>` | | Downstream bandwidth |
| `--up <kbps>` | | Upstream bandwidth |
| `--latency <ms>` | | Added latency |
| `--status` | | Show current throttle settings |
| `--format <format>` | `table` | `json`, `table`, or `agent` |
| `--ui-port <number>` | `8081` | UI/API port |

Six presets: `56k`, `edge`, `3g`, `4g`, `dsl`, `wifi`. A preset fully replaces the current
settings; `off` disables throttling. Running `throttle` with no preset and no rate flags
shows current status, same as `--status`.

```bash
laurel-proxy throttle 3g                                    # apply a preset
laurel-proxy throttle off                                   # disable
laurel-proxy throttle --down 500 --up 100 --latency 200      # explicit values
laurel-proxy throttle --status --format agent
```

**⚠️ Throttling inflates recorded `duration`.** The proxy simulates latency/bandwidth
limits by delaying bytes before forwarding them, and that delay is baked into the
`duration` stored for every request — indistinguishable from real upstream slowness. If
you're diagnosing "why is this request slow" and throttling is enabled (`laurel-proxy
throttle --status`), a high `duration` may mean nothing about the actual server. Always
check throttle status before drawing conclusions from timing data.

### `laurel-proxy messages <id> [options]`

Show WebSocket frames captured for a connection. `<id>` must be the id of a request with
`kind: 'websocket'` — use `laurel-proxy requests --kind websocket` first to find it (see
[WebSocket Capture](#websocket-capture) below).

| Option | Default | Description |
|---|---|---|
| `--follow` | off | Stream new frames as they arrive |
| `--limit <n>` | `500` | Max frames to show |
| `--format <format>` | `table` | `json`, `table`, or `agent` |
| `--ui-port <number>` | `8081` | UI/API port (used with `--follow`) |
| `--db-path <path>` | (config) | Database path |

```bash
laurel-proxy messages a1b2c3d4                    # frames for a websocket connection
laurel-proxy messages a1b2c3d4 --follow           # stream new frames live
laurel-proxy messages a1b2c3d4 --format agent
```

Pointing `<id>` at a plain HTTP request id fails with a message telling you to use
`laurel-proxy request <id>` instead. Output is paginated (`--limit` defaults to 500) —
`table`/`json`/`agent` all report `total`/`limit`/`offset` so you know if there's more.

### `laurel-proxy learn`

Print this skill file to stdout, so an AI agent (or human) can read exactly how to drive
Laurel Proxy.

| Option | Default | Description |
|---|---|---|
| `--format <format>` | `table` | `json`, `table`, or `agent` |

`table`/`agent` print the raw markdown. `--format json` wraps it as `{"content": "..."}`
for programmatic callers.

## Agent Output Format (`--format agent`)

The `agent` format returns enriched JSON optimized for LLM consumption. Use this when debugging via Claude Code instead of `json` or `table`.

**List view** (`laurel-proxy requests --format agent`): returns an array of enriched records with decoded bodies, `is_error` flag, and timing metadata.

**Detail view** (`laurel-proxy request <id> --format agent`): returns a single enriched record with full request/response bodies decoded (not base64), a human-readable `summary` line, and `context.is_error` for quick triage.

```bash
# Get all failed requests in agent-optimized format
laurel-proxy requests --failed --format agent

# Get full detail for a specific request
laurel-proxy request <uuid> --format agent
```

## Smart Filter Aliases

Convenience shortcuts that map to common filter combinations:

```bash
laurel-proxy requests --failed              # status >= 400
laurel-proxy requests --last-hour           # since 1 hour ago
laurel-proxy requests --last-day            # since 24 hours ago
laurel-proxy requests --slow 500            # duration > 500ms
laurel-proxy requests --failed --last-hour  # combine filters
```

`--status` overrides `--failed` if both are specified.

## Interactive Tail TUI

The `--tail` TUI has two views: a **request list** and a **request detail** view.

### Request list

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate requests |
| `Enter` | Open request detail |
| `g` / `G` | Jump to newest / oldest |
| `Ctrl+C` | Quit (cleans up proxy + system proxy) |

New requests auto-scroll to the top. Scrolling down disables auto-scroll; `g` re-enables it.

### Request detail (tabbed)

The detail view has three tabs: **Overview**, **Request**, **Response**.

| Key | Action |
|---|---|
| `←` / `→` or `h` / `l` | Switch tabs |
| `1` / `2` / `3` | Jump to Overview / Request / Response |
| `Esc` | Back to request list |

- **Overview** — ID, URL, method, status, duration, protocol, client/origin wire-protocol hop, timestamp, request/response sizes
- **Request** — Request headers and body (JSON bodies are pretty-printed)
- **Response** — Response headers and body (JSON bodies are pretty-printed)

## HTTPS Interception

```bash
laurel-proxy start        # generates CA on first run
laurel-proxy trust-ca     # installs cert (prompts for sudo)
```

After trusting, HTTPS traffic is automatically decrypted when routed through the proxy. Per-domain certificates are generated on-the-fly and cached (LRU, default 500).

## Routing Traffic

```bash
# Explicit proxy flag
curl -x http://127.0.0.1:8080 https://api.example.com/data

# Environment variables
export http_proxy=http://127.0.0.1:8080
export https_proxy=http://127.0.0.1:8080

# macOS system-wide (all apps)
laurel-proxy proxy-on
laurel-proxy proxy-off
```

`--tail` handles routing automatically — it enables the system proxy on start and disables it on quit.

## WebSocket Capture

The proxy intercepts WebSocket connections the same way it intercepts HTTP. The `101
Switching Protocols` handshake is recorded as an ordinary row in `requests` with
`kind: 'websocket'` — it shows up in `laurel-proxy requests`, filters, and search like
any other request. Every frame after that is decoded and stored separately, keyed by
the handshake's request id.

**Discovery matters more than anything else here.** Frames live under the handshake's
id, not under a URL or hostname, so the workflow is always two commands:

```bash
laurel-proxy requests --kind websocket --format agent   # 1. find the connection's id
laurel-proxy messages <id> --format agent                # 2. read its frames
```

`--format table` tags WebSocket rows with a cyan `WS` in the method column so you can
spot them in a mixed traffic list.

**Known limitations — don't misread these:**

- **Recording can degrade silently.** If the frame decoder hits a set RSV bit, a
  malformed frame, or a frame (or reassembled fragmented message) over the 32 MiB cap,
  that *direction* stops being recorded for the rest of the connection — but the relay
  keeps forwarding bytes normally, so the application never notices. There is no error,
  log line, or UI badge. If a captured connection looks like it's missing frames in one
  direction, this is why.
- **`Sec-WebSocket-Extensions` is stripped** from the upgrade request before it's
  forwarded upstream, so `permessage-deflate` can never be negotiated on an intercepted
  connection — a deliberate trade-off so every captured frame is readable without a
  decompression path.
- **Payload encoding differs by surface.** The REST API and SSE `ws-message` event
  base64-encode every payload unconditionally, regardless of opcode. The CLI's
  `--format json`/`--format agent` output instead decodes text frames to UTF-8 and
  base64-encodes only non-text frames, with an explicit `payload_encoding: 'utf8' |
  'base64'` field saying which. Don't assume one behavior applies to the other surface.

## HTTP/2 Support

The proxy negotiates HTTP/2 with clients and origins independently over the same MITM
tunnel — no flag, no user decision. ALPN decides each hop on its own, so an h2 client
talking to an HTTP/1.1-only origin is a normal case, and both hops are visible in the
recording as `client_protocol` and `origin_protocol` (`'http/1.1'` | `'h2'` | `null`).
`null` means genuinely unknown — never read as `'http/1.1'`; a client offering no ALPN
at all lands on `http/1.1`, never a guessed h2.

```bash
laurel-proxy requests --client-protocol h2 --format agent                       # find h2 exchanges
laurel-proxy requests --client-protocol h2 --origin-protocol http/1.1 --format agent  # the mixed-hops case
```

`--format table` tags an h2 client hop with a magenta `H2` in the method column
(never alongside the `WS` marker — a WebSocket's client hop is always h1.1). The web
UI does the same in the traffic list, and shows `client hop → origin hop` in the
request detail panel's meta bar. See [`docs/http2.md`](../../docs/http2.md) for the
full field reference, migration behavior, and known gaps.

**Known limitations — don't misread these:**

- **WebSockets over HTTP/2 (RFC 8441) are not supported.** An h2 client attempting one
  fails cleanly (reset stream, or a `405`, or a client-side refusal before a byte
  leaves) rather than hanging — none of the three is recorded as an exchange.
- **Cleartext h2c is not supported.**
- **One class of truncated h2 response is genuinely indistinguishable from a clean
  end:** a `RST_STREAM(NO_ERROR)` mid-body on a response with no `content-length`.
  Every other truncation shape (mismatched `content-length`, a non-`NO_ERROR` reset, a
  client-side cancel) is caught and excluded from the recording.

### Replay

`POST /api/websocket/replay` (body: `{"requestId": "<id>"}`) reopens the connection and
resends the client-sent `text`/`binary` frames, preserving original inter-frame gaps.
Control frames (ping/pong/close) are not resent. It refuses (`400`) if any client-sent
data frame was recorded truncated (`truncated: 1`) — replaying a cut-off payload would
send corrupted data.

**`stoppedBecause` is not a success signal on its own:**

| Value | Meaning |
|---|---|
| `'close'` | Server closed the connection. |
| `'idle'` | 500ms of silence after the last frame either side sent — **routine**, e.g. the server is doing a DB read before replying, not necessarily "done". |
| `'timeout'` | Overall replay timeout (30s default) elapsed. `error` is also set. |
| `'error'` | Something failed outright. `error` is also set. |

Check `sentAll` (false = partial replay — not all client-sent frames went out) and
`sentCount`/`received` before treating any replay as successful. `stoppedBecause: 'idle'`
with nothing received does **not** mean the replay failed — it may just mean the server
was still working.

## REST API

Available at `http://127.0.0.1:8081/api` when the proxy is running.

| Endpoint | Method | Description |
|---|---|---|
| `/api/requests` | GET | Query requests (same filters as CLI via query params, incl. `client_protocol`/`origin_protocol`) |
| `/api/requests/:id` | GET | Full request detail |
| `/api/requests` | DELETE | Clear all traffic |
| `/api/status` | GET | Proxy status |
| `/api/proxy/start` | POST | Start the proxy |
| `/api/proxy/stop` | POST | Stop the proxy |
| `/api/shutdown` | POST | Shut down the entire process |
| `/api/events` | GET | SSE stream for real-time traffic (`request` events; `ws-message` for WebSocket frames) |
| `/api/replay` | POST | Replay a captured request (body: `{ url, method, headers, body }`) |
| `/api/throttle` | GET | Current throttle settings + presets |
| `/api/throttle` | PUT | Set throttle (body: `{ preset }` or `{ enabled, downKbps, upKbps, latencyMs }`) |
| `/api/requests/:id/messages` | GET | Paginated WebSocket frames for a connection (`?limit&offset`) |
| `/api/websocket/replay` | POST | Replay a captured WebSocket connection (body: `{ requestId }`) |

## Using Laurel Proxy as Claude (agent workflow)

When you (Claude) need to debug HTTP traffic — for example, the user says "why is this API call failing" or "what's my app sending to Stripe" — use `--format agent` for enriched, LLM-optimized output. This is much faster than asking the user to describe what they see.

**Before drawing any conclusion from `duration`, run `laurel-proxy throttle --status`.**
If throttling is enabled, recorded durations include simulated delay and will look like
upstream slowness even when the server responded instantly — see [`throttle`](#laurel-proxy-throttle-presetoff-options).

### Step 1: Find failing requests

```bash
# Get all recent failures with enriched output
laurel-proxy requests --host <relevant-host> --failed --format agent

# Or narrow by time
laurel-proxy requests --host <relevant-host> --failed --last-hour --format agent
```

The `agent` format returns decoded bodies (not base64), `is_error` flags, and timing metadata — everything you need to diagnose the issue.

### Step 2: Inspect a specific request

```bash
laurel-proxy request <uuid> --format agent
```

Returns the full request and response with decoded bodies, headers, a human-readable summary line, and error context. JSON bodies are already parsed.

### Step 3: Replay with diff to verify a fix

After identifying the issue and applying a fix, replay the original request and diff against the original response:

```bash
laurel-proxy replay <uuid> --diff --format agent
```

The `--diff` flag shows whether the status improved, regressed, or stayed the same. The agent format returns structured JSON with `result` ("improved", "regressed", "changed", "unchanged"), `status_changed`, and `body_changed` fields. Exit code 0 means the replay returned 2xx (success).

### Step 4: Tail for real-time debugging

If the issue needs live reproduction:

```bash
laurel-proxy requests --host <relevant-host> --format agent --tail
```

Streams enriched JSON to stdout in real-time. Run this, then ask the user to reproduce the issue.

### Example: diagnosing a 422 error

```bash
# 1. Find the failing request
laurel-proxy requests --host api.example.com --failed --format agent --limit 1
# 2. Read the full detail (replace with actual UUID from step 1)
laurel-proxy request <uuid-from-step-1> --format agent
# 3. The agent format shows decoded body, error context, and timing
# 4. After fixing, replay with diff to verify
laurel-proxy replay <uuid-from-step-1> --diff --format agent
```

This pattern works for any HTTP debugging task — auth failures, unexpected response bodies, missing headers, wrong payloads, CORS preflight issues, etc.

## Debugging Workflows (user-facing)

### Debug a failing API call

```bash
# Watch traffic in real time, filtered to the failing service
laurel-proxy requests --host api.failing-service.com --tail
# Reproduce the issue — the request appears in the TUI
# Press Enter on the failing request, switch to Response tab to see error body
# Or query after the fact:
laurel-proxy requests --host api.failing-service.com --status 500
laurel-proxy request <uuid>
```

### Inspect authentication headers

```bash
# Filter to the auth endpoint
laurel-proxy requests --host auth.example.com --method POST --tail
# Select a request, switch to Request tab to inspect Authorization header, tokens, cookies
```

### Debug webhook payloads

```bash
# Your app receives webhooks — route traffic through the proxy and filter
laurel-proxy requests --host localhost --search "/webhooks" --tail
# Select the webhook request, Request tab shows the incoming payload
# Response tab shows what your server replied
```

### Compare request/response for an API integration

```bash
# Capture all traffic to the third-party API
laurel-proxy requests --host api.thirdparty.com --tail
# Walk through each request: Overview shows status + timing
# Request tab shows exactly what was sent (headers + body)
# Response tab shows exactly what came back
```

### Find slow requests

```bash
# Check throttling isn't skewing durations before trusting any timing data
laurel-proxy throttle --status

# Find requests slower than 500ms
laurel-proxy requests --host api.example.com --slow 500 --format agent

# Or browse visually in the table
laurel-proxy requests --host api.example.com --format table --limit 50
# The TIME column shows duration in ms — spot outliers
```

If throttling is enabled, `duration` includes the simulated delay — a "slow" request may
just be throttled, not actually slow upstream. Run `laurel-proxy throttle off` to rule
this out.

### Debug a WebSocket connection

```bash
# 1. Find the connection (handshakes show up with kind: websocket)
laurel-proxy requests --kind websocket --format agent
# 2. Read its frames
laurel-proxy messages <id-from-step-1> --format agent
# 3. Watch it live
laurel-proxy messages <id-from-step-1> --follow
```

If a direction seems to be missing frames, see [WebSocket Capture](#websocket-capture) —
recording can degrade silently for a malformed/oversized frame with no visible error.

### Feed captured traffic to an LLM for analysis

```bash
# Export as JSON and pipe to your tool of choice
laurel-proxy requests --host api.example.com --format json | jq '.data' > traffic.json
# Or get a single request's full detail
laurel-proxy request <uuid> > request-detail.json
```

### Debug CORS or preflight issues

```bash
# Filter for OPTIONS requests
laurel-proxy requests --method OPTIONS --host api.example.com --tail
# Check the Response tab for Access-Control-Allow-* headers
```

## Configuration

Config file at `~/.laurel-proxy/config.json`:

```json
{
  "proxyPort": 8080,
  "uiPort": 8081,
  "dbPath": "~/.laurel-proxy/data.db",
  "maxAge": "7d",
  "maxDbSize": "500MB",
  "maxBodySize": "1MB",
  "certCacheSize": 500
}
```

Priority: CLI flags > config file > defaults.

## Data Locations

| Path | Purpose |
|---|---|
| `~/.laurel-proxy/data.db` | SQLite database |
| `~/.laurel-proxy/config.json` | Configuration (optional) |
| `~/.laurel-proxy/ca/ca.crt` | Root CA certificate |
| `~/.laurel-proxy/ca/ca.key` | Root CA private key |
| `~/.laurel-proxy/pid` | Process ID file |

## Platform Notes

Works on **macOS** and **Linux**. Core proxy, query, and web UI features work on both platforms. These are macOS-only:

- System proxy (`proxy-on` / `proxy-off`)
- Auto-enable system proxy with `--tail`
- CA trust via Keychain (`trust-ca`)

## Port Conflicts

Laurel Proxy auto-detects port conflicts:
- If another laurel-proxy instance holds the port, it's automatically shut down
- Otherwise, the next available port is used (8080 -> 8081 -> 8082...)

The actual ports are always printed on startup.
