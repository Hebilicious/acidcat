# Sessions

A **session** serves one target to one caller context. It holds that context's identity and resources, starts invocations, and owns the work they start.

Closes divergence row D9.

## Identity

Capability inputs MUST NOT carry identity, credentials or tokens. A session closes over whatever identity its caller context has. An authenticated session is a session whose services are bound to that identity when it is created. A capability can see the identity only through those services.

## Lifecycle

A session is **open**, then **closing**, then **closed**.

1. **Open.** The session admits invocations.
2. **Closing.** Closing starts at logout, when the session is lost, or when the host disposes of the session. The session first stops admitting invocations and stops registering capabilities with any binding. Its signal is then aborted. Each owner settles or cancels the work it holds, as its own policy decides.
3. **Closed.** The session is closed once every owner and every finaliser has finished. Attachments are released last.

An invocation made after closing has begun fails as `cancelled`, because the session's signal is aborted. Every invocation that was in flight when closing began settles: with its result if its owner let it finish, and as `cancelled` otherwise.

A remote binding creates a session for each request and closes it once the response is complete.

## Rationale

*This section is not normative.*

**JB's lifecycle, made general.** JB closes admission before it closes resources. It aborts a lifetime signal, closes owners, then closes the attachment registry, and completes disposal only once finalisers have run. HS has a single disposal signal and no admission, which is the degenerate case of the same lifecycle. Both report calls after closing, and calls interrupted by closing, as cancellations (`AbortError`), so the kind follows the code.

**Identity stays out of inputs.** This is explicit in JB's specification and ADR 0014, and HS has no identity at all. A session that closes over identity means an agent cannot claim to be another user by changing an argument.

**What stays in the application.** JB's Discord-shaped user, its logout navigation, and its rule that a failed logout keeps the session usable are application behaviour (see row D18). The specification fixes only the order in which a session closes.

**Changes for each implementation.**
- JB conforms.
- HS: the WebMCP adapter's scope is created on its own and is not closed when the root is disposed, so its registrations can outlive the session. Closing should withdraw them.
