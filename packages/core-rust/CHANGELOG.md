# Changelog

## [0.3.0](https://github.com/Hebilicious/acidcat/compare/crates-core/v0.2.1...crates-core/v0.3.0) (2026-11-17)


### Features

* **cli:** exit with 130 after a grace period when an interrupt cannot stop the run ([#168](https://github.com/Hebilicious/acidcat/issues/168)) ([74b2623](https://github.com/Hebilicious/acidcat/commit/74b26236afe2b1a68c779e9f2605c18397b16bf8))


### Bug Fixes

* **cli:** stop with the message and exit code 5 when the command line breaks a rule at start ([#166](https://github.com/Hebilicious/acidcat/issues/166)) ([e0c5173](https://github.com/Hebilicious/acidcat/commit/e0c5173870ef935b2ed3a0d34fed707915aec123))

## [0.2.1](https://github.com/Hebilicious/acidcat/compare/crates-core/v0.2.0...crates-core/v0.2.1) (2026-11-17)


### Bug Fixes

* **cli:** ignore a first argument --, which package runners pass to the program ([#167](https://github.com/Hebilicious/acidcat/issues/167)) ([fdd3b9a](https://github.com/Hebilicious/acidcat/commit/fdd3b9a92b4c52fa5f2c239188797b160f5c533a))

## [0.2.0](https://github.com/Hebilicious/acidcat/compare/crates-core/v0.1.2...crates-core/v0.2.0) (2026-11-17)


### ⚠ BREAKING CHANGES

* **cli:** add a human form of the output, off by default, with output flags and typed formatters in each core ([#159](https://github.com/Hebilicious/acidcat/issues/159))

### Features

* **cli:** add a human form of the output, off by default, with output flags and typed formatters in each core ([#159](https://github.com/Hebilicious/acidcat/issues/159)) ([c1794ec](https://github.com/Hebilicious/acidcat/commit/c1794ecc252aea5acdff269fa42a7f72375c34d1))
* **cli:** add aliases of events and a default alias ([#146](https://github.com/Hebilicious/acidcat/issues/146)) ([cf40029](https://github.com/Hebilicious/acidcat/commit/cf4002937a50c059d45411fa680be7005796198c))
* **cli:** add aliases to the CLI binding ([#145](https://github.com/Hebilicious/acidcat/issues/145)) ([63c3f87](https://github.com/Hebilicious/acidcat/commit/63c3f87033240833a43a3219d265333de74f8128))
* **cli:** give check and conform a JSON output for scripts and agents ([#154](https://github.com/Hebilicious/acidcat/issues/154)) ([29cf5ab](https://github.com/Hebilicious/acidcat/commit/29cf5abd70b4cc0c54e7a42696abd66f0f12e990))
* **model:** add a Quint model of the output rules of the CLI, with proofs and generated cases for each core ([#160](https://github.com/Hebilicious/acidcat/issues/160)) ([f1b3dfa](https://github.com/Hebilicious/acidcat/commit/f1b3dfacefb783f4567946646c11167325f1df75))


### Code Refactoring

* **model:** generate the shared facts of the cores from one source ([#163](https://github.com/Hebilicious/acidcat/issues/163)) ([10c2a0d](https://github.com/Hebilicious/acidcat/commit/10c2a0d7eabb5180015ea95d4d0fa97214f7eaeb))

## [0.1.2](https://github.com/Hebilicious/acidcat/compare/crates-core/v0.1.1...crates-core/v0.1.2) (2026-11-16)


### Code Refactoring

* **cores:** say in code what the deleted comments said ([#144](https://github.com/Hebilicious/acidcat/issues/144)) ([c590bed](https://github.com/Hebilicious/acidcat/commit/c590bedc37cf93ce593311655030c58bc1c5973a))

## [0.1.1](https://github.com/Hebilicious/acidcat/compare/crates-core/v0.1.0...crates-core/v0.1.1) (2026-11-15)


### Bug Fixes

* **cores:** end watch with 130 and nothing on standard error when an interrupt comes before the subscription starts ([#137](https://github.com/Hebilicious/acidcat/issues/137)) ([99764b7](https://github.com/Hebilicious/acidcat/commit/99764b7ba5e805d91ee647dde78b7e7daaef2d28))

## 0.1.0 (2026-11-14)


### Features

* **core-rust:** add a Rust core that passes acid-cat conform ([#123](https://github.com/Hebilicious/acidcat/issues/123)) ([69f17a0](https://github.com/Hebilicious/acidcat/commit/69f17a072a999b5cfeac3c8eb9037ab62af6d94b))
* **cores:** give each capability its target, and let the context of a remote request refuse it ([#129](https://github.com/Hebilicious/acidcat/issues/129)) ([741daf1](https://github.com/Hebilicious/acidcat/commit/741daf181b2aed64667190bfd39cea2ae50c35c7))
* **cores:** let the command line call the HTTP binding of a server ([#125](https://github.com/Hebilicious/acidcat/issues/125)) ([37488ca](https://github.com/Hebilicious/acidcat/commit/37488ca54418957e98ced494fbcfff56f44ea9c8))


### Bug Fixes

* **cores:** count a webhook subscription that starts for the limit, and verify the URL as the client sent it ([#132](https://github.com/Hebilicious/acidcat/issues/132)) ([c5ad7a1](https://github.com/Hebilicious/acidcat/commit/c5ad7a1993f4fe7967e785955f1138019b81607d))
