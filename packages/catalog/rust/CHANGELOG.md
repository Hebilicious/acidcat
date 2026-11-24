# Changelog

## [0.4.0](https://github.com/Hebilicious/acidcat/compare/crates/v0.3.1...crates/v0.4.0) (2026-11-24)


### ⚠ BREAKING CHANGES

* **spec:** rename binding to surface, and give each target its catalog in place of a view ([#215](https://github.com/Hebilicious/acidcat/issues/215))

### Features

* **spec:** rename binding to surface, and give each target its catalog in place of a view ([#215](https://github.com/Hebilicious/acidcat/issues/215)) ([052ceab](https://github.com/Hebilicious/acidcat/commit/052ceab833bcdad8fb764e25b187e68e6b776087))

## [0.3.1](https://github.com/Hebilicious/acidcat/compare/crates/v0.3.0...crates/v0.3.1) (2026-11-18)


### Bug Fixes

* **catalog:** write integers above 2^53 as JSON.stringify writes them ([d1dea9d](https://github.com/Hebilicious/acidcat/commit/d1dea9de906ea20f485b1f7c94f00195f9171db0))

## [0.3.0](https://github.com/Hebilicious/acidcat/compare/crates/v0.2.2...crates/v0.3.0) (2026-11-18)


### Features

* **catalog:** add the destructive and idempotent hints of a capability ([#183](https://github.com/Hebilicious/acidcat/issues/183)) ([0e21bea](https://github.com/Hebilicious/acidcat/commit/0e21bea609b3e3392a9bf8f89ce8cd2e17a4188a))

## [0.2.2](https://github.com/Hebilicious/acidcat/compare/crates/v0.2.1...crates/v0.2.2) (2026-11-12)


### Bug Fixes

* **catalog:** require each schema of a catalog to be an object ([#120](https://github.com/Hebilicious/acidcat/issues/120)) ([5ce6008](https://github.com/Hebilicious/acidcat/commit/5ce60082e7f94b7837cf46ff46827638f65663da))

## [0.2.1](https://github.com/Hebilicious/acidcat/compare/crates/v0.2.0...crates/v0.2.1) (2026-11-12)


### Bug Fixes

* **cli:** reject inherited names, sort integer-like keys by code point, and resolve a $ref with other keys ([#115](https://github.com/Hebilicious/acidcat/issues/115)) ([c690f83](https://github.com/Hebilicious/acidcat/commit/c690f8357cd4d47f32baa4d9aa02281f06a8339e))

## [0.2.0](https://github.com/Hebilicious/acidcat/compare/crates/v0.1.0...crates/v0.2.0) (2026-11-10)


### Features

* **spec:** add events, subscriptions and occurrences, with catalog support in every library ([#106](https://github.com/Hebilicious/acidcat/issues/106)) ([3391fb3](https://github.com/Hebilicious/acidcat/commit/3391fb3ef683c4cb0cc5a252fe4bd4c70eee25bf))
