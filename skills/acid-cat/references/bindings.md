# The traps of each binding

The documents of the bindings are at https://github.com/Hebilicious/acidcat/tree/main/spec/bindings.

## MCP through HTTP

- One URL, `/mcp`. Revision `2026-07-28`: each request is its own session. The server keeps no state between requests, except poll leases and webhook subscriptions.
- The server rejects origins that are not in `allowedOrigins`. A request with no `Origin` header is accepted.
- An unavailable capability is not listed, and a call to it gets the same answer as an unknown tool.
- Events use the MCP events extension, only in revision `2026-07-28`, and only when the view has events. A client with the `initialize` handshake gets no events.
  - Push: the answer to `events/stream` is a stream of server-sent events.
  - Poll: `events/poll` reads a lease, which holds the subscription between polls in a session of its own. A lease ends when it gets no poll for 5 minutes. Keep the cursor of each result, and give it to the next poll.
  - Webhook: off by default. The deployment turns it on, and gives the identity of each client (the principal). In core-ts: the options `webhooks: webhookDelivery(…)` (from `@acid-cat/core-ts/node`) and `principal(request)` of `mcpHandler`. In core-effect: the options `webhooks: { sender: NodeWebhook.sender(…) }` and `principal` of the MCP binding. With webhook delivery off, `events/subscribe` and `events/unsubscribe` answer `Unsupported`. The callback URL must use `https`, must agree to get deliveries (a `verification` message, or the allowlist), and must resolve to a globally routable address. In tests with a local receiver, set `allowPrivateNetworks` and give its certificate in `ca`.
- The principal is part of the key of a poll lease and of a webhook subscription. Give it from a verified identity, never from a header that the client chooses.
- Poll leases and webhook subscriptions are the only state between requests. They are soft: after a restart, clients start again with their cursors.
- Keep the network safety of the webhook sender on: it connects only to globally routable addresses. Allow private networks only in tests.

## Serve MCP and HTTP on a network

- The cores give web handlers, `(request: Request) => Promise<Response>`. The host serves them. On Node.js, use the server of the core: `serve` from `@acid-cat/core-ts/node`, or `NodeServer.serve` and `NodeServer.layer` from `@acid-cat/core-effect/NodeServer`. On Bun, Deno and Cloudflare Workers, give the handler to the server of the runtime.
- Authenticate each request in the context of the request: `createContext(request)` and `refuse` in core-ts, a per-request layer with `Remote.IncomingRequest` and `Remote.refuse` in core-effect, `with_request_context` and `Refusal` in core-rust. The function reads the headers, and refuses a request with no valid caller: the answer has its status (400 to 599) and the body `{ "message" }`, and no session opens. Through MCP, also give the `principal` from the same caller: a poll lease is keyed by the principal, so with no principal two callers share one lease. In core-effect, `Mcp.withEvents` refuses only the requests of the events extension; your own MCP server authenticates the others. The capabilities read the caller from the context.
- `serve` from `@acid-cat/cli` is for tests only. It listens on `127.0.0.1`, on a free port.
- The server of a core is plain HTTP/1.1, on `127.0.0.1:3000` by default. In a container, set `hostname` to `0.0.0.0` or `::`, or the platform cannot connect.
- End TLS in the platform, before the server: a load balancer, the ingress of a Kubernetes cluster with cert-manager, or a tunnel. The platform sends plain HTTP to the server. Do not write a TLS proxy in front of the server. When TLS must reach the process, give the handler to a library that serves HTTPS, for example srvx, in place of the server of the core.

## MCP through stdio

- The process is one session. Standard output carries only MCP messages. Write logs to standard error.
- The server tells the client when the set of available tools changes (`notifications/tools/list_changed`).
- When standard input ends, the server cancels the calls in progress, ends each subscription as complete, and exits.
- The messages of each `events/stream` request go to standard output, with the id of the request in `_meta["io.modelcontextprotocol/subscriptionId"]`. `notifications/cancelled` with that id cancels the subscription.
- `events/poll` serves poll leases. When standard input ends, the leases end. Webhook delivery is not served through stdio.

## HTTP

- `GET {base}/capabilities` lists the view with availability. `POST {base}/capabilities/{id}` calls a capability with the input as the body.
- A result has the status 200. A call failure has its own status: 404, 422, 503, 409 or 500.
- `GET {base}/events` lists the events. `POST {base}/events/{id}` gives a stream of server-sent events in the framing of graphql-sse: `event: next`, then `event: complete` or `event: error`. A failure before the first occurrence is a JSON call failure with its status. `Last-Event-ID` gives the cursor. Behind a proxy, turn off the buffering of responses, or the client gets no occurrence until the buffer is full.

## Command line

- Each capability is a command: `aircon.power.set` gives `aircon power set`. Each input property is a flag.
- A shared prefix only contains other commands. An id must not be the start of another id: with `aircon.status` and `aircon.status.get`, the command line stops with an error when it starts.
- An array of simple items is a repeated flag: `--days mon --days fri`, or `--days '["mon","fri"]'`.
- Exit codes: 0 for a value, 1 for a failure, 2 unknown, 3 invalid input, 4 unavailable, 5 internal, 130 cancelled.
- `watch <id>` subscribes to an event, and writes each occurrence as JSON on one line. It exits with 0 when the subscription is complete, 130 after an interrupt, and 5 after `internal`. `list` gives each item a `kind`: `capability` or `event`. No command can have the name `watch`. Write logs to standard error, or they break the lines of JSON.
- `watch <id> --cursor <cursor> --max-age-ms <integer>` resumes after the cursor of an earlier occurrence. No input property of an event can be named `cursor` or `max-age-ms`: the command line stops with an error when it starts.
- In core-rust, the command line can run on another machine than the application: `CliOptions::remote(HttpClient::new(url)?)` sends each call and each subscription to the HTTP binding of a server. The commands still come from the view in the program. Serve that HTTP binding with the target of the command line (`HttpOptions { target: "cli".into(), .. }`), so that both have the same view. Add a token with `HttpClient::header("Authorization", …)` when the server checks one.

## WebMCP

- The page registers one tool for each available capability, on `document.modelContext` or `navigator.modelContext`. With no host, the binding does nothing.
- The page can remove all tools while the session stays open.
- WebMCP serves no events. The page follows events through the TypeScript binding.

## GraphQL subscription from an event

A GraphQL API is application code, beside the bindings. A subscription field can follow an event through an event handle:

```ts
subscription: {
  statusChanged: {
    subscribe: (_, __, { session }) => session.eventHandle(statusChanged).subscribe({}), // core-ts
    resolve: (occurrence) => occurrence.data,
  },
}
```

- Return the promise of `subscribe`. It rejects with a `CallFailureError` when the subscription cannot start. GraphQL calls `return()` of the iterator when the client ends the subscription. In core-effect, use `session.event(statusChanged).subscribe({})` of `Handles.open`.
- Through server-sent events (GraphQL Yoga, the graphql-sse client), the request has one session. Keep it open until the stream ends, and close it when the client cancels the stream: then each subscription of the session is complete.
- Through WebSockets (graphql-ws on a `ws` server), make each connection one session: open it in `onConnect`, and close it in `onClose`. Refuse a connection from an origin that the API does not allow.
- `examples/aircon/apis/graphql.ts` does both, with Pothos and one schema.

## Other APIs that follow an event

- **Cap'n Web.** Take a function of the client: `followStatus(listener: RpcStub<(status: Status) => void>)`. Subscribe with a signal, keep `listener.dup()`, because Cap'n Web disposes the stubs of the parameters when the call returns, and call it with the data of each occurrence. Return an `RpcTarget` whose `[Symbol.dispose]()` aborts the signal: the client disposes it to stop. Also abort when `onRpcBroken` fires or a call to the listener rejects. A call back to the client needs a connection that stays open: serve it through WebSockets, with one session for each connection. Do not return a `ReadableStream` for this: when the client cancels it while the server waits for the next occurrence, Cap'n Web does not cancel the source.
- **Elysia.** Use a generator route and `sse`. Pass `request.signal` to `subscribe`: Elysia calls `return()` of the generator when the client goes away, but that call waits until the `await` of the loop ends. Elysia sends the response after the first value of the generator, so yield a first event at once, for example `sse({ retry: 1000 })`. Open the session in the generator with `await using`: it closes when the stream ends. For a WebSocket, use `.ws()` on a server adapter that serves WebSockets, for example `@elysiajs/node` on Node.js: open a session and subscribe in `open`, and abort the subscription in `close`. The `listen` callback of `@elysiajs/node` gives the server, with `stop()`.
- `examples/aircon/apis/capnweb.ts` and `examples/aircon/apis/elysia.ts` do this, with their tests.
