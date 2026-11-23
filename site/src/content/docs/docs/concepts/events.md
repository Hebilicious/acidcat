---
title: Events
description: An event is a thing that happens in the application. A client subscribes to it and gets an occurrence each time that the thing happens.
sidebar:
  order: 14
---

An **event** is a kind of thing that happens in the application, and that clients can follow, for example `aircon.status.changed`. A client **subscribes** to an event with an input. Then it gets an **occurrence** each time that the thing happens, until the subscription ends.

Use an event when clients must know about a change as it happens. Use a capability for a call that gives one result.

## Declare an event

```json title="aircon.acidcat.json (part)"
"events": {
  "aircon.status.changed": {
    "description": "The status of the unit changed.",
    "audience": ["app", "taskbar", "cli", "mcp", "api"],
    "input": { "properties": {}, "type": "object" },
    "payload": { "$ref": "#/$defs/Status" }
  }
}
```

| Member | Required | Value |
| --- | --- | --- |
| `description` | Yes | What happens, and when an occurrence comes |
| `audience` | No | The targets that can use the event |
| `input` | No | The schema of the input of a subscription, for example a filter. It is an object |
| `payload` | No | The schema of the `data` of each occurrence. It is an object |

The payload is always an object. An object can get new members, and old clients still read it. To keep old clients working, add members to a payload. Do not remove or change members.

## Occurrences

Each occurrence has this form:

```json
{
  "eventId": "41",
  "name": "aircon.status.changed",
  "timestamp": "2026-11-10T09:30:00Z",
  "data": { "power": true, "mode": "cool", "fan": "auto", "targetCelsius": 22, "roomCelsius": 25 },
  "cursor": "41"
}
```

- `data` matches the payload schema.
- `cursor` is optional. It marks a position. A client gives it back to **resume** a subscription after that position.
- `truncated: true` tells the client that occurrences before this one are missing, for example because the client read too slowly.

## How a subscription ends

A subscription ends exactly one time:

| End | When |
| --- | --- |
| Complete | The provider has no more occurrences, or the session closes |
| Cancelled | The client stops the subscription |
| Call failure | The provider fails, or gives data that does not match the payload schema. The client gets `internal` |

A problem in the source of the event is not a call failure. Put it in the payload, for example as a union with a `_tag`.

## Events on each surface

| Binding | How a client follows an event |
| --- | --- |
| CLI | `watch <id>` writes one line of JSON for each occurrence. In the air conditioner, the alias `follow` does the same |
| MCP | The MCP events extension: push, poll and webhook delivery |
| HTTP | `POST {base}/events/{id}` gives a stream of server-sent events |
| TypeScript | An event handle gives an async iterable |
| WebMCP | None. The page follows events through the TypeScript binding |

## Read more

- [Events](/spec/events/) in the specification: subscribing, ending, slow clients and resuming.
- The events section of each binding: [CLI](/spec/bindings/cli/#events), [MCP](/spec/bindings/mcp/#events), [HTTP](/spec/bindings/http/#events), [TypeScript](/spec/bindings/typescript/#event-handles).
