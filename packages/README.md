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
| Specification data | [`spec-ts/`](spec-ts) | npm `@acid-cat/spec-ts` | The fixed details of the specification as TypeScript data and pure functions, with no dependencies, and a Node.js server for web handlers that both cores use |
| Core for Effect | [`core-effect/`](core-effect) | npm `@acid-cat/core-effect` | Serve capabilities, written fully in Effect: capabilities are Effect programs, sessions are scopes, services are layers |
| Core for TypeScript | [`core-ts/`](core-ts) | npm `@acid-cat/core-ts` | Serve capabilities in plain TypeScript, with no Effect dependency: capabilities return promises, inputs use Standard Schema |

### Two cores

Each core is complete in its own style. Neither core wraps the other. Both cores serve the TypeScript binding and the four protocol bindings: MCP, HTTP, CLI and WebMCP. Both cores use `@acid-cat/spec-ts` for the fixed details, both write the catalog of an application from its code, and both pass all checks of `acid-cat conform`.

| | `@acid-cat/core-effect` | `@acid-cat/core-ts` |
| --- | --- | --- |
| Capability | An Effect program | A function that returns a promise |
| Schemas | Effect Schema | Any Standard Schema library |
| Services | Layers | A context object |
| Cancellation | Fiber interruption | `AbortSignal` |
| MCP server | `effect/ai/McpServer` | Built in |
| Command line | `effect/cli` | Built in |
| Availability and state | A `SubscriptionRef` | An observable source |
| Handles for code without Effect | `Handles.make`, `Handles.open` | `createSession` |


## Publishing

[release-please](https://github.com/googleapis/release-please) makes the releases, in [`release.yml`](../.github/workflows/release.yml). It reads the commits on `main`, whose titles have the form `type(scope): subject`, and keeps one release pull request open:

- A package gets a release when a commit with the type `feat`, `fix`, `perf`, `revert` or `deps` changes a file in its directory. Other types, and files outside the packages, give no release.
- Before version 1.0, `feat` and a breaking change (`!`) increase the minor version. The other types increase the patch version.
- The five npm packages are linked: they always have the same version, and they are released together.
- The release pull request changes the versions in the package files, and the `CHANGELOG.md` of each package. release-please writes these changelogs.

To release, merge the release pull request. release-please then tags each released package and creates its GitHub release. Each new tag starts the release workflow of its registry. [`release-please-config.json`](../release-please-config.json) holds the settings, and [`.release-please-manifest.json`](../.release-please-manifest.json) holds the version of each package.

release-please works with a token of the GitHub App `heb-release`, not with the token of the workflow. GitHub starts no workflows for tags that the token of a workflow makes, and holds the checks of pull requests that it opens. With the token of the App, the release pull request has its checks, and each tag starts the release workflow of its registry. The App needs write access to contents, pull requests and issues. The repository holds its client ID in the variable `RELEASE_APP_CLIENT_ID` and its private key in the secret `RELEASE_APP_PRIVATE_KEY`.

Each registry has its own release workflow. A tag that is pushed by hand on `main` also starts it. The version in the tag must be the version in the package files.

| Registry | Packages | Tag | Workflow |
| --- | --- | --- | --- |
| npm | The five npm packages, all at one version | `npm/v0.1.0` | `release-npm.yml`: `moon run verify`, then `scripts/publish-npm.ts` |
| PyPI | `acid-cat-catalog` | `pypi/v0.1.0` | `release-pypi.yml` |
| crates.io | `acid-cat-catalog` | `crates/v0.1.0` | `release-crates.yml` |
| Pkl | `acid-cat-catalog` | `acid-cat-catalog@0.1.0` | `release-pkl.yml`: a GitHub release with the package files |
| Go | `github.com/Hebilicious/acidcat/packages/catalog/go` | `packages/catalog/go/v0.1.0` | None. The Go module proxy reads the tag |

The workflows authenticate with trusted publishing. They hold no tokens.

### npm

- `moon run :build` writes `dist/` in each npm package with [`scripts/build-package.ts`](../scripts/build-package.ts). In the workspace, `exports` and `bin` point to the TypeScript sources. `publishConfig` points to `dist/`, and pnpm uses it when it packs a package.
- `moon run packages` packs the packages, installs the tarballs into an empty project, type-checks both cores' conformance tests against the installed declarations, and runs them. `moon run verify` includes it.
- `node scripts/publish-npm.ts [--dry-run] [<package> ...]` publishes in dependency order, and skips versions that are on npm already.
- Peer dependency ranges come from the `peers` catalog in `pnpm-workspace.yaml`. The packages test against the versions in the default catalog.

npm accepts a trusted publisher only for a package that exists. To publish a new package for the first time, log in with `npm login --auth-type=web`, run `node scripts/publish-npm.ts <package>`, and then connect the package to the workflow:

```sh
npm trust github <package> --repo Hebilicious/acidcat --file release-npm.yml --allow-publish --yes
```

### PyPI

On pypi.org, add a pending trusted publisher for `acid-cat-catalog`: repository `Hebilicious/acidcat`, workflow `release-pypi.yml`, environment `pypi`. The first tag then creates the project. `moon run catalog-python:package` builds the distributions into `dist/`.

### crates.io

crates.io accepts a trusted publisher only for a crate that exists. Publish the first version with `cargo publish` and a token. Then, in the settings of the crate, add the trusted publisher: repository `Hebilicious/acidcat`, workflow `release-crates.yml`, environment `crates-io`. `moon run catalog-rust:package` packages the crate and builds it from the package.

### Pkl

`PklProject` reads the version from `version.txt`, which release-please changes. `moon run catalog-pkl:test` writes the package into `packages/catalog/pkl/.out/`. The workflow attaches these files to the release `acid-cat-catalog@<version>`. pkg.pkl-lang.org redirects `package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog@<version>` to that release.

### Go

The module is in a subdirectory, so its tags have the prefix `packages/catalog/go/`. After a tag is pushed, `go get github.com/Hebilicious/acidcat/packages/catalog/go@v0.1.0` fetches the module from the Go module proxy.
