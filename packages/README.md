# Packages

Each package is a Moon project with a `test` task. The TypeScript packages share a pnpm workspace. The specification in [`spec/`](../spec/README.md) does not depend on these packages.

## Tools for all implementations

These packages work with an implementation in any language.

| Package | Directory | Registry name | Use |
| --- | --- | --- | --- |
| Command line | [`cli/`](cli) | npm `@acid-cat/cli` | Check, format and view catalogs, and test implementations with `acid-cat conform` |
| Catalog library for TypeScript | [`catalog/typescript/`](catalog/typescript) | npm `@acid-cat/catalog` | Write a catalog in TypeScript |
| Catalog library for Python | [`catalog/python/`](catalog/python) | PyPI `acid-cat-catalog` | Write a catalog in Python |
| Catalog library for Go | [`catalog/go/`](catalog/go) | Go `github.com/Hebilicious/acidcat/packages/catalog/go` | Write a catalog in Go |
| Catalog library for Rust | [`catalog/rust/`](catalog/rust) | crates.io `acid-cat-catalog` | Write a catalog in Rust |
| Catalog module for Pkl | [`catalog/pkl/`](catalog/pkl) | Pkl `package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog` | Write a catalog in Pkl |

## Reference implementation in TypeScript

These packages show one way to implement the specification. Reference implementations in more languages will follow. An implementation in another language does not use these packages: it follows the specification, and `acid-cat conform` tests it.

| Package | Directory | Registry name | Use |
| --- | --- | --- | --- |
| Specification data | [`spec-ts/`](spec-ts) | npm `@acid-cat/spec-ts` | The fixed details of the specification as TypeScript data and pure functions, with no dependencies |
| Core for Effect | [`core-effect/`](core-effect) | npm `@acid-cat/core-effect` | Serve capabilities, written fully in Effect: capabilities are Effect programs, sessions are scopes, services are layers |
| Core for TypeScript | [`core-ts/`](core-ts) | npm `@acid-cat/core-ts` | Serve capabilities in plain TypeScript, with no Effect dependency: capabilities return promises, inputs use Standard Schema |
| MCP handshake | [`mcp-handshake/`](mcp-handshake) | npm `@acid-cat/mcp-handshake` | Serve MCP clients of earlier revisions, which open the session with `initialize`, from an MCP server through HTTP. Both TypeScript cores re-export it. The Rust core serves the handshake itself |

`@acid-cat/spec-ts` holds only the data and pure functions of the specification. Runtime code, such as servers and I/O, goes in the cores, and in `@acid-cat/mcp-handshake`, which works in front of either core.

### Two TypeScript cores

Each core is complete in its own style. Neither core wraps the other. Both TypeScript cores serve the TypeScript binding and the four protocol bindings: MCP, HTTP, CLI and WebMCP. Both use `@acid-cat/spec-ts` for the fixed details, both write the catalog of an application from its code, and both pass all checks of `acid-cat conform`. The [core for Rust](#reference-implementation-in-rust) is the third core. It has the same features, except the bindings that run in a web page or in TypeScript code.

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
| Core for Rust | [`core-rust/`](core-rust) | crates.io `acid-cat-core` | Serve capabilities and events in Rust, on Tokio, through the MCP binding (HTTP and stdio, with push, poll and webhook delivery), the HTTP binding and the CLI binding |

`acid-cat-core` does not use the TypeScript packages. It follows the specification, and its tests run `acid-cat conform` against the conformance fixture, which [`examples/fixture.rs`](core-rust/examples/fixture.rs) serves. It writes the catalog of an application from its code, with `acid-cat-catalog`. It has no WebMCP binding, because WebMCP runs in a web page, and no language binding: Rust code in the same process opens a `Session`.

## Publishing

[release-please](https://github.com/googleapis/release-please) makes the releases, in [`release.yml`](../.github/workflows/release.yml). It reads the commits on `main`, whose titles have the form `type(scope): subject`, and keeps one release pull request open:

- A package gets a release when a commit with the type `feat`, `fix`, `perf`, `revert` or `deps` changes a file in its directory. Other types, and files outside the packages, give no release.
- Before version 1.0, `feat` and a breaking change (`!`) increase the minor version. The other types increase the patch version.
- The six npm packages are linked: they always have the same version, and they are released together.
- The release pull request changes the versions in the package files, and the `CHANGELOG.md` of each package. release-please writes these changelogs.
- Three Rust crates use `acid-cat-catalog` or `acid-cat-core` through a path: `packages/core-rust` and the two crates in `examples/aircon`. The `Cargo.lock` of each of these crates records the version of the crate that it uses.
- The `extra-files` of the two published crates in `release-please-config.json` list these lock files. The release pull request changes the version in each lock file.
- Each Rust test runs cargo with `--locked`. A lock file with an old version fails the test.
- The release pull request also changes the version of `acid-cat-catalog` that `packages/core-rust/Cargo.toml` requires. crates.io does not have this version before the release. For this reason, `moon run core-rust:package` builds the core with `acid-cat-catalog` from `packages/catalog/rust`.
- A release can publish `acid-cat-catalog` and `acid-cat-core` together. The release workflow of the core waits until crates.io has the version of `acid-cat-catalog` that the core requires. Then it publishes the core.


To release, merge the release pull request. release-please then tags each released package and creates its GitHub release. Each new tag starts the release workflow of its registry. [`release-please-config.json`](../release-please-config.json) holds the settings, and [`.release-please-manifest.json`](../.release-please-manifest.json) holds the version of each package.

release-please works with a token of the GitHub App `heb-release`, not with the token of the workflow. GitHub starts no workflows for tags that the token of a workflow makes, and holds the checks of pull requests that it opens. With the token of the App, the release pull request has its checks, and each tag starts the release workflow of its registry. The App needs write access to contents, pull requests and issues. The repository holds its client ID in the variable `RELEASE_APP_CLIENT_ID` and its private key in the secret `RELEASE_APP_PRIVATE_KEY`.

Each registry has its own release workflow. A tag that is pushed by hand on `main` also starts it. The version in the tag must be the version in the package files.

| Registry | Packages | Tag | Workflow |
| --- | --- | --- | --- |
| npm | The six npm packages, all at one version | `npm/v0.1.0` | `release-npm.yml`: `moon run verify`, then `scripts/publish-npm.ts` |
| PyPI | `acid-cat-catalog` | `pypi/v0.1.0` | `release-pypi.yml` |
| crates.io | `acid-cat-catalog` | `crates/v0.1.0` | `release-crates.yml` |
| crates.io | `acid-cat-core` | `crates-core/v0.1.0` | `release-crates-core.yml` |
| Pkl | `acid-cat-catalog` | `acid-cat-catalog@0.1.0` | `release-pkl.yml`: a GitHub release with the package files |
| Go | `github.com/Hebilicious/acidcat/packages/catalog/go` | `packages/catalog/go/v0.1.0` | None. The Go module proxy reads the tag |

The workflows authenticate with trusted publishing. They hold no tokens.

### npm

- `moon run :build` writes `dist/` in each npm package with [`scripts/build-package.ts`](../scripts/build-package.ts). In the workspace, `exports` and `bin` point to the TypeScript sources. `publishConfig` points to `dist/`, and pnpm uses it when it packs a package.
- `moon run verify` builds each npm package.
- `node scripts/publish-npm.ts [--dry-run] [<package> ...]` publishes in dependency order, and skips versions that are on npm already.
- Peer dependency ranges come from the `peers` catalog in `pnpm-workspace.yaml`. The packages test against the versions in the lockfile. `effect` and its platform packages have `^` ranges in the default catalog, so that a published package does not hold `effect` back while a platform package moves on.

The release workflow publishes every version of every npm package, with trusted publishing and provenance. Do not publish a version from a computer.

npm accepts a trusted publisher only for a package that exists. So a new npm package gets its name on npm before its first release: an empty placeholder, version `0.0.0`, and the trusted publisher. If a package is not on npm, the release workflow publishes nothing. The skill [`npm-release`](../.agents/skills/npm-release/SKILL.md) gives the steps for a release, a new package, a trusted publisher and a failed release.

### PyPI

On pypi.org, add a pending trusted publisher for `acid-cat-catalog`: repository `Hebilicious/acidcat`, workflow `release-pypi.yml`, environment `pypi`. The first tag then creates the project. `moon run catalog-python:package` builds the distributions into `dist/`.

### crates.io

crates.io accepts a trusted publisher only for a crate that exists. Publish the first version of each crate with `cargo publish` and a token. Then, in the settings of the crate, add the trusted publisher: repository `Hebilicious/acidcat`, environment `crates-io`, and the workflow `release-crates.yml` for `acid-cat-catalog` or `release-crates-core.yml` for `acid-cat-core`. `moon run catalog-rust:package` and `moon run core-rust:package` package each crate and build it from the package.

### Pkl

`PklProject` reads the version from `version.txt`, which release-please changes. `moon run catalog-pkl:test` writes the package into `packages/catalog/pkl/.out/`. The workflow attaches these files to the release `acid-cat-catalog@<version>`. pkg.pkl-lang.org redirects `package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog@<version>` to that release.

### Go

The module is in a subdirectory, so its tags have the prefix `packages/catalog/go/`. After a tag is pushed, `go get github.com/Hebilicious/acidcat/packages/catalog/go@v0.1.0` fetches the module from the Go module proxy.
