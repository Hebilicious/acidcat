# Changelog

## [0.19.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.18.0...@acid-cat/spec-ts@0.19.0) (2026-11-25)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions

## [0.18.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.17.0...@acid-cat/spec-ts@0.18.0) (2026-11-24)


### ⚠ BREAKING CHANGES

* **spec:** rename binding to surface, and give each target its catalog in place of a view ([#215](https://github.com/Hebilicious/acidcat/issues/215))

### Features

* **spec:** rename binding to surface, and give each target its catalog in place of a view ([#215](https://github.com/Hebilicious/acidcat/issues/215)) ([052ceab](https://github.com/Hebilicious/acidcat/commit/052ceab833bcdad8fb764e25b187e68e6b776087))

## [0.17.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.16.0...@acid-cat/spec-ts@0.17.0) (2026-11-23)


### Features

* **mcp:** check the Mcp-Method, Mcp-Name and Mcp-Param headers against the body ([#206](https://github.com/Hebilicious/acidcat/issues/206)) ([8067e0e](https://github.com/Hebilicious/acidcat/commit/8067e0ec328a1271afa5091b56f90cbf4b3142c9))
* **mcp:** negotiate the heartbeat interval of events/stream ([#205](https://github.com/Hebilicious/acidcat/issues/205)) ([73fcdd0](https://github.com/Hebilicious/acidcat/commit/73fcdd043badc06aedbfec0f67aead146ff8828a))
* **mcp:** serve an MCP Server Card, and sign webhook requests with Ed25519 keys ([#208](https://github.com/Hebilicious/acidcat/issues/208)) ([9fc1e51](https://github.com/Hebilicious/acidcat/commit/9fc1e511119fb9fd7a826072366372b19eaf20cd))

## [0.16.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.15.0...@acid-cat/spec-ts@0.16.0) (2026-11-19)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions

## [0.15.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.14.0...@acid-cat/spec-ts@0.15.0) (2026-11-18)


### ⚠ BREAKING CHANGES

* **conform:** keep each lease and webhook subscription alive for the whole check, and remove duplicate conform checks ([#197](https://github.com/Hebilicious/acidcat/issues/197))

### Bug Fixes

* **conform:** keep each lease and webhook subscription alive for the whole check, and remove duplicate conform checks ([#197](https://github.com/Hebilicious/acidcat/issues/197)) ([fc02fe3](https://github.com/Hebilicious/acidcat/commit/fc02fe31483b97e0d4b76972e6f57f786e3ee78c))

## [0.14.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.13.1...@acid-cat/spec-ts@0.14.0) (2026-11-18)


### Features

* **catalog:** add the destructive and idempotent hints of a capability ([#183](https://github.com/Hebilicious/acidcat/issues/183)) ([0e21bea](https://github.com/Hebilicious/acidcat/commit/0e21bea609b3e3392a9bf8f89ce8cd2e17a4188a))
* **cli:** allow command aliases of two words ([#185](https://github.com/Hebilicious/acidcat/issues/185)) ([ae0ef97](https://github.com/Hebilicious/acidcat/commit/ae0ef978ccc54e1387d10de2ae1f2c6c3f501fe8))
* **cli:** let an alias be the default of a shared prefix ([#187](https://github.com/Hebilicious/acidcat/issues/187)) ([89c50a4](https://github.com/Hebilicious/acidcat/commit/89c50a480279ade527ce32e42b6ed5da0acbbee6))


### Bug Fixes

* **cli:** write the help of a command and the command list of a shared prefix ([#186](https://github.com/Hebilicious/acidcat/issues/186)) ([82773ae](https://github.com/Hebilicious/acidcat/commit/82773ae65ba798e807bcdfeafb882845743c8487))

## [0.13.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.13.0...@acid-cat/spec-ts@0.13.1) (2026-11-17)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions

## [0.13.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.12.1...@acid-cat/spec-ts@0.13.0) (2026-11-17)


### Features

* **cli:** exit with 130 after a grace period when an interrupt cannot stop the run ([#168](https://github.com/Hebilicious/acidcat/issues/168)) ([74b2623](https://github.com/Hebilicious/acidcat/commit/74b26236afe2b1a68c779e9f2605c18397b16bf8))

## [0.12.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.12.0...@acid-cat/spec-ts@0.12.1) (2026-11-17)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions

## [0.12.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.11.2...@acid-cat/spec-ts@0.12.0) (2026-11-17)


### Features

* **cli:** add aliases of events and a default alias ([#146](https://github.com/Hebilicious/acidcat/issues/146)) ([cf40029](https://github.com/Hebilicious/acidcat/commit/cf4002937a50c059d45411fa680be7005796198c))
* **cli:** add aliases to the CLI binding ([#145](https://github.com/Hebilicious/acidcat/issues/145)) ([63c3f87](https://github.com/Hebilicious/acidcat/commit/63c3f87033240833a43a3219d265333de74f8128))


### Code Refactoring

* **model:** generate the shared facts of the cores from one source ([#163](https://github.com/Hebilicious/acidcat/issues/163)) ([10c2a0d](https://github.com/Hebilicious/acidcat/commit/10c2a0d7eabb5180015ea95d4d0fa97214f7eaeb))

## [0.11.2](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.11.1...@acid-cat/spec-ts@0.11.2) (2026-11-16)


### Code Refactoring

* **cores:** say in code what the deleted comments said ([#144](https://github.com/Hebilicious/acidcat/issues/144)) ([c590bed](https://github.com/Hebilicious/acidcat/commit/c590bedc37cf93ce593311655030c58bc1c5973a))

## [0.11.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.11.0...@acid-cat/spec-ts@0.11.1) (2026-11-15)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions

## [0.11.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.10.2...@acid-cat/spec-ts@0.11.0) (2026-11-14)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions

## [0.10.2](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.10.1...@acid-cat/spec-ts@0.10.2) (2026-11-12)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions

## [0.10.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.10.0...@acid-cat/spec-ts@0.10.1) (2026-11-12)


### Bug Fixes

* **cli:** reject inherited names, sort integer-like keys by code point, and resolve a $ref with other keys ([#115](https://github.com/Hebilicious/acidcat/issues/115)) ([c690f83](https://github.com/Hebilicious/acidcat/commit/c690f8357cd4d47f32baa4d9aa02281f06a8339e))

## [0.10.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.9.0...@acid-cat/spec-ts@0.10.0) (2026-11-10)


### Features

* **spec:** add events, subscriptions and occurrences, with catalog support in every library ([#106](https://github.com/Hebilicious/acidcat/issues/106)) ([3391fb3](https://github.com/Hebilicious/acidcat/commit/3391fb3ef683c4cb0cc5a252fe4bd4c70eee25bf))

## [0.9.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.8.0...@acid-cat/spec-ts@0.9.0) (2026-10-28)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions

## [0.8.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.7.0...@acid-cat/spec-ts@0.8.0) (2026-10-28)


### Features

* **cli:** take array inputs as repeated flags ([#81](https://github.com/Hebilicious/acidcat/issues/81)) ([f33b456](https://github.com/Hebilicious/acidcat/commit/f33b456ac7ee2bf83f2f8dda1446f370d12b653d))

## [0.7.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.6.1...@acid-cat/spec-ts@0.7.0) (2026-10-27)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions

## [0.6.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.6.0...@acid-cat/spec-ts@0.6.1) (2026-10-27)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions

## [0.6.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.5.0...@acid-cat/spec-ts@0.6.0) (2026-10-26)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions

## [0.5.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.4.0...@acid-cat/spec-ts@0.5.0) (2026-10-25)


### ⚠ BREAKING CHANGES

* **cores:** `@acid-cat/spec-ts` `fail` takes the whole failure: `fail({ _tag: "Offline" })` instead of `fail("Offline")`. The old signature accepted a type for the data that the call did not give.

### Code Refactoring

* **cores:** type capabilities, sessions and failures so that no code needs a type assertion ([#67](https://github.com/Hebilicious/acidcat/issues/67)) ([6841a29](https://github.com/Hebilicious/acidcat/commit/6841a29031894c8e7df29bcf47d670ac18046ba1))

## [0.4.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.3.1...@acid-cat/spec-ts@0.4.0) (2026-10-16)


### Bug Fixes

* **cores:** write an input that is a union of objects as an object schema ([#58](https://github.com/Hebilicious/acidcat/issues/58)) ([ab58953](https://github.com/Hebilicious/acidcat/commit/ab58953d051936d7c687b3964c483db95b5a7388))

## [0.3.1](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.3.0...@acid-cat/spec-ts@0.3.1) (2026-10-15)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions

## [0.3.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.2.0...@acid-cat/spec-ts@0.3.0) (2026-10-14)


### Bug Fixes

* **cli:** write the flags of each command in the usage that list gives ([#27](https://github.com/Hebilicious/acidcat/issues/27)) ([a0777b9](https://github.com/Hebilicious/acidcat/commit/a0777b9d199a9b7fdd3fe45c947104bd2b0bee5d))

## [0.2.0](https://github.com/Hebilicious/acidcat/compare/@acid-cat/spec-ts@0.1.0...@acid-cat/spec-ts@0.2.0) (2026-10-14)


### Miscellaneous Chores

* **@acid-cat/spec-ts:** Synchronize npm versions
