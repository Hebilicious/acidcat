# Adoption

This page shows how Jarette's Box (JB) and heb-stack (HS) move onto this specification without rewriting how they work. Both keep writing capabilities in TypeScript with Effect. What changes is that each one commits its catalog as a document, and each surface follows its binding.

## What stays

- **Capability definitions in code.** Both keep `defineCapability` with Effect Schema input, output and error codecs. The catalog is generated from those definitions, committed, and checked. It is the one file that every other implementation reads: a Swift app, a Kotlin app, the conformance kit.
- **Target names.** Targets are the application's own choice, so JB keeps `application` and HS keeps `web` and `rpc`.
- **Handles, owners and the root.** The [TypeScript binding](bindings/typescript.md) is the handle shape that both kernels already have. Effect, XState, owners, scopes and lazy loading stay as they are.
- **The compact manifest encoding in JB.** It stays as a way of carrying the `application` view to the page.

## Shared steps

1. **Generate `acidcat.catalog.json` and commit it.** Extend the existing manifest generator, walking the same `definitions` tree:
   - write `acidcat: "0.1"` and a `targets` map;
   - for each leaf, write `description`, `audience`, `input` and `output` from the program's codecs;
   - split the error union into `failures` keyed by each variant's `_tag` literal, and copy the `$defs` each variant uses into that variant's schema. A capability whose error is `never` gets no `failures`.
2. **Check the catalog.** In the existing conformance gate, fail when the committed catalog differs from a fresh generation, and validate it against `schemas/catalog.schema.json`.
3. **Serve views.** The page fetches the view of its target instead of today's manifest. The MCP server and the CLI serve the views of theirs.
4. **Give call failures their kind.** In the executor, set `kind` on the errors that `invokeExternal` throws (`cancelled`, `unavailable`, `invalid-input`, `internal`), and map them in each adapter, as each binding states.
5. **MCP.** Wrap failures as `{ "ok": false, "error" }`, return call failures with `{ "kind", "message" }`, publish `outputSchema` and `readOnlyHint`, pass the request's signal to the call, and screen the media type and UTF-8.

## Jarette's Box

| Change | Where |
| --- | --- |
| Generate and commit the catalog, with targets `application: [typescript, webmcp]`, `cli: [cli]` and `mcp: [mcp]` | `tools/generators/generate-acidcat-manifest.ts`, `.moon/tasks/generators/acidcat.yml` |
| Derive the page's compact manifest from the `application` view | the same generator |
| Generate CLI commands from ids and flags from input properties, keep `solve` as an application command, and use the binding's exit codes | `packages/cli/src` |
| Commit only a WebMCP pass that has succeeded, so that a failed pass cannot strand its registrations | `packages/webmcp-adapter/src/webmcp-machine.ts` |
| Mark handle fields with `format: acidcat-attachment`, make handles in outputs belong to the provider, and release the handles of rejected OCR reviews | `packages/acidcat-kernel/src/attachments.ts`, the ships and bartering owners |
| Slice `navigation.atlas.feature.inspect` connections to the declared maximum | `packages/application-navigation` |

JB's own requirements stay JB's own checks: every capability reaches `application`; `cli` and `mcp` are strict subsets; every array has `maxItems`; Product Promises cover every id. The specification allows all of them and requires none of them.

## heb-stack

| Change | Where |
| --- | --- |
| Generate and commit the catalog, with targets `web: [typescript, webmcp]`, `cli: [cli]`, `mcp: [mcp]` and `rpc: [hs:capnweb]` | `apps/web/scripts/generate-manifest.ts`, `apps/web/moon.yml` |
| Mark `primes.check`, `primes.next` and `primes.history.list` as `readOnly`, replacing the README's `query` and `command` | `packages/primes/src/capabilities.ts`, `README.md` |
| Give call failures their own exit codes, written on standard error as `{ kind, message }` | `packages/cli/src/main.ts` |
| Accept any return value from `registerTool` | `packages/browser-runtime/src/webmcp.ts` |
| Close the WebMCP adapter's scope when the root is disposed | `packages/acidcat/src/root.ts` |
| State in `primes.history.list`'s description that the history holds the 20 newest checks | `packages/primes` |

The capnweb API can keep its typed `check` and `next` methods as an application binding (`hs:capnweb`). Moving to the [HTTP binding](bindings/http.md) later is optional.

## Order

1. Both repositories generate, commit and check their catalogs. Nothing else changes yet, and both stay green.
2. Each binding change lands behind the conformance kit, one binding at a time.
3. Once both repositories pass the kit, either can replace its kernel with the reference implementation in `ref/ts/`.
