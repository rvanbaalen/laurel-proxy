# Bandwidth Throttling

Simulate slower network conditions on traffic passing through the proxy: presets modeled
on common connection types, or explicit down/up/latency values.

## Presets

From `THROTTLE_PRESETS` in `src/server/throttle.ts`:

| Preset | Down (kbps) | Up (kbps) | Latency (ms) |
| ------ | ----------- | --------- | ------------ |
| `56k`  | 56          | 33        | 120          |
| `edge` | 240         | 200       | 400          |
| `3g`   | 780         | 330       | 100          |
| `4g`   | 4000        | 3000      | 20           |
| `dsl`  | 2000        | 256       | 40           |
| `wifi` | 30000       | 15000     | 5            |

`off` disables throttling and zeroes all three values.

## CLI

```bash
laurel-proxy throttle 3g              # apply a preset
laurel-proxy throttle off             # disable
laurel-proxy throttle --down 500 --up 100 --latency 200   # explicit values (enables throttling)
laurel-proxy throttle --status        # show current settings
laurel-proxy throttle --status --format json   # json | table | agent
```

Running `laurel-proxy throttle` with no preset and no `--down`/`--up`/`--latency` flags
also shows current status (same as `--status`).

## REST API

### `GET /api/throttle`

```json
{ "settings": { "enabled": true, "downKbps": 780, "upKbps": 330, "latencyMs": 100 }, "presets": { "56k": { "...": "..." } } }
```

### `PUT /api/throttle`

Either a preset:

```bash
curl -X PUT http://localhost:8081/api/throttle -H 'Content-Type: application/json' \
  -d '{"preset":"3g"}'
```

`{"preset":"off"}` disables throttling. A preset takes full precedence over any
`enabled`/`downKbps`/`upKbps`/`latencyMs` fields sent alongside it — it replaces the
settings object rather than merging into it.

Or explicit fields (omitted fields fall back to the current setting):

```bash
curl -X PUT http://localhost:8081/api/throttle -H 'Content-Type: application/json' \
  -d '{"enabled":true,"downKbps":500,"upKbps":100,"latencyMs":200}'
```

Settings are **persisted to `~/.laurel-proxy/config.json` before being applied** to the
live throttler. If the write fails, the endpoint returns `500` and the change is
**not** applied — the running proxy and the config file never end up disagreeing. A
successful request returns `{ "settings": { ... } }`.

Set `LAUREL_PROXY_CONFIG` to point config I/O at a different file (used by the test
suite to avoid touching a developer's real config; also handy for running multiple
proxy instances with independent settings).

## Shared-pipe semantics

Throttling models **one shared virtual link per direction**, not one per connection.
Concurrent requests contend for the same bandwidth budget and queue behind each other,
the same as a single real network link would. There is no burst allowance — the limiter
has no initial credit to spend before pacing kicks in.

## Latency

Latency is injected **once per HTTP exchange**, immediately before the first response
byte — not per chunk, and not per WebSocket frame. A WebSocket connection is
bandwidth-paced in both directions (each relayed chunk waits its turn on the
up/down rate limiter) but receives **no added latency at all**, because delaying every
frame of a long-lived connection would distort the very timing that WebSocket debugging
usually cares about.

## Duration is inflated by throttling — read this before trusting timing data

Throttling works by making the proxy wait before forwarding bytes, and that wait is
indistinguishable from real elapsed time as far as the request record is concerned. A
request slowed down by a simulated 3G profile will show that simulated delay baked
into its stored `duration` — in the traffic list, in `laurel-proxy requests`, and in
the CLI's `request <id>` output. It will look exactly like the upstream server was
slow, even though the delay came entirely from the proxy. Chrome DevTools network
throttling has the same property.

The web UI marks this: the throttle dropdown's tooltip and an accent `*` badge on the
traffic table's duration column both call out that durations include simulated delay
while throttling is enabled. **The CLI has no equivalent marker** — if you're
scripting against `laurel-proxy requests` or reading `duration` from the REST API
while throttling is on, you need to remember this yourself.
