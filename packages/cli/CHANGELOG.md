# Changelog

## [0.19.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.18.0...@acid-cat/cli@0.19.0) (2026-11-25)


### Features

* **conform:** stop a run of conform with an abort signal ([c7e995a](https://github.com/Hebilicious/acidcat/commit/c7e995ad3dd918f3300109a7a3ce257ce4255dfa))


### Bug Fixes

* **cli:** close no idle connection, and cut no accepted request at close ([c7e995a](https://github.com/Hebilicious/acidcat/commit/c7e995ad3dd918f3300109a7a3ce257ce4255dfa))
* **conform:** check the heartbeat interval from the request ([db50d54](https://github.com/Hebilicious/acidcat/commit/db50d54cc792700db7f7ed893cd40ee5c7860c68))
* **conform:** give each run of a property-based check the deadline ([c7e995a](https://github.com/Hebilicious/acidcat/commit/c7e995ad3dd918f3300109a7a3ce257ce4255dfa))
* **core-effect:** close no idle connection, and cut no accepted request at close ([c7e995a](https://github.com/Hebilicious/acidcat/commit/c7e995ad3dd918f3300109a7a3ce257ce4255dfa))
* **core-effect:** stop listening for interrupts when the program of NodeCli ends with no interrupt ([c7e995a](https://github.com/Hebilicious/acidcat/commit/c7e995ad3dd918f3300109a7a3ce257ce4255dfa))
* **core-rust:** exit at once at a second interrupt during the cancellation ([c7e995a](https://github.com/Hebilicious/acidcat/commit/c7e995ad3dd918f3300109a7a3ce257ce4255dfa))
* **core-rust:** listen for interrupts on a thread with its own runtime ([c7e995a](https://github.com/Hebilicious/acidcat/commit/c7e995ad3dd918f3300109a7a3ce257ce4255dfa))
* **core-rust:** send each message of a stream at once, with TCP_NODELAY ([db50d54](https://github.com/Hebilicious/acidcat/commit/db50d54cc792700db7f7ed893cd40ee5c7860c68))
* **core-rust:** stop listening for interrupts when run_cli_process returns with no interrupt ([c7e995a](https://github.com/Hebilicious/acidcat/commit/c7e995ad3dd918f3300109a7a3ce257ce4255dfa))
* **core-ts:** close no idle connection, and cut no accepted request at close ([c7e995a](https://github.com/Hebilicious/acidcat/commit/c7e995ad3dd918f3300109a7a3ce257ce4255dfa))
* **core-ts:** stop listening for interrupts when the run of cliMain ends with no interrupt ([c7e995a](https://github.com/Hebilicious/acidcat/commit/c7e995ad3dd918f3300109a7a3ce257ce4255dfa))
* **core-ts:** use the clock of webhookDelivery for the wait for each webhook answer ([db50d54](https://github.com/Hebilicious/acidcat/commit/db50d54cc792700db7f7ed893cd40ee5c7860c68))
* **core-ts:** use the clock option for the heartbeats of MCP event streams ([db50d54](https://github.com/Hebilicious/acidcat/commit/db50d54cc792700db7f7ed893cd40ee5c7860c68))


### Performance Improvements

* **core-effect:** build the TLS context of webhook requests once ([db50d54](https://github.com/Hebilicious/acidcat/commit/db50d54cc792700db7f7ed893cd40ee5c7860c68))
* **core-ts:** build the TLS context of webhook requests once ([db50d54](https://github.com/Hebilicious/acidcat/commit/db50d54cc792700db7f7ed893cd40ee5c7860c68))

## [0.18.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.17.0...@acid-cat/cli@0.18.0) (2026-11-24)


### ⚠ BREAKING CHANGES

* **spec:** rename binding to surface, and give each target its catalog in place of a view ([#215](https://github.com/Hebilicious/acidcat/issues/215))

### Features

* **site:** add the AcidCat site with the homepage, the docs, the specification and the packages ([82ac1cd](https://github.com/Hebilicious/acidcat/commit/82ac1cd748d2b960e4fb8537b0fb5e053303354c))
* **spec:** rename binding to surface, and give each target its catalog in place of a view ([#215](https://github.com/Hebilicious/acidcat/issues/215)) ([052ceab](https://github.com/Hebilicious/acidcat/commit/052ceab833bcdad8fb764e25b187e68e6b776087))

## [0.17.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.16.0...@acid-cat/cli@0.17.0) (2026-11-23)


### Features

* **mcp:** check the Mcp-Method, Mcp-Name and Mcp-Param headers against the body ([#206](https://github.com/Hebilicious/acidcat/issues/206)) ([8067e0e](https://github.com/Hebilicious/acidcat/commit/8067e0ec328a1271afa5091b56f90cbf4b3142c9))
* **mcp:** negotiate the heartbeat interval of events/stream ([#205](https://github.com/Hebilicious/acidcat/issues/205)) ([73fcdd0](https://github.com/Hebilicious/acidcat/commit/73fcdd043badc06aedbfec0f67aead146ff8828a))
* **mcp:** serve an MCP Server Card, and sign webhook requests with Ed25519 keys ([#208](https://github.com/Hebilicious/acidcat/issues/208)) ([9fc1e51](https://github.com/Hebilicious/acidcat/commit/9fc1e511119fb9fd7a826072366372b19eaf20cd))

## [0.16.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.15.0...@acid-cat/cli@0.16.0) (2026-11-19)


### Miscellaneous Chores

* **@acid-cat/cli:** Synchronize npm versions

## [0.15.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.14.0...@acid-cat/cli@0.15.0) (2026-11-18)


### ⚠ BREAKING CHANGES

* **conform:** keep each lease and webhook subscription alive for the whole check, and remove duplicate conform checks ([#197](https://github.com/Hebilicious/acidcat/issues/197))

### Bug Fixes

* **cli:** start the independent processes of the conformance checks of the command line at the same time ([#192](https://github.com/Hebilicious/acidcat/issues/192)) ([ad1503c](https://github.com/Hebilicious/acidcat/commit/ad1503cc15ee4e5068fe045d08425b525d04b979))
* **conform:** keep each lease and webhook subscription alive for the whole check, and remove duplicate conform checks ([#197](https://github.com/Hebilicious/acidcat/issues/197)) ([fc02fe3](https://github.com/Hebilicious/acidcat/commit/fc02fe31483b97e0d4b76972e6f57f786e3ee78c))

## [0.14.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.13.1...@acid-cat/cli@0.14.0) (2026-11-18)


### Features

* **catalog:** add the destructive and idempotent hints of a capability ([#183](https://github.com/Hebilicious/acidcat/issues/183)) ([0e21bea](https://github.com/Hebilicious/acidcat/commit/0e21bea609b3e3392a9bf8f89ce8cd2e17a4188a))
* **cli:** allow command aliases of two words ([#185](https://github.com/Hebilicious/acidcat/issues/185)) ([ae0ef97](https://github.com/Hebilicious/acidcat/commit/ae0ef978ccc54e1387d10de2ae1f2c6c3f501fe8))
* **cli:** let an alias be the default of a shared prefix ([#187](https://github.com/Hebilicious/acidcat/issues/187)) ([89c50a4](https://github.com/Hebilicious/acidcat/commit/89c50a480279ade527ce32e42b6ed5da0acbbee6))


### Bug Fixes

* **cli:** write the help of a command and the command list of a shared prefix ([#186](https://github.com/Hebilicious/acidcat/issues/186)) ([82773ae](https://github.com/Hebilicious/acidcat/commit/82773ae65ba798e807bcdfeafb882845743c8487))

## [0.13.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.13.0...@acid-cat/cli@0.13.1) (2026-11-17)


### Miscellaneous Chores

* **@acid-cat/cli:** Synchronize npm versions

## [0.13.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.12.1...@acid-cat/cli@0.13.0) (2026-11-17)


### Features

* **cli:** exit with 130 after a grace period when an interrupt cannot stop the run ([#168](https://github.com/Hebilicious/acidcat/issues/168)) ([74b2623](https://github.com/Hebilicious/acidcat/commit/74b26236afe2b1a68c779e9f2605c18397b16bf8))

## [0.12.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.12.0...@acid-cat/cli@0.12.1) (2026-11-17)


### Bug Fixes

* **cli:** ignore a first argument --, which package runners pass to the program ([#167](https://github.com/Hebilicious/acidcat/issues/167)) ([fdd3b9a](https://github.com/Hebilicious/acidcat/commit/fdd3b9a92b4c52fa5f2c239188797b160f5c533a))

## [0.12.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.11.2...@acid-cat/cli@0.12.0) (2026-11-17)


### Features

* **cli:** add aliases of events and a default alias ([#146](https://github.com/Hebilicious/acidcat/issues/146)) ([cf40029](https://github.com/Hebilicious/acidcat/commit/cf4002937a50c059d45411fa680be7005796198c))
* **cli:** add aliases to the CLI binding ([#145](https://github.com/Hebilicious/acidcat/issues/145)) ([63c3f87](https://github.com/Hebilicious/acidcat/commit/63c3f87033240833a43a3219d265333de74f8128))
* **cli:** give check and conform a JSON output for scripts and agents ([#154](https://github.com/Hebilicious/acidcat/issues/154)) ([29cf5ab](https://github.com/Hebilicious/acidcat/commit/29cf5abd70b4cc0c54e7a42696abd66f0f12e990))


### Bug Fixes

* **core-effect:** write the help of a usage error to standard error ([#151](https://github.com/Hebilicious/acidcat/issues/151)) ([60a5225](https://github.com/Hebilicious/acidcat/commit/60a52256d897af0e12a639ff9cc175d316d2afd1))

## [0.11.2](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.11.1...@acid-cat/cli@0.11.2) (2026-11-16)


### Code Refactoring

* **cores:** say in code what the deleted comments said ([#144](https://github.com/Hebilicious/acidcat/issues/144)) ([c590bed](https://github.com/Hebilicious/acidcat/commit/c590bedc37cf93ce593311655030c58bc1c5973a))

## [0.11.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.11.0...@acid-cat/cli@0.11.1) (2026-11-15)


### Miscellaneous Chores

* **@acid-cat/cli:** Synchronize npm versions

## [0.11.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.10.2...@acid-cat/cli@0.11.0) (2026-11-14)


### Miscellaneous Chores

* **@acid-cat/cli:** Synchronize npm versions

## [0.10.2](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.10.1...@acid-cat/cli@0.10.2) (2026-11-12)


### Bug Fixes

* **catalog:** require each schema of a catalog to be an object ([#120](https://github.com/Hebilicious/acidcat/issues/120)) ([5ce6008](https://github.com/Hebilicious/acidcat/commit/5ce60082e7f94b7837cf46ff46827638f65663da))

## [0.10.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.10.0...@acid-cat/cli@0.10.1) (2026-11-12)


### Bug Fixes

* **cli:** reject inherited names, sort integer-like keys by code point, and resolve a $ref with other keys ([#115](https://github.com/Hebilicious/acidcat/issues/115)) ([c690f83](https://github.com/Hebilicious/acidcat/commit/c690f8357cd4d47f32baa4d9aa02281f06a8339e))

## [0.10.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.9.0...@acid-cat/cli@0.10.0) (2026-11-10)


### Features

* **cli:** test events with acid-cat conform, and follow aircon.status.changed from every API of the example ([#109](https://github.com/Hebilicious/acidcat/issues/109)) ([f6b4ca4](https://github.com/Hebilicious/acidcat/commit/f6b4ca4fa3869502d24f183628cc7e2ca6405f67))
* **mcp:** serve the initialize handshake of earlier revisions through @acid-cat/mcp-handshake ([#97](https://github.com/Hebilicious/acidcat/issues/97)) ([2db2231](https://github.com/Hebilicious/acidcat/commit/2db2231042a448b405d46bd5bc8c96172d6258fa))
* **spec:** add events, subscriptions and occurrences, with catalog support in every library ([#106](https://github.com/Hebilicious/acidcat/issues/106)) ([3391fb3](https://github.com/Hebilicious/acidcat/commit/3391fb3ef683c4cb0cc5a252fe4bd4c70eee25bf))

## [0.9.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.8.0...@acid-cat/cli@0.9.0) (2026-10-28)


### Features

* **mcp:** add a stdio transport to the MCP binding ([#82](https://github.com/Hebilicious/acidcat/issues/82)) ([a9f3043](https://github.com/Hebilicious/acidcat/commit/a9f3043a8b9888e50321bda8de4b44337a1a9098))

## [0.8.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.7.0...@acid-cat/cli@0.8.0) (2026-10-28)


### Features

* **cli:** take array inputs as repeated flags ([#81](https://github.com/Hebilicious/acidcat/issues/81)) ([f33b456](https://github.com/Hebilicious/acidcat/commit/f33b456ac7ee2bf83f2f8dda1446f370d12b653d))
* **cores:** serve web handlers on Node.js with no extra dependency ([#83](https://github.com/Hebilicious/acidcat/issues/83)) ([561eb59](https://github.com/Hebilicious/acidcat/commit/561eb590cc0824a0a64cca93b4cb7b3cfa1b5e6f))

## [0.7.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.6.1...@acid-cat/cli@0.7.0) (2026-10-27)


### Miscellaneous Chores

* **@acid-cat/cli:** Synchronize npm versions

## [0.6.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.6.0...@acid-cat/cli@0.6.1) (2026-10-27)


### Miscellaneous Chores

* **@acid-cat/cli:** Synchronize npm versions

## [0.6.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.5.0...@acid-cat/cli@0.6.0) (2026-10-26)


### Miscellaneous Chores

* **@acid-cat/cli:** Synchronize npm versions

## [0.5.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.4.0...@acid-cat/cli@0.5.0) (2026-10-25)


### Miscellaneous Chores

* **@acid-cat/cli:** Synchronize npm versions

## [0.4.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.3.1...@acid-cat/cli@0.4.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* **cli:** the conformance fixture has `fixture.hold`, `fixture.held` and `fixture.release` in place of `fixture.slow`. An implementation must serve them to pass `acid-cat conform`. `TestHost.call` takes an `id` in place of `cancelAfter`.

### Bug Fixes

* **cli:** make conform wait for observable state, not for time, before it cancels a call ([#57](https://github.com/Hebilicious/acidcat/issues/57)) ([3bf6bee](https://github.com/Hebilicious/acidcat/commit/3bf6bee3d496a4f11279bcbdf2e48d410be9871c))

## [0.3.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.3.0...@acid-cat/cli@0.3.1) (2026-10-15)


### Bug Fixes

* **core-effect:** write an empty Schema.Struct input as an object with no properties ([#30](https://github.com/Hebilicious/acidcat/issues/30)) ([f2f37c2](https://github.com/Hebilicious/acidcat/commit/f2f37c2187e09d876b74f004bb8e852e894ecab7))

## [0.3.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.2.0...@acid-cat/cli@0.3.0) (2026-10-14)


### Features

* **mcp:** give server instructions from the options, or else from the description of the catalog ([#26](https://github.com/Hebilicious/acidcat/issues/26)) ([cb91cfc](https://github.com/Hebilicious/acidcat/commit/cb91cfc6981bc316b89630a446bb604fe61a4051))


### Bug Fixes

* **cli:** write the flags of each command in the usage that list gives ([#27](https://github.com/Hebilicious/acidcat/issues/27)) ([a0777b9](https://github.com/Hebilicious/acidcat/commit/a0777b9d199a9b7fdd3fe45c947104bd2b0bee5d))

## [0.2.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/cli@0.1.0...@acid-cat/cli@0.2.0) (2026-10-14)


### Bug Fixes

* **cli:** pin effect, @effect/platform-node and @effect/platform-node-shared to one version ([#11](https://github.com/Hebilicious/acidcat/issues/11)) ([528a66c](https://github.com/Hebilicious/acidcat/commit/528a66cb56dc88fb603d5da5b321a195d3d8cbaa))
