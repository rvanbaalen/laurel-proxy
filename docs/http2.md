# HTTP/2 Support

The proxy negotiates HTTP/2 with clients and with origins, independently, over
the same MITM tunnel used for HTTP/1.1: no flag, no user decision. ALPN
decides each hop on its own — an h2 client talking to an HTTP/1.1-only origin
is a normal case, not a special one, and the recording says so.

## How the two hops are negotiated

- **Client hop.** The MITM TLS socket offers `ALPNProtocols: ['h2', 'http/1.1']`.
  Whatever the client picks is what it gets. A client that offers no ALPN
  extension at all (`alpnProtocol === false`) lands on HTTP/1.1 — never
  treated as h2, never a crash.
- **Origin hop.** Negotiated separately via its own ALPN probe, cached per
  `host:port` so repeat requests to the same origin don't re-probe.
  Concurrent requests to a *cold* origin share one probe and one handshake
  rather than each starting their own — a page load against a single host is
  one probe plus one h2 session, not one of each per request. A dead pooled
  session is discarded and retried once on a fresh one; it does not fail the
  request that discovered it.

The two are independent by design: nothing about the client's protocol
influences what's offered to the origin, or vice versa.

## What gets recorded

Every `RequestRecord` (and every WebSocket handshake row — see below) carries
two additional fields, separate from `protocol` (which is the URL scheme,
`'http'`/`'https'`, not a wire protocol):

| Field              | Meaning                                              |
|---------------------|-------------------------------------------------------|
| `client_protocol`   | Wire protocol negotiated with the **client**: `'http/1.1'` \| `'h2'` \| `null` |
| `origin_protocol`   | Wire protocol negotiated with the **origin**: `'http/1.1'` \| `'h2'` \| `null` |

**`null` means genuinely unknown — never read it as `'http/1.1'`.** Every
exchange this proxy records sets both fields explicitly to a real value,
so a `null` here is either a legacy row from before this feature existed
(migrated to `'http/1.1'` for both hops — see below) or a signal that
something upstream of the recording layer didn't know. Every surface that
displays these fields (CLI table, CLI agent JSON, web UI) renders an unset
hop as **unknown**, not as a guessed value.

### Migration

Existing databases get `client_protocol`/`origin_protocol` columns added on
first open after upgrading (guarded by `PRAGMA table_info`, so it's a no-op on
every run after the first — same pattern as the earlier `kind` column). Rows
that predate this feature are backfilled with `'http/1.1'` for both hops, not
left `null`: before HTTP/2 support existed, every exchange this proxy ever
recorded genuinely spoke HTTP/1.1 on both hops, so that's a fact about the
row, not a guess.

### Where each surface shows it

- **CLI** — `laurel-proxy requests --format table` tags an h2 client hop with
  a magenta `H2` in the method column (mirrors the WebSocket `WS` marker; the
  two never co-occur, since a WebSocket's client hop is h1.1 by construction).
  `laurel-proxy request <id>` (table format) prints `Client Hop` and
  `Origin Hop` lines, showing `unknown` rather than a guess when unset.
  `--format agent`/`--format json` carry `client_protocol`/`origin_protocol`
  on both `laurel-proxy requests` and `laurel-proxy request <id>`, and on
  `--tail` in both `agent` and `table` mode.
- **Filters** — `laurel-proxy requests --client-protocol h2` and
  `--origin-protocol http/1.1` (either or both), exact match, no
  NULL-inclusion fallback: an unset hop matches neither filter value. An
  unrecognised value exits non-zero rather than silently returning everything.
  Works on `--tail` too. Same on the REST side: `GET /api/requests?client_protocol=h2&origin_protocol=http%2F1.1`,
  400 on an unrecognised value.
- **Web UI** — the traffic list tags an h2 client hop with a small `H2` badge
  in the method column, the same "only the non-default is worth a badge"
  approach as the CLI and the WebSocket `WS` marker. The request detail panel
  shows `client hop → origin hop` in its meta bar (e.g. `h2 → http/1.1`),
  reading `unknown` for an unset value.

### Finding the mixed-hops case

```bash
laurel-proxy requests --client-protocol h2 --origin-protocol http/1.1 --format agent
```

This is the case that used to be invisible: before this feature, an h2
exchange and an h1.1 exchange recorded identically, because `protocol` is the
URL scheme, not the wire protocol.

## WebSocket connections

A WebSocket handshake only ever arrives via the `Upgrade` header, which
HTTP/2 forbids outright — so every WebSocket connection this proxy records has
`client_protocol: 'http/1.1'` and `origin_protocol: 'http/1.1'` **by
construction**, not by default. There is no such thing as an h2 WebSocket
connection in this proxy's recording, because there is no such connection to
record (see "Not supported" below).

## Not supported

- **WebSockets over HTTP/2 (RFC 8441 Extended CONNECT).** An h2 client
  attempting one fails cleanly rather than hanging: the compatibility server
  doesn't advertise `SETTINGS_ENABLE_CONNECT_PROTOCOL`, so a `:protocol`
  stream is reset (`RST_STREAM(PROTOCOL_ERROR)`); a plain `CONNECT` stream on
  h2 gets a `405`; and the `Upgrade` header is forbidden by the protocol
  itself, so an h2 client's own request builder refuses to send one. None of
  the three is recorded as an exchange.
- **Cleartext h2c** (prior-knowledge or `Upgrade`-based). Rare in practice —
  browsers don't do it — and out of scope.
- **HTTP/3 / QUIC**, and server push (deprecated, unimplemented in browsers).
- **Response trailers are dropped, on both hops.** An origin's trailing
  headers reach neither the client nor the recording — an h2 origin's
  `sendTrailers`, and an HTTP/1.1 origin's chunked trailer block alike. This
  is not new (HTTP/1.1 always dropped them here) and it is deliberate:
  recording them means a new `RequestRecord` field, a guarded migration and a
  route to the CLI/REST/UI surfaces, and relaying them would change the bytes
  an application sees. What *is* guaranteed is that dropping them is clean: a
  trailer is never merged into the recorded response headers, so a trailer
  named like a header cannot overwrite what the origin actually sent, and the
  body is unaffected. If you need to see trailers, they are on the wire — this
  proxy simply does not capture them.

## Known gaps, documented rather than hidden

- **A `RST_STREAM(NO_ERROR)` mid-body on a response with no `content-length`
  is genuinely indistinguishable from a clean end.** Every observable property
  matches: Node's h2 client pushes a clean end-of-stream either way. This one
  class of truncated h2 response can still record as complete. Every other
  truncation shape (a declared `content-length` that doesn't match, a
  non-`NO_ERROR` reset, a client-side cancel) is caught — see
  `UpstreamResponse.bodyStatus()` in `src/server/upstream.ts` and the
  recording guard in `handleExchange` (`src/server/exchange.ts`).
- **A client `RST_STREAM` is best-effort to detect before the upstream
  request is even sent.** Node destroys a reset h2 stream a tick or two after
  the compatibility layer ends the request readable, so the pre-upstream
  check (`h2ClientGone` in `src/server/exchange.ts`) frequently can't see a
  cancel that lands mid-body. The check right before recording is what
  actually guarantees a cancelled exchange isn't recorded as a completed one
  — `writeHead`/`end` are silent no-ops on a closed h2 stream, so nothing else
  would ever complain.
