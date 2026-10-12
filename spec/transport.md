# Remote transports

A **remote binding** serves a target to clients over the network, as the MCP and API bindings do. This section states what every remote binding does before it decodes a request. Each binding document gives the status codes and the protocol errors it uses.

Closes divergence row D14.

## Screening

A remote binding screens every request before it opens a session or decodes the protocol. It MUST refuse the request when:

- the method is not one the binding accepts;
- the request carries an `Origin` header that names an origin the deployment does not allow;
- the media type is not the one the protocol uses;
- the body is larger than the deployment's limit;
- the body is not valid UTF-8, when the protocol is text.

A binding states whether it accepts requests without an `Origin` header. A binding meant for non-browser clients accepts them.

## Body limits

Every remote binding has a body limit, measured in bytes. The binding counts the bytes as they arrive and stops reading once the limit is passed. It MAY refuse early when a declared `Content-Length` is over the limit, but it MUST NOT rely on that declaration.

The values of the limits are deployment configuration. Manifests do not carry them.

## Rationale

*This section is not normative.*

**The rule is core; the numbers are not.** Both implementations screen origin and method, and both bound bodies by the bytes that actually arrive (JB's MCP reader, and HS's `readAtMost`). HS's capnweb binding also checks the media type and UTF-8. Every remote surface needs the same protection, so the obligation is stated once here. Statuses and error codes depend on the protocol and belong to the bindings. Limits depend on the deployment: JB allows 4 MiB for its optimiser RPC and 64 KiB for its auth RPC.

**Where the code lives is up to the implementation.** HS put the byte reader in its kernel and JB put it in the adapter. The specification states behaviour, not packages.

**Changes for each implementation.** Both MCP bindings decode bodies leniently, so invalid UTF-8 becomes U+FFFD instead of being refused, and neither checks the media type. JB's RPC request reader throws on invalid UTF-8 instead of answering 400.
