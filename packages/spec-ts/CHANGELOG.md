# Changelog

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
