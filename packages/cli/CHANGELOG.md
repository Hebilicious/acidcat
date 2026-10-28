# Changelog

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
