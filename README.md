<p align="center">
  <img src="assets/logo.png" alt="Laurel Proxy" width="600" />
</p>

<h3 align="center">See every HTTP request. Debug anything.</h3>

<p align="center">
  Capture, inspect, and replay HTTP/HTTPS traffic. Debug web APIs, reverse-engineer mobile apps, or let your AI agent query everything.<br>
  <strong>Free and open source.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/laurel-proxy"><img src="https://img.shields.io/npm/v/laurel-proxy" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue" alt="Platform" />
</p>

---

**Other proxy tools show traffic to humans.** Laurel Proxy makes it queryable by AI agents. Tell Claude "the Stripe webhook is failing, debug it" and it queries Laurel Proxy, finds the 422 response, reads the error body, and fixes your code.

<p align="center">
  <img src="demo/laurel-proxy-demo.gif" alt="Laurel Proxy demo — one prompt to debug any API" width="720" />
</p>

```bash
# Install and start capturing traffic in 10 seconds
npx laurel-proxy requests --tail
```

## Why Laurel Proxy?

- **AI-native.** A `--format agent` output mode returns enriched JSON optimized for LLM consumption. A Claude Code plugin teaches your AI assistant every command and API endpoint.
- **One command.** `npx @rvanbaalen/laurel-proxy` starts the proxy, enables system routing, and opens an interactive TUI. Ctrl+C to clean up.
- **SQLite storage.** All traffic in a queryable database. Filter by host, status, method, time range. JSON output for piping.
- **HTTPS interception.** Local CA, per-domain cert generation, one command to trust.
- **Smart filters.** `--failed` for 4xx/5xx, `--last-hour`, `--last-day`, `--slow 500` for requests over 500ms.
- **iOS inspection.** Point your device at the proxy, install the cert profile, full HTTPS visibility.
- **REST API + SSE.** Every feature available via HTTP. Real-time streaming. Machine-readable by default.

## Quick Start

```bash
# Start proxy + TUI (auto-enables system proxy on macOS)
laurel-proxy requests --tail

# Filter for a specific host
laurel-proxy requests --host api.example.com --tail

# Show only failed requests from the last hour
laurel-proxy requests --failed --last-hour

# AI-optimized output for Claude Code
laurel-proxy requests --host stripe.com --failed --format agent
```

### Manual setup

```bash
laurel-proxy start                                              # Start proxy
curl -x http://127.0.0.1:8080 http://httpbin.org/get        # Route traffic
laurel-proxy requests                                            # View captured traffic
open http://127.0.0.1:8081                                   # Open web UI
laurel-proxy stop                                                # Stop
```

For HTTPS: `laurel-proxy trust-ca` then traffic flows through automatically.

## Claude Code Plugin

```
/plugin marketplace add rvanbaalen/laurelproxy
```

After installation, just tell Claude what you need. It knows every command, filter, and API endpoint.

## Installation

```bash
npx laurel-proxy          # Run without installing
npm install -g laurel-proxy  # Or install globally
```

## Platform

Works on **macOS** and **Linux**. System proxy features (`proxy-on`/`proxy-off`) are macOS-only.

## Interactive Mode

Running `laurel-proxy` with no arguments launches an interactive terminal menu:

```bash
laurel-proxy
```

![Interactive mode](assets/interactive-mode.png)

The interactive menu provides access to all features:

- **Start/Stop proxy** -- toggle the proxy server on and off
- **Status** -- view proxy stats (port, request count, DB size)
- **View requests** -- browse captured traffic in the terminal
- **Clear traffic** -- delete all captured requests
- **Open web UI** -- opens the dashboard in your browser (auto-starts the proxy if needed)
- **Trust CA certificate** -- install the CA cert for HTTPS interception
- **Enable/Disable system proxy** -- route all macOS traffic through Laurel Proxy
- **Quit** -- stop the proxy and exit

Use arrow keys to navigate and Enter to select. Press `q` or Ctrl+C to quit.

The interactive mode stays in sync with the web UI -- if you stop the proxy from the web dashboard, the CLI menu updates within a second, and vice versa.

---

## CLI Commands

### start

Start the proxy server in the foreground.

```bash
laurel-proxy start [options]
```

| Option | Default | Description |
|---|---|---|
| `--port <number>` | `8080` | Proxy listening port |
| `--ui-port <number>` | `8081` | Web UI and API port |
| `--db-path <path>` | `~/.laurel-proxy/data.db` | SQLite database location |

```bash
# Default ports
laurel-proxy start

# Custom ports
laurel-proxy start --port 9000 --ui-port 9001

# Custom database location
laurel-proxy start --db-path /tmp/proxy.db
```

The process writes its PID to `~/.laurel-proxy/pid` and responds to SIGINT/SIGTERM for graceful shutdown.

### stop

Stop the running proxy server.

```bash
laurel-proxy stop [options]
```

| Option | Default | Description |
|---|---|---|
| `--ui-port <number>` | `8081` | API port to send shutdown request to |

Sends a graceful shutdown request via the API. Falls back to SIGTERM via the PID file if the API is unreachable.

```bash
laurel-proxy stop
laurel-proxy stop --ui-port 9001
```

### status

Show proxy status.

```bash
laurel-proxy status [options]
```

| Option | Default | Description |
|---|---|---|
| `--ui-port <number>` | `8081` | API port to query |

```bash
laurel-proxy status
```

Output:

```
Status     Running
Proxy      port 8080
Requests   142
DB Size    3.2MB
```

### requests

Query captured requests from the database.

```bash
laurel-proxy requests [options]
```

| Option | Default | Description |
|---|---|---|
| `--host <pattern>` | | Filter by hostname (substring match) |
| `--status <code>` | | Filter by HTTP status code |
| `--failed` | | Show only 4xx and 5xx responses |
| `--method <method>` | | Filter by HTTP method |
| `--search <pattern>` | | Search URLs (substring match) |
| `--since <time>` | | After this time (Unix ms or ISO date) |
| `--until <time>` | | Before this time (Unix ms or ISO date) |
| `--last-hour` | | Requests from the last hour |
| `--last-day` | | Requests from the last 24 hours |
| `--slow <ms>` | | Requests slower than threshold (ms) |
| `--limit <n>` | `100` | Maximum number of results |
| `--format <format>` | `table` | Output format: `table`, `json`, or `agent` |
| `--tail` | | Stream new requests in real-time (interactive TUI) |
| `--ui-port <number>` | `8081` | UI/API port (used with `--tail`) |
| `--db-path <path>` | `~/.laurel-proxy/data.db` | Database location |

The default output is a human-readable table. Use `--format json` for piping to `jq`, or `--format agent` for LLM-optimized output with decoded bodies and context:

```bash
# All 500 errors
laurel-proxy requests --status 500

# POST requests to a specific host
laurel-proxy requests --host api.example.com --method POST

# Search URLs
laurel-proxy requests --search "/api/v2"

# Limit results
laurel-proxy requests --format table --limit 20

# Time-bounded query
laurel-proxy requests --since "2024-01-15T00:00:00Z" --until "2024-01-16T00:00:00Z"

# JSON for piping to jq
laurel-proxy requests --format json --host stripe.com | jq '.data[].url'
```

#### Real-time tailing

The `--tail` flag launches an interactive terminal UI that streams new requests as they arrive:

```bash
# Tail all traffic (auto-starts proxy + system proxy if needed)
laurel-proxy requests --tail

# Tail with filters
laurel-proxy requests --host todoist.com --tail
laurel-proxy requests --status 500 --tail
laurel-proxy requests --method POST --host api.example.com --tail
```

**What `--tail` does automatically:**

1. **Starts the proxy** if it isn't already running
2. **Enables the macOS system proxy** so all traffic routes through Laurel Proxy
3. Opens an interactive TUI with arrow-key navigation
4. On quit (Ctrl+C), **disables the system proxy** and stops the proxy it started

**TUI keyboard shortcuts:**

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate requests |
| `Enter` | View full request detail (headers, body) |
| `Esc` | Back to list from detail view |
| `g` / `G` | Jump to top (newest) / bottom (oldest) |
| `Ctrl+C` | Quit (cleans up proxy and system proxy) |

New requests auto-scroll to the top. Scrolling down disables auto-scroll; pressing `g` re-enables it.

To get raw JSON streaming instead of the TUI, use `--format json --tail`.

### request

Show full details of a single captured request, including headers and bodies.

```bash
laurel-proxy request <id> [options]
```

| Option | Default | Description |
|---|---|---|
| `--format <format>` | `json` | Output format: `json`, `table`, or `agent` |
| `--db-path <path>` | `~/.laurel-proxy/data.db` | Database location |

```bash
laurel-proxy request a1b2c3d4-e5f6-7890-abcd-ef1234567890
laurel-proxy request a1b2c3d4-e5f6-7890-abcd-ef1234567890 --format agent
```

### clear

Delete all captured traffic from the database.

```bash
laurel-proxy clear [options]
```

| Option | Default | Description |
|---|---|---|
| `--ui-port <number>` | `8081` | API port |

```bash
laurel-proxy clear
```

### trust-ca

Install and trust the Laurel Proxy CA certificate for HTTPS interception.

```bash
laurel-proxy trust-ca [options]
```

| Option | Description |
|---|---|
| `--no-interactive` | Skip prompts; print cert path and manual instructions |

```bash
# Interactive (prompts for sudo password)
laurel-proxy trust-ca

# Non-interactive (CI, scripts)
laurel-proxy trust-ca --no-interactive
```

See [HTTPS Interception](#https-interception) for details.

### uninstall-ca

Remove the Laurel Proxy CA certificate from the system trust store.

```bash
laurel-proxy uninstall-ca [options]
```

| Option | Description |
|---|---|
| `--no-interactive` | Skip prompts; print removal instructions |

```bash
# Interactive (prompts for sudo password)
laurel-proxy uninstall-ca

# Non-interactive
laurel-proxy uninstall-ca --no-interactive
```

On macOS, removes via `security remove-trusted-cert`. On Linux, removes from `/usr/local/share/ca-certificates/` and refreshes the store. Only available when the certificate is currently installed.

### proxy-on (macOS)

Configure Laurel Proxy as the system-wide HTTP/HTTPS proxy.

```bash
laurel-proxy proxy-on [options]
```

| Option | Default | Description |
|---|---|---|
| `--port <number>` | `8080` | Proxy port |
| `--service <name>` | auto-detected | Network service (e.g., "Wi-Fi", "Ethernet") |

```bash
laurel-proxy proxy-on
laurel-proxy proxy-on --port 9000 --service "Wi-Fi"
```

### proxy-off (macOS)

Remove Laurel Proxy from system proxy settings.

```bash
laurel-proxy proxy-off [options]
```

| Option | Default | Description |
|---|---|---|
| `--service <name>` | auto-detected | Network service |

```bash
laurel-proxy proxy-off
```

---

## Web UI

Available at `http://127.0.0.1:8081` when the proxy is running.

### Features

- **Live traffic stream** -- requests appear in real-time via Server-Sent Events
- **Historical traffic** -- previously captured requests load on page open
- **Sortable columns** -- click any column header to sort (Time, Method, Status, Host, Path, Duration, Size)
- **Resizable columns** -- drag column borders to adjust widths
- **Request detail panel** -- click any row to inspect headers and response body in a resizable side panel
- **Filters** -- filter by host, status code, HTTP method, or URL search
- **Proxy controls** -- start/stop the proxy and clear traffic directly from the UI
- **Live sync** -- start/stop state is synchronized between the web UI and CLI in real-time

### Keyboard Shortcuts

The filter bar is always accessible. Type in any filter field to narrow results instantly.

---

## HTTPS Interception

Laurel Proxy performs HTTPS interception via a local Certificate Authority (CA).

### How it works

1. On first startup, Laurel Proxy generates a root CA certificate and private key at `~/.laurel-proxy/ca/`
2. When a client sends a CONNECT request (HTTPS), Laurel Proxy:
   - Accepts the tunnel
   - Generates a per-domain certificate signed by the CA on the fly
   - Terminates TLS with the client using the generated cert
   - Opens a separate TLS connection to the real server
   - Forwards traffic in both directions, capturing it along the way

### Setup

**Step 1: Start the proxy** (generates the CA if it doesn't exist)

```bash
laurel-proxy start
```

**Step 2: Trust the CA certificate**

```bash
laurel-proxy trust-ca
```

This runs the platform-specific trust command:

| Platform | What happens |
|---|---|
| **macOS** | Adds to System Keychain via `security add-trusted-cert` (requires sudo) |
| **Linux** | Copies to `/usr/local/share/ca-certificates/` and runs `update-ca-certificates` (requires sudo) |
| **Firefox** | Must be done manually: Settings > Privacy & Security > Certificates > View Certificates > Import `~/.laurel-proxy/ca/ca.crt` |

**Step 3: Route HTTPS traffic through the proxy**

```bash
# Via explicit proxy flag
curl -x http://127.0.0.1:8080 https://api.example.com/data

# Or enable system-wide proxy (macOS)
laurel-proxy proxy-on
```

### Certificate Details

| Property | Value |
|---|---|
| CA location | `~/.laurel-proxy/ca/ca.crt` and `ca.key` |
| CA validity | 10 years |
| CA subject | "Laurel Proxy CA" |
| Per-domain cert validity | 1 year |
| Key size | 2048-bit RSA |
| Signature algorithm | SHA-256 |
| Domain cert cache | LRU, default 500 entries (configurable) |

---

## iOS Device Inspection

Laurel Proxy can inspect HTTP/HTTPS traffic from an iOS device. Your computer and iOS device must be on the same Wi-Fi network.

### Setup

**Step 1: Start Laurel Proxy on your computer**

```bash
laurel-proxy start
```

**Step 2: Note your computer's network address**

The CLI prints a `Network` line on startup with your hostname, e.g.:

```
  ● Network  http://robins-macbook.local:8081
```

You can also find your IP manually:

```bash
ipconfig getifaddr en0    # macOS
hostname -I | awk '{print $1}'  # Linux
```

**Step 3: Configure the iOS device to use the proxy**

1. Open **Settings > Wi-Fi**
2. Tap the **(i)** icon next to your connected network
3. Scroll down and tap **Configure Proxy**
4. Select **Manual**
5. Set **Server** to your computer's hostname or IP (e.g., `robins-macbook.local` or `192.168.1.42`)
6. Set **Port** to `8080`
7. Tap **Save**

HTTP traffic is now being captured. For HTTPS inspection, continue below.

**Step 4: Install the CA certificate on iOS**

Open Safari on your iOS device and navigate to the network address shown in the CLI or web UI:

```
http://robins-macbook.local:8081/api/ca.crt
```

Or use the IP directly: `http://192.168.1.42:8081/api/ca.crt`

You can also open the web UI (`http://robins-macbook.local:8081`) and tap the **CA Cert** link in the toolbar.

Safari will prompt you to download a configuration profile. Tap **Allow**.

**Step 5: Install the profile**

1. Open **Settings > General > VPN & Device Management** (or **Profiles & Device Management** on older iOS)
2. Tap the **Laurel Proxy CA** profile
3. Tap **Install** and enter your passcode

**Step 6: Enable full trust for the certificate**

1. Open **Settings > General > About > Certificate Trust Settings**
2. Toggle **Enable Full Trust** for **Laurel Proxy CA**
3. Tap **Continue** on the warning dialog

HTTPS traffic from the iOS device is now fully inspectable through Laurel Proxy.

### Viewing traffic

Open the web UI from any browser:

```
http://<your-computer-ip>:8081
```

Or use the CLI:

```bash
laurel-proxy requests --tail
```

### Cleanup

When you're done inspecting, remove the proxy from iOS:

1. **Settings > Wi-Fi > (i) > Configure Proxy > Off**
2. Optionally remove the CA profile: **Settings > General > VPN & Device Management > Laurel Proxy CA > Remove Profile**

---

## System Proxy (macOS)

On macOS, Laurel Proxy can configure itself as the system-wide HTTP/HTTPS proxy. This routes all traffic from most applications through the proxy without needing per-app configuration.

```bash
# Enable
laurel-proxy proxy-on

# Disable
laurel-proxy proxy-off
```

This uses `networksetup` to set the proxy on your active network service (auto-detects Wi-Fi, Ethernet, or the first available interface).

---

## Configuration

Configuration is loaded from (highest priority first):

1. CLI flags
2. `~/.laurel-proxy/config.json`
3. Built-in defaults

### Config file

Create `~/.laurel-proxy/config.json`:

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

### Options

| Field | Default | Description |
|---|---|---|
| `proxyPort` | `8080` | Proxy listening port |
| `uiPort` | `8081` | Web UI and REST API port |
| `dbPath` | `~/.laurel-proxy/data.db` | SQLite database file path (supports `~`) |
| `maxAge` | `7d` | Auto-delete requests older than this |
| `maxDbSize` | `500MB` | Auto-delete oldest requests when DB exceeds this size |
| `maxBodySize` | `1MB` | Truncate request/response bodies larger than this |
| `certCacheSize` | `500` | Max per-domain SSL certificates cached in memory |

### Size and duration formats

Sizes accept: raw bytes (`1048576`), or human units (`1KB`, `10MB`, `1GB`).

Durations accept: raw milliseconds (`86400000`), or human units (`1s`, `5m`, `1h`, `7d`).

### Auto-cleanup

A background job runs every 5 minutes to enforce `maxAge` and `maxDbSize`:

- Deletes requests older than `maxAge`
- If the database still exceeds `maxDbSize`, deletes the oldest requests in batches
- Runs incremental vacuum to reclaim disk space

---

## REST API

The API is available at `http://127.0.0.1:8081/api` when the proxy is running.

### Endpoints

#### `GET /api/requests`

Query captured requests. Returns paginated results.

Query parameters match the CLI `requests` command: `host`, `status`, `method`, `content_type`, `search`, `since`, `until`, `limit`, `offset`.

```bash
# All requests
curl http://127.0.0.1:8081/api/requests

# Filtered
curl "http://127.0.0.1:8081/api/requests?host=example.com&status=200&limit=50"
```

Response:

```json
{
  "data": [ { "id": "...", "timestamp": 1700000000000, "method": "GET", ... } ],
  "total": 142,
  "limit": 100,
  "offset": 0
}
```

#### `GET /api/requests/:id`

Get full details for a single request, including headers and base64-encoded bodies.

```bash
curl http://127.0.0.1:8081/api/requests/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

#### `DELETE /api/requests`

Delete all captured traffic.

```bash
curl -X DELETE http://127.0.0.1:8081/api/requests
```

#### `GET /api/status`

Get proxy status.

```bash
curl http://127.0.0.1:8081/api/status
```

Response:

```json
{
  "running": true,
  "proxyPort": 8080,
  "requestCount": 142,
  "dbSizeBytes": 3358720
}
```

#### `GET /api/ca.crt`

Download the Laurel Proxy CA certificate. Useful for installing on mobile devices -- open this URL in the device's browser to trigger a certificate install prompt.

```bash
curl -O http://127.0.0.1:8081/api/ca.crt
```

#### `POST /api/proxy/start`

Start the proxy server.

```bash
curl -X POST http://127.0.0.1:8081/api/proxy/start
```

#### `POST /api/proxy/stop`

Stop the proxy server (the API remains available).

```bash
curl -X POST http://127.0.0.1:8081/api/proxy/stop
```

#### `POST /api/shutdown`

Shut down the entire process (proxy + API + web UI).

```bash
curl -X POST http://127.0.0.1:8081/api/shutdown
```

#### `GET /api/events`

Server-Sent Events stream for real-time updates.

```bash
curl -N http://127.0.0.1:8081/api/events
```

Events are named:

- `event: request` -- new captured request (data is the request record as JSON)
- `event: status` -- proxy state change (data is `{"running": true/false, "proxyPort": 8080}`)

---

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │              Laurel Proxy                   │
                    │                                         │
  HTTP/S traffic    │  ┌──────────────┐    ┌──────────────┐  │
 ─────────────────► │  │ Proxy Server │───►│  EventManager │  │
                    │  │    :8080     │    │  (pub/sub)    │──┼──► SSE to Web UI
                    │  └──────┬───────┘    └──────────────┘  │
                    │         │                               │
                    │         ▼                               │
                    │  ┌──────────────┐    ┌──────────────┐  │
                    │  │   SQLite DB  │◄───│   Cleanup    │  │
                    │  │  (batched)   │    │  (5 min)     │  │
                    │  └──────┬───────┘    └──────────────┘  │
                    │         │                               │
                    │         ▼                               │
                    │  ┌──────────────┐    ┌──────────────┐  │
                    │  │  REST API    │    │   Web UI     │  │
                    │  │  /api/*      │    │  (React)     │  │
                    │  │    :8081     │    │    :8081     │  │
                    │  └──────────────┘    └──────────────┘  │
                    └─────────────────────────────────────────┘
```

### Key design decisions

- **SQLite with WAL mode** -- high write throughput with concurrent reads
- **Batched writes** -- requests are queued in memory and flushed every 100ms to reduce I/O
- **Event batching** -- SSE events are buffered for 100ms before flushing to connected clients
- **Response decompression** -- gzip, deflate, and brotli responses are automatically decompressed before storage
- **Body truncation** -- configurable max body size prevents storage bloat; a `truncated` flag is set on affected records
- **Per-domain cert caching** -- LRU cache avoids regenerating SSL certificates for frequently accessed domains

### Data storage

All data is stored in `~/.laurel-proxy/data.db` (SQLite). The `requests` table has indexes on `timestamp`, `host`, `status`, `path`, and `content_type` for fast querying.

Request and response bodies are stored as binary blobs. In the API and SSE stream, they are base64-encoded.

### Files

| Path | Purpose |
|---|---|
| `~/.laurel-proxy/data.db` | SQLite database |
| `~/.laurel-proxy/config.json` | Configuration file (optional) |
| `~/.laurel-proxy/ca/ca.crt` | Root CA certificate |
| `~/.laurel-proxy/ca/ca.key` | Root CA private key |
| `~/.laurel-proxy/pid` | Process ID file |

---

## Development

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Build server (TypeScript)
npm run build:server

# Build web UI (Vite + React)
npm run build:ui

# Build everything
npm run build

# Vite dev server with API proxy to :8081
npm run dev:ui
```

### Project structure

```
src/
├── cli/                # CLI entry point, commands, interactive mode
│   ├── index.ts        # Command registration (Commander.js)
│   ├── interactive.tsx  # Interactive terminal menu (Ink/React)
│   ├── tail-ui.tsx     # Real-time tail TUI (Ink/React)
│   ├── format.ts       # Table/JSON output formatting
│   ├── commands/       # Individual CLI commands
│   └── system-proxy.ts # macOS system proxy & CA management
├── server/             # Proxy server, API, SSL, events
│   ├── index.ts        # LaurelProxyServer orchestrator
│   ├── proxy.ts        # HTTP/HTTPS intercepting proxy
│   ├── api.ts          # Express REST API + SSE
│   ├── ssl.ts          # CA generation & per-domain cert caching
│   ├── events.ts       # Pub/sub event manager
│   └── config.ts       # Config loading and merging
├── storage/            # Database and cleanup
│   ├── db.ts           # SQLite operations (better-sqlite3)
│   └── cleanup.ts      # Auto-cleanup job
├── shared/             # Shared TypeScript types
│   └── types.ts        # Config, RequestRecord, RequestFilter
└── ui/                 # React web UI (Vite)
    ├── App.tsx          # Main app component
    ├── api.ts           # API client + SSE hook
    └── components/      # UI components
```
