/**
 * A client of the HTTP binding (spec/bindings/http.md), with the HTTP client of `effect/http`. `Http.client` makes it.
 * The command line uses it to serve a view of an application that runs on a server (spec/bindings/cli.md#server).
 */
import { CALL_FAILURE_KINDS, callFailure, isOccurrence } from "@acid-cat/spec-ts";
import type { Availability, CallFailure, Occurrence, Outcome, Resume } from "@acid-cat/spec-ts";
import { Effect, Layer, Option, Result, Schema, Scope, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

import { CallFailed } from "../Session.ts";

/** The largest answer that the client reads, in bytes. */
const MAXIMUM_ANSWER = 64 * 1024 * 1024;

/** A capability that the server lists, with its availability. */
export type Listed = { readonly id: string } & Availability;

/** A client of the HTTP binding at a base URL. */
export interface Client {
  /** The base URL, with no `/` at the end, for example `http://pi.local:8080/cli`. */
  readonly base: string;
  /**
   * The capabilities of the view of the server, with their availability: `GET {base}/capabilities`. It fails with
   * `unavailable` when the server does not answer, and with `internal` when the answer is not of the HTTP binding.
   */
  readonly capabilities: Effect.Effect<ReadonlyArray<Listed>, CallFailed>;
  /**
   * Call a capability: `POST {base}/capabilities/{id}`. The outcome is in its JSON form, and the effect never fails.
   * Interrupt the effect to cancel the call: the client closes the request, and the server cancels the call.
   */
  readonly invoke: (id: string, input: unknown) => Effect.Effect<Outcome<unknown, unknown>>;
  /**
   * Subscribe to an event: `POST {base}/events/{id}`, with the cursor in `Last-Event-ID` and `maxAgeMs` in the query.
   * The effect succeeds when the server sends the stream of server-sent events. It fails with the call failure of the
   * server before the first occurrence. The stream ends at `complete`, and fails at `error` with its call failure, or
   * with `internal` when the connection breaks. Close the scope, or interrupt the stream, to cancel the subscription.
   */
  readonly subscribe: (id: string, input: unknown, options?: Resume) => Effect.Effect<Stream.Stream<Occurrence, CallFailed>, CallFailed, Scope.Scope>;
}

export interface ClientOptions {
  /**
   * The headers that the client adds to each request, for example `{ Authorization: "Bearer …" }`. The client never
   * writes them to its errors or to its call failures.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * The HTTP client that sends the requests. The default is `FetchHttpClient.layer` of `effect/http`, which uses
   * `globalThis.fetch`. Give another layer for another transport, for example to trust the certificate of a server.
   */
  readonly layer?: Layer.Layer<HttpClient.HttpClient> | undefined;
}

/**
 * A client of the HTTP binding at `base`, an `http` or `https` URL. It throws an `Error` when `base` is not such a URL,
 * or when a header is not valid. The message of the error does not contain the value of a header.
 */
export function make(base: string, options: ClientOptions = {}): Client {
  const root = base.replace(/\/+$/, "");
  if (!URL.canParse(root)) throw new Error(`${root} is not a URL.`);
  const url = new URL(root);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") throw new Error(`${root} is not an http or https URL.`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    try {
      headers.append(name, value);
    } catch {
      throw new Error(`The header ${name} is not valid.`);
    }
  }
  const layer = options.layer ?? FetchHttpClient.layer;
  const unreachable = callFailure("unavailable", `The server at ${root} does not answer.`);

  /**
   * Send a request in the current scope. The scope owns the request and the body of the answer: when it closes, the
   * client closes the request.
   */
  const send = (method: "GET" | "POST", path: string, body: unknown, extra: Readonly<Record<string, string>> = {}) =>
    Effect.gen(function* () {
      const http = HttpClient.withScope(yield* HttpClient.HttpClient);
      let request = HttpClientRequest.make(method)(`${root}${path}`, {
        headers: { ...Object.fromEntries(headers), Accept: "application/json, text/event-stream", ...extra },
      });
      if (method === "POST") request = HttpClientRequest.bodyText(request, JSON.stringify(body), "application/json");
      return yield* http.execute(request).pipe(Effect.mapError(() => new CallFailed(unreachable)));
    }).pipe(Effect.provide(layer));

  const capabilities = Effect.scoped(
    Effect.gen(function* () {
      const answer = yield* send("GET", "/capabilities", undefined);
      const body = yield* readJson(answer);
      if (answer.status !== 200) return yield* new CallFailed(failureOf(body));
      const listed = Schema.decodeUnknownOption(CapabilityList)(body);
      if (Option.isNone(listed)) return yield* new CallFailed(notAnAnswer);
      return listed.value.map(
        ({ id, available, reason }): Listed => (available ? { id, available: true } : { id, available: false, reason: reason ?? "" }),
      );
    }),
  );

  const invoke = (id: string, input: unknown): Effect.Effect<Outcome<unknown, unknown>> =>
    Effect.scoped(
      Effect.gen(function* () {
        const answer = yield* send("POST", `/capabilities/${encodeURIComponent(id)}`, input);
        const body = yield* readJson(answer);
        if (answer.status !== 200) return failureOf(body);
        return Option.getOrElse(Schema.decodeUnknownOption(CallResult)(body), () => notAnAnswer);
      }),
    ).pipe(Effect.catch((failed) => Effect.succeed({ kind: failed.kind, message: failed.message })));

  const subscribe = (id: string, input: unknown, resume: Resume = {}) =>
    Effect.gen(function* () {
      const query = resume.maxAgeMs === undefined ? "" : `?maxAgeMs=${resume.maxAgeMs}`;
      const answer = yield* send("POST", `/events/${encodeURIComponent(id)}${query}`, input, resume.cursor === undefined ? {} : { "Last-Event-ID": resume.cursor });
      if (answer.status !== 200) return yield* new CallFailed(failureOf(yield* readJson(answer)));
      return occurrences(answer.stream);
    });

  return { base: root, capabilities, invoke, subscribe };
}

const CallFailureSchema = Schema.Struct({ kind: Schema.Literals(CALL_FAILURE_KINDS), message: Schema.String });

/** The body of an answer with the status 200 to a call: a value or a failure. */
const CallResult = Schema.Union([Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json }), Schema.Struct({ ok: Schema.Literal(false), error: Schema.Json })]);

const CapabilityList = Schema.Array(Schema.Struct({ id: Schema.String, available: Schema.Boolean, reason: Schema.optionalKey(Schema.String) }));

export const notAnAnswer = callFailure("internal", "The server gave an answer that the HTTP binding does not give.");

/** The JSON value of a text, or nothing when the text is not JSON. */
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const broken = callFailure("internal", "The connection to the server broke.");

/** The call failure in the body of an answer with a status that is not 200. */
function failureOf(body: unknown): CallFailure {
  return Option.getOrElse(Schema.decodeUnknownOption(CallFailureSchema)(body), () => notAnAnswer);
}

/** The JSON body of an answer, read up to `MAXIMUM_ANSWER` bytes. */
const readJson = (answer: HttpClientResponse.HttpClientResponse): Effect.Effect<unknown, CallFailed> =>
  answer.stream.pipe(
    Stream.mapError(() => new CallFailed(broken)),
    Stream.runFoldEffect(
      () => ({ chunks: new Array<Uint8Array>(), size: 0 }),
      (read, chunk) => {
        const size = read.size + chunk.length;
        if (size > MAXIMUM_ANSWER) return Effect.fail(new CallFailed(notAnAnswer));
        read.chunks.push(chunk);
        return Effect.succeed({ chunks: read.chunks, size });
      },
    ),
    Effect.flatMap(({ chunks }) => {
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return Option.match(parseJson(new TextDecoder().decode(bytes)), {
        onNone: () => Effect.fail(new CallFailed(notAnAnswer)),
        onSome: Effect.succeed,
      });
    }),
  );

/** One message of a stream of server-sent events, that a blank line ends. */
export interface Message {
  readonly event: string;
  readonly data: string;
  readonly id: string | undefined;
}

/** The fields of the message that the parser reads now. */
interface Fields {
  readonly event: string;
  readonly data: readonly string[];
  readonly id: string | undefined;
}

const noFields: Fields = { event: "", data: [], id: undefined };

/**
 * Read one line of a stream of server-sent events (the event stream format of the HTML standard). A blank line ends a
 * message. A line that starts with `:` is a comment, for example a keepalive. A field with no `:` has the empty value,
 * and one space after the `:` is not part of the value. Fields other than `event`, `data` and `id` are ignored.
 */
export function readLine(fields: Fields, line: string): readonly [Fields, readonly Message[]] {
  if (line === "") {
    if (fields.event === "" && fields.data.length === 0) return [noFields, []];
    return [noFields, [{ event: fields.event, data: fields.data.join("\n"), id: fields.id }]];
  }
  if (line.startsWith(":")) return [fields, []];
  const colon = line.indexOf(":");
  const name = colon === -1 ? line : line.slice(0, colon);
  const rest = colon === -1 ? "" : line.slice(colon + 1);
  const value = rest.startsWith(" ") ? rest.slice(1) : rest;
  if (name === "event") return [{ ...fields, event: value }, []];
  if (name === "data") return [{ ...fields, data: [...fields.data, value] }, []];
  if (name === "id" && !value.includes("\0")) return [{ ...fields, id: value }, []];
  return [fields, []];
}

/** What one message of the HTTP binding means for the subscription. */
type Signal =
  | { readonly _tag: "next"; readonly occurrence: Occurrence }
  | { readonly _tag: "complete" }
  | { readonly _tag: "error"; readonly failure: CallFailure };

/** The signal of a message, or nothing for a message of another type. */
function signalOf(message: Message): Signal | undefined {
  if (message.event === "next") {
    const occurrence = Option.getOrUndefined(parseJson(message.data));
    return isOccurrence(occurrence) ? { _tag: "next", occurrence } : { _tag: "error", failure: notAnAnswer };
  }
  if (message.event === "complete") return { _tag: "complete" };
  if (message.event === "error") {
    const body = parseJson(message.data);
    return { _tag: "error", failure: Option.match(body, { onNone: () => notAnAnswer, onSome: failureOf }) };
  }
  return undefined;
}

/**
 * The occurrences of a stream of server-sent events, as the HTTP binding sends them (spec/bindings/http.md#events).
 * The stream ends at `complete`. It fails at `error` with its call failure, and with `internal` at a `next` that is not
 * an occurrence, or when the body ends before `complete` or `error`.
 */
export const occurrences = <E>(body: Stream.Stream<Uint8Array, E>): Stream.Stream<Occurrence, CallFailed> =>
  body.pipe(
    Stream.mapError(() => new CallFailed(broken)),
    Stream.decodeText,
    Stream.splitLines,
    Stream.mapAccum(() => noFields, readLine),
    Stream.filterMap((message) => {
      const signal = signalOf(message);
      return signal === undefined ? Result.failVoid : Result.succeed(signal);
    }),
    Stream.concat(Stream.succeed<Signal>({ _tag: "error", failure: broken })),
    Stream.takeUntil((signal) => signal._tag !== "next"),
    Stream.flatMap((signal) => {
      if (signal._tag === "next") return Stream.succeed(signal.occurrence);
      if (signal._tag === "complete") return Stream.empty;
      return Stream.fail(new CallFailed(signal.failure));
    }),
  );
