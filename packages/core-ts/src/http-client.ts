/**
 * A client of the HTTP binding (spec/bindings/http.md). The command line uses it to call the capabilities and follow
 * the events of an application that runs in another process or on another machine (spec/bindings/cli.md#server).
 */
import { AVAILABLE, CALL_FAILURE_KINDS, CallFailureError, callFailure, isJsonObject, isOccurrence, SSE_MEDIA_TYPE, unavailable } from "@acid-cat/spec-ts";
import type { Availability, CallFailure, CallFailureKind, Occurrence, Outcome } from "@acid-cat/spec-ts";

/** The largest answer that the client reads, in bytes. */
const MAXIMUM_ANSWER = 64 * 1024 * 1024;

export interface HttpClientOptions {
  /**
   * The headers to send with each request, for example `{ Authorization: "Bearer …" }`. The client never writes them in
   * a message or an error.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** The function that sends the requests. The default is the global `fetch`. */
  readonly fetch?: typeof fetch | undefined;
}

export interface HttpSubscribeOptions {
  /** Abort to close the request. The server then cancels the subscription, and the occurrences end. */
  readonly signal?: AbortSignal | undefined;
  /** The cursor to resume after, sent as `Last-Event-ID`. */
  readonly cursor?: string | undefined;
  /** The oldest occurrence to replay, in milliseconds, sent as the query parameter `maxAgeMs`. */
  readonly maxAgeMs?: number | undefined;
}

/**
 * A client of an HTTP binding at a base URL. No method rejects: a server that does not answer is the call failure
 * `unavailable`, an answer that the HTTP binding does not give is `internal`, and an abort is `cancelled`.
 */
export interface HttpClient {
  /** The base URL, without its last `/`. */
  readonly base: string;
  /** The capabilities of the view of the server, by id, with their availability: `GET {base}/capabilities`. */
  capabilities(options?: { readonly signal?: AbortSignal | undefined }): Promise<ReadonlyMap<string, Availability> | CallFailure>;
  /** Call a capability: `POST {base}/capabilities/{id}`. Abort the signal to close the request: the server then cancels the call. */
  invoke(id: string, input: unknown, options?: { readonly signal?: AbortSignal | undefined }): Promise<Outcome<unknown, unknown>>;
  /**
   * Subscribe to an event: `POST {base}/events/{id}`. The result is the occurrences, or the call failure before the first
   * occurrence. The occurrences reject with a `CallFailureError` when the subscription ends with a call failure, and end
   * with no error when the signal aborts.
   */
  subscribe(id: string, input: unknown, options?: HttpSubscribeOptions): Promise<AsyncIterable<Occurrence> | CallFailure>;
}

/**
 * A client of the HTTP binding at `url`, an `http` or `https` URL, for example `http://pi.local:8080/cli`. It throws
 * when the URL or a header is not valid. The error does not contain the value of a header.
 */
export function httpClient(url: string, options: HttpClientOptions = {}): HttpClient {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The URL of the server is not a URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("The URL of the server is not an http or https URL.");
  if (parsed.search !== "" || parsed.hash !== "") throw new Error("The URL of the server must not have a query or a fragment.");
  if (parsed.username !== "" || parsed.password !== "") throw new Error("The URL of the server must not have a user name or a password. Give them in a header.");
  const base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  const headers = new Headers();
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    try {
      headers.append(name, value);
    } catch {
      throw new Error(`The header ${/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ? name : "with that name"} is not valid.`);
    }
  }
  const send = options.fetch ?? fetch;
  const notAnswering = () => callFailure("unavailable", `The server at ${base} does not answer.`);

  /** Send a request. The result is the response, or the call failure when the server does not answer or the signal aborts. */
  async function request(method: "GET" | "POST", path: string, init: { readonly body?: unknown; readonly signal?: AbortSignal | undefined; readonly lastEventId?: string | undefined }): Promise<Response | CallFailure> {
    if (aborted(init.signal)) return cancelled();
    const requestHeaders = new Headers(headers);
    requestHeaders.set("Accept", "application/json, text/event-stream");
    if (init.lastEventId !== undefined) {
      try {
        requestHeaders.set("Last-Event-ID", init.lastEventId);
      } catch {
        return callFailure("invalid-input", "The cursor cannot be sent in the header Last-Event-ID.");
      }
    }
    let body: string | undefined;
    if (method === "POST") {
      requestHeaders.set("Content-Type", "application/json");
      body = JSON.stringify(init.body ?? {});
    }
    try {
      return await send(`${base}${path}`, { method, headers: requestHeaders, ...(body === undefined ? {} : { body }), ...(init.signal === undefined ? {} : { signal: init.signal }) });
    } catch {
      return aborted(init.signal) ? cancelled() : notAnswering();
    }
  }

  /** The status and the JSON body of an answer, or the call failure when it is not JSON. */
  async function read(response: Response, signal: AbortSignal | undefined): Promise<{ readonly status: number; readonly body: unknown } | CallFailure> {
    const text = await boundedText(response, signal);
    if (typeof text !== "string") return text;
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return notAnAnswer();
    }
  }

  return {
    base,
    async capabilities(callOptions = {}) {
      const response = await request("GET", "/capabilities", { signal: callOptions.signal });
      if (!(response instanceof Response)) return response;
      const answer = await read(response, callOptions.signal);
      if (!("status" in answer)) return answer;
      if (answer.status !== 200) return failureOf(answer.body);
      if (!Array.isArray(answer.body)) return notAnAnswer();
      const served = new Map<string, Availability>();
      for (const item of answer.body) {
        const entry = availabilityEntry(item);
        if (entry === undefined) return notAnAnswer();
        served.set(entry.id, entry.availability);
      }
      return served;
    },
    async invoke(id, input, callOptions = {}) {
      const response = await request("POST", `/capabilities/${encodeURIComponent(id)}`, { body: input, signal: callOptions.signal });
      if (!(response instanceof Response)) return response;
      const answer = await read(response, callOptions.signal);
      if (!("status" in answer)) return answer;
      if (answer.status !== 200) return failureOf(answer.body);
      const { body } = answer;
      if (isJsonObject(body) && body.ok === true && "value" in body) return { ok: true, value: body.value };
      if (isJsonObject(body) && body.ok === false && "error" in body) return { ok: false, error: body.error };
      return notAnAnswer();
    },
    async subscribe(id, input, subscribeOptions = {}) {
      const query = subscribeOptions.maxAgeMs === undefined ? "" : `?maxAgeMs=${encodeURIComponent(String(subscribeOptions.maxAgeMs))}`;
      const response = await request("POST", `/events/${encodeURIComponent(id)}${query}`, {
        body: input,
        signal: subscribeOptions.signal,
        lastEventId: subscribeOptions.cursor,
      });
      if (!(response instanceof Response)) return response;
      if (response.status !== 200) {
        const answer = await read(response, subscribeOptions.signal);
        return "status" in answer ? failureOf(answer.body) : answer;
      }
      const mediaType = (response.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
      if (mediaType !== SSE_MEDIA_TYPE || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        return notAnAnswer();
      }
      return occurrencesOf(response.body, subscribeOptions.signal);
    },
  };
}

/** True if the signal aborted. A function, so that TypeScript does not keep a test of the signal from before an await. */
const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const cancelled = () => callFailure("cancelled", "The call was cancelled.");

const notAnAnswer = () => callFailure("internal", "The server gave an answer that the HTTP binding does not give.");

const broken = () => callFailure("internal", "The connection to the server broke.");

const isCallFailureKind = (value: unknown): value is CallFailureKind => CALL_FAILURE_KINDS.some((kind) => kind === value);

/** The call failure in the body of an answer, or `internal` when the body is not a call failure. */
function failureOf(body: unknown): CallFailure {
  if (isJsonObject(body) && isCallFailureKind(body.kind) && typeof body.message === "string") return callFailure(body.kind, body.message);
  return notAnAnswer();
}

/** One item of `GET {base}/capabilities`, or `undefined` when it is not one. */
function availabilityEntry(item: unknown): { readonly id: string; readonly availability: Availability } | undefined {
  if (!isJsonObject(item) || typeof item.id !== "string") return undefined;
  if (item.available === true) return { id: item.id, availability: AVAILABLE };
  if (item.available === false && typeof item.reason === "string") return { id: item.id, availability: unavailable(item.reason) };
  return undefined;
}

/** The text of a body, at most `MAXIMUM_ANSWER` bytes, or the call failure when it cannot be read. */
async function boundedText(response: Response, signal: AbortSignal | undefined): Promise<string | CallFailure> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > MAXIMUM_ANSWER) {
        await reader.cancel().catch(() => undefined);
        return notAnAnswer();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return aborted(signal) ? cancelled() : broken();
  }
}

/** A message of a stream of server-sent events. */
interface Message {
  readonly event: string;
  readonly data: string;
}

/**
 * The parser of a stream of server-sent events (https://html.spec.whatwg.org/multipage/server-sent-events.html): lines
 * end with CRLF, LF or CR, a line that starts with `:` is a comment, and a blank line ends a message. It reads the
 * fields `event` and `data`, and ignores the others, also `id`: the cursor of an occurrence is in its data. It gives a
 * message with no data only when its event is `complete`.
 */
export class SseParser {
  #buffer = "";
  #event = "";
  #data: string[] = [];
  #started = false;

  /** Give the next text of the stream. The result is the messages that it ends. */
  push(text: string): Message[] {
    this.#buffer += text;
    if (!this.#started && this.#buffer.length > 0) {
      this.#started = true;
      if (this.#buffer.startsWith("﻿")) this.#buffer = this.#buffer.slice(1);
    }
    const messages: Message[] = [];
    for (;;) {
      const end = this.#buffer.search(/\r\n|\n|\r/);
      if (end < 0) break;
      // A CR at the end of the buffer can be the start of a CRLF that the next text ends.
      if (this.#buffer[end] === "\r" && end === this.#buffer.length - 1) break;
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + (this.#buffer.startsWith("\r\n", end) ? 2 : 1));
      const message = this.#line(line);
      if (message !== undefined) messages.push(message);
    }
    return messages;
  }

  #line(line: string): Message | undefined {
    if (line === "") {
      const message = { event: this.#event === "" ? "message" : this.#event, data: this.#data.join("\n") };
      const empty = this.#data.length === 0;
      this.#event = "";
      this.#data = [];
      // A message with no data is not dispatched, except `complete`: the HTTP binding needs no data to end a stream.
      return empty && message.event !== "complete" ? undefined : message;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const raw = colon < 0 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") this.#event = value;
    else if (field === "data") this.#data.push(value);
    return undefined;
  }
}

/** Parse JSON text, or give `undefined` when it is not JSON. */
function parseJson(text: string): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/**
 * The occurrences of a stream of server-sent events of the HTTP binding. `next` is an occurrence, `complete` the end,
 * and `error` the end with its call failure. A stream that ends with no `complete` or `error` is `internal`.
 */
async function* occurrencesOf(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined): AsyncGenerator<Occurrence> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        if (aborted(signal)) return;
        throw new CallFailureError(broken());
      }
      if (chunk.done) {
        if (aborted(signal)) return;
        throw new CallFailureError(broken());
      }
      for (const message of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        const data = parseJson(message.data);
        if (message.event === "next") {
          if (data === undefined || !isOccurrence(data.value)) throw new CallFailureError(notAnAnswer());
          yield data.value;
        } else if (message.event === "complete") {
          return;
        } else if (message.event === "error") {
          throw new CallFailureError(data === undefined ? notAnAnswer() : failureOf(data.value));
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

