# The traps of each binding

The documents of the bindings are at https://github.com/Hebilicious/acidcat/tree/main/spec/bindings.

## MCP through HTTP

- One URL, `/mcp`. Revision `2026-07-28`: each request is its own session, so the server keeps no state between requests.
- The server rejects origins that are not in `allowedOrigins`. A request with no `Origin` header is accepted.
- An unavailable capability is not listed, and a call to it gets the same answer as an unknown tool.
- With Ktor (Kotlin), use the Netty engine: the adapter cancels the call when the client closes its connection.

## MCP through stdio

- The process is one session. Standard output carries only MCP messages. Write logs to standard error.
- The server tells the client when the set of available tools changes (`notifications/tools/list_changed`).
- When standard input ends, the server cancels the calls in progress and exits.

## HTTP

- `GET {base}/capabilities` lists the view with availability. `POST {base}/capabilities/{id}` calls a capability with the input as the body.
- A result has the status 200. A call failure has its own status: 404, 422, 503, 409 or 500.

## Command line

- Each capability is a command: `aircon.power.set` gives `aircon power set`. Each input property is a flag.
- An array of simple items is a repeated flag: `--days mon --days fri`, or `--days '["mon","fri"]'`.
- Exit codes: 0 for a value, 1 for a failure, 2 unknown, 3 invalid input, 4 unavailable, 5 internal, 130 cancelled.

## WebMCP

- The page registers one tool for each available capability, on `document.modelContext` or `navigator.modelContext`. With no host, the binding does nothing.
- The page can remove all tools while the session stays open.

## Android AppFunctions

- Android 16 (API 36) or later, and the Jetpack library `androidx.appfunctions`.
- The Gradle plugin `dev.acidcat.appfunctions` reads the view of one target from the JSON catalog at build time, and generates the service. The AppFunctions compiler (KSP) indexes it. Configure it in `acidCatAppFunctions { catalog; target; packageName; serviceName; provider }`.
- The provider is an `object` that implements `AppFunctionsProvider` and keeps the binding, so that the screen of the app and the app functions share one context.
- Call `<Service>Functions.keepAvailability(context, scope)` in `Application.onCreate`, so that the enabled state of each app function follows the availability of its capability.
- A capability with failures returns a result: `ok`, `value`, and `error` with its `tag`. Schemas that AppFunctions cannot type, for example unions or maps, are JSON text.
- Test on a device or an emulator with `adb shell cmd app_function list-app-functions --package <package>` and `execute-app-function`. On a headless emulator in CI, use the image `aosp_atd`, and wait until user 0 is unlocked before the first call.
