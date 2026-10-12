# Manifest

A **manifest** is a JSON document that describes every capability a target can serve. It is derived from the catalog's definitions when the application is built, so it does not change while a session runs. Whether a capability is available at a given moment is a runtime matter and is never part of the manifest.

Closes divergence row D7.

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
- `description`: what the capability does for its caller, from 1 to 1000 characters and not blank.
- `inputSchema`: the input the capability accepts. Its top level MUST state `"type": "object"`.
- `outputSchema`: the encoded value of a successful call.
- `errorSchema`: the capability's expected failures, as [Invocation](invocation.md#expected-failures) defines them. A capability with no expected failures has the schema `false` or `{ "not": {} }`.

Every schema is a JSON Schema 2020-12 document that contains its own definitions under `$defs` and has no external references.

## Agreement with behaviour

A manifest describes behaviour, so it must not disagree with what the target does:

- An input that does not conform to `inputSchema` MUST fail as invalid input.
- The value of every successful call MUST conform to `outputSchema`.
- The error of every expected failure MUST conform to `errorSchema`.

## Encoding

A manifest is served as `application/json` in UTF-8. A binding MAY carry it in another encoding if decoding that encoding yields the same JSON value. Such encodings are not part of this specification.

## Rationale

*This section is not normative.*

**One manifest per target.** A capability outside a target's audience is absent from every listing for that target, and a manifest of the whole catalog would be such a listing. Under the [page rule](targets.md#the-page), the `web` manifest is the whole catalog anyway, so the files JB and HS generate today are already `web` manifests apart from the `target` member.

**Output and error schemas are included.** JB publishes all three schemas, while HS publishes only the input schema. MCP clients use output schemas, and an agent that can read a capability's failures can recover from them, so JB's document is adopted.

**The compact encoding is transport only.** JB's `acidcat-json-v1` string and node tables shrink the page's download. They are lossless, and JB's own generator checks that a round trip is exact. That makes them a transport optimisation rather than part of the contract, and no other surface needs them.

**No audience member.** A target's clients have no use for the names of other targets, and listing those names would reveal how the catalog is divided up.

**Limits are policy.** JB's budget of 192 KiB and HS's maximum of 256 capabilities protect each application's context and bundle sizes. They are left to the applications and bindings.

**Changes for each implementation.** Both add `target` and generate one manifest for each target they serve. HS adds `outputSchema` and `errorSchema`. JB keeps its compact encoding as a transport.
