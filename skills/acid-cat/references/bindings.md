# The traps of each binding

The documents of the bindings are at https://github.com/Hebilicious/acidcat/tree/main/spec/bindings.

## MCP through HTTP

- One URL, `/mcp`. Revision `2026-07-28`: each request is its own session, so the server keeps no state between requests.
- The server rejects origins that are not in `allowedOrigins`. A request with no `Origin` header is accepted.
- An unavailable capability is not listed, and a call to it gets the same answer as an unknown tool.

## Serve MCP and HTTP on a network

- The cores give web handlers, `(request: Request) => Promise<Response>`. The host serves them. On Node.js, use the server of the core: `serve` from `@acid-cat/core-ts/node`, or `NodeServer.serve` and `NodeServer.layer` from `@acid-cat/core-effect/NodeServer`. On Bun, Deno and Cloudflare Workers, give the handler to the server of the runtime.
- `serve` from `@acid-cat/cli` is for tests only. It listens on `127.0.0.1`, on a free port.
- The server of a core is plain HTTP/1.1, on `127.0.0.1:3000` by default. In a container, set `hostname` to `0.0.0.0` or `::`, or the platform cannot connect.
- End TLS in the platform, before the server: a load balancer, the ingress of a Kubernetes cluster with cert-manager, or a tunnel. The platform sends plain HTTP to the server. Do not write a TLS proxy in front of the server. When TLS must reach the process, give the handler to a library that serves HTTPS, for example srvx, in place of the server of the core.

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
