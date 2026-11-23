# Changelog

## [0.17.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.16.0...@acid-cat/core-ts@0.17.0) (2026-11-23)


### Features

* **mcp:** check the Mcp-Method, Mcp-Name and Mcp-Param headers against the body ([#206](https://github.com/Hebilicious/acidcat/issues/206)) ([8067e0e](https://github.com/Hebilicious/acidcat/commit/8067e0ec328a1271afa5091b56f90cbf4b3142c9))
* **mcp:** negotiate the heartbeat interval of events/stream ([#205](https://github.com/Hebilicious/acidcat/issues/205)) ([73fcdd0](https://github.com/Hebilicious/acidcat/commit/73fcdd043badc06aedbfec0f67aead146ff8828a))
* **mcp:** serve an MCP Server Card, and sign webhook requests with Ed25519 keys ([#208](https://github.com/Hebilicious/acidcat/issues/208)) ([9fc1e51](https://github.com/Hebilicious/acidcat/commit/9fc1e511119fb9fd7a826072366372b19eaf20cd))

## [0.16.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.15.0...@acid-cat/core-ts@0.16.0) (2026-11-19)


### Features

* **cli:** write JSON output on one line when standard output is not a terminal ([#203](https://github.com/Hebilicious/acidcat/issues/203)) ([6ea22b2](https://github.com/Hebilicious/acidcat/commit/6ea22b2d17cdc15ed238cce7b1a7659ecaa250fc)), closes [#202](https://github.com/Hebilicious/acidcat/issues/202)

## [0.15.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.14.0...@acid-cat/core-ts@0.15.0) (2026-11-18)


### ⚠ BREAKING CHANGES

* **conform:** keep each lease and webhook subscription alive for the whole check, and remove duplicate conform checks ([#197](https://github.com/Hebilicious/acidcat/issues/197))

### Bug Fixes

* **cli:** start the independent processes of the conformance checks of the command line at the same time ([#192](https://github.com/Hebilicious/acidcat/issues/192)) ([ad1503c](https://github.com/Hebilicious/acidcat/commit/ad1503cc15ee4e5068fe045d08425b525d04b979))
* **conform:** keep each lease and webhook subscription alive for the whole check, and remove duplicate conform checks ([#197](https://github.com/Hebilicious/acidcat/issues/197)) ([fc02fe3](https://github.com/Hebilicious/acidcat/commit/fc02fe31483b97e0d4b76972e6f57f786e3ee78c))
* **core-ts:** treat a path that is not under base as an unknown route, and audit the tests ([#198](https://github.com/Hebilicious/acidcat/issues/198)) ([8536b17](https://github.com/Hebilicious/acidcat/commit/8536b17021134a238701b77973d30fa3bc9b9a2e))

## [0.14.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.13.1...@acid-cat/core-ts@0.14.0) (2026-11-18)


### Features

* **catalog:** add the destructive and idempotent hints of a capability ([#183](https://github.com/Hebilicious/acidcat/issues/183)) ([0e21bea](https://github.com/Hebilicious/acidcat/commit/0e21bea609b3e3392a9bf8f89ce8cd2e17a4188a))
* **cli:** allow command aliases of two words ([#185](https://github.com/Hebilicious/acidcat/issues/185)) ([ae0ef97](https://github.com/Hebilicious/acidcat/commit/ae0ef978ccc54e1387d10de2ae1f2c6c3f501fe8))
* **cli:** let an alias be the default of a shared prefix ([#187](https://github.com/Hebilicious/acidcat/issues/187)) ([89c50a4](https://github.com/Hebilicious/acidcat/commit/89c50a480279ade527ce32e42b6ed5da0acbbee6))


### Bug Fixes

* **cli:** write the help of a command and the command list of a shared prefix ([#186](https://github.com/Hebilicious/acidcat/issues/186)) ([82773ae](https://github.com/Hebilicious/acidcat/commit/82773ae65ba798e807bcdfeafb882845743c8487))

## [0.13.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.13.0...@acid-cat/core-ts@0.13.1) (2026-11-17)


### Bug Fixes

* **core-ts:** give HandleOf and EventHandleOf the input type of the input schema only ([#178](https://github.com/Hebilicious/acidcat/issues/178)) ([92efe12](https://github.com/Hebilicious/acidcat/commit/92efe1224a6471f1e7088355a61662494c155acc))

## [0.13.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.12.1...@acid-cat/core-ts@0.13.0) (2026-11-17)


### Features

* **cli:** exit with 130 after a grace period when an interrupt cannot stop the run ([#168](https://github.com/Hebilicious/acidcat/issues/168)) ([74b2623](https://github.com/Hebilicious/acidcat/commit/74b26236afe2b1a68c779e9f2605c18397b16bf8))


### Bug Fixes

* **cli:** stop with the message and exit code 5 when the command line breaks a rule at start ([#166](https://github.com/Hebilicious/acidcat/issues/166)) ([e0c5173](https://github.com/Hebilicious/acidcat/commit/e0c5173870ef935b2ed3a0d34fed707915aec123))

## [0.12.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.12.0...@acid-cat/core-ts@0.12.1) (2026-11-17)


### Bug Fixes

* **cli:** ignore a first argument --, which package runners pass to the program ([#167](https://github.com/Hebilicious/acidcat/issues/167)) ([fdd3b9a](https://github.com/Hebilicious/acidcat/commit/fdd3b9a92b4c52fa5f2c239188797b160f5c533a))

## [0.12.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.11.2...@acid-cat/core-ts@0.12.0) (2026-11-17)


### ⚠ BREAKING CHANGES

* **cli:** add a human form of the output, off by default, with output flags and typed formatters in each core ([#159](https://github.com/Hebilicious/acidcat/issues/159))

### Features

* **cli:** add a human form of the output, off by default, with output flags and typed formatters in each core ([#159](https://github.com/Hebilicious/acidcat/issues/159)) ([c1794ec](https://github.com/Hebilicious/acidcat/commit/c1794ecc252aea5acdff269fa42a7f72375c34d1))
* **cli:** add aliases of events and a default alias ([#146](https://github.com/Hebilicious/acidcat/issues/146)) ([cf40029](https://github.com/Hebilicious/acidcat/commit/cf4002937a50c059d45411fa680be7005796198c))
* **cli:** add aliases to the CLI binding ([#145](https://github.com/Hebilicious/acidcat/issues/145)) ([63c3f87](https://github.com/Hebilicious/acidcat/commit/63c3f87033240833a43a3219d265333de74f8128))
* **model:** add a Quint model of the output rules of the CLI, with proofs and generated cases for each core ([#160](https://github.com/Hebilicious/acidcat/issues/160)) ([f1b3dfa](https://github.com/Hebilicious/acidcat/commit/f1b3dfacefb783f4567946646c11167325f1df75))


### Bug Fixes

* **core-effect:** write the help of a usage error to standard error ([#151](https://github.com/Hebilicious/acidcat/issues/151)) ([60a5225](https://github.com/Hebilicious/acidcat/commit/60a52256d897af0e12a639ff9cc175d316d2afd1))


### Code Refactoring

* **model:** generate the shared facts of the cores from one source ([#163](https://github.com/Hebilicious/acidcat/issues/163)) ([10c2a0d](https://github.com/Hebilicious/acidcat/commit/10c2a0d7eabb5180015ea95d4d0fa97214f7eaeb))

## [0.11.2](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.11.1...@acid-cat/core-ts@0.11.2) (2026-11-16)


### Code Refactoring

* **cores:** say in code what the deleted comments said ([#144](https://github.com/Hebilicious/acidcat/issues/144)) ([c590bed](https://github.com/Hebilicious/acidcat/commit/c590bedc37cf93ce593311655030c58bc1c5973a))

## [0.11.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.11.0...@acid-cat/core-ts@0.11.1) (2026-11-15)


### Bug Fixes

* **cores:** end watch with 130 and nothing on standard error when an interrupt comes before the subscription starts ([#137](https://github.com/Hebilicious/acidcat/issues/137)) ([99764b7](https://github.com/Hebilicious/acidcat/commit/99764b7ba5e805d91ee647dde78b7e7daaef2d28))

## [0.11.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.10.2...@acid-cat/core-ts@0.11.0) (2026-11-14)


### Features

* **core-rust:** add a Rust core that passes acid-cat conform ([#123](https://github.com/Hebilicious/acidcat/issues/123)) ([69f17a0](https://github.com/Hebilicious/acidcat/commit/69f17a072a999b5cfeac3c8eb9037ab62af6d94b))
* **cores:** give each capability its target, and let the context of a remote request refuse it ([#129](https://github.com/Hebilicious/acidcat/issues/129)) ([741daf1](https://github.com/Hebilicious/acidcat/commit/741daf181b2aed64667190bfd39cea2ae50c35c7))
* **cores:** let the command line call the HTTP binding of a server ([#125](https://github.com/Hebilicious/acidcat/issues/125)) ([37488ca](https://github.com/Hebilicious/acidcat/commit/37488ca54418957e98ced494fbcfff56f44ea9c8))


### Bug Fixes

* **cores:** count a webhook subscription that starts for the limit, and verify the URL as the client sent it ([#132](https://github.com/Hebilicious/acidcat/issues/132)) ([c5ad7a1](https://github.com/Hebilicious/acidcat/commit/c5ad7a1993f4fe7967e785955f1138019b81607d))

## [0.10.2](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.10.1...@acid-cat/core-ts@0.10.2) (2026-11-12)


### Performance Improvements

* **cores:** start the core-effect command line faster, and run the test suites in about one minute ([#121](https://github.com/Hebilicious/acidcat/issues/121)) ([0318ef7](https://github.com/Hebilicious/acidcat/commit/0318ef796d9f820e5d5bf8466a8efc68ea0ea8d3))

## [0.10.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.10.0...@acid-cat/core-ts@0.10.1) (2026-11-12)


### Bug Fixes

* **core-ts:** follow the webhook, maxAgeMs and error-precedence rules of the specification ([#116](https://github.com/Hebilicious/acidcat/issues/116)) ([09df3eb](https://github.com/Hebilicious/acidcat/commit/09df3eb686e08b96cb43b7e4ccbbb6b653de9184))

## [0.10.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.9.0...@acid-cat/core-ts@0.10.0) (2026-11-10)


### Features

* **cli:** test events with acid-cat conform, and follow aircon.status.changed from every API of the example ([#109](https://github.com/Hebilicious/acidcat/issues/109)) ([f6b4ca4](https://github.com/Hebilicious/acidcat/commit/f6b4ca4fa3869502d24f183628cc7e2ca6405f67))
* **core-ts:** serve events through the TypeScript, HTTP, CLI and MCP bindings ([#107](https://github.com/Hebilicious/acidcat/issues/107)) ([23b0b91](https://github.com/Hebilicious/acidcat/commit/23b0b91e04824399bbbe6a10d21c5a5eed1931d1))
* **mcp:** serve the initialize handshake of earlier revisions through @acid-cat/mcp-handshake ([#97](https://github.com/Hebilicious/acidcat/issues/97)) ([2db2231](https://github.com/Hebilicious/acidcat/commit/2db2231042a448b405d46bd5bc8c96172d6258fa))


### Bug Fixes

* **core-effect:** tell each change of the tools through stdio, update effect to 4.1.0, and make CI deterministic ([#92](https://github.com/Hebilicious/acidcat/issues/92)) ([df9e18b](https://github.com/Hebilicious/acidcat/commit/df9e18b9469b8e7f7cc1f620ca3ae4f3b8e6624f))

## [0.9.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.8.0...@acid-cat/core-ts@0.9.0) (2026-10-28)


### Features

* **mcp:** add a stdio transport to the MCP binding ([#82](https://github.com/Hebilicious/acidcat/issues/82)) ([a9f3043](https://github.com/Hebilicious/acidcat/commit/a9f3043a8b9888e50321bda8de4b44337a1a9098))

## [0.8.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.7.0...@acid-cat/core-ts@0.8.0) (2026-10-28)


### Features

* **cli:** take array inputs as repeated flags ([#81](https://github.com/Hebilicious/acidcat/issues/81)) ([f33b456](https://github.com/Hebilicious/acidcat/commit/f33b456ac7ee2bf83f2f8dda1446f370d12b653d))
* **cores:** serve web handlers on Node.js with no extra dependency ([#83](https://github.com/Hebilicious/acidcat/issues/83)) ([561eb59](https://github.com/Hebilicious/acidcat/commit/561eb590cc0824a0a64cca93b4cb7b3cfa1b5e6f))

## [0.7.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.6.1...@acid-cat/core-ts@0.7.0) (2026-10-27)


### Miscellaneous Chores

* **@acid-cat/core-ts:** Synchronize npm versions

## [0.6.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.6.0...@acid-cat/core-ts@0.6.1) (2026-10-27)


### Bug Fixes

* **cores:** declare the functions of a session as properties, so that code can pass them on alone ([#76](https://github.com/Hebilicious/acidcat/issues/76)) ([a9a7ddf](https://github.com/Hebilicious/acidcat/commit/a9a7ddfd179f949492ae88464c7e4c6e8e3f2e90))

## [0.6.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.5.0...@acid-cat/core-ts@0.6.0) (2026-10-26)


### Miscellaneous Chores

* **@acid-cat/core-ts:** Synchronize npm versions

## [0.5.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.4.0...@acid-cat/core-ts@0.5.0) (2026-10-25)


### ⚠ BREAKING CHANGES

* **cores:** `@acid-cat/core-ts` removes `getHandle` and `Handles`. Use `session.handle(capability)`. `session.handles` is a `ReadonlyMap<string, Handle>`.
* **cores:** `@acid-cat/spec-ts` `fail` takes the whole failure: `fail({ _tag: "Offline" })` instead of `fail("Offline")`. The old signature accepted a type for the data that the call did not give.

### Features

* **cores:** call a capability with session.call and session.handle, and close a session with await using ([#70](https://github.com/Hebilicious/acidcat/issues/70)) ([0e1dbb5](https://github.com/Hebilicious/acidcat/commit/0e1dbb5c8c31c42d75969b3147ccbea04063d886))


### Code Refactoring

* **cores:** type capabilities, sessions and failures so that no code needs a type assertion ([#67](https://github.com/Hebilicious/acidcat/issues/67)) ([6841a29](https://github.com/Hebilicious/acidcat/commit/6841a29031894c8e7df29bcf47d670ac18046ba1))

## [0.4.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.3.1...@acid-cat/core-ts@0.4.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* **core-effect:** read availability and state when they are needed ([#54](https://github.com/Hebilicious/acidcat/issues/54))
* **cli:** the conformance fixture has `fixture.hold`, `fixture.held` and `fixture.release` in place of `fixture.slow`. An implementation must serve them to pass `acid-cat conform`. `TestHost.call` takes an `id` in place of `cancelAfter`.

### Features

* **cli:** add the commands of the application to the command line ([#52](https://github.com/Hebilicious/acidcat/issues/52)) ([11981b9](https://github.com/Hebilicious/acidcat/commit/11981b97ec018ec1b61f8be8f0d787b71e2b0480))
* **core-effect:** read availability and state when they are needed ([#54](https://github.com/Hebilicious/acidcat/issues/54)) ([823a0ab](https://github.com/Hebilicious/acidcat/commit/823a0ab284106434de088fc5bffc52b38849d75c))
* **cores:** give handles the types of their capability ([#55](https://github.com/Hebilicious/acidcat/issues/55)) ([e7f5aa2](https://github.com/Hebilicious/acidcat/commit/e7f5aa2c1d05d71d629ebf647010e967f5846029))
* **cores:** keep the literal id of a capability, and infer its services from all its parts ([#59](https://github.com/Hebilicious/acidcat/issues/59)) ([23d82c4](https://github.com/Hebilicious/acidcat/commit/23d82c4893c9801a42719137176898f7ea0c763f))


### Bug Fixes

* **cli:** make conform wait for observable state, not for time, before it cancels a call ([#57](https://github.com/Hebilicious/acidcat/issues/57)) ([3bf6bee](https://github.com/Hebilicious/acidcat/commit/3bf6bee3d496a4f11279bcbdf2e48d410be9871c))
* **core-effect:** cancel the call when its request is aborted ([#51](https://github.com/Hebilicious/acidcat/issues/51)) ([9ed4686](https://github.com/Hebilicious/acidcat/commit/9ed4686379b6e804ca9923d63eb19f1c37efb09f))
* **cores:** write an input that is a union of objects as an object schema ([#58](https://github.com/Hebilicious/acidcat/issues/58)) ([ab58953](https://github.com/Hebilicious/acidcat/commit/ab58953d051936d7c687b3964c483db95b5a7388))


### Performance Improvements

* **cores:** open a session without writing JSON Schema ([#53](https://github.com/Hebilicious/acidcat/issues/53)) ([ff6a223](https://github.com/Hebilicious/acidcat/commit/ff6a223e2ae2e1d0869198192e28b95d6f65ea07))

## [0.3.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.3.0...@acid-cat/core-ts@0.3.1) (2026-10-15)


### Bug Fixes

* **core-effect:** write an empty Schema.Struct input as an object with no properties ([#30](https://github.com/Hebilicious/acidcat/issues/30)) ([f2f37c2](https://github.com/Hebilicious/acidcat/commit/f2f37c2187e09d876b74f004bb8e852e894ecab7))

## [0.3.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.2.0...@acid-cat/core-ts@0.3.0) (2026-10-14)


### Features

* **mcp:** give server instructions from the options, or else from the description of the catalog ([#26](https://github.com/Hebilicious/acidcat/issues/26)) ([cb91cfc](https://github.com/Hebilicious/acidcat/commit/cb91cfc6981bc316b89630a446bb604fe61a4051))


### Bug Fixes

* **cli:** write the flags of each command in the usage that list gives ([#27](https://github.com/Hebilicious/acidcat/issues/27)) ([a0777b9](https://github.com/Hebilicious/acidcat/commit/a0777b9d199a9b7fdd3fe45c947104bd2b0bee5d))

## [0.2.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/core-ts@0.1.0...@acid-cat/core-ts@0.2.0) (2026-10-14)


### Features

* **core-ts:** make the context of a web handler for each request, with createContext ([#17](https://github.com/Hebilicious/acidcat/issues/17)) ([ab14aea](https://github.com/Hebilicious/acidcat/commit/ab14aeade0d59f2b7ef51b3bdb833975e267765e))
