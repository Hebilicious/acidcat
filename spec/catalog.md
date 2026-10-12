# Catalog

A **catalog** is a JSON document that states what an application can do and where. It is the contract that every provider, binding and client is built from and checked against. An application MAY write it by hand, with an [SDK](../sdk/README.md), or generate it from code, but there is one catalog per application.

[`schemas/catalog.schema.json`](../schemas/catalog.schema.json) validates the document's shape. This page states the rules that the schema cannot express.

## Example

```json
{
  "acidcat": "0.1",
  "title": "Living-room air conditioner",
  "targets": {
    "app": { "bindings": ["typescript", "acme:swift", "acme:kotlin"] },
    "cli": { "bindings": ["cli"] },
    "mcp": { "bindings": ["mcp"] }
  },
  "capabilities": {
    "aircon.temperature.set": {
      "description": "Set the target temperature in degrees Celsius.",
      "audience": ["app", "cli", "mcp"],
      "input": {
        "type": "object",
        "required": ["celsius"],
        "properties": { "celsius": { "type": "number", "minimum": 16, "maximum": 31 } }
      },
      "failures": { "Offline": { "type": "object" } }
    }
  }
}
```

The full example is [`examples/aircon.acidcat.json`](../examples/aircon.acidcat.json), rendered from [`examples/aircon.pkl`](../examples/aircon.pkl).

## Build time and run time

The catalog is a build-time artifact. It is committed with the application, reviewed as a diff, validated by the toolchain, used to generate code, and used by the conformance kit to check the running application. An implementation is not required to read it at runtime.

At runtime, an implementation works from its own definitions: code generated from the catalog, or the code the catalog was generated from. What each binding publishes and does MUST match the catalog. The toolchain and the conformance kit check that match, so the running program never has to read the file. A binding MAY still load a precomputed part of the catalog at runtime when that is cheaper, for example to keep schema conversion out of a web page's bundle.

## Authoring

Only the JSON document is normative. A catalog MAY be written in any language that produces it: by hand in JSON or YAML, with Pkl or one of the [SDKs](../sdk/README.md), or generated from the application's own code.

[Pkl](https://pkl-lang.org) is the recommended language for writing a catalog by hand. A catalog that amends [`sdk/pkl/Catalog.pkl`](../sdk/pkl/Catalog.pkl) gets types, and its rules are checked while it is being written. An undeclared audience, an input that is not an object, or a malformed id is an error before any JSON is produced. Shared types go under `types`, which renders as `$defs`. `module.ref("Status")` references one, and fails if no type has that name. Members under `extensions` render with their `x-` prefix. `pkl eval` renders the JSON.

## Document

| Member | Required | Meaning |
| --- | --- | --- |
| `acidcat` | yes | The version of this specification that the catalog follows, `"0.1"` |
| `title` | no | A name for people |
| `description` | no | What the application is |
| `targets` | yes | The targets, keyed by name |
| `capabilities` | yes | The capabilities, keyed by id |
| `$defs` | no | Shared types, keyed by name. See [Types](#types) |

## Targets

Each key of `targets` names a target, and each value says how that target is served:

| Member | Required | Meaning |
| --- | --- | --- |
| `bindings` | yes | The names of the bindings that serve this target, such as `["typescript", "webmcp"]` |
| `description` | no | Who the target is for |
| `options` | no | Settings for the bindings, in a form each binding defines |

Target names match `[a-z][a-z0-9-]*`, optionally followed by `:` and a second name of the same form. They are the application's own choice. This specification reserves none.

A binding name is either one that this specification defines (see [Bindings](bindings/README.md#bindings-in-this-specification)) or a name the application chooses. A binding that this specification does not define SHOULD be named `<prefix>:<name>`.

## Capabilities

Each key of `capabilities` is an [id](#ids), and each value describes the capability:

| Member | Required | Meaning |
| --- | --- | --- |
| `description` | yes | What the capability does for its caller, written for people and agents |
| `audience` | no | The targets the capability is offered to. Each entry MUST be a key of `targets`. When absent or empty, the capability reaches no target |
| `input` | no | The schema of the input. It MUST describe an object: its top level states `"type": "object"`, or it is a `$ref` to a type that does. When absent, the input is an empty object |
| `output` | no | The schema of the value a successful call returns. When absent, the value is `null` |
| `failures` | no | The capability's failures, keyed by tag. See [Failures](#failures) |
| `readOnly` | no | `true` when a call changes nothing that the caller or anyone else can observe. It is a hint for clients, such as an agent deciding whether to ask the user first, and does not change how a call runs |
| `state` | no | The schema of a value the capability exposes for clients to observe. See [State](invocation.md#state) |

## Ids

An id is two or more segments joined by `.`. Each segment matches `[a-z][a-z0-9]*(-[a-z0-9]+)*`, and the whole id is at most 128 characters long. The first segment is the capability's **namespace**.

Bindings derive every surface name from the id: tool names, commands, URLs, fields, methods. How a binding transforms the id is up to that binding, for example `aircon.power.set` → `cli aircon power set` → `airconPowerSet`.

## Failures

Each key of `failures` is a **tag**, a non-empty string, conventionally in PascalCase. A failure value is a JSON object whose `_tag` member equals its tag. The value MUST conform to the schema stored under that tag.

## Schemas

Every schema in a catalog is a JSON Schema 2020-12 schema. A value that crosses a boundary is in the form its schema describes. Every input, output, failure and state value MUST conform to its schema.

## Types

A type that is used in more than one place is written once, under the catalog's top-level `$defs`, and referenced by name:

```json
{
  "$defs": {
    "Status": { "type": "object", "required": ["power"], "properties": { "power": { "type": "boolean" } } }
  },
  "capabilities": {
    "aircon.status.get": { "description": "…", "output": { "$ref": "#/$defs/Status" } }
  }
}
```

- A type name matches `[A-Za-z][A-Za-z0-9_]*`. PascalCase is conventional. Language bindings generate a named type from each one.
- Every `$ref` in a catalog has the form `#/$defs/<Name>`, and names a type in the catalog's `$defs`. Types can reference each other.
- Schemas inside capabilities do not carry `$defs` of their own.

A schema's `title` SHOULD name the type when the schema is written inline, so that language bindings can still give it a readable name.

## Bundling

Some surfaces need a schema that stands on its own: an MCP tool's input schema is an example. A binding produces one by **bundling**. It copies every type the schema reaches, directly or through other types, into the schema's own `$defs`. When the schema is only a `$ref`, the bundle is the referenced type itself, carrying those `$defs`. References keep their form, so `#/$defs/Status` resolves the same way in the bundle as it does in the catalog.

## Views

The **view** of a target is the catalog reduced to that target: `targets` keeps only that target, and `capabilities` keeps only the capabilities whose audience names it. `$defs` keeps only the types those capabilities reach, so that a view reveals nothing about capabilities outside it. A view is itself a catalog.

A binding serves exactly its target's view. A client of a target MUST NOT be able to learn about a capability outside the view. A call naming such a capability fails as a call naming an id that does not exist ([Invocation](invocation.md#call-failures)).

## Change

A catalog has no version of its own, and neither do capabilities. A catalog describes the build that serves it. When the build changes, the catalog changes with it. A client that keeps a description of a target, such as an MCP client's tool list, fetches it again from the binding. An application that wants to keep old clients working keeps an id's meaning unchanged, and adds a new id when it needs a new meaning.

The `acidcat` member is the version of this specification, not of the catalog.

## Extensions

Consumers ignore members they do not know. Members that this specification does not define SHOULD be prefixed `x-`, as in `x-icon`. [Extensions](extensions/README.md) are optional conventions that use only the members defined here.

## Rationale

*This section is not normative.*

**The catalog is the contract, even when code generates it.** Jarette's Box and heb-stack write capabilities in TypeScript and derive their manifests from that code. A Swift or Kotlin app cannot read TypeScript, so the shared artifact has to be a document. Generating that document from code remains allowed, provided there is one catalog per application (see [Adoption](adoption.md)).

**Checked at build time, not read at runtime.** If every program read the catalog when it started, it would pay for a file read, a parse and the compilation of validators, only to learn what its own code already says. It would also have two sources of truth to keep in step. Making the catalog a build-time contract keeps runtime cost at zero, lets each language use its native types, and moves the agreement between code and catalog into the toolchain, where a mismatch fails the build rather than a request. Jarette's Box already works this way for MCP, whose tools come from its definitions. It fetches a precomputed manifest only for WebMCP, as an optimisation.

**JSON to exchange; Pkl or an SDK to write.** Every language and every tool can read JSON, and the schemas inside a catalog are already JSON Schema, so the contract is JSON. Writing a catalog is a different job: a long YAML file repeats itself and checks nothing. Pkl adds types, checks, reuse and templates, renders exactly the JSON, and has code generators for Swift, Kotlin, Go and Java, so it matches the many-languages goal. It is a recommendation, not a requirement, because applications that generate their catalog from code (as Jarette's Box and heb-stack do) never write one by hand.

**The catalog declares its targets.** Declaring targets turns a misspelt audience into an error the schema catches. It also records, in the same place, which bindings serve each target: one catalog, many targets, stated once.

**No audience means no target.** Jarette's Box grows each tool surface one declaration at a time, so that a new capability never reaches an agent by accident. An explicit `audience` keeps that safety without any special case.

**Failures keyed by tag.** Both implementations already send failures as objects with a `_tag`. Keying the schemas by tag makes the failures easy to read and to write by hand, and gives each language a natural union of named failures.

**Shared types, bundled where needed.** A draft of this specification required every schema to stand on its own, because MCP and WebMCP need that. Exporting Jarette's Box showed the cost. Its catalog came to 2.6 MB, and 22 capabilities each repeated the same 90 KB workbench schema. With shared types it is about 275 KB, and code generators get one `Workbench` type instead of 22 anonymous copies. Bundling gives MCP and WebMCP what they need, and it is mechanical. OpenAPI shares types between operations in the same way.
