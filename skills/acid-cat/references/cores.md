# A capability in each core

Each example is the same capability: `aircon.power.set` turns the unit on or off, for the targets `cli` and `mcp`, and can fail with `Offline`. The README of each core has the full API:

- core-ts: https://github.com/Hebilicious/acidcat/blob/main/packages/core-ts/README.md
- core-effect: https://github.com/Hebilicious/acidcat/blob/main/packages/core-effect/README.md
- Kotlin: https://github.com/Hebilicious/acidcat/blob/main/packages/core-kotlin/README.md

## core-ts

```ts
import { capabilitiesFor, defineApp, fail, ok, renderCatalog } from "@acid-cat/core-ts";
import { z } from "zod";

const Offline = z.object({ _tag: z.literal("Offline") });
const capability = capabilitiesFor<{ unit: Unit }>();

export const powerSet = capability({
  id: "aircon.power.set",
  description: "Turn the unit on or off.",
  audience: ["cli", "mcp"],
  input: z.object({ on: z.boolean() }),
  failures: { Offline },
  run: async ({ on }, { context, signal }) => ((await context.unit.setPower(on, signal)) ? ok(null) : fail({ _tag: "Offline" })),
});

export const aircon = defineApp<{ unit: Unit }>({
  targets: { cli: { bindings: ["cli"] }, mcp: { bindings: ["mcp"] } },
  capabilities: [powerSet],
});

const toJsonSchema = (schema) => z.toJSONSchema(schema, { target: "draft-2020-12" });
await writeFile("acidcat.catalog.json", renderCatalog(aircon, { toJsonSchema }));
```

- `run` gets the decoded input, the `AbortSignal` of the call and the context. It returns `ok(value)` or `fail(failure)`.
- `availability: (context) => observable` makes the capability available or not. `state: { schema, source }` gives a value that clients observe.

## core-effect

```ts
import { App, Capability } from "@acid-cat/core-effect";
import { Schema } from "effect";

const Offline = Schema.TaggedStruct("Offline", {});

export const powerSet = Capability.make({
  id: "aircon.power.set",
  description: "Turn the unit on or off.",
  audience: ["cli", "mcp"],
  input: Schema.Struct({ on: Schema.Boolean }),
  failures: [Offline],
  run: ({ on }) => Unit.setPower(on), // an Effect that can fail with Offline
});

export const aircon = App.make({
  targets: { cli: { bindings: ["cli"] }, mcp: { bindings: ["mcp"] } },
  capabilities: [powerSet],
});

await writeFile("acidcat.catalog.json", App.render(aircon));
```

- A failure is a `Schema.TaggedStruct`. Use `Schema.Finite` or `Schema.Int` for numbers, because `Schema.Number` accepts `Infinity` and `NaN`.
- Services are layers. Make each `SubscriptionRef` of availability or state in a layer, so that all sessions share it.
- Give a shared type an `identifier` annotation. It becomes a named type in `$defs`.

## Kotlin

```kotlin
@Serializable
data class Power(val on: Boolean)

@Serializable
sealed interface AirconFailure {
    @Serializable @SerialName("Offline")
    data object Offline : AirconFailure
}

val capability = capabilitiesFor<Device>()

val powerSet = capability("aircon.power.set", "Turn the unit on or off.", listOf("cli", "mcp"))
    .input<Power>()
    .failures<AirconFailure>()
    .run { input -> if (context.setPower(input.on)) ok() else fail(AirconFailure.Offline) }

val aircon = App(
    targets = mapOf("cli" to Target(listOf("cli")), "mcp" to Target(listOf("mcp"))),
    capabilities = listOf(powerSet),
)

File("acidcat.catalog.json").writeText(aircon.renderCatalog())
```

- Apply the Kotlin serialization plugin. The schema of each type comes from its serializer. `@Minimum`, `@Maximum`, `@Length`, `@Items`, `@Pattern`, `@Format` and `@Description` add keywords, and `@SharedType` puts a class in `$defs`.
- The failures are a sealed class. The `@SerialName` of each subclass is its tag.
- `run` is a suspending function. The cancellation of its coroutine is the cancellation of the call.
- `.availability { context -> stateFlow }` and `.state<T> { context -> stateFlow }` give availability and state.
