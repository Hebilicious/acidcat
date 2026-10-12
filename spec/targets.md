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

## Other targets

An application MAY define targets of its own, such as a native shell, a chat bot or a scheduler. It SHOULD name them `<prefix>:<name>`, so that a future core target cannot collide with them. Every rule in this specification applies to them as it applies to core targets.

An implementation SHOULD report an audience that names a target the application does not serve, since that is usually a typo.

## Audience

A capability's audience is a non-empty set of target names, declared where the capability is defined.

A session serves a capability only when the capability's audience contains the session's target and the capability is available. A capability outside the audience is never available to that session. It MUST be absent from every listing and registration the session produces, and a call that names it MUST fail as a call to an unknown capability does (see [Invocation](invocation.md#invocation-failures)).

## The page

The `web` target covers the human interface and in-page agents alike. They act on one session, so neither sees a capability the other cannot.

When an application serves the `web` target, every capability's audience SHOULD contain `web`, so that the page is the complete interface and a person can do anything an agent can. Tool targets such as `cli`, `mcp` or `rpc` then serve subsets that grow one declaration at a time. An application with a reason to keep a capability off the page, such as an operator-only RPC, may leave `web` out of that capability's audience.

## Rationale

*This section is not normative.*

**`web`, not `application`.** JB calls the page target `application`, but AcidCat is itself the application interface, and JB already uses `application` as a namespace (`application.session.inspect`). The page target therefore gets a name that collides with neither. HS renamed it to `web` deliberately, with rewritten documentation, so HS's name is adopted. JB's manifest records no target names, so only its code changes.

**`rpc` is a target.** A target exists when its clients need their own audience decision. A transport on its own is only a binding. HS's capnweb API serves a different subset from its command line (the check history is served to `cli` and not to `rpc`), so it needs an audience of its own.

**A small core, and anything else allowed.** A closed set cannot cover surfaces nobody has built yet. The core names exist so that bindings and the conformance kit can rely on them. Everything else is left to the application. The prefix and the typo warning are recommendations, so a small application is not made to do any ceremony.

**In-page agents share `web`.** An agent on the page acts through the user's live session and can drive anything the interface can, so a separate audience would hide tools from it without restricting what it can do. JB's rule, that every capability reaches the page, is kept as the default. It is a SHOULD rather than a MUST, so that JB can keep enforcing it in its own checks while other applications can serve capabilities only to tools. Whether some capabilities need authorisation beyond audience remains an open gap in the [inventory](divergence.md#not-yet-covered-by-either).

**Changes for each implementation.** JB renames `application` to `web`. HS already conforms. Neither defines targets of its own yet.
