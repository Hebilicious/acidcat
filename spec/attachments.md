# Attachments

An **attachment** is binary data, such as a screenshot, that a session holds outside any capability's input. A capability refers to it by an opaque **handle**. Moving the bytes in is the job of a binding.

Closes divergence row D8.

## Handle

A handle is a string of 1 to 128 characters with no structure a caller can rely on. In a manifest, every handle is described by this schema:

```json
{ "type": "string", "minLength": 1, "maxLength": 128, "format": "acidcat-attachment" }
```

A handle is valid only within the session that registered the attachment.

## Metadata

Each attachment carries:

- `name`;
- `mediaType`;
- `size`, the length of the data in bytes.

## Lifetime

The session owns every attachment. An attachment stays available until it is released or the session closes, whichever happens first. Releasing a handle that is already released, or that is unknown, does nothing.

- Once a capability has finished with an attachment it received as input, the capability's owner releases it, unless the owner keeps it as part of its state.
- An attachment that an owner keeps is released by the owner when it drops it. A handle that appears in an output refers to such an attachment, so the caller never has to release it.
- When a session closes, it releases every attachment it still holds, after the owners have closed.

A capability that accepts a handle declares an expected failure tagged `AttachmentUnavailable`. It reports that failure when the handle is released, unknown, or belongs to another session.

## Bindings

A binding that serves a capability taking a handle provides some way to register attachments with the session. A capability whose audience names a target that has no such way still works, but only with handles the caller has received from another output.

## Rationale

*This section is not normative.*

**JB's design is adopted.** Keeping binary values such as browser `File` and `Blob` out of capability contracts lets every surface share one input schema. JB already relies on this for screenshots and OCR. HS has no attachments, so nothing changes there.

**The format marker.** JB's handle schema is a branded string, and a branded string looks like any other string in JSON Schema. The `format` annotation tells a binding which fields expect an attachment, for example so that an MCP client can be offered an upload. The annotation does not change validation.

**Handles in outputs are owned by their owner.** JB's comment says that "successful callers own their release" for handles returned by `bartering.workbench.inspect`. No capability exposes a release, so a WebMCP caller cannot do it, and the handles stay alive until the session closes. Making the owner responsible removes that obligation, which no caller could meet.

**Changes for each implementation.**
- JB: add the `format` annotation; make handles in outputs owner-held; release the handles of a rejected `ships.resource-inventory.ocr.review` call (it returns `resource/busy` without releasing them).
- HS: nothing.
