# Laurel Proxy

HTTP/HTTPS intercepting proxy with CLI, web UI, REST API, and Claude Code plugin. Captures traffic in SQLite and makes it queryable.

## Project Structure

- `main` branch: proxy source code, CLI, server, web UI, tests
- Website: separate repo at github.com/rvanbaalen/laurelproxy-website, deployed to GitHub Pages

## Features

- **Bandwidth throttling** — simulate slow networks (56k/edge/3g/4g/dsl/wifi presets
  or custom rates). See `docs/throttling.md` — read it before trusting `duration` on
  a request captured while throttling is enabled.
- **WebSocket capture and replay** — frames captured alongside HTTP traffic, with
  CLI/UI viewers and connection replay. See `docs/websocket.md` — has a known
  silent-recording-degradation gap and a base64-vs-UTF-8 inconsistency between the
  REST API and CLI output.

## Git Workflow

Push directly to `main`. Releases are handled automatically by release-please.

## Development

```bash
npm install          # install dependencies
npm test             # run tests (vitest)
npm run build        # build server + UI
npm run dev:ui       # dev server for web UI
```

## Testing

Test framework: vitest. Run with `npm test`. Tests are colocated with source (`src/**/*.test.ts`) and in `tests/integration/`.

## Demo Recordings

Terminal demos use asciinema. The setup is reusable for future feature demos.

- `demo/run-demo.sh` — the scripted demo (emulated CLI + simulated AI agent UI)
- `demo/record.sh` — wrapper that records with asciinema and generates a GIF
- `demo/laurel-proxy-demo.cast` — the asciinema recording (text-based, 11KB)
- `demo/laurel-proxy-demo.gif` — animated GIF for the GitHub README

The website (`website` branch) embeds the `.cast` file via asciinema-player in the hero section (`src/components/DemoPlayer.astro`). The cast file is served from `public/demo.cast`.

### Recording a new demo

```bash
npm run build                    # build the CLI first
brew install asciinema agg       # if not installed
bash demo/record.sh              # records + generates GIF
```

Then copy the cast to the website branch: `git show main:demo/laurel-proxy-demo.cast > public/demo.cast`

### Creating additional feature demos

The demo script helpers (`type_text`, `shell_prompt`, `agent_say`, `agent_tool`, `agent_think`, `print_agent_output`) are reusable. Copy `demo/run-demo.sh` as a starting point, modify the scenes, and record with the same asciinema setup.
