# Packages

This directory holds the AcidCat tools and one reference implementation of the specification. The specification in [`spec/`](../spec/README.md) does not depend on any of it. Each package is a Moon project with a `test` task, and the TypeScript packages share a pnpm workspace.

## Tools for every implementation

These packages work with an implementation in any language.

| Package | Directory | Registry name | Use |
| --- | --- | --- | --- |
| Command line | [`cli/`](cli) | npm `@acid-cat/cli` | Check and format catalogs, print the catalog of a target, and test implementations with `acid-cat conform` |
| Catalog library for TypeScript | [`catalog/typescript/`](catalog/typescript) | npm `@acid-cat/catalog` | Write a catalog in TypeScript |
| Catalog library for Python | [`catalog/python/`](catalog/python) | PyPI `acid-cat-catalog` | Write a catalog in Python |
| Catalog library for Go | [`catalog/go/`](catalog/go) | Go `github.com/Hebilicious/acidcat/packages/catalog/go` | Write a catalog in Go |
| Catalog library for Rust | [`catalog/rust/`](catalog/rust) | crates.io `acid-cat-catalog` | Write a catalog in Rust |
| Catalog module for Pkl | [`catalog/pkl/`](catalog/pkl) | Pkl `package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog` | Write a catalog in Pkl |

## Reference implementation in TypeScript

These packages are one way to implement the specification. Reference implementations in more languages will follow. An implementation in another language does not use these packages: it follows the specification, and `acid-cat conform` tests it.

The cores in this repository also take the rules they share from the formal model in [`model/`](../model/README.md). Each core reads the generated data, and its tests run every case that the model generates.

| Package | Directory | Registry name | Use |
| --- | --- | --- | --- |
| Specification data | [`spec-ts/`](spec-ts) | npm `@acid-cat/spec-ts` | The fixed details of the specification as TypeScript data and pure functions, with no dependencies. Its shared constants are generated from [`model/`](../model/README.md) |
| Core for Effect | [`core-effect/`](core-effect) | npm `@acid-cat/core-effect` | Serve capabilities, written fully in Effect: capabilities are Effect programs, sessions are scopes, services are layers |
| Core for TypeScript | [`core-ts/`](core-ts) | npm `@acid-cat/core-ts` | Serve capabilities in plain TypeScript, with no Effect dependency: capabilities return promises, inputs use Standard Schema |
| MCP handshake | [`mcp-handshake/`](mcp-handshake) | npm `@acid-cat/mcp-handshake` | Serve MCP clients of earlier revisions, which open the session with `initialize`, from an MCP server through HTTP. Both TypeScript cores re-export it. The Rust core serves the handshake itself |

`@acid-cat/spec-ts` holds only data and pure functions. Runtime code, such as servers and I/O, goes in the cores and in `@acid-cat/mcp-handshake`, which works in front of either core.

When a test of a TypeScript package starts a program as a process, it starts the bundle of the program. The `test-programs` task of the package writes the bundles into `.out/programs/` with [`scripts/bundle-programs.ts`](../scripts/bundle-programs.ts), and the `test` task depends on it. A bundle starts in less time than its source modules, because Node does not load and strip the types of each module. Run the tests with `moon run <package>:test`, so that the bundles are up to date.

### Two TypeScript cores

Each core is complete in its own style, and neither wraps the other. Both serve the TypeScript surface and the four protocol surfaces (MCP, HTTP, CLI and WebMCP), take the fixed details from `@acid-cat/spec-ts`, write an application's catalog from its code, and pass every check of `acid-cat conform`. The [Rust core](#reference-implementation-in-rust) is the third core. It has the same features, except WebMCP, which runs in a web page. It serves the [Rust surface](../spec/surfaces/rust.md) in place of the TypeScript surface. Both language surfaces map the [programmatic surface](../spec/surfaces/programmatic.md).

| | `@acid-cat/core-effect` | `@acid-cat/core-ts` |
| --- | --- | --- |
| Capability | An Effect program | A function that returns a promise |
| Schemas | Effect Schema | Any Standard Schema library |
| Services | Layers | A context object |
| Cancellation | Fiber interruption | `AbortSignal` |
| MCP server | `effect/ai/McpServer` | Built in |
| Command line | `effect/cli` | Built in |
| Node.js server | `NodeServer`, which serves in a scope | `serve` from `@acid-cat/core-ts/node` |
| Availability and state | A `SubscriptionRef` | An observable source |
| Handles for code without Effect | `Handles.make`, `Handles.open` | `createSession` |

## Reference implementation in Rust

| Package | Directory | Registry name | Use |
| --- | --- | --- | --- |
| Core for Rust | [`core-rust/`](core-rust) | crates.io `acid-cat-core` | Serve capabilities and events in Rust, on Tokio, through the Rust surface, the MCP surface (HTTP and stdio, with push, poll and webhook delivery), the HTTP surface and the CLI surface |

`acid-cat-core` does not use the TypeScript packages. It follows the specification, and its tests run `acid-cat conform` against the conformance fixture, which [`examples/fixture.rs`](core-rust/examples/fixture.rs) serves. It writes an application's catalog from its code with `acid-cat-catalog`. It has no WebMCP surface, because WebMCP runs in a web page. Rust code in the same process opens a `Session`, which serves the [Rust surface](../spec/surfaces/rust.md).

## Publishing

[release-please](https://github.com/googleapis/release-please) makes the releases in [`release.yml`](../.github/workflows/release.yml). [`release-please-config.json`](../release-please-config.json) holds its settings, and [`.release-please-manifest.json`](../.release-please-manifest.json) holds each package's version.

To release, merge the release pull request. release-please then tags each released package and creates its GitHub release, and each new tag starts its registry's release workflow.

### The release pull request

release-please reads the commits on `main` (titles of the form `type(scope): subject`) and keeps one release pull request open.

- release-please reads each squash commit with `@conventional-commits/parser`. When the parser fails, release-please skips the commit without a warning, and no package gets a release for it. The squash commit is the pull request title and its body, which GitHub wraps at 72 columns. The parser fails, for example, on a line that starts with `f(g(x))`. The `semantic` check parses the squash commit with the same parser version (`scripts/check-commit-message.ts`), and fails when the parser fails. To fix it, change the line in the body, or put the commit in a `BEGIN_COMMIT_OVERRIDE` … `END_COMMIT_OVERRIDE` block in the body. release-please reads the text after the first marker as the commit, so do not write a marker in other text of the body.
- A package gets a release when a commit of type `feat`, `fix`, `perf`, `refactor` or `revert`, or a breaking change (`!`), changes a file in its directory. Other types, and files outside the packages, give no release. `changelog-sections` in `release-please-config.json` sets this rule for each package.
- Before 1.0, `feat` and a breaking change (`!`) increase the minor version. The other types increase the patch version.
- The pull request changes the versions in the package files and each package's `CHANGELOG.md`, which release-please writes.
- The six npm packages are linked: they always have the same version and are released together.
- On each push to `main`, release-please writes the pull request again on top of `main` (`always-update` in `release-please-config.json`). After each run it is up to date with `main`, which the rules of `main` require before a merge. It holds one commit, so it passes the `semantic` check. Do not update its branch by hand.

### Rust crates that depend on each other

- Three Rust crates use `acid-cat-catalog` or `acid-cat-core` through a path: `packages/core-rust` and the two crates in `examples/aircon`. Each of these crates' `Cargo.lock` records the version it uses.
- The `extra-files` of the two published crates in `release-please-config.json` list these lock files, so the release pull request changes the version in each one.
- Each Rust test runs cargo with `--locked`, so a lock file with an old version fails the test.
- The release pull request also changes the version of `acid-cat-catalog` that `packages/core-rust/Cargo.toml` requires. crates.io does not have that version before the release, so `moon run core-rust:package` builds the core with `acid-cat-catalog` from `packages/catalog/rust`.
- One release can publish `acid-cat-catalog` and `acid-cat-core` together. The core's release workflow waits until crates.io has the `acid-cat-catalog` version that the core requires, then publishes the core.

### The `heb-release` GitHub App

release-please uses a token of the GitHub App `heb-release`, not the workflow's own token. GitHub starts no workflow for a tag that a workflow token pushes, and it holds the checks of a pull request that a workflow token opens. With the App's token, the release pull request gets its checks, and each tag starts its registry's release workflow.

- The App needs write access to contents, pull requests and issues.
- The repository holds the App's client ID in the variable `RELEASE_APP_CLIENT_ID` and its private key in the secret `RELEASE_APP_PRIVATE_KEY`.

### Registries

Each registry has its own release workflow. A tag pushed by hand on `main` also starts it, and the version in the tag must match the version in the package files. The workflows authenticate with trusted publishing and hold no tokens.

| Registry | Packages | Tag | Workflow |
| --- | --- | --- | --- |
| npm | The six npm packages, all at one version | `npm/v0.1.0`. `release.yml` makes it on each run when the release of `@acid-cat/cli` exists without it | `release-npm.yml`: `moon run verify`, then `scripts/publish-npm.ts` |
| PyPI | `acid-cat-catalog` | `pypi/v0.1.0` | `release-pypi.yml` |
| crates.io | `acid-cat-catalog` | `crates/v0.1.0` | `release-crates.yml` |
| crates.io | `acid-cat-core` | `crates-core/v0.1.0` | `release-crates-core.yml` |
| Pkl | `acid-cat-catalog` | `acid-cat-catalog@0.1.0` | `release-pkl.yml`: a GitHub release with the package files |
| Go | `github.com/Hebilicious/acidcat/packages/catalog/go` | `packages/catalog/go/v0.1.0` | None. The Go module proxy reads the tag |

### npm

- `moon run :build` writes `dist/` in each npm package with [`scripts/build-package.ts`](../scripts/build-package.ts). In the workspace, `exports` and `bin` point to the TypeScript sources. `publishConfig` points to `dist/`, and pnpm uses it when it packs a package.
- `moon run verify` builds each npm package.
- `node scripts/publish-npm.ts [--dry-run] [<package> ...]` publishes in dependency order and skips versions already on npm.
- Peer dependency ranges come from the `peers` catalog in `pnpm-workspace.yaml`. The packages test against the versions in the lockfile. `effect` and its platform packages have `^` ranges in the default catalog, so a published package does not hold `effect` back while a platform package moves on.
- The release workflow publishes every version of every npm package, with trusted publishing and provenance. Do not publish a version from your computer.
- npm accepts a trusted publisher only for a package that exists. Before its first release, a new npm package gets its name on npm: an empty placeholder at version `0.0.0`, with the trusted publisher. If a package is not on npm, the release workflow publishes nothing.

The [`npm-release`](../.agents/skills/npm-release/SKILL.md) skill gives the steps for a release, a new package, a trusted publisher and a failed release.

### PyPI

On pypi.org, add a pending trusted publisher for `acid-cat-catalog`: repository `Hebilicious/acidcat`, workflow `release-pypi.yml`, environment `pypi`. The first tag then creates the project. `moon run catalog-python:package` builds the distributions into `dist/`.

### crates.io

crates.io accepts a trusted publisher only for a crate that exists.

1. Publish the first version of each crate with `cargo publish` and a token.
2. In the crate's settings, add the trusted publisher: repository `Hebilicious/acidcat`, environment `crates-io`, and workflow `release-crates.yml` for `acid-cat-catalog` or `release-crates-core.yml` for `acid-cat-core`.

`moon run catalog-rust:package` and `moon run core-rust:package` package each crate and build it from the package.

### Pkl

`PklProject` reads the version from `version.txt`, which release-please changes. `moon run catalog-pkl:test` writes the package into `packages/catalog/pkl/.out/`, and the workflow attaches these files to the release `acid-cat-catalog@<version>`. pkg.pkl-lang.org redirects `package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog@<version>` to that release.

### Go

The module lives in a subdirectory, so its tags have the prefix `packages/catalog/go/`. Once a tag is pushed, `go get github.com/Hebilicious/acidcat/packages/catalog/go@v0.1.0` fetches the module from the Go module proxy.
