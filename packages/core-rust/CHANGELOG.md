# Changelog

## [0.6.0](https://github.com/Hebilicious/acidcat/compare/crates-core/v0.5.0...crates-core/v0.6.0) (2026-11-19)


### Features

* **cli:** write JSON output on one line when standard output is not a terminal ([#203](https://github.com/Hebilicious/acidcat/issues/203)) ([6ea22b2](https://github.com/Hebilicious/acidcat/commit/6ea22b2d17cdc15ed238cce7b1a7659ecaa250fc)), closes [#202](https://github.com/Hebilicious/acidcat/issues/202)

## [0.5.0](https://github.com/Hebilicious/acidcat/compare/crates-core/v0.4.0...crates-core/v0.5.0) (2026-11-18)


### ⚠ BREAKING CHANGES

* **conform:** keep each lease and webhook subscription alive for the whole check, and remove duplicate conform checks ([#197](https://github.com/Hebilicious/acidcat/issues/197))

### Bug Fixes

* **catalog:** write integers above 2^53 as JSON.stringify writes them ([d1dea9d](https://github.com/Hebilicious/acidcat/commit/d1dea9de906ea20f485b1f7c94f00195f9171db0))
* **cli:** start the independent processes of the conformance checks of the command line at the same time ([#192](https://github.com/Hebilicious/acidcat/issues/192)) ([ad1503c](https://github.com/Hebilicious/acidcat/commit/ad1503cc15ee4e5068fe045d08425b525d04b979))
* **conform:** keep each lease and webhook subscription alive for the whole check, and remove duplicate conform checks ([#197](https://github.com/Hebilicious/acidcat/issues/197)) ([fc02fe3](https://github.com/Hebilicious/acidcat/commit/fc02fe31483b97e0d4b76972e6f57f786e3ee78c))

## [0.4.0](https://github.com/Hebilicious/acidcat/compare/crates-core/v0.3.1...crates-core/v0.4.0) (2026-11-18)


### Features

* **catalog:** add the destructive and idempotent hints of a capability ([#183](https://github.com/Hebilicious/acidcat/issues/183)) ([0e21bea](https://github.com/Hebilicious/acidcat/commit/0e21bea609b3e3392a9bf8f89ce8cd2e17a4188a))
* **cli:** allow command aliases of two words ([#185](https://github.com/Hebilicious/acidcat/issues/185)) ([ae0ef97](https://github.com/Hebilicious/acidcat/commit/ae0ef978ccc54e1387d10de2ae1f2c6c3f501fe8))
* **cli:** let an alias be the default of a shared prefix ([#187](https://github.com/Hebilicious/acidcat/issues/187)) ([89c50a4](https://github.com/Hebilicious/acidcat/commit/89c50a480279ade527ce32e42b6ed5da0acbbee6))


### Bug Fixes

* **cli:** write the help of a command and the command list of a shared prefix ([#186](https://github.com/Hebilicious/acidcat/issues/186)) ([82773ae](https://github.com/Hebilicious/acidcat/commit/82773ae65ba798e807bcdfeafb882845743c8487))

## [0.3.1](https://github.com/Hebilicious/acidcat/compare/crates-core/v0.3.0...crates-core/v0.3.1) (2026-11-17)


### Bug Fixes

* **core-rust:** cancel the token of a call when the call is cancelled, also while its work blocks a thread ([#180](https://github.com/Hebilicious/acidcat/issues/180)) ([c0ccc24](https://github.com/Hebilicious/acidcat/commit/c0ccc248ce26a769657059fe0beef99dd53e7203))

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
