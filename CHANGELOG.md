# Changelog

## [0.1.1](https://github.com/rvanbaalen/roxyproxy/compare/roxyproxy-v0.1.0...roxyproxy-v0.1.1) (2026-03-17)


### Features

* add CA certificate generation with LRU-cached per-domain certs ([ec80885](https://github.com/rvanbaalen/roxyproxy/commit/ec80885f532e6ab6d2bb830de7b15f3d1863ccce))
* add CLI with start, stop, status, requests, clear, and trust-ca commands ([5098216](https://github.com/rvanbaalen/roxyproxy/commit/5098216d18b78b3f20fd2bbe24d95fc344de8783))
* add colored CLI with ASCII art, interactive cert install, system proxy commands ([e8f2bd5](https://github.com/rvanbaalen/roxyproxy/commit/e8f2bd546ae86c2f498eee13d6d3bc0b46808301))
* add config loading with defaults, file, and CLI flag merging ([1db5d1d](https://github.com/rvanbaalen/roxyproxy/commit/1db5d1d56b870e30723b6194f20687facc98fc29))
* add HTTP/HTTPS proxy engine with MITM interception ([099d0d6](https://github.com/rvanbaalen/roxyproxy/commit/099d0d6d4b43b7fc8961cda53db876d71c638a41))
* add Ink-based interactive CLI mode ([5f9f8c5](https://github.com/rvanbaalen/roxyproxy/commit/5f9f8c5f0aaddf0be8c5fc79e3c4e93f1b3bf02a))
* add integration tests and fix Express 5 wildcard route ([e20df33](https://github.com/rvanbaalen/roxyproxy/commit/e20df3396d9671e0a45df35a379a94019439eb6e))
* add REST API with request querying, SSE events, and proxy control ([d968839](https://github.com/rvanbaalen/roxyproxy/commit/d9688396bc47a51c307f3a5cad1451ea9acb192a))
* add server orchestrator wiring proxy, API, and storage ([a260f77](https://github.com/rvanbaalen/roxyproxy/commit/a260f77a8eb1d11b2b1b86a696c084007d26894b))
* add SQLite storage layer with query filtering and auto-cleanup ([1fb3820](https://github.com/rvanbaalen/roxyproxy/commit/1fb38205a927b03a19dff68ac4e1990d52ffdbf2))
* add SSE event manager with 100ms batching ([14dff5c](https://github.com/rvanbaalen/roxyproxy/commit/14dff5c9ee5da5ac1468d875c23d45bafb54f6db))
* add web UI with traffic list, request detail, filters, and controls ([e5f3e95](https://github.com/rvanbaalen/roxyproxy/commit/e5f3e95677150834149d5619c8859c851112c19b))
* execute proxy/cert/ui actions directly from interactive menu ([53f3cd7](https://github.com/rvanbaalen/roxyproxy/commit/53f3cd7eda075c52fc66174aadc6eca042b0d6a8))
* live client-side filtering as you type ([c956c4c](https://github.com/rvanbaalen/roxyproxy/commit/c956c4c5cd506911912af7d8e3118754cbda0151))
* resizable detail panel and click-to-toggle selection ([45d96e4](https://github.com/rvanbaalen/roxyproxy/commit/45d96e4b519e8105b52969b358d1a5855877fec8))
* scaffold project with TypeScript config and shared types ([97a6c53](https://github.com/rvanbaalen/roxyproxy/commit/97a6c5366f0a35cfb7210a67a31ac35d124f4165))
* toggle proxy start/stop, check CA trust status on startup ([4d8b7fc](https://github.com/rvanbaalen/roxyproxy/commit/4d8b7fc9a316c09009a7975b79a03b4722579a5b))
* toggle system proxy with status badge, clear screen on start ([8449f69](https://github.com/rvanbaalen/roxyproxy/commit/8449f6951ea2e56dbae8008141919aaa3390a2de))
* **ui:** add historical traffic, sortable/resizable columns, and datetime display ([cb947eb](https://github.com/rvanbaalen/roxyproxy/commit/cb947ebb4a807b3ce7f3a5392a4449b0fdeb01b1))


### Bug Fixes

* cleanup deletes oldest in batches, stop shuts down server ([b52dcbb](https://github.com/rvanbaalen/roxyproxy/commit/b52dcbb9df77c9db469dffed30cb1dc98533884b))
* destroy open connections on shutdown to prevent hang ([61b610a](https://github.com/rvanbaalen/roxyproxy/commit/61b610aeb1d31161e9327a28f17deb66c359cc5b))
* handle Ctrl+C and q to quit interactive CLI ([0aba96d](https://github.com/rvanbaalen/roxyproxy/commit/0aba96d5446f9ec10bbc463acf2496d3ce1b830d))
* resolve TypeScript compilation errors in api and proxy modules ([5af2d20](https://github.com/rvanbaalen/roxyproxy/commit/5af2d205fe8eb555877ae2baffc807eba6af4c95))
* serialize Buffer bodies as base64 to prevent React render errors ([001110e](https://github.com/rvanbaalen/roxyproxy/commit/001110ea09f62809b70fe0dd41a67f6794c7d378))
* **server:** fix proxy stop hanging, add real-time CLI/Web state sync via SSE ([d0aaf11](https://github.com/rvanbaalen/roxyproxy/commit/d0aaf11fc65597f3023638d7171971e7fdde0333))
* use proper ANSI escape for terminal clear ([6253c3d](https://github.com/rvanbaalen/roxyproxy/commit/6253c3d24c604cf2223e3b74e48d2ef43d560fda))
