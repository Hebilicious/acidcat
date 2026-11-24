# Programmatic surface

The **programmatic surface** is the contract of every [language surface](README.md). It tells how code in the same process calls capabilities and follows events through a session. It has no language. A language surface maps each part of the contract to one language: its types, how a call waits for its outcome, how an error shows, how code observes a value that changes, and how code cancels work.

This document fulfils [What a surface document tells](README.md#what-a-surface-document-tells) for all language surfaces. Each language surface document adds only what its language needs.

| Language surface | Mapping |
| --- | --- |
| [`typescript`](typescript.md) | TypeScript and JavaScript: objects, promises, `AbortSignal` and async iterables |
| [`rust`](rust.md) | Rust: an `Outcome` enum, cancellation tokens and an async `next` |

A protocol surface can use the handles of a session to serve its own clients.

## Sessions

A client opens a [session](../invocation.md#sessions) for one target. The language surface tells how a session opens. The session gives:

- a **handle** for each capability in the catalog of its target;
- an **event handle** for each event in the catalog of its target;
- the catalog of the target, from which the client can read the description, the audience and the schemas of each capability and each event.

A handle can be an object of its own, or the functions of the session that take the id. The language surface tells which.

- A language surface MUST give a way to close the session. The session then follows the [session lifecycle](../invocation.md#sessions).
- A language surface MUST let code know when the session starts to close, for example through a signal.

## Handles

- **Names.** A session gives each handle by id. The id is the only name. A language surface MAY also put the handles in a tree of objects, or give a handle from a definition of the application. The application chooses the tree. No name comes from the tree.
- **Input.** A handle gives two kinds of call:
  - An **external call** takes an input that is not trusted. The handle validates the input against the input schema before the operation starts. An input that does not agree fails as `invalid-input`. The result is in its JSON form. Each language surface MUST give the external call.
  - A **typed call** takes an input that is already decoded into the types of the language. The value and the failure have the types of their schemas. A language surface SHOULD give the typed call.
- **Outcomes.** A call ends with exactly one [outcome](../invocation.md#outcomes).
  - A result is data. The client gets it as a value, and can tell a value from a failure.
  - A call failure has a form apart from results. The client MUST be able to read its `kind` and its `message`. A language surface SHOULD show a call failure with the usual error mechanism of the language.
- **Listing.** A session lists the handles of all the capabilities in its target. A call to an id that is not in the target fails as `unknown-capability`. A language surface MAY give a handle for a capability that is not in the target, for example from a definition that the session does not serve. That handle is always unavailable, and each call through it fails as `unknown-capability`.
- **Availability.** A language surface MUST let the client read the [availability](../invocation.md#availability) of each handle now, and MUST tell the client after it changes. A language surface SHOULD give the availability of each handle as an [observable value](#observable-values).
- **State.** A handle of a capability that has [`state`](../invocation.md#state) gives the state as an [observable value](#observable-values). A handle MAY also give a state for code in the same process when the catalog has no `state`. Each snapshot and each new value is a copy. It is not the data of the provider.
- **Cancellation.** A language surface MUST let the client cancel one call, as [Cancellation and concurrency](../invocation.md#cancellation-and-concurrency) tells.
- **Types.** A language surface with static types SHOULD take the types of the input, the value, the failures and the state from the schemas of the capability.

## Observable values

An **observable value** is a value that changes, such as an availability or a state. The client reads it now, as a **snapshot**, and follows it.

- A read gives the latest value.
- After the value changes, the language surface tells the client. The client can then read the latest value.
- The client can miss a value between two reads, for example when two changes come quickly. A language surface MAY give each new value. It does not have to.

## Event handles

Each language surface serves [events](../events.md).

- **Names.** A session gives each event handle by id, apart from the handles of capabilities. A language surface MAY also put them in a tree of objects. The application chooses the tree. No name comes from the tree.
- **Subscribing.** An event handle gives an external subscription and a typed subscription, with the same rules as the external call and the typed call. A subscription also takes a [cursor](../events.md#resuming) and `maxAgeMs`, both optional. The subscription gives the occurrences once it has started. A call failure before the first occurrence has the same form as the call failure of a call.
- **Occurrences.** The client reads the occurrences one at a time, in their order. Each occurrence has the members of an [occurrence](../events.md#occurrences). Each one is a copy. It is not the data of the provider. Through the external subscription, each `data` is in its JSON form. Through the typed subscription, each `data` has the type of the payload.
- **Ending.** A subscription ends as [Ending](../events.md#ending) tells. The client MUST be able to tell a complete end from the end with the call failure `internal`. A cancelled subscription MAY show the normal end, as a complete one does: the client cancelled it, so the client knows the cause.

  | End | The client sees |
  | --- | --- |
  | Complete | The normal end of the occurrences |
  | Cancelled | The normal end of the occurrences, or nothing more |
  | `internal` | The call failure `internal`, after the occurrences before it. Then the normal end |

- **Cancellation.** A language surface MUST let the client cancel a subscription at any time, also while it waits for the next occurrence. After that, the client gets no more occurrences.
- **Listing.** A session lists the event handles of all the events in its target. A subscription to an id that is not in the target fails as `unknown-capability`. A language surface MAY give an event handle for an event that is not in the target. Each subscription through it fails as `unknown-capability`.
- **Types.** A language surface with static types SHOULD take the types of the input and the payload from the schemas of the event.

## What a language surface document tells

A language surface document links this contract and tells, for its language:

1. how a session opens and closes, and how code knows that it starts to close;
2. the form of a handle and an event handle, and how the client gets them by id;
3. the form of the external call and, if the surface gives it, the typed call;
4. the form of a result, and how a call failure and its `kind` show;
5. how the client reads and follows an observable value, and how it learns that the availability changed;
6. how the client cancels a call and a subscription;
7. how the client reads occurrences, and how each end shows.

## Design notes

*This section is not normative.*

- **Why a contract with no language.** Every language surface gives the same guarantees to its clients. Only the form changes: a promise or a future, an exception or an enum, a signal or a token. One contract keeps these guarantees the same in each language, and each mapping stays short.
- **Why the typed call is a recommendation.** A client must be able to call every capability with an input that it does not trust, for example the input of a protocol surface. A typed call only saves the work of decoding, so it is not required.
- **Why a client can miss a value.** To give each value, a surface must keep a buffer for each client that reads slowly. A client acts on the latest value, so the contract asks only for that.
- **Why a handle can be the functions of the session.** In some languages, an object for each capability is the usual style. In others, a function that takes the id is simpler. Both give the same guarantees.
