---
name: roxyproxy
description: Use when working with RoxyProxy, intercepting HTTP/HTTPS traffic, debugging API calls, inspecting network requests, or when the user mentions roxyproxy, proxy traffic, captured requests, or network debugging. Also use when the user asks to start/stop a proxy, view traffic, or configure HTTPS interception.
version: 1.0.0
---

# RoxyProxy

RoxyProxy is an HTTP/HTTPS intercepting proxy with a CLI and web UI. It captures traffic, stores it in SQLite, and makes it queryable. Developed and tested on **macOS**.

Install: `npm install -g @rvanbaalen/roxyproxy`
Run without installing: `npx @rvanbaalen/roxyproxy`

## Quick Reference

### One-command traffic monitoring (recommended)

The fastest way to capture and inspect traffic:

```bash
# Start tailing -- auto-starts proxy + macOS system proxy
roxyproxy requests --tail

# Tail with a host filter
roxyproxy requests --host api.example.com --tail

# Tail only errors
roxyproxy requests --status 500 --tail

# Combine filters
roxyproxy requests --host stripe.com --method POST --tail
```

`--tail` automatically:
1. Starts the proxy if it isn't running
2. Enables the macOS system proxy (routes all traffic through RoxyProxy)
3. Opens an interactive terminal TUI
4. On quit (Ctrl+C), disables the system proxy and stops the proxy it started

**TUI keyboard shortcuts:**

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate requests |
| `Enter` | View full request detail (headers, body) |
| `Esc` | Back to list from detail view |
| `g` / `G` | Jump to top (newest) / bottom (oldest) |
| `Ctrl+C` | Quit (cleans up proxy and system proxy) |

New requests auto-scroll to the top. Scrolling down disables auto-scroll; `g` re-enables it.

For raw JSON streaming instead of the TUI: `roxyproxy requests --format json --tail`

### Starting the Proxy (manual)

```bash
# Interactive mode (recommended for first-time use)
roxyproxy

# Start in foreground
roxyproxy start

# Custom ports
roxyproxy start --port 9000 --ui-port 9001
```

The web UI is available at `http://127.0.0.1:8081` when running.

### Stopping the Proxy

```bash
roxyproxy stop
```

### HTTPS Interception Setup

HTTPS interception requires trusting the RoxyProxy CA certificate:

```bash
roxyproxy start        # generates CA on first run
roxyproxy trust-ca     # installs cert (prompts for sudo)
```

To remove the certificate later:

```bash
roxyproxy uninstall-ca
```

### Routing Traffic Through the Proxy

```bash
# Single command
curl -x http://127.0.0.1:8080 https://api.example.com/data

# Terminal session
export http_proxy=http://127.0.0.1:8080
export https_proxy=http://127.0.0.1:8080

# macOS system-wide (routes all app traffic)
roxyproxy proxy-on
roxyproxy proxy-off    # to disable
```

## Querying Traffic

### CLI Queries

The default output is a human-readable table. Use `--format json` for piping to `jq` or LLMs:

```bash
# All captured requests (last 100, table format)
roxyproxy requests

# Filter by host
roxyproxy requests --host api.example.com

# Filter by status code
roxyproxy requests --status 500

# Filter by HTTP method
roxyproxy requests --method POST

# Search URLs
roxyproxy requests --search "/api/v2"

# Combine filters
roxyproxy requests --host stripe.com --method POST --status 200

# JSON output for piping
roxyproxy requests --format json --host example.com | jq '.data[].url'

# Time-bounded
roxyproxy requests --since "2024-01-15T00:00:00Z"

# Full detail for one request (headers + body)
roxyproxy request <uuid>
```

**All filter options:**

| Flag | Description |
|---|---|
| `--host <pattern>` | Substring match on hostname |
| `--status <code>` | Exact HTTP status code |
| `--method <method>` | HTTP method (GET, POST, etc.) |
| `--search <pattern>` | Substring match on full URL |
| `--since <time>` | After timestamp (Unix ms or ISO date) |
| `--until <time>` | Before timestamp (Unix ms or ISO date) |
| `--limit <n>` | Max results (default: 100) |
| `--format <fmt>` | `table` (default) or `json` |
| `--tail` | Real-time interactive TUI (auto-starts proxy) |

### REST API

The API is at `http://127.0.0.1:8081/api` when running:

```bash
# Query requests (same filters as CLI via query params)
curl "http://127.0.0.1:8081/api/requests?host=example.com&limit=50"

# Single request detail
curl http://127.0.0.1:8081/api/requests/<uuid>

# Proxy status
curl http://127.0.0.1:8081/api/status

# Start/stop proxy
curl -X POST http://127.0.0.1:8081/api/proxy/start
curl -X POST http://127.0.0.1:8081/api/proxy/stop

# Clear all traffic
curl -X DELETE http://127.0.0.1:8081/api/requests

# SSE stream (real-time traffic)
curl -N http://127.0.0.1:8081/api/events
```

### Clear Traffic

```bash
roxyproxy clear
```

## Configuration

Config file at `~/.roxyproxy/config.json`:

```json
{
  "proxyPort": 8080,
  "uiPort": 8081,
  "dbPath": "~/.roxyproxy/data.db",
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
| `~/.roxyproxy/data.db` | SQLite database |
| `~/.roxyproxy/config.json` | Configuration (optional) |
| `~/.roxyproxy/ca/ca.crt` | Root CA certificate |
| `~/.roxyproxy/ca/ca.key` | Root CA private key |
| `~/.roxyproxy/pid` | Process ID file |

## Common Workflows

### Debug a failing API call

```bash
# One command -- starts proxy, enables system proxy, shows live traffic
roxyproxy requests --host api.failing-service.com --tail

# After spotting the failing request, press Enter to see full detail
# Or query the database after the fact:
roxyproxy requests --host api.failing-service.com --status 500
roxyproxy request <uuid-of-failing-request>
```

### Inspect what an app sends to a third-party API

```bash
# Tail traffic filtered to the third-party host
roxyproxy requests --host third-party-api.com --tail

# For HTTPS, make sure the CA is trusted first:
roxyproxy trust-ca
```

### Monitor traffic in real-time

```bash
# Interactive TUI (recommended)
roxyproxy requests --tail

# Or open the web UI
open http://127.0.0.1:8081

# Or raw SSE stream
curl -N http://127.0.0.1:8081/api/events
```

## Platform Notes

RoxyProxy is developed and tested on **macOS**. Core proxy and query features work on Linux, but these are macOS-only:

- System proxy (`proxy-on` / `proxy-off`) -- uses `networksetup`
- Auto-enable system proxy with `--tail`
- CA trust via Keychain (`trust-ca`)

## Port Conflicts

RoxyProxy auto-detects port conflicts. If the default port is in use:
- If another roxyproxy instance holds the port, it's automatically shut down
- Otherwise, the next available port is used (8080 -> 8081 -> 8082...)

The actual ports are always printed on startup.
