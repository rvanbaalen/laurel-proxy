# Changelog

## [0.3.3](https://github.com/rvanbaalen/laurelproxy/compare/laurel-proxy-v0.3.2...laurel-proxy-v0.3.3) (2026-08-05)


### Bug Fixes

* **cli:** read --version from package.json instead of a hardcoded string ([#19](https://github.com/rvanbaalen/laurelproxy/issues/19)) ([edb5f12](https://github.com/rvanbaalen/laurelproxy/commit/edb5f1248ed27958cecb250e7c30f0f8812ceca6))

## [0.3.2](https://github.com/rvanbaalen/laurelproxy/compare/laurel-proxy-v0.3.1...laurel-proxy-v0.3.2) (2026-08-04)


### Features

* **storage:** migrate from better-sqlite3 to node:sqlite ([#17](https://github.com/rvanbaalen/laurelproxy/issues/17)) ([aded322](https://github.com/rvanbaalen/laurelproxy/commit/aded322116fef5a8a8ef0c6c5fe44d7a9174b211))

## [0.3.1](https://github.com/rvanbaalen/laurelproxy/compare/laurel-proxy-v0.3.0...laurel-proxy-v0.3.1) (2026-08-04)


### Bug Fixes

* **server:** destroy the upstream body when the relay loop is never reached ([81fa465](https://github.com/rvanbaalen/laurelproxy/commit/81fa465de47f1b26d3e9e6dfd7b5412cf45f1609))
* **server:** re-check a joined h2 session before handing it to a caller ([67a78be](https://github.com/rvanbaalen/laurelproxy/commit/67a78bee8a2eb8c89eb4c5fb7de950987692db04))

## [0.3.0](https://github.com/rvanbaalen/laurelproxy/compare/laurel-proxy-v0.2.2...laurel-proxy-v0.3.0) (2026-08-03)


### ⚠ BREAKING CHANGES

* **server:** drop the unused upstream trailers API

### Features

* add `laurel-proxy learn` command ([a4d913a](https://github.com/rvanbaalen/laurelproxy/commit/a4d913a714b4ca1a8959d3a446b31e024771224d))
* add bandwidth rate limiter with network presets ([84f8115](https://github.com/rvanbaalen/laurelproxy/commit/84f811598f4ba1ffd2415fdbdc776e660489f843))
* add laurel-proxy messages command ([15589b1](https://github.com/rvanbaalen/laurelproxy/commit/15589b1efa43cffd350b1146120a828d08551cc8))
* add laurel-proxy throttle command ([307b732](https://github.com/rvanbaalen/laurelproxy/commit/307b732e6055fff4a2ccb8e2df7dbcd25c7ae758))
* add RFC 6455 WebSocket frame decoder ([5ef9a20](https://github.com/rvanbaalen/laurelproxy/commit/5ef9a206ff31232a057cf94302ef596dee223cbd))
* add throttle configuration REST endpoints ([d081d59](https://github.com/rvanbaalen/laurelproxy/commit/d081d59448e064026db7ed2d7d4dcc262414ce59))
* add throttle control to web UI ([a6029cb](https://github.com/rvanbaalen/laurelproxy/commit/a6029cb088f48dd03ef40594f225eefa7d8c6e82))
* add WebSocket connection replay ([df93281](https://github.com/rvanbaalen/laurelproxy/commit/df9328133fb7b0d1fa6e7d023e6d1e24be2a306e))
* add websocket message storage with kind column migration ([79340bc](https://github.com/rvanbaalen/laurelproxy/commit/79340bc1d2866ff1884d8609982b0f910e46396c))
* add WebSocket messages tab to web UI ([a9f92f6](https://github.com/rvanbaalen/laurelproxy/commit/a9f92f65aa52c1f1ff05924fc885ad2a67fe6b21))
* **api:** add client_protocol/origin_protocol query filters to GET /api/requests ([c22396b](https://github.com/rvanbaalen/laurelproxy/commit/c22396b3c2596ef85d62a40f78e58f5eac75128e))
* apply bandwidth throttling and latency to proxied exchanges ([1a3a046](https://github.com/rvanbaalen/laurelproxy/commit/1a3a046a2a2d9500ebb8bd3859692fc80c675b53))
* capture WebSocket traffic through the proxy ([60f0acc](https://github.com/rvanbaalen/laurelproxy/commit/60f0acce30d3357d10e43c2041afebfa70e77071))
* **cli:** surface client/origin wire protocol in requests, request, and --tail ([623cbe6](https://github.com/rvanbaalen/laurelproxy/commit/623cbe6cbdf30e188fc435fb9de7875ee28b29b0))
* **cli:** surface request kind on the agent and table surfaces, and add --kind ([d60d527](https://github.com/rvanbaalen/laurelproxy/commit/d60d527148403198e89078fc1b65115a019e4c6c))
* expose websocket messages via REST and SSE ([0c83f55](https://github.com/rvanbaalen/laurelproxy/commit/0c83f558556f69a9780dba1e618e57bb78a99501))
* **server:** add upstream transport with HTTP/2 support ([c27998a](https://github.com/rvanbaalen/laurelproxy/commit/c27998afcbad8997c9d4755698e28937a29a0529))
* **server:** negotiate HTTP/2 with clients over the MITM tunnel ([3d5f7b7](https://github.com/rvanbaalen/laurelproxy/commit/3d5f7b77b60c732e600e9391c0d3d967c7736a2e))
* **server:** teach the exchange pipeline what an HTTP/2 client needs ([0939cee](https://github.com/rvanbaalen/laurelproxy/commit/0939ceed2bafaeadee68acb6192b62d201ba13ee))
* **server:** thread client_protocol/origin_protocol into every record site ([c628bd3](https://github.com/rvanbaalen/laurelproxy/commit/c628bd34bb7c4914dee0430b608eaa4862bab527))
* **storage:** record the negotiated wire protocol for both hops ([e56b4d7](https://github.com/rvanbaalen/laurelproxy/commit/e56b4d7949e0216b22f1982c3aa455bba8589790))
* **ui:** add custom throttle rate popover to the toolbar ([5b28a6a](https://github.com/rvanbaalen/laurelproxy/commit/5b28a6a5e65b53d129e7bba536fc592b856139bc))
* **ui:** filter by kind and mark WebSocket rows in the traffic list ([b88347f](https://github.com/rvanbaalen/laurelproxy/commit/b88347f464fbdc53633f91acfac9d3be67a1b61c))
* **ui:** show client/origin wire protocol in the traffic list and detail panel ([ef23adc](https://github.com/rvanbaalen/laurelproxy/commit/ef23adcc64a29e32661c6a26e695cd6b78acebfe))


### Bug Fixes

* accept --format agent on laurel-proxy throttle ([7af8363](https://github.com/rvanbaalen/laurelproxy/commit/7af8363ecc695017f646b24995aa32f7027dc03c))
* **cli:** align the Client Hop and Origin Hop meta rows ([009c05f](https://github.com/rvanbaalen/laurelproxy/commit/009c05fe684ffb5bd5abf13a4967ebefcd1ea949))
* **cli:** stop websocket message output presenting a page as the whole collection ([66a846c](https://github.com/rvanbaalen/laurelproxy/commit/66a846cda10510273403f02a4c5b455951d774e9))
* correct repository URL to unscoped laurelproxy (no hyphen) ([3f81dcd](https://github.com/rvanbaalen/laurelproxy/commit/3f81dcdcf4df4624d093c9ff81614280c75352cd))
* don't drop live WS frames on a fetch/SSE race in useWsMessages ([4553875](https://github.com/rvanbaalen/laurelproxy/commit/4553875f0eaffb9ecd16ec99d99af7a04ffd2ed3))
* don't misreport unknown throttle state as disabled ([4cbc3c3](https://github.com/rvanbaalen/laurelproxy/commit/4cbc3c31fd26075b4e2234c12d77f11d43477717))
* guard against unbounded-rate rounding and strengthen concurrency test ([d38110b](https://github.com/rvanbaalen/laurelproxy/commit/d38110b15681b381a98ff5e0da7c4acbb86357f3))
* keep the port in recorded HTTPS URLs ([d277072](https://github.com/rvanbaalen/laurelproxy/commit/d2770726c50ac238be5f07b19fb61bc93625d6f4))
* let Node re-chunk streamed responses instead of forcing connection close ([556b864](https://github.com/rvanbaalen/laurelproxy/commit/556b8648544d11ef04de31b6e6ccd13b8c287521))
* persist throttle settings before applying to the live throttler ([781a028](https://github.com/rvanbaalen/laurelproxy/commit/781a02806fac0aba79b72991c313d1d119105c12))
* preserve query string in recorded path, don't record failed exchanges ([c897d91](https://github.com/rvanbaalen/laurelproxy/commit/c897d91111f7855b0610dd6b86594d3062274e53))
* refuse to replay truncated frames, and say why a replay stopped ([77723d4](https://github.com/rvanbaalen/laurelproxy/commit/77723d434b7af31996aa9c3339a48154a5e25203))
* regenerate assets with Laurel Proxy branding ([a02c384](https://github.com/rvanbaalen/laurelproxy/commit/a02c3846db180316389df5956ee06b271014ba84))
* **server:** ask whether an HTTP/1.1 body is complete before why it failed ([5f97f20](https://github.com/rvanbaalen/laurelproxy/commit/5f97f2033fb3a5e6b6a9376a0119e17cde97b83e))
* **server:** bound a stalled MITM handshake and guard the h2 socket poke ([c052e05](https://github.com/rvanbaalen/laurelproxy/commit/c052e05ebc47e08ee1116445e10d83dd0e8c46cf))
* **server:** keep an HTTP/2 truncation from ending the process ([4490245](https://github.com/rvanbaalen/laurelproxy/commit/4490245362ec29bea80e80ec7920b0809e70f959))
* **server:** make sendableStatus HTTP/2-aware ([b0b6e67](https://github.com/rvanbaalen/laurelproxy/commit/b0b6e673b49a29df100792962ad7a7679d037992))
* **server:** make the destroyed check meaningful for HTTP/2 responses ([7e3542d](https://github.com/rvanbaalen/laurelproxy/commit/7e3542d58f300ffa6d333a333bbc24536d8780e0))
* **server:** never let a recording failure kill the proxy or a transfer ([89dc07e](https://github.com/rvanbaalen/laurelproxy/commit/89dc07e9a113d81c309cac4b64741fcee6f04c6f))
* **server:** report a WebSocket replay that stopped before sending everything ([9617763](https://github.com/rvanbaalen/laurelproxy/commit/96177636126ec78d2b2fab7a579536005f2ef316))
* **server:** share cold-start ALPN probes and h2 handshakes ([330c580](https://github.com/rvanbaalen/laurelproxy/commit/330c5809f9ce7599952a7bf0ae4c3f9215dc0c4b))
* **server:** stop an unsendable upstream status and pipeline throws from killing the proxy ([ca5d475](https://github.com/rvanbaalen/laurelproxy/commit/ca5d4754693e714f6ca4a8cd6a17a3ecf08a0bdb))
* **server:** validate the config file's throttle block instead of trusting it ([34cca71](https://github.com/rvanbaalen/laurelproxy/commit/34cca71449da03f0b13edb0ad8779ad9fd275783))
* stop recording failures from tearing down relayed connections ([4325253](https://github.com/rvanbaalen/laurelproxy/commit/4325253129d22ecb6efeac381b697e1d1a162edc))
* **storage:** keep a failing retention pass from killing the proxy ([f7b930d](https://github.com/rvanbaalen/laurelproxy/commit/f7b930d50483d3e0324a58d21dc1145b21e4107f))
* **storage:** reclaim orphaned websocket messages; rename guard to neverFatal ([4ffa596](https://github.com/rvanbaalen/laurelproxy/commit/4ffa5963064dcca74e9e310dd8a29b415188cf45))
* **ui:** let the sliders button close the throttle popover it opened ([69ed0ff](https://github.com/rvanbaalen/laurelproxy/commit/69ed0ffa0bbbbc6d6b1938cedaf2954a8d69e8d9))


### Code Refactoring

* **server:** drop the unused upstream trailers API ([5d54e03](https://github.com/rvanbaalen/laurelproxy/commit/5d54e036c4a1c4a9892e1e34e1dde76775f57191))

## [0.2.2](https://github.com/rvanbaalen/laurelproxy/compare/laurel-proxy-v0.2.1...laurel-proxy-v0.2.2) (2026-03-28)


### Features

* disable system proxy on graceful shutdown ([d9f8413](https://github.com/rvanbaalen/laurelproxy/commit/d9f8413d8fd09c0cbd1382a1f2916578ec7f496c))


### Bug Fixes

* replace remaining RoxyProxy branding with Laurel Proxy ([2568143](https://github.com/rvanbaalen/laurelproxy/commit/25681434664fe753fe3d14f055883a399a99dc4f))

## [0.2.1](https://github.com/rvanbaalen/laurel-proxy/compare/laurel-proxy-v0.2.0...laurel-proxy-v0.2.1) (2026-03-28)


### Bug Fixes

* repair broken isLaurelProxy identifier in port-utils ([b6259d4](https://github.com/rvanbaalen/laurel-proxy/commit/b6259d432cac568c0611c505fdfbe47505b76572))

## [0.2.0](https://github.com/rvanbaalen/laurel-proxy/compare/laurel-proxy-v0.1.7...laurel-proxy-v0.2.0) (2026-03-28)


### ⚠ BREAKING CHANGES

* Package renamed from @rvanbaalen/roxyproxy to laurel-proxy. CLI binary renamed from roxyproxy to laurel-proxy. Config path changed from ~/.roxyproxy/ to ~/.laurel-proxy/.

### Features

* add CA certificate generation with LRU-cached per-domain certs ([ec80885](https://github.com/rvanbaalen/laurel-proxy/commit/ec80885f532e6ab6d2bb830de7b15f3d1863ccce))
* add Claude Code plugin with roxyproxy skill ([3c7d227](https://github.com/rvanbaalen/laurel-proxy/commit/3c7d22716ddc633eaa371320c193b68f2266a2d9))
* add CLI with start, stop, status, requests, clear, and trust-ca commands ([5098216](https://github.com/rvanbaalen/laurel-proxy/commit/5098216d18b78b3f20fd2bbe24d95fc344de8783))
* add colored CLI with ASCII art, interactive cert install, system proxy commands ([e8f2bd5](https://github.com/rvanbaalen/laurel-proxy/commit/e8f2bd546ae86c2f498eee13d6d3bc0b46808301))
* add config loading with defaults, file, and CLI flag merging ([1db5d1d](https://github.com/rvanbaalen/laurel-proxy/commit/1db5d1d56b870e30723b6194f20687facc98fc29))
* add HTTP/HTTPS proxy engine with MITM interception ([099d0d6](https://github.com/rvanbaalen/laurel-proxy/commit/099d0d6d4b43b7fc8961cda53db876d71c638a41))
* add Ink-based interactive CLI mode ([5f9f8c5](https://github.com/rvanbaalen/laurel-proxy/commit/5f9f8c5f0aaddf0be8c5fc79e3c4e93f1b3bf02a))
* add integration tests and fix Express 5 wildcard route ([e20df33](https://github.com/rvanbaalen/laurel-proxy/commit/e20df3396d9671e0a45df35a379a94019439eb6e))
* add ios inspection support ([#5](https://github.com/rvanbaalen/laurel-proxy/issues/5)) ([eaf7573](https://github.com/rvanbaalen/laurel-proxy/commit/eaf75738899309f80dae0296c289039fc21e8682))
* add marketplace.json for Claude Code plugin installation ([2afc0b5](https://github.com/rvanbaalen/laurel-proxy/commit/2afc0b5b352e4806635863a72916b3dd40f251b3))
* add POST /api/replay endpoint ([b255534](https://github.com/rvanbaalen/laurel-proxy/commit/b255534ac9d25001304ee783d022c1d0f2feb4a6))
* add Repeater component with tabbed editor and response viewer ([ca8e5e0](https://github.com/rvanbaalen/laurel-proxy/commit/ca8e5e01bafa28fc08c0df52b1b8db55813a9374))
* add replay module for resending HTTP requests ([35d56ab](https://github.com/rvanbaalen/laurel-proxy/commit/35d56ab0b93589031930a7c849b62b2fbb0c08fd))
* add ReplayRequest and ReplayResponse types ([1b81fb1](https://github.com/rvanbaalen/laurel-proxy/commit/1b81fb1e94abc7782463208d7907a2d805e8fd06))
* add replayRequest API client function ([38c4434](https://github.com/rvanbaalen/laurel-proxy/commit/38c443485670240c7229093560e3e76db0113480))
* add REST API with request querying, SSE events, and proxy control ([d968839](https://github.com/rvanbaalen/laurel-proxy/commit/d9688396bc47a51c307f3a5cad1451ea9acb192a))
* add roxyproxy replay CLI command ([d6b6dd9](https://github.com/rvanbaalen/laurel-proxy/commit/d6b6dd962ec821cadeae96badb286b9f6e21c7fa))
* add server orchestrator wiring proxy, API, and storage ([a260f77](https://github.com/rvanbaalen/laurel-proxy/commit/a260f77a8eb1d11b2b1b86a696c084007d26894b))
* add SQLite storage layer with query filtering and auto-cleanup ([1fb3820](https://github.com/rvanbaalen/laurel-proxy/commit/1fb38205a927b03a19dff68ac4e1990d52ffdbf2))
* add SSE event manager with 100ms batching ([14dff5c](https://github.com/rvanbaalen/laurel-proxy/commit/14dff5c9ee5da5ac1468d875c23d45bafb54f6db))
* add web UI with traffic list, request detail, filters, and controls ([e5f3e95](https://github.com/rvanbaalen/laurel-proxy/commit/e5f3e95677150834149d5619c8859c851112c19b))
* **cli:** add agent output format for LLM-friendly request inspection ([f4af6a4](https://github.com/rvanbaalen/laurel-proxy/commit/f4af6a4c5f73db5a960869c9c0b07884444da3a7))
* **cli:** add buildFilter helper with --failed/--last-hour/--last-day/--slow aliases ([4edf399](https://github.com/rvanbaalen/laurel-proxy/commit/4edf399e1f8264d3e81454cfb482c7f7f53e242a))
* **cli:** add interactive tail TUI with auto-start proxy and system proxy ([6ac8035](https://github.com/rvanbaalen/laurel-proxy/commit/6ac80350a6740f99470058c823f46c49bffd22cc))
* **cli:** add untrust-ca command to remove CA certificate from system trust store ([b8df7ea](https://github.com/rvanbaalen/laurel-proxy/commit/b8df7ea4c1629b4aa96b7ccd4bd6562f42ddb838))
* **cli:** show filtering examples in requests view ([2500b86](https://github.com/rvanbaalen/laurel-proxy/commit/2500b867824d8bbf93fab7b149603cf8d1d19ddc))
* **db:** add statusMin/statusMax/durationMin filter support with duration index ([d2f423f](https://github.com/rvanbaalen/laurel-proxy/commit/d2f423f0cc16cc40174e713ca5ae05b83908dcda))
* **demo:** add terminal recording with simulated Claude Code UI ([095c208](https://github.com/rvanbaalen/laurel-proxy/commit/095c2082a20c9cf0f3823b408d6b8ee9fbc558fd))
* **demo:** polished recording with colored agent UI ([da5a5e5](https://github.com/rvanbaalen/laurel-proxy/commit/da5a5e554e208d76ab01f90538f9a8d81c79db68))
* **demo:** slow down pacing between scenes ([5391b16](https://github.com/rvanbaalen/laurel-proxy/commit/5391b161a512280253d2a613baf3739a6f96d476))
* detect and kill existing instances on start ([e6e56bd](https://github.com/rvanbaalen/laurel-proxy/commit/e6e56bdf71e810001e19c12d11c70bae8676f5cb))
* execute proxy/cert/ui actions directly from interactive menu ([53f3cd7](https://github.com/rvanbaalen/laurel-proxy/commit/53f3cd7eda075c52fc66174aadc6eca042b0d6a8))
* live client-side filtering as you type ([c956c4c](https://github.com/rvanbaalen/laurel-proxy/commit/c956c4c5cd506911912af7d8e3118754cbda0151))
* rename RoxyProxy to Laurel Proxy ([76a0711](https://github.com/rvanbaalen/laurel-proxy/commit/76a071115c9103bc8a74f9299882930d92e94048))
* **replay:** add --diff flag to compare original vs replay response ([bc9620c](https://github.com/rvanbaalen/laurel-proxy/commit/bc9620c622fc84c2e5631c64373301e28c9cb4c8))
* resizable detail panel and click-to-toggle selection ([45d96e4](https://github.com/rvanbaalen/laurel-proxy/commit/45d96e4b519e8105b52969b358d1a5855877fec8))
* scaffold project with TypeScript config and shared types ([97a6c53](https://github.com/rvanbaalen/laurel-proxy/commit/97a6c5366f0a35cfb7210a67a31ac35d124f4165))
* **server:** add system proxy GET/POST API endpoints ([750d0da](https://github.com/rvanbaalen/laurel-proxy/commit/750d0dae0e14a25f6b99da70d2726670437a5fc3))
* **server:** detect and kill stale roxyproxy instances on port conflict ([058abc9](https://github.com/rvanbaalen/laurel-proxy/commit/058abc98c443a0eff145e246206798c208b2f6e8))
* toggle proxy start/stop, check CA trust status on startup ([4d8b7fc](https://github.com/rvanbaalen/laurel-proxy/commit/4d8b7fc9a316c09009a7975b79a03b4722579a5b))
* toggle system proxy with status badge, clear screen on start ([8449f69](https://github.com/rvanbaalen/laurel-proxy/commit/8449f6951ea2e56dbae8008141919aaa3390a2de))
* **ui:** add copy-as-curl button to request detail panel ([a254a70](https://github.com/rvanbaalen/laurel-proxy/commit/a254a70dced9b070d47bbb63c62a76297b6ed7dc))
* **ui:** add design system foundation — tokens, fonts, scrollbars, animations ([8fc16da](https://github.com/rvanbaalen/laurel-proxy/commit/8fc16da2f91a9c0fe4ee1259ab232d321e2102c3))
* **ui:** add historical traffic, sortable/resizable columns, and datetime display ([cb947eb](https://github.com/rvanbaalen/laurel-proxy/commit/cb947ebb4a807b3ce7f3a5392a4449b0fdeb01b1))
* **ui:** add network hostname and CA cert link to toolbar ([9e2b132](https://github.com/rvanbaalen/laurel-proxy/commit/9e2b1328e89b04147f50b9364ec1ff310645efd5))
* **ui:** full visual redesign — unified workspace, design tokens, transitions ([9720df0](https://github.com/rvanbaalen/laurel-proxy/commit/9720df0577945a805664836ebb902ed157b76df9))
* **ui:** make web interface mobile-friendly ([62a7a52](https://github.com/rvanbaalen/laurel-proxy/commit/62a7a526b31144001494bdd9b6d692ac2536f21b))
* wire up Traffic/Repeater view switching in App ([04e888d](https://github.com/rvanbaalen/laurel-proxy/commit/04e888d779e85a935a612538f0bba140280d2eeb))


### Bug Fixes

* cleanup deletes oldest in batches, stop shuts down server ([b52dcbb](https://github.com/rvanbaalen/laurel-proxy/commit/b52dcbb9df77c9db469dffed30cb1dc98533884b))
* **cli:** pretty-print JSON bodies and decode base64 in tail TUI detail view ([4b30400](https://github.com/rvanbaalen/laurel-proxy/commit/4b30400eb2e949ce044d03f0e3789ba34276bd6c))
* correct release-please package-name to laurel-proxy ([e8dec05](https://github.com/rvanbaalen/laurel-proxy/commit/e8dec05bd339be0be67a44e962927f68fdb87409))
* destroy open connections on shutdown to prevent hang ([61b610a](https://github.com/rvanbaalen/laurel-proxy/commit/61b610aeb1d31161e9327a28f17deb66c359cc5b))
* handle Ctrl+C and q to quit interactive CLI ([0aba96d](https://github.com/rvanbaalen/laurel-proxy/commit/0aba96d5446f9ec10bbc463acf2496d3ce1b830d))
* resolve TypeScript compilation errors in api and proxy modules ([5af2d20](https://github.com/rvanbaalen/laurel-proxy/commit/5af2d205fe8eb555877ae2baffc807eba6af4c95))
* serialize Buffer bodies as base64 to prevent React render errors ([001110e](https://github.com/rvanbaalen/laurel-proxy/commit/001110ea09f62809b70fe0dd41a67f6794c7d378))
* **server:** add error handling for port binding failures ([895b242](https://github.com/rvanbaalen/laurel-proxy/commit/895b242f3138f262914a621489f25d4cb4a7d57e))
* **server:** auto-retry next port on EADDRINUSE instead of crashing ([256f19b](https://github.com/rvanbaalen/laurel-proxy/commit/256f19bd34949558d7d7c458e26026498a0729ad))
* **server:** fix proxy stop hanging, add real-time CLI/Web state sync via SSE ([d0aaf11](https://github.com/rvanbaalen/laurel-proxy/commit/d0aaf11fc65597f3023638d7171971e7fdde0333))
* **storage:** reclaim disk space on clear and fix stale db size indicator ([01f1914](https://github.com/rvanbaalen/laurel-proxy/commit/01f19144ce44938d6dffc8f99f74eba34dcffd63))
* update CLI ASCII art banner to Laurel Proxy ([3d20363](https://github.com/rvanbaalen/laurel-proxy/commit/3d20363fc0c9d85d4ffedbce07cd919417a992aa))
* use actual UI port instead of hardcoded 8081 in interactive CLI ([16928e3](https://github.com/rvanbaalen/laurel-proxy/commit/16928e3f7ee1cfb8c09c0ebf910ad2bbb244acb7))
* use proper ANSI escape for terminal clear ([6253c3d](https://github.com/rvanbaalen/laurel-proxy/commit/6253c3d24c604cf2223e3b74e48d2ef43d560fda))


### Reverts

* move plugin back to repo root (marketplace requires whole repo) ([88989ba](https://github.com/rvanbaalen/laurel-proxy/commit/88989ba6952de2bb31cb3dd848df4e4ec1a27b47))

## [0.1.7](https://github.com/rvanbaalen/laurel-proxy/compare/laurel-proxy-v0.1.6...laurel-proxy-v0.1.7) (2026-03-27)


### Features

* add Repeater component with tabbed editor and response viewer ([ca8e5e0](https://github.com/rvanbaalen/laurel-proxy/commit/ca8e5e01bafa28fc08c0df52b1b8db55813a9374))
* **cli:** add agent output format for LLM-friendly request inspection ([f4af6a4](https://github.com/rvanbaalen/laurel-proxy/commit/f4af6a4c5f73db5a960869c9c0b07884444da3a7))
* **cli:** add buildFilter helper with --failed/--last-hour/--last-day/--slow aliases ([4edf399](https://github.com/rvanbaalen/laurel-proxy/commit/4edf399e1f8264d3e81454cfb482c7f7f53e242a))
* **db:** add statusMin/statusMax/durationMin filter support with duration index ([d2f423f](https://github.com/rvanbaalen/laurel-proxy/commit/d2f423f0cc16cc40174e713ca5ae05b83908dcda))
* detect and kill existing instances on start ([e6e56bd](https://github.com/rvanbaalen/laurel-proxy/commit/e6e56bdf71e810001e19c12d11c70bae8676f5cb))
* wire up Traffic/Repeater view switching in App ([04e888d](https://github.com/rvanbaalen/laurel-proxy/commit/04e888d779e85a935a612538f0bba140280d2eeb))

## [0.1.6](https://github.com/rvanbaalen/laurel-proxy/compare/laurel-proxy-v0.1.5...laurel-proxy-v0.1.6) (2026-03-18)


### Features

* add POST /api/replay endpoint ([b255534](https://github.com/rvanbaalen/laurel-proxy/commit/b255534ac9d25001304ee783d022c1d0f2feb4a6))
* add replay module for resending HTTP requests ([35d56ab](https://github.com/rvanbaalen/laurel-proxy/commit/35d56ab0b93589031930a7c849b62b2fbb0c08fd))
* add ReplayRequest and ReplayResponse types ([1b81fb1](https://github.com/rvanbaalen/laurel-proxy/commit/1b81fb1e94abc7782463208d7907a2d805e8fd06))
* add replayRequest API client function ([38c4434](https://github.com/rvanbaalen/laurel-proxy/commit/38c443485670240c7229093560e3e76db0113480))
* add laurel-proxy replay CLI command ([d6b6dd9](https://github.com/rvanbaalen/laurel-proxy/commit/d6b6dd962ec821cadeae96badb286b9f6e21c7fa))
* **ui:** make web interface mobile-friendly ([62a7a52](https://github.com/rvanbaalen/laurel-proxy/commit/62a7a526b31144001494bdd9b6d692ac2536f21b))

## [0.1.5](https://github.com/rvanbaalen/laurel-proxy/compare/laurel-proxy-v0.1.4...laurel-proxy-v0.1.5) (2026-03-18)


### Features

* **ui:** add copy-as-curl button to request detail panel ([a254a70](https://github.com/rvanbaalen/laurel-proxy/commit/a254a70dced9b070d47bbb63c62a76297b6ed7dc))
* **ui:** add network hostname and CA cert link to toolbar ([9e2b132](https://github.com/rvanbaalen/laurel-proxy/commit/9e2b1328e89b04147f50b9364ec1ff310645efd5))


### Bug Fixes

* **storage:** reclaim disk space on clear and fix stale db size indicator ([01f1914](https://github.com/rvanbaalen/laurel-proxy/commit/01f19144ce44938d6dffc8f99f74eba34dcffd63))

## [0.1.4](https://github.com/rvanbaalen/laurel-proxy/compare/laurel-proxy-v0.1.3...laurel-proxy-v0.1.4) (2026-03-18)


### Features

* add ios inspection support ([#5](https://github.com/rvanbaalen/laurel-proxy/issues/5)) ([eaf7573](https://github.com/rvanbaalen/laurel-proxy/commit/eaf75738899309f80dae0296c289039fc21e8682))
* **cli:** add interactive tail TUI with auto-start proxy and system proxy ([6ac8035](https://github.com/rvanbaalen/laurel-proxy/commit/6ac80350a6740f99470058c823f46c49bffd22cc))


### Bug Fixes

* **cli:** pretty-print JSON bodies and decode base64 in tail TUI detail view ([4b30400](https://github.com/rvanbaalen/laurel-proxy/commit/4b30400eb2e949ce044d03f0e3789ba34276bd6c))

## [0.1.3](https://github.com/rvanbaalen/laurel-proxy/compare/laurel-proxy-v0.1.2...laurel-proxy-v0.1.3) (2026-03-17)


### Bug Fixes

* use actual UI port instead of hardcoded 8081 in interactive CLI ([16928e3](https://github.com/rvanbaalen/laurel-proxy/commit/16928e3f7ee1cfb8c09c0ebf910ad2bbb244acb7))

## [0.1.2](https://github.com/rvanbaalen/laurel-proxy/compare/laurel-proxy-v0.1.1...laurel-proxy-v0.1.2) (2026-03-17)


### Features

* add Claude Code plugin with laurel-proxy skill ([3c7d227](https://github.com/rvanbaalen/laurel-proxy/commit/3c7d22716ddc633eaa371320c193b68f2266a2d9))
* add marketplace.json for Claude Code plugin installation ([2afc0b5](https://github.com/rvanbaalen/laurel-proxy/commit/2afc0b5b352e4806635863a72916b3dd40f251b3))
* **cli:** add untrust-ca command to remove CA certificate from system trust store ([b8df7ea](https://github.com/rvanbaalen/laurel-proxy/commit/b8df7ea4c1629b4aa96b7ccd4bd6562f42ddb838))
* **cli:** show filtering examples in requests view ([2500b86](https://github.com/rvanbaalen/laurel-proxy/commit/2500b867824d8bbf93fab7b149603cf8d1d19ddc))
* **server:** detect and kill stale laurel-proxy instances on port conflict ([058abc9](https://github.com/rvanbaalen/laurel-proxy/commit/058abc98c443a0eff145e246206798c208b2f6e8))


### Bug Fixes

* **server:** add error handling for port binding failures ([895b242](https://github.com/rvanbaalen/laurel-proxy/commit/895b242f3138f262914a621489f25d4cb4a7d57e))
* **server:** auto-retry next port on EADDRINUSE instead of crashing ([256f19b](https://github.com/rvanbaalen/laurel-proxy/commit/256f19bd34949558d7d7c458e26026498a0729ad))


### Reverts

* move plugin back to repo root (marketplace requires whole repo) ([88989ba](https://github.com/rvanbaalen/laurel-proxy/commit/88989ba6952de2bb31cb3dd848df4e4ec1a27b47))

## [0.1.1](https://github.com/rvanbaalen/laurel-proxy/compare/laurel-proxy-v0.1.0...laurel-proxy-v0.1.1) (2026-03-17)


### Features

* add CA certificate generation with LRU-cached per-domain certs ([ec80885](https://github.com/rvanbaalen/laurel-proxy/commit/ec80885f532e6ab6d2bb830de7b15f3d1863ccce))
* add CLI with start, stop, status, requests, clear, and trust-ca commands ([5098216](https://github.com/rvanbaalen/laurel-proxy/commit/5098216d18b78b3f20fd2bbe24d95fc344de8783))
* add colored CLI with ASCII art, interactive cert install, system proxy commands ([e8f2bd5](https://github.com/rvanbaalen/laurel-proxy/commit/e8f2bd546ae86c2f498eee13d6d3bc0b46808301))
* add config loading with defaults, file, and CLI flag merging ([1db5d1d](https://github.com/rvanbaalen/laurel-proxy/commit/1db5d1d56b870e30723b6194f20687facc98fc29))
* add HTTP/HTTPS proxy engine with MITM interception ([099d0d6](https://github.com/rvanbaalen/laurel-proxy/commit/099d0d6d4b43b7fc8961cda53db876d71c638a41))
* add Ink-based interactive CLI mode ([5f9f8c5](https://github.com/rvanbaalen/laurel-proxy/commit/5f9f8c5f0aaddf0be8c5fc79e3c4e93f1b3bf02a))
* add integration tests and fix Express 5 wildcard route ([e20df33](https://github.com/rvanbaalen/laurel-proxy/commit/e20df3396d9671e0a45df35a379a94019439eb6e))
* add REST API with request querying, SSE events, and proxy control ([d968839](https://github.com/rvanbaalen/laurel-proxy/commit/d9688396bc47a51c307f3a5cad1451ea9acb192a))
* add server orchestrator wiring proxy, API, and storage ([a260f77](https://github.com/rvanbaalen/laurel-proxy/commit/a260f77a8eb1d11b2b1b86a696c084007d26894b))
* add SQLite storage layer with query filtering and auto-cleanup ([1fb3820](https://github.com/rvanbaalen/laurel-proxy/commit/1fb38205a927b03a19dff68ac4e1990d52ffdbf2))
* add SSE event manager with 100ms batching ([14dff5c](https://github.com/rvanbaalen/laurel-proxy/commit/14dff5c9ee5da5ac1468d875c23d45bafb54f6db))
* add web UI with traffic list, request detail, filters, and controls ([e5f3e95](https://github.com/rvanbaalen/laurel-proxy/commit/e5f3e95677150834149d5619c8859c851112c19b))
* execute proxy/cert/ui actions directly from interactive menu ([53f3cd7](https://github.com/rvanbaalen/laurel-proxy/commit/53f3cd7eda075c52fc66174aadc6eca042b0d6a8))
* live client-side filtering as you type ([c956c4c](https://github.com/rvanbaalen/laurel-proxy/commit/c956c4c5cd506911912af7d8e3118754cbda0151))
* resizable detail panel and click-to-toggle selection ([45d96e4](https://github.com/rvanbaalen/laurel-proxy/commit/45d96e4b519e8105b52969b358d1a5855877fec8))
* scaffold project with TypeScript config and shared types ([97a6c53](https://github.com/rvanbaalen/laurel-proxy/commit/97a6c5366f0a35cfb7210a67a31ac35d124f4165))
* toggle proxy start/stop, check CA trust status on startup ([4d8b7fc](https://github.com/rvanbaalen/laurel-proxy/commit/4d8b7fc9a316c09009a7975b79a03b4722579a5b))
* toggle system proxy with status badge, clear screen on start ([8449f69](https://github.com/rvanbaalen/laurel-proxy/commit/8449f6951ea2e56dbae8008141919aaa3390a2de))
* **ui:** add historical traffic, sortable/resizable columns, and datetime display ([cb947eb](https://github.com/rvanbaalen/laurel-proxy/commit/cb947ebb4a807b3ce7f3a5392a4449b0fdeb01b1))


### Bug Fixes

* cleanup deletes oldest in batches, stop shuts down server ([b52dcbb](https://github.com/rvanbaalen/laurel-proxy/commit/b52dcbb9df77c9db469dffed30cb1dc98533884b))
* destroy open connections on shutdown to prevent hang ([61b610a](https://github.com/rvanbaalen/laurel-proxy/commit/61b610aeb1d31161e9327a28f17deb66c359cc5b))
* handle Ctrl+C and q to quit interactive CLI ([0aba96d](https://github.com/rvanbaalen/laurel-proxy/commit/0aba96d5446f9ec10bbc463acf2496d3ce1b830d))
* resolve TypeScript compilation errors in api and proxy modules ([5af2d20](https://github.com/rvanbaalen/laurel-proxy/commit/5af2d205fe8eb555877ae2baffc807eba6af4c95))
* serialize Buffer bodies as base64 to prevent React render errors ([001110e](https://github.com/rvanbaalen/laurel-proxy/commit/001110ea09f62809b70fe0dd41a67f6794c7d378))
* **server:** fix proxy stop hanging, add real-time CLI/Web state sync via SSE ([d0aaf11](https://github.com/rvanbaalen/laurel-proxy/commit/d0aaf11fc65597f3023638d7171971e7fdde0333))
* use proper ANSI escape for terminal clear ([6253c3d](https://github.com/rvanbaalen/laurel-proxy/commit/6253c3d24c604cf2223e3b74e48d2ef43d560fda))
