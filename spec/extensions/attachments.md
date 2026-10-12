# Attachments

Binary data, such as a screenshot, stays out of capability inputs. A session holds the data, and an input refers to it by an opaque **handle**.

## Handles

A handle is a string of 1 to 128 characters with no structure a client can rely on. In a catalog, a field that holds a handle has this schema:

```json
{ "type": "string", "minLength": 1, "maxLength": 128, "format": "acidcat-attachment" }
```

The `format` tells bindings which fields expect an attachment, so that they can offer an upload. It does not change validation.

A handle is valid only in the session that registered the attachment. Each attachment carries a `name`, a `mediaType`, and its `size` in bytes.

## Lifetime

- The session owns every attachment, and releases whatever it still holds when it closes.
- When a capability has finished with an attachment it received, the provider releases it, unless it keeps the attachment as part of its own data. A handle that appears in an output belongs to the provider, so the client never has to release it.
- Releasing a handle twice, or releasing an unknown handle, does nothing.
- A capability that accepts a handle declares the failure `AttachmentUnavailable`. It reports that failure for a handle that is released, unknown, or from another session.

## Bindings

A binding that supports attachments states how a client registers one: an upload route, a file flag, a page's file picker. A target whose bindings cannot register attachments can still pass handles that it received in an output.
