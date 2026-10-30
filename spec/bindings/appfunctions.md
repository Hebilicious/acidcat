# AppFunctions binding

A protocol binding that serves a view as Android **app functions**. An app function is an operation of an app that agents and assistants on the device can find and execute, through the AppFunctions API of the platform (`android.app.appfunctions`, Android 16 and later). The app declares its app functions at build time. The platform indexes them, and calls the app when a caller executes one. A target with this binding usually also uses the [Kotlin binding](kotlin.md).

## Service

- The build makes the app functions from the view of the target. It writes one app function for each capability in the view, and one data type for each object that a schema needs. The app does not read the catalog at run time.
- The service of the app functions is a class of the app. The app chooses its name. Each app function is a member of this class.
- **Instructions.** The app metadata gives the platform `instructions`: how a model uses the app functions as a whole. They are the `description` of the catalog. If the catalog has no `description`, the app has no app metadata.
- Each execution of an app function has its own session. The session closes when the execution ends. The platform checks the permission of the caller before the execution. The session holds no other identity.

## Names

- The **function name** comes from the id. Each `.` becomes `_`, and each `-` becomes `__`. For example, `aircon.power.set` becomes `aircon_power_set`, and `fan-speed.set` becomes `fan__speed_set`. Two ids never give the same name.
- The **function identifier** is the fully qualified name of the service class, `#`, and the function name. For example: `com.example.AirconFunctions#aircon_power_set`.
- The description of an app function is the description of its capability. The description of a parameter or a property is the `description` of its schema.

## Input

- Each top-level property of the input schema is one parameter, with the same name. If the input schema is a `$ref`, use the type that it refers to. A property in `required` is a required parameter. Other parameters are optional, and the input does not contain a parameter that the caller leaves out.
- If the input schema has no top-level `properties` member, the app function has one required parameter, `input`. Its value is the input as JSON text.
- A capability with no input schema, or with `"properties": {}`, has no parameters.
- A name that is not a Kotlin identifier (`[A-Za-z_][A-Za-z0-9_]*`) becomes one: each other character becomes `_`, and a name that starts with a digit gets `_` before it. A name that is a hard keyword of Kotlin, for example `in` or `class`, gets `_` after it. If two names of one object give the same identifier, the build MUST stop with an error.
- The provider validates the input against the schema. The platform can also reject an input that does not have the types of the parameters.

## Types

Each schema becomes a type of AppFunctions:

| Schema | Type |
| --- | --- |
| `string` | String |
| `enum` or `const` of strings | String, with the strings as its enum values |
| `integer` | Long |
| `number` | Double |
| `boolean` | Boolean |
| `object` with `properties` that are not empty, and no `additionalProperties` other than `false` | A data type with one property for each property of the schema. Its name is the `title` of the schema, the name of the type in `$defs`, or a name from the position of the schema |
| `array` of `string` | List of strings |
| `array` of `integer`, `number` or `boolean` | Array of Long, Double or Boolean |
| `array` of an object that is a data type | List of the data type |
| Other | String, with the value as JSON text |

- A schema whose `type` also allows `null`, or an `anyOf` of a schema and `null`, has the type of the other schema. A property that is in `required` and allows `null` is JSON text.
- A value that is JSON text is in the JSON form of the value. For example, the JSON text of an object `{ "a": 1 }` is the string `{"a":1}`.

## Outcomes

| Outcome | Answer |
| --- | --- |
| Value | The return value of the app function. A capability with no output schema returns nothing |
| Failure | The return value. See below |
| `cancelled` | The error `ERROR_CANCELLED` (2001) |
| `unknown-capability` | The error `ERROR_FUNCTION_NOT_FOUND` (1003) |
| `unavailable` | The error `ERROR_DISABLED` (1002) |
| `invalid-input` | The error `ERROR_INVALID_ARGUMENT` (1001) |
| `internal` | The error `ERROR_APP_UNKNOWN_ERROR` (3000) |

The return value of a capability that has `failures` is a **result**, a data type with these properties:

| Property | Value |
| --- | --- |
| `ok` | `true` for a value, `false` for a failure |
| `value` | The value, when `ok` is `true`. It is not present when the capability has no output schema |
| `error` | The failure, when `ok` is `false` |

The failure is a data type. Its property `tag` is the tag of the failure. For each tag whose schema has properties other than `_tag`, the failure has one more property: the name of the tag in camelCase, for example `offline` for `Offline`. When `tag` is that tag, the property holds the other members of the failure.

A capability with no `failures` returns its value directly.

## Listing

- The platform lists one app function for each capability in the view.
- The enabled state of an app function agrees with the availability of its capability. While a capability is unavailable, its app function is disabled, and the platform rejects each call with `ERROR_DISABLED`. The app keeps the enabled states while its process runs.
- A call that comes in when the availability changes gets the availability of the session at that moment, as in [Availability](../invocation.md#availability).

## Cancellation

When the platform cancels an execution, the call is cancelled. For example, the platform cancels an execution when the caller cancels it, or when its time ends.

## Design notes

*This section is not normative.*

- **Why generated code.** The platform reads the app functions of an app from a file that the build writes. Thus the app functions come from the view at build time, as the catalog requires.
- **Why a result for failures.** A failure is data that the caller can act on. The errors of the platform tell only that a call did not run. Thus a failure is a return value, as a value is.
- **Why JSON text.** The types of AppFunctions cannot hold all JSON Schemas, for example unions or maps. JSON text keeps each value that a capability accepts or returns.
