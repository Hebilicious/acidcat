# Catalog

A **catalog** is a JSON document. It tells what an application can do, and which targets can use each capability. Each application has one catalog.

[`schemas/catalog.schema.json`](../schemas/catalog.schema.json) defines the structure of a catalog. This page gives the rules that the schema cannot express.

## Example

```json
{
  "acidcat": "0.1",
  "title": "Living-room air conditioner",
  "targets": {
    "app": { "bindings": ["typescript"] },
    "mcp": { "bindings": ["mcp"] }
  },
  "capabilities": {
    "aircon.temperature.set": {
      "description": "Set the target temperature in degrees Celsius.",
      "audience": ["app", "mcp"],
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

The full example is [`examples/aircon.acidcat.json`](../examples/aircon.acidcat.json). Its source is [`examples/aircon.pkl`](../examples/aircon.pkl).

## Build time and run time

The catalog is a build-time file. Keep it with the source code of the application. You can commit it, or you can make it again in each build. Tools use the catalog to:

- validate the catalog;
- generate code;
- test the application against the catalog.

An implementation does not read the catalog at run time. It uses its own code. That code can come from the catalog, or the catalog can come from that code. The behavior of each binding MUST agree with the catalog. A binding MAY load a precomputed part of the catalog at run time, if this is faster.

## Writing a catalog

Only the JSON document is normative. You can write a catalog in these ways:

- in JSON or YAML;
- in [Pkl](https://pkl-lang.org), with [`Catalog.pkl`](../packages/catalog/pkl/Catalog.pkl);
- with a [catalog library](../packages/catalog/README.md) for TypeScript, Python, Go or Rust;
- with a generator that reads the code of the application.

We recommend Pkl to write a catalog by hand. Pkl finds errors before it writes the JSON. In Pkl, shared types go in `types`, and `module.ref("Name")` refers to one.

## Document

| Member | Required | Value |
| --- | --- | --- |
| `acidcat` | Yes | The version of this specification: `"0.1"` |
| `title` | No | A name for people |
| `description` | No | What the application does |
| `targets` | Yes | The targets, by name. See [Targets](#targets) |
| `$defs` | No | The shared types, by name. See [Types](#types) |
| `capabilities` | Yes | The capabilities, by id. See [Capabilities](#capabilities) |

## Targets

A **target** is a group of clients that can use a set of capabilities, for example `app`, `cli` or `mcp`. Each key of `targets` is the name of a target.

| Member | Required | Value |
| --- | --- | --- |
| `bindings` | Yes | The bindings that serve the target, for example `["typescript", "webmcp"]` |
| `description` | No | The clients of the target |
| `options` | No | Settings for the bindings. Each binding defines its settings |

- A target name matches `[a-z][a-z0-9-]*`. It can have a second part after a colon, as in `acme:panel`.
- The application chooses its target names. This specification reserves no target name.
- A binding name is a name from [Bindings](bindings/README.md#bindings-in-this-specification), or a name that the application chooses. Give a new binding a name with a prefix, as in `acme:swift`.

## Capabilities

A **capability** is one operation that a client can do. Each key of `capabilities` is the [id](#ids) of a capability.

| Member | Required | Value |
| --- | --- | --- |
| `description` | Yes | What the capability does. Write it for people and for agents |
| `audience` | No | The targets that can use the capability. Each entry MUST be a key of `targets`. If there is no audience, no target can use the capability |
| `input` | No | The schema of the input. It MUST be an object: `"type": "object"`, or a `$ref` to a type that is an object. If there is no input schema, the input is an empty object |
| `output` | No | The schema of the value that a successful call returns. If there is no output schema, the value is `null` |
| `failures` | No | The failures that the capability can return, by tag. See [Failures](#failures) |
| `readOnly` | No | `true` if a call changes nothing that a client can see. This is a hint for clients. It does not change the behavior of a call |
| `state` | No | The schema of a value that clients can observe. See [State](invocation.md#state) |

## Ids

An id has two or more segments, with a dot between them. Each segment matches `[a-z][a-z0-9]*(-[a-z0-9]+)*`. An id has a maximum of 128 characters.

The first segment is the **namespace** of the capability.

Each binding makes its surface names from the id. For example, `aircon.power.set` becomes the command `aircon power set` and the GraphQL field `airconPowerSet`.

## Failures

A **failure** is a result that tells why a capability did not do the operation. Each key of `failures` is a **tag**, for example `Offline`.

A failure value is a JSON object. Its `_tag` member is equal to the tag. The value MUST agree with the schema for that tag.

## Schemas

Each schema in a catalog is a JSON Schema 2020-12 schema. Each input, output, failure and state value MUST agree with its schema.

## Types

Put a type that you use in more than one location in `$defs`. Then refer to it by name:

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

- A type name matches `[A-Za-z][A-Za-z0-9_]*`. Use PascalCase.
- Each `$ref` has the form `#/$defs/<Name>`. It MUST refer to a type in `$defs`. Types can refer to other types.
- A schema in a capability MUST NOT have its own `$defs`.
- Give an inline schema a `title`. Code generators use it as the name of the type.

## Bundling

Some surfaces need a schema that has no references to other locations. An MCP tool is an example. To **bundle** a schema:

1. Find each type that the schema uses, directly or through other types.
2. Copy these types into the `$defs` of the schema.
3. If the schema is only a `$ref`, use the type that it refers to as the schema.

After bundling, each `$ref` has the same form and refers to the same type.

## Views

The **view** of a target is the part of the catalog that the target can see. A view is a catalog that contains:

- only that target in `targets`;
- only the capabilities whose audience includes that target;
- only that target in the audience of each capability;
- only the types that these capabilities use.

A binding serves the view of its target. A client MUST NOT get information about a capability that is not in its view. A call to such a capability fails as a call to an unknown id ([Invocation](invocation.md#call-failures)).

## Changes

A catalog has no version. A capability has no version. The catalog agrees with the build of the application. When the build changes, the catalog changes.

To keep old clients working, do not change the meaning of an id. For a new meaning, add a new id.

The `acidcat` member is the version of this specification. It is not the version of the catalog.

## Canonical form

The **canonical form** is the one correct text for a catalog. All tools and catalog libraries write the same bytes for the same catalog. A committed catalog SHOULD be in canonical form. `acid-cat format` writes this form.

- **Member order.** The catalog: `acidcat`, `title`, `description`, `targets`, `$defs`, `capabilities`. A target: `bindings`, `description`, `options`. A capability: `description`, `audience`, `input`, `output`, `failures`, `readOnly`, `state`. Other members come after these members, in sorted order.
- **Sorted keys.** Sort the keys of `targets`, `$defs`, `capabilities` and `failures`. Sort the keys of all objects in schemas and in `options`, at all levels. Sort by Unicode code point. Do not sort arrays.
- **Values.** Write strings and numbers as `JSON.stringify` in ECMAScript writes them. For example: `16`, `0.5`, `1e-7`, `1e+21`. Escape only `"`, `\` and control characters.
- **Layout.** Use UTF-8. Indent with two spaces. Put each member and each item on its own line. Write an empty object as `{}` and an empty array as `[]`. End the text with one line feed.

## Extensions

A tool ignores members that it does not know. A member that this specification does not define SHOULD start with `x-`, as in `x-icon`. [Extensions](extensions/README.md) give optional conventions.

## Design notes

*This section is not normative.*

- **Why JSON.** All languages and tools can read JSON. The schemas in a catalog are JSON Schema. Thus the contract is JSON. Pkl and the catalog libraries help you write it.
- **Why build time.** If a program read the catalog at run time, it would read a file and compile schemas to learn what its own code already says. A check at build time costs nothing at run time, and an error stops the build, not a request.
- **Why no default audience.** A new capability does not go to an agent by accident. A target gets a capability only when the catalog says so.
- **Why shared types.** Large catalogs use the same types many times. Shared types make the catalog smaller, and code generators make one named type for each.
