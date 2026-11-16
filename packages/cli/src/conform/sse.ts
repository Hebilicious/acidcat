export interface SseMessage {
  readonly event?: string;
  readonly id?: string;
  readonly data: string;
}

type SseFrame = { readonly type: "comment" } | { readonly type: "message"; readonly message: SseMessage };

export function sseReader(response: Response) {
  if (response.body === null) throw new Error("the response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const read = async (): Promise<SseFrame | undefined> => {
    for (;;) {
      const end = /\r?\n\r?\n/.exec(text);
      if (end !== null) {
        const raw = text.slice(0, end.index);
        text = text.slice(end.index + end[0].length);
        return parse(raw);
      }
      const chunk = await reader.read();
      if (chunk.done) return text.trim() === "" ? undefined : parse(text);
      text += decoder.decode(chunk.value, { stream: true });
    }
  };
  return {
    async next(): Promise<SseMessage | undefined> {
      for (;;) {
        const frame = await read();
        if (frame === undefined) return undefined;
        if (frame.type === "message") return frame.message;
      }
    },
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

function parse(raw: string): SseFrame {
  const fields: { event?: string; id?: string; data: string[] } = { data: [] };
  const lines = raw.split(/\r?\n/);
  if (lines.every((line) => line.startsWith(":"))) return { type: "comment" };
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (name === "event") fields.event = value;
    else if (name === "id") fields.id = value;
    else if (name === "data") fields.data.push(value);
  }
  const message = { ...(fields.event === undefined ? {} : { event: fields.event }), ...(fields.id === undefined ? {} : { id: fields.id }), data: fields.data.join("\n") };
  return { type: "message", message };
}
