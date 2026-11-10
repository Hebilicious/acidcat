/**
 * A reader of a stream of server-sent events, for the tests. It gives each message with its fields, and each comment
 * line as a message with the event `comment`.
 */

export interface SseMessage {
  readonly event?: string;
  readonly id?: string;
  readonly data: string;
  /** The text of the message as the server sent it, without the blank line at its end. */
  readonly raw: string;
}

/** Read the messages of a response one at a time. `next` resolves with `undefined` at the end of the stream. */
export function sseReader(response: Response) {
  if (response.body === null) throw new Error("The response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    async next(): Promise<SseMessage | undefined> {
      for (;;) {
        const end = text.indexOf("\n\n");
        if (end >= 0) {
          const raw = text.slice(0, end);
          text = text.slice(end + 2);
          return parse(raw);
        }
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        text += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

function parse(raw: string): SseMessage {
  const fields: { event?: string; id?: string; data: string[] } = { data: [] };
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) return { event: "comment", data: line.slice(1), raw };
    const [name = "", ...rest] = line.split(":");
    const value = rest.join(":").replace(/^ /, "");
    if (name === "event") fields.event = value;
    else if (name === "id") fields.id = value;
    else if (name === "data") fields.data.push(value);
  }
  return { ...(fields.event === undefined ? {} : { event: fields.event }), ...(fields.id === undefined ? {} : { id: fields.id }), data: fields.data.join("\n"), raw };
}
