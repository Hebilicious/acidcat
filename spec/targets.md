# Targets and audience

A **target** is a kind of surface that a session serves. Every session is created for exactly one target, and every capability declares its **audience**, the set of targets allowed to see it.

Closes divergence rows D1, D2 and D3.

## Core targets

| Target | Serves |
| --- | --- |
| `web` | The page: the human interface, and the agents that act inside the page through WebMCP on the same live session |
| `cli` | A command line |
| `mcp` | Model Context Protocol clients of a remote endpoint |
| `rpc` | Programmatic clients of a remote procedure call API |

A new core target is added only by a new version of this specification. An implementation MUST NOT use a core target name with another meaning.

## Extension targets

An application MAY serve targets beyond the core set. An extension target name has the form `<prefix>:<name>`, where both parts match `[a-z][a-z0-9-]*`. The prefix identifies whoever defines the target, such as the application or a binding.

An application declares the extension targets it serves. An implementation MUST refuse to build a catalog in which an audience names a target that is neither a core target nor a declared extension target.

Every rule in this specification applies to extension targets as it applies to core targets.

## Audience

A capability's audience is a non-empty set of target names, declared where the capability is defined.

A session serves a capability only when the capability's audience contains the session's target and the capability is available. A capability outside the audience is never available to that session. It MUST be absent from every listing and registration the session produces, and a call that names it MUST fail as a call to an unknown capability does (see [Invocation](invocation.md#invocation-failures)).

## The page

The `web` target covers the human interface and in-page agents alike. They act on one session, so neither sees a capability the other cannot.

When an application serves the `web` target, every capability's audience MUST contain `web`. The page is then the complete interface. A tool target such as `cli`, `mcp` or `rpc` serves a subset that grows one declaration at a time.

## Rationale

*This section is not normative.*

**`web`, not `application`.** JB calls the page target `application`, but AcidCat is itself the application interface, and JB already uses `application` as a namespace (`application.session.inspect`). The page target therefore gets a name that collides with neither. HS renamed it to `web` deliberately, with rewritten documentation, so HS's name is adopted. JB's manifest records no target names, so only its code changes.

**`rpc` is a target.** A target exists when its clients need their own audience decision. A transport on its own is only a binding. HS's capnweb API serves a different subset from its command line (the check history is served to `cli` and not to `rpc`), so it needs an audience of its own.

**A fixed core with prefixed extensions.** A closed set cannot cover surfaces nobody has built yet, such as a native shell, a chat bot or a scheduler. A fully open set would let an unknown target hide a capability with nobody noticing. Extension targets therefore need a prefix and a declaration, and a misspelt target is refused when the catalog is built.

**In-page agents share `web`.** An agent on the page acts through the user's live session and can drive anything the interface can, so a separate audience would hide tools from it without restricting what it can do. JB's explicit rule, that every capability reaches the page, is kept. It also means a human can always do everything an agent can. Whether some capabilities need authorisation beyond audience remains an open gap in the [inventory](divergence.md#not-yet-covered-by-either).

**Changes for each implementation.** JB renames `application` to `web`. HS already conforms. Neither has extension targets yet.
