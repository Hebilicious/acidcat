# acid-cat-core-kotlin

Serve AcidCat capabilities in Kotlin, on the JVM and on Android. Maven packages: `dev.acidcat:acid-cat-core-kotlin`, and `dev.acidcat:acid-cat-ktor` to serve the web bindings with Ktor.

A capability is a suspending function. Its schemas come from serializable Kotlin types, with kotlinx.serialization. Availability and state are `StateFlow`s. The cancellation of a call is the cancellation of its coroutine. The application writes its own catalog from its code.

```kotlin
dependencies {
    implementation("dev.acidcat:acid-cat-core-kotlin:0.1.0")
    implementation("dev.acidcat:acid-cat-ktor:0.1.0") // for the MCP and HTTP bindings with Ktor
}
```

Apply the Kotlin serialization plugin, `org.jetbrains.kotlin.plugin.serialization`, to the module of the capabilities.

## Write capabilities

```kotlin
import dev.acidcat.core.*
import kotlinx.serialization.*

@Serializable
data class Power(val on: Boolean)

@Serializable
data class Temperature(@Minimum(16.0) @Maximum(31.0) val celsius: Double)

@Serializable
sealed interface AirconFailure {
    @Serializable @SerialName("Offline")
    data class Offline(val since: String? = null) : AirconFailure
}

class Device(val connected: StateFlow<Availability>, val status: StateFlow<Status>) { /* … */ }

val capability = capabilitiesFor<Device>()

val powerSet = capability("aircon.power.set", "Turn the unit on or off.", listOf("app", "cli", "mcp"))
    .input<Power>()
    .failures<AirconFailure>()
    .availability { device -> device.connected }
    .run { input -> if (context.setPower(input.on)) ok() else fail(AirconFailure.Offline()) }

val temperatureSet = capability("aircon.temperature.set", "Set the target temperature in degrees Celsius.", listOf("app", "cli", "mcp"))
    .input<Temperature>()
    .state<Status> { device -> device.status }
    .run { input -> context.setTemperature(input.celsius); ok() }

val aircon = App(
    title = "Living-room air conditioner",
    targets = mapOf("app" to Target(listOf("kotlin")), "cli" to Target(listOf("cli")), "mcp" to Target(listOf("mcp"))),
    capabilities = listOf(powerSet, temperatureSet),
)
```

- `capabilitiesFor<Context>()` sets the type of the services one time. `capability(id, description, audience)` starts a capability. Each member that has a type gives a new builder with that type, so that `run` gets the decoded input and returns the types of the output and of the failures.
- `run` has the `Call` as its receiver: `context` is the context of the session, and `id` is the id. It returns `ok(value)`, `ok()` when the capability has no output, or `fail(failure)`. If `run` throws, the call fails as `internal`, and `SessionOptions.onDefect` records the cause.
- The failures are a sealed class. Each subclass is one tag: its `@SerialName` is the tag, and the JSON of a failure has the tag in `_tag`.
- With no `input`, the input is an empty object. With no `output`, the value is `null`.
- `availability` gives a `StateFlow<Availability>` for a context. A session reads its value when a call comes in.

### Schemas

`input<T>()`, `output<T>()`, `state<T>()` and `failures<T>()` make the JSON Schema 2020-12 schema of `T` from its serializer:

| Kotlin | Schema |
| --- | --- |
| `String`, `Char` | `string` |
| `Boolean` | `boolean` |
| `Byte`, `Short`, `Int`, `Long` | `integer` |
| `Float`, `Double` | `number` |
| An enum class | `string` with the serial names in `enum` |
| A list, a set or an array | `array` |
| A map with `String` keys | `object` with `additionalProperties` |
| A class | `object`, with its simple name as `title`. A property is `required` when it has no default and is not nullable |
| A sealed class | `oneOf`, with the serial name of each subclass as a constant in `_tag` |
| `JsonElement`, `JsonObject` | Any value, any object |

- A nullable property is optional. The JSON leaves out a property that is `null`.
- `@Description`, `@Minimum`, `@Maximum`, `@Length`, `@Items`, `@Pattern` and `@Format` add keywords. `@SchemaMembers("""{ "multipleOf": 0.5 }""")` adds any other keyword.
- `@SharedType` puts a class in the `$defs` of the catalog, and the schemas refer to it with `$ref`.
- `schemaOf<T>(json, types)` gives a schema that you write yourself, for example for a union. The session validates each input against the JSON Schema, then decodes it with the serializer.

### Write the catalog

```kotlin
File("acidcat.catalog.json").writeText(aircon.renderCatalog()) // canonical form
```

`aircon.catalog` is the catalog as a `JsonObject`. Write the catalog in a build task or a test, and commit it.

## Serve the capabilities

| Function | Binding | Result |
| --- | --- | --- |
| `app.openSession(target, context)` | [Kotlin](../../spec/bindings/kotlin.md) | A session with a handle for each capability in the view |
| `mcpHandler(app, McpSettings(…), context)` | [MCP](../../spec/bindings/mcp.md#http) through HTTP | A `WebHandler` |
| `mcpStdioMain(app, McpStdioSettings(…), context)`, `runMcpStdio(…)` | [MCP](../../spec/bindings/mcp.md#stdio) through stdio | The MCP server of the process, or the server on a flow of lines |
| `httpHandler(app, HttpSettings(…), context)` | [HTTP](../../spec/bindings/http.md) | A `WebHandler` |
| `cliMain(app, CliSettings(…), args)`, `runCli(…)` | [CLI](../../spec/bindings/cli.md) | The command line of the process, or an exit code |

### Sessions and handles

```kotlin
aircon.openSession("app", device).use { session ->
    val power = session.handle(powerSet)          // Handle<Power, Unit, AirconFailure, Nothing>
    when (val result = power.execute(Power(on = true))) {
        is Result.Ok -> println("On")
        is Result.Failed -> println(result.error)  // AirconFailure
    }
    session.call(temperatureSet, request.body)   // validates JSON that is not trusted
    session.invoke("aircon.power.set", json)     // the JSON form of the outcome, for bindings
}
```

- `session.handle(capability)` gives the handle of the capability, with its types. Only the capability object that the session serves gets a handle that calls it. Any other capability gets a handle that is always unavailable.
- `session.handles` is the map of the handles by id, for bindings. A handle of the map takes JSON with `invokeExternal`.
- A call failure throws a `CallFailureException` with its `kind`. A cancelled call throws a `CallCancelledException`, which is a `CancellationException`.
- The cancellation of the coroutine of the caller cancels the call. `close()` cancels all the calls of the session. A call ends when it is cancelled, also if its work does not stop.
- `session.changes` emits each time an availability changes.

### Ktor

```kotlin
embeddedServer(Netty, port = 8080) {
    routing {
        route("/mcp") { serve(mcpHandler(aircon, McpSettings(name = "aircon", version = "1.0.0", allowedOrigins = emptyList()), device)) }
        route("/api") { serve(httpHandler(aircon, HttpSettings(allowedOrigins = emptyList(), base = "/api"), device)) }
    }
}.start(wait = true)
```

Use the Netty engine. When a client closes its connection, the adapter cancels the call of the request. The other engines of Ktor do not tell a handler that the client went away. `ContextSource.PerRequest(create, release)` makes a context for each request.

### Command line

```kotlin
fun main(args: Array<String>) = cliMain(aircon, CliSettings(name = "aircon", version = "1.0.0", context = device), args)
```

An interrupt (`SIGINT`) cancels the call, and the process exits with the code 130. An array of simple items is a repeated flag: `--tags a --tags b`, or `--tags '["a","b"]'`. `CliSettings.commands` adds commands of the application.

### MCP through stdio

```kotlin
fun main() = mcpStdioMain(aircon, McpStdioSettings(name = "aircon", version = "1.0.0"), device)
```

The process is one session. It serves revision `2026-07-28` and the `initialize` handshake of revisions `2025-11-25` and `2025-06-18`, so local MCP clients can start it. It tells the client when the set of available tools changes. When standard input ends, it cancels the calls in progress and exits.

## Tests

`moon run core-kotlin:test` runs the tests of the core, and runs `acid-cat conform` from [`packages/cli`](../cli) against the MCP binding through HTTP and through stdio, and the HTTP and CLI bindings of the fixture, with Node. `fixture/build/conform.txt` has the result of each check.

- [`fixture/src/main/kotlin/dev/acidcat/fixture/Fixture.kt`](fixture/src/main/kotlin/dev/acidcat/fixture/Fixture.kt) has one capability for each behavior that `acid-cat conform` tests.
- [`fixture/fixture.acidcat.json`](fixture/fixture.acidcat.json) is the catalog that the core writes for the fixture. A test checks it, and `moon run core-kotlin:catalog` writes it again.
- [`core/src/test/resources/edge.acidcat.json`](core/src/test/resources/edge.acidcat.json) is the canonical form that `acid-cat format` writes for `edge.input.json`. The core writes the same bytes.
