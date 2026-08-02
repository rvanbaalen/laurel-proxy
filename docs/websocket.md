# WebSocket Capture and Replay

The proxy intercepts WebSocket connections the same way it intercepts HTTP: the
101 handshake is recorded as a request, and every frame that crosses the tunnel
afterward is decoded and stored.

## What gets captured

- The `101 Switching Protocols` handshake becomes an ordinary row in `requests`
  with `kind: 'websocket'`, so it shows up in the existing traffic list, filters,
  and search exactly like an HTTP request — same table, same `laurel-proxy requests`
  output, one extra `kind` value to notice.
- Every subsequent frame is decoded (RFC 6455) and written to a separate
  `websocket_messages` table, keyed by the handshake's request id.
- `direction` on each frame is `'sent'` (client → server) or `'received'`
  (server → client). The CLI and web UI render these as `→` and `←`.

## Extensions are stripped — plaintext in exchange for readability

The proxy deletes `Sec-WebSocket-Extensions` from the upgrade request before forwarding
it upstream, so `permessage-deflate` can never be negotiated on an intercepted
connection. This is a deliberate trade-off: Laurel changes the connection the
application actually gets (no compression) in exchange for making every captured
frame readable without implementing a decompression path.

If a server sets a compression RSV bit on a frame anyway, the frame decoder treats it
as invalid and fails that connection's decoding rather than recording garbage as if
it were a plaintext payload. The frame itself is still relayed untouched — decoding
failure never touches the bytes in flight, only what gets recorded.

## Recording can degrade silently — there is currently no visible signal

The relay and the recorder are deliberately decoupled: a decoding problem must never
break the actual connection, so decode failures are swallowed rather than surfaced.
Concretely, if the decoder for one direction hits any of:

- a set RSV bit (see above),
- a malformed/invalid frame, or
- a frame (or reassembled fragmented message) over the 32 MiB decoder cap,

that direction stops being recorded for the rest of the connection. The relay keeps
forwarding bytes normally — the application never notices — but frames for that
direction silently stop appearing in `websocket_messages`. **There is no error, log
line, or UI badge that tells you this happened.** If a captured WebSocket connection
looks like it's missing frames in one direction, this is the first thing to suspect.

## Size limits

- **32 MiB** per frame and per reassembled fragmented message, enforced by the frame
  decoder (`MAX_PAYLOAD_BYTES` in `src/server/ws-frames.ts`). This exists to bound
  memory in a long-running proxy against a hostile or corrupt length field; exceeding
  it fails decoding for that direction (see above), it does not truncate and keep going.
- **`maxBodySize`** (default 1 MiB, same config key HTTP bodies use) caps what's
  actually *stored* per frame. A frame under the 32 MiB decoder cap but over
  `maxBodySize` is stored with its payload cut to `maxBodySize` bytes and
  `truncated: 1` set. This is a separate, smaller limit than the decoder cap above.

## CLI

```bash
laurel-proxy messages <id>                    # frames for a websocket connection
laurel-proxy messages <id> --follow           # stream new frames as they arrive
laurel-proxy messages <id> --limit 100
laurel-proxy messages <id> --format json      # json | table | agent
```

`<id>` must be the id of a request with `kind: 'websocket'`; pointing it at an HTTP
request id fails with a message telling you to use `laurel-proxy request <id>` instead.

## REST API

### `GET /api/requests/:id/messages?limit&offset`

```bash
curl 'http://localhost:8081/api/requests/<id>/messages?limit=100&offset=0'
```

Paginated (`limit` default 500, `offset` default 0, both must be non-negative
integers). An unknown or not-yet-populated id returns an empty page (`total: 0`),
not a 404. **Payloads are base64-encoded unconditionally**, regardless of opcode.

### SSE: `event: ws-message`

Subscribe via `GET /api/events`. Each new frame is pushed immediately (not batched
like the `request` event) as `event: ws-message` with the same base64-encoded shape
as the REST endpoint above.

### `POST /api/websocket/replay`

See [Replay](#replay) below.

## A documented inconsistency: base64 vs UTF-8

The REST API (`GET /api/requests/:id/messages` and the `ws-message` SSE event)
base64-encodes every payload, for every opcode, unconditionally.

The CLI's `--format json` and `--format agent` output does **not**: text frames are
decoded to UTF-8 strings, non-text frames (`binary`, `ping`, `pong`, `close`) are
base64, and an explicit `payload_encoding: 'utf8' | 'base64'` field says which. This
makes CLI JSON output usable without a decode step for the common case (text frames)
while still round-tripping binary data exactly.

Both choices are individually defensible — the REST API stays uniform and
type-agnostic; the CLI optimizes for the common text case and is explicit about it —
but they are genuinely inconsistent with each other. An agent or script that consumes
both surfaces needs to know this going in: **do not assume the presence of a
`payload_encoding` field, and do not assume base64-always, across both surfaces.**
Check which surface you're reading from.

## Replay

`POST /api/websocket/replay` reopens a WebSocket connection and resends the
client-sent data frames from a previously recorded connection, preserving the
original inter-frame gaps.

```bash
curl -X POST http://localhost:8081/api/websocket/replay -H 'Content-Type: application/json' \
  -d '{"requestId":"<id>"}'
```

Only frames with `direction: 'sent'` and opcode `text` or `binary` are replayed.
Control frames (ping/pong/close) are not resent — the WebSocket client library
manages those itself — and everything the server sent is what replay *collects*,
not what it resends.

### Prefer `requestId` over inline `url`/`frames`

The alternative body shape, `{"url": "...", "frames": [...]}`, exists for replaying
frames that didn't come from a stored connection. But `express.json()` is mounted
with its default 100 kb body-size limit, and a recorded connection's frames — base64
encoded, inline in a request body — routinely exceed that. Posting a large recorded
payload via `{url, frames}` will fail on body size before it even reaches the replay
logic. **This is exactly why the web UI's replay button uses `{requestId}`**: the
server reads the frames itself from storage, so the HTTP request body stays tiny
regardless of how much data the connection captured.

A replay also refuses (`400`) if the connection has any **truncated client-sent data
frame** recorded (`truncated: 1` on a `sent` text/binary frame) — replaying a payload
that was cut off at `maxBodySize` would send corrupted, incomplete data to a real
server, which is worse than not replaying at all. A truncated *server*-sent frame
does not block replay; only what's about to be sent matters.

### `stoppedBecause` — read this before treating a replay as successful

A WebSocket connection has no equivalent of an HTTP response boundary, so the replay
has to guess when the server is "done" and reports how via `stoppedBecause`:

| Value       | Meaning |
| ----------- | ------- |
| `'close'`   | The server closed the connection. |
| `'idle'`    | 500ms of silence elapsed after the last frame either side sent. |
| `'timeout'` | The overall replay timeout (default 30s) elapsed. `error` is also set. |
| `'error'`   | Something failed outright (connection refused, send failure, etc). `error` is also set. |

**`'idle' is not a success signal.`** It fires whenever the server's *first* reply
takes longer than 500ms to arrive — which is routine for anything doing real work
behind the scenes, like a database read — and in that case the replay ends having
collected nothing, indistinguishable in `stoppedBecause` from a server that
legitimately had nothing more to say. Anything consuming a replay result must not
read "no `error` field" as "the replay succeeded and captured everything." Check
`received` and `sentCount` too.

**`'close'` is not a success signal on its own either.** A server that closes the
connection after the first of three frames stops the replay with
`stoppedBecause: 'close'` and a `sentCount` of 1 — a partial replay that reads
exactly like a clean one. Two fields make that visible without re-counting the
frames you passed in:

| Field        | Meaning |
| ------------ | ------- |
| `frameCount` | Frames the replay was asked to send. |
| `sentAll`    | `false` when it stopped before all of them went out. |

`sentAll: false` means the replay did not do what was asked, whatever
`stoppedBecause` says. The web UI treats it as a failure and reports
"only N of M frames were sent" rather than a green success.

### Known replay limitations

- **Non-UTF-8 text frames can't round-trip.** A recorded `text` frame is resent via
  the standard `WebSocket` API, which takes a JS string for text frames. A frame
  whose bytes aren't valid UTF-8 is already non-conformant per RFC 6455 §5.6 (text
  frames must carry UTF-8), so this is recorded-data corruption from the original
  connection, not a bug in replay — but it does mean such a frame cannot be replayed
  faithfully.
- **`wss://` to a self-signed origin cannot be replayed.** Node's built-in
  `WebSocket` exposes no way to pass TLS options (no `rejectUnauthorized: false`
  equivalent), so replaying against an origin whose *own* certificate is self-signed
  or otherwise untrusted fails at the TLS handshake. This is unrelated to Laurel's
  interception CA — it's purely about the certificate the origin server presents.
