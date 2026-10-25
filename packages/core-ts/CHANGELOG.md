# Changelog

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
