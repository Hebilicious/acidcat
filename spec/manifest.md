# Manifest

A **manifest** is a JSON document that describes every capability a target can serve. It is derived from the catalog's definitions when the application is built, so it does not change while a session runs. Whether a capability is available at a given moment is a runtime matter and is never part of the manifest.

Closes divergence rows D5, D6 and D7.

## Document

```json
{
  "version": 1,
  "target": "mcp",
  "capabilities": [
    {
      "id": "primes.check",
      "description": "Check whether a number is prime.",
      "inputSchema": { "type": "object", "properties": { "n": { "type": "integer" } }, "required": ["n"] },
      "outputSchema": { "type": "object" },
      "errorSchema": { "anyOf": [{ "type": "object", "properties": { "_tag": { "const": "OutOfRange" } }, "required": ["_tag"] }] }
    }
  ]
}
```

- `version` is the integer `1`, which identifies this manifest format.
- `target` is the name of the target the manifest describes.
- `capabilities` holds one entry for each capability whose audience contains the target, and no others. Their order carries no meaning.

Each entry has these members:

- `id`: the capability's [id](identifiers.md).
- `description`: what the capability does for its caller, not blank.
- `inputSchema`: the input the capability accepts. Its top level MUST state `"type": "object"`.
- `outputSchema`: the encoded value of a successful call.
- `errorSchema`: the capability's expected failures, as [Invocation](invocation.md#expected-failures) defines them. A capability with no expected failures has the schema `false` or `{ "not": {} }`.
- `readOnly` (optional): `true` when a call changes no state that the caller or anyone else can observe. When it is absent, the value is `false`. The flag is a hint for clients, such as an agent deciding whether a call needs the user's approval. It does not change how a call is executed.

Every schema is a JSON Schema 2020-12 document that contains its own definitions under `$defs` and has no external references.

A manifest and its entries MAY carry other members. Consumers ignore members they do not know, so an application can describe more than this specification does.

## Change

A manifest has no version of its own, and capabilities have none either. A manifest describes the build that serves it. When the build changes, the manifest changes with it, and a client that has kept a copy reads it again.

## Agreement with behaviour

A manifest describes behaviour, so it must not disagree with what the target does:

- An input that does not conform to `inputSchema` MUST fail as invalid input.
- The value of every successful call MUST conform to `outputSchema`.
- The error of every expected failure MUST conform to `errorSchema`.

## Encoding

A manifest is served as `application/json` in UTF-8. A binding MAY carry it in another encoding if decoding that encoding yields the same JSON value. Such encodings are not part of this specification.

## Rationale

*This section is not normative.*

**One manifest per target.** A capability outside a target's audience is absent from every listing for that target, and a manifest of the whole catalog would be such a listing. Under the [page rule](targets.md#the-page), the `web` manifest is usually the whole catalog. In JB and HS it is, so the files JB and HS generate today are already `web` manifests apart from the `target` member.

**Output and error schemas are included.** JB publishes all three schemas, while HS publishes only the input schema. MCP clients use output schemas, and an agent that can read a capability's failures can recover from them, so JB's document is adopted.

**The compact encoding is transport only.** JB's `acidcat-json-v1` string and node tables shrink the page's download. They are lossless, and JB's own generator checks that a round trip is exact. That makes them a transport optimisation rather than part of the contract, and no other surface needs them.

**No audience member.** A target's clients have no use for the names of other targets, and listing those names would reveal how the catalog is divided up.

**Limits are policy.** JB's budget of 192 KiB, HS's maximum of 256 capabilities, and the 1000-character description limit that both use protect each application's context and bundle sizes. They are left to the applications and bindings.

**`readOnly` and nothing more (row D5).** JB deliberately has no effect classification because it wants no confirmation protocol: logged-in users invoke destructive capabilities directly. An advisory flag keeps that intact, because nothing in AcidCat acts on it. It still lets MCP clients run reads without asking the user. One boolean covers the common case. Distinctions such as destructive or idempotent can travel as extra members until real use shows they are needed. HS's `query` and `command` correspond to `true` and `false`.

**No versioning (row D6).** MCP works the same way. Its protocol has dated revisions, but tools have no versions: a server's tool list may change at any time, and clients list the tools again. JB's rule that "the served bundle is the contract version" is that same idea applied to the page. Clients of another build, over MCP, the CLI or RPC, notice a change by reading the manifest again. An application that wants stability can keep an id's meaning unchanged and add a new id for a new meaning. That is a practice, not a rule. The specification's own version is a separate, open gap.

**Changes for each implementation.** Both add `target` and generate one manifest for each target they serve. HS adds `outputSchema` and `errorSchema`, and maps its `query` capabilities to `readOnly`. JB keeps its compact encoding as a transport.
