# Attachments

Binary data, for example an image, is not part of an input. The session keeps the data. The input refers to the data with a **handle**.

## Handles

A handle is a string of 1 to 128 characters. A client MUST NOT use its structure. A field that contains a handle has this schema:

```json
{ "type": "string", "minLength": 1, "maxLength": 128, "format": "acidcat-attachment" }
```

The `format` tells bindings that the field needs an attachment, so they can show an upload control. It does not change validation.

A handle is valid only in the session that registered the attachment. Each attachment has a `name`, a `mediaType` and a `size` in bytes.

## Lifetime

- The session owns all attachments. When the session closes, it releases the attachments that it still has.
- When a capability no longer needs an attachment, the provider releases it. If the provider keeps the attachment in its data, it does not release it.
- A handle in an output belongs to the provider. The client does not release it.
- A second release of a handle, or the release of an unknown handle, has no effect.
- A capability that accepts a handle has the failure `AttachmentUnavailable`. It returns this failure for a handle that is released, unknown, or from a different session.

## Bindings

A binding that supports attachments tells how a client registers an attachment, for example with an upload route, a file flag or a file picker. A target that cannot register attachments can still use handles from outputs.
